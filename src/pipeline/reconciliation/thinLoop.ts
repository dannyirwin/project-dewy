import { z } from "zod";
import type { AppConfig } from "../../config/index.js";
import { ReconciliationReportSchema, type Scratchpad } from "../../domain/schemas.js";
import { logger } from "../../logging/index.js";
import type { ChatMessage, ChatProvider } from "../../providers/interfaces.js";
import type { Repositories } from "../../repositories/interfaces.js";
import type { SearchService } from "../../retrieval/search.js";
import { mergeScratchpad, renderScratchpadMarkdown } from "../scratchpad.js";
import type { ReconciliationEngine, ReconciliationInput, ReconciliationOutput } from "./engine.js";
import { createReconciliationTools } from "./tools.js";

/**
 * Default Stage-2 implementation (locked decision #1): a thin tool-call loop —
 * `while (toolCalls && steps < budget)` — over the provider abstraction.
 * No framework. The step budget comes from config; on exhaustion we force a
 * final report and mark uninvestigated statements needs_review (fail safe,
 * never silent).
 */

/** What the model returns at the end: the report plus scratchpad additions. */
const FinalOutputSchema = z
  .object({
    report: ReconciliationReportSchema,
    scratchpad_additions: z
      .object({
        relevant_summaries: z
          .array(
            z.object({ document_id: z.uuid(), title: z.string(), summary: z.string() }).strict(),
          )
          .default([]),
        entity_resolutions: z
          .array(
            z
              .object({
                mention: z.string(),
                document_id: z.uuid().nullable(),
                decision: z.string(),
                confidence: z.number().min(0).max(1),
              })
              .strict(),
          )
          .default([]),
        name_decisions: z
          .array(
            z.object({ original: z.string(), resolved: z.string(), reason: z.string() }).strict(),
          )
          .default([]),
        notes: z.array(z.string()).default([]),
      })
      .strict(),
  })
  .strict();

export class ThinLoopReconciliationEngine implements ReconciliationEngine {
  constructor(
    private chat: ChatProvider,
    private repos: Repositories,
    private search: SearchService,
    private cfg: Pick<AppConfig, "RECONCILIATION_STEP_BUDGET">,
  ) {}

  async reconcile(input: ReconciliationInput): Promise<ReconciliationOutput> {
    const tools = createReconciliationTools(this.repos, this.search, input.kb.id);
    const log = logger.child({ ingestion_job_id: input.jobId, stage: "reconciling" });

    const statements = [
      ...input.classification.buckets.clear,
      ...input.classification.buckets.semi_clear,
    ];
    const statementList = statements.map((s) => `- [${s.id}] ${s.text}`).join("\n");

    const system =
      "You reconcile new statements against an existing wiki-style knowledge base.\n" +
      "For EVERY statement id, decide its status:\n" +
      "- confirmed: the KB already says this (link the supporting documents)\n" +
      "- conflicts: the KB says something contradictory (link the conflicting documents)\n" +
      "- new: genuinely new information (after checking it is not a misspelled or variant reference to an existing entity)\n" +
      "- needs_review: a human must decide (ambiguous referent, plausible-but-unverifiable, or you ran out of budget)\n" +
      "Use the tools to investigate before deciding. ALWAYS run checkName on proper nouns before treating them as new entities — " +
      "misspellings and variants must resolve to the existing entity, recorded as a name_decision.\n" +
      "When you are done investigating, respond with ONLY the final JSON (no tool calls): " +
      '{ "report": { "version": 1, "items": [{ "statement_id", "statement_text", "status", "linked_document_ids", "confidence", "rationale" }] }, ' +
      '"scratchpad_additions": { "relevant_summaries": [], "entity_resolutions": [], "name_decisions": [], "notes": [] } }';

    const messages: ChatMessage[] = [
      {
        role: "user",
        content:
          `Knowledge base: ${input.kb.name}\n\n` +
          `Statements to reconcile:\n${statementList}\n\n` +
          `Prior working notes:\n${renderScratchpadMarkdown(input.scratchpad)}`,
      },
    ];

    let stepsUsed = 0;
    let final: z.infer<typeof FinalOutputSchema> | null = null;

    while (stepsUsed < this.cfg.RECONCILIATION_STEP_BUDGET) {
      const result = await this.chat.complete({
        system,
        messages,
        tools: tools.definitions,
        schema: FinalOutputSchema,
        temperature: 0,
      });

      if (result.toolCalls.length === 0) {
        if (result.parsed) {
          final = result.parsed;
          break;
        }
        // No tools, no valid final output → nudge once per loop iteration.
        messages.push({ role: "assistant", content: result.text });
        messages.push({
          role: "user",
          content: "Respond with ONLY the final JSON object in the required shape.",
        });
        stepsUsed++;
        continue;
      }

      stepsUsed++;
      messages.push({ role: "assistant", content: result.text, tool_calls: result.toolCalls });
      for (const call of result.toolCalls) {
        const output = await tools.execute(call.name, call.arguments);
        log.info("tool call", { tool: call.name, args: call.arguments });
        messages.push({ role: "tool", content: output, tool_call_id: call.id });
      }
    }

    if (!final) {
      // Budget exhausted: ask for a forced wrap-up; anything unresolved → needs_review.
      log.warn("step budget exhausted; forcing final report");
      messages.push({
        role: "user",
        content:
          "STOP investigating — your step budget is exhausted. Emit the final JSON now. " +
          "Mark any statement you could not verify as needs_review with a rationale.",
      });
      const result = await this.chat.complete({
        system,
        messages,
        schema: FinalOutputSchema,
        temperature: 0,
      });
      final = result.parsed!;
    }

    // Safety net: every statement must appear in the report.
    const reported = new Set(final.report.items.map((i) => i.statement_id));
    for (const s of statements) {
      if (!reported.has(s.id)) {
        final.report.items.push({
          statement_id: s.id,
          statement_text: s.text,
          status: "needs_review",
          linked_document_ids: [],
          confidence: 0,
          rationale: "not addressed by reconciliation within budget",
        });
      }
    }

    const scratchpad: Scratchpad = mergeScratchpad(input.scratchpad, final.scratchpad_additions);
    return { report: ReconciliationReportSchema.parse(final.report), scratchpad, stepsUsed };
  }
}
