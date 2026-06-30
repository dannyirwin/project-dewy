import { z } from "zod";
import { normalizedHash } from "../../domain/hash.js";
import { ClassificationSchema, type IngestionJob, type Statement } from "../../domain/schemas.js";
import type { ChatProvider } from "../../providers/interfaces.js";
import type { Repositories } from "../../repositories/interfaces.js";
import type { StepResult } from "../stateMachine.js";

/**
 * Stage 1 (plan §4): break raw input into statements bucketed clear /
 * semi_clear / unusable, each with provenance offsets back into the source.
 *
 * Dedup (locked decision #9) happens at the `received` step:
 * - identical content hash from a prior completed job → short-circuit to
 *   completed with duplicate_of_job_id recorded;
 * - identical *normalized* hash but different raw hash → near match: flagged
 *   via near_duplicate_of_job_id and processing continues (full diff/merge
 *   semantics deferred per plan §13).
 */

/** LLM-facing schema: statements without ids/offsets (we assign those). */
const RawClassificationSchema = z
  .object({
    input_quality: z.enum(["high", "medium", "low"]),
    clear: z.array(z.string()),
    semi_clear: z.array(z.string()),
    unusable: z.array(z.string()),
  })
  .strict();

function locate(source: string, statement: string): { start: number; end: number } {
  // Best-effort provenance: exact match, else longest-prefix match, else 0..0.
  const idx = source.indexOf(statement);
  if (idx !== -1) return { start: idx, end: idx + statement.length };
  const words = statement.split(/\s+/).slice(0, 6).join(" ");
  const partial = words ? source.indexOf(words) : -1;
  if (partial !== -1)
    return { start: partial, end: Math.min(source.length, partial + statement.length) };
  return { start: 0, end: 0 };
}

export function makeReceivedStep(repos: Repositories) {
  return async (job: IngestionJob): Promise<StepResult> => {
    const siblings = (
      await repos.ingestionJobs.findBySourceHash(job.knowledge_base_id, job.source_hash)
    ).filter((j) => j.id !== job.id && j.state === "completed");
    if (siblings.length > 0) {
      return {
        next: "completed",
        patch: { stage_outputs: { ...job.stage_outputs, duplicate_of_job_id: siblings[0]!.id } },
      };
    }

    // near-match: same normalized hash, different raw hash
    const myNorm = normalizedHash(job.source.raw_text);
    const all = await repos.ingestionJobs.listByKb(job.knowledge_base_id);
    const near = all.find(
      (j) =>
        j.id !== job.id &&
        j.state === "completed" &&
        j.source_hash !== job.source_hash &&
        normalizedHash(j.source.raw_text) === myNorm,
    );
    if (near) {
      return {
        next: "classifying",
        patch: { stage_outputs: { ...job.stage_outputs, near_duplicate_of_job_id: near.id } },
      };
    }
    return { next: "classifying" };
  };
}

export function makeClassifyStep(chat: ChatProvider) {
  return async (job: IngestionJob): Promise<StepResult> => {
    const result = await chat.complete({
      system:
        "You classify raw notes for a wiki-style knowledge base. Split the input into atomic factual statements. " +
        "Bucket each statement:\n" +
        "- clear: unambiguous, self-contained fact\n" +
        "- semi_clear: probably useful but ambiguous, missing referent, or hedged\n" +
        "- unusable: noise, formatting junk, or content-free\n" +
        "Copy statement text verbatim from the input where possible (do not paraphrase). " +
        "Also rate overall input_quality (high/medium/low). " +
        'Respond as JSON: { "input_quality": "...", "clear": [...], "semi_clear": [...], "unusable": [...] }.',
      messages: [{ role: "user", content: job.source.raw_text }],
      schema: RawClassificationSchema,
      temperature: 0,
    });
    const raw = result.parsed!;

    let n = 0;
    const toStatements = (texts: string[]): Statement[] =>
      texts
        .filter((t) => t.trim().length > 0)
        .map((text) => ({
          id: `s${++n}`,
          text,
          provenance: locate(job.source.raw_text, text),
        }));

    const classification = ClassificationSchema.parse({
      version: 1,
      input_quality: raw.input_quality,
      buckets: {
        clear: toStatements(raw.clear),
        semi_clear: toStatements(raw.semi_clear),
        unusable: toStatements(raw.unusable),
      },
    });

    if (
      classification.buckets.clear.length === 0 &&
      classification.buckets.semi_clear.length === 0
    ) {
      return { next: "failed", error: "no usable statements found in input" };
    }

    return {
      next: "classified",
      patch: { stage_outputs: { ...job.stage_outputs, classification } },
    };
  };
}

/** classified → reconciling is a pure bookkeeping hop. */
export async function makeClassifiedStep(): Promise<StepResult> {
  return { next: "reconciling" };
}
