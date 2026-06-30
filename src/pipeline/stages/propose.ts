import {
  type ActionContext,
  AppendSectionPayload,
  actionRegistry,
  applyAction,
  CreateDocumentPayload,
  validateAction,
} from "../../actions/index.js";
import type { AppConfig } from "../../config/index.js";
import type { IngestionJob } from "../../domain/schemas.js";
import type { KbConfigService } from "../../kb/index.js";
import { logger } from "../../logging/index.js";
import type { ChatMessage, ChatProvider, EmbeddingProvider } from "../../providers/interfaces.js";
import type { Repositories } from "../../repositories/interfaces.js";
import type { SearchService } from "../../retrieval/search.js";
import type { VersioningService } from "../../versioning/index.js";
import { renderScratchpadMarkdown } from "../scratchpad.js";
import type { StepResult } from "../stateMachine.js";
import { createProposalTools } from "./propose-tools.js";

/**
 * Stage 3 (plan §6): the LLM proposes structured actions via a tool-call loop;
 * deterministic code validates, gates, and applies them.
 */

export interface Stage3Deps {
  repos: Repositories;
  chat: ChatProvider;
  embeddings: EmbeddingProvider;
  search: SearchService;
  versioning: VersioningService;
  kbService: KbConfigService;
  cfg: Pick<AppConfig, "AUTO_APPLY_CONFIDENCE_THRESHOLD" | "PROPOSAL_STEP_BUDGET">;
}

async function buildActionContext(
  deps: Stage3Deps,
  job: IngestionJob,
  humanApproved: boolean,
): Promise<ActionContext> {
  const kb = await deps.repos.knowledgeBases.getById(job.knowledge_base_id);
  if (!kb) throw new Error("knowledge base not found");
  return {
    repos: deps.repos,
    versioning: deps.versioning,
    search: deps.search,
    embeddings: deps.embeddings,
    knowledgeBaseId: kb.id,
    kbConfig: kb.config,
    configVersion: kb.config_version,
    jobId: job.id,
    actor: humanApproved ? "human" : "pipeline:stage3",
    humanApproved,
  };
}

async function collectProposals(
  deps: Stage3Deps,
  job: IngestionJob,
  kb: NonNullable<Awaited<ReturnType<Repositories["knowledgeBases"]["getById"]>>>,
  report: NonNullable<IngestionJob["stage_outputs"]["reconciliation"]>,
): Promise<ReturnType<ReturnType<typeof createProposalTools>["getCollected"]>> {
  const tools = createProposalTools();
  const log = logger.child({ ingestion_job_id: job.id, stage: "proposing_edits" });

  const linkedIds = [...new Set(report.items.flatMap((i) => i.linked_document_ids))];
  const linkedDocs = (
    await Promise.all(linkedIds.map((id) => deps.repos.documents.getById(id)))
  ).filter((d) => d !== null);
  const docContext = linkedDocs
    .map((d) => {
      const template = kb.config.templates.find(
        (t) => t.id === (d.template_id ?? kb.config.default_template_id),
      );
      return `- ${d.id} "${d.title}" (template: ${template?.id ?? "generic"}; sections: ${template?.sections.map((s) => s.key).join(", ")})`;
    })
    .join("\n");
  const tags = await deps.repos.tags.listByKb(kb.id);
  const rules = kb.config.page_eligibility_rules;

  const system =
    "You translate a reconciliation report into concrete wiki edits by calling proposal tools one at a time.\n" +
    "PHILOSOPHY: augment first. Prefer propose_append_section / propose_update_section over propose_create_document. " +
    `New pages must satisfy the KB's eligibility rules (≥${rules.min_statements} statements, ≥${rules.min_total_words} words about the entity). ` +
    "For every propose_create_document, ALSO supply fallback_attach (an existing document id + section key).\n" +
    "- confirmed statements: usually no action\n" +
    "- new statements: append/update sections or create_document when clearly warranted\n" +
    "- conflicts/needs_review with human context in the working notes: follow the human's guidance\n" +
    "Call one propose_* tool per action. Invalid payloads return an error — fix and retry. " +
    "When finished, call done().";

  const messages: ChatMessage[] = [
    {
      role: "user",
      content:
        `Knowledge base: ${kb.name}\n` +
        `Available templates: ${kb.config.templates.map((t) => `${t.id} [${t.sections.map((s) => s.key).join("/")}]`).join("; ")}\n` +
        `Existing tags: ${tags.map((t) => t.name).join(", ") || "(none)"}\n` +
        `Documents in scope:\n${docContext || "(none yet — empty KB)"}\n\n` +
        `Reconciliation report:\n${JSON.stringify(report, null, 2)}\n\n` +
        `Working notes (includes any human review context):\n${renderScratchpadMarkdown(job.scratchpad)}`,
    },
  ];

  let stepsUsed = 0;
  let finished = false;

  while (stepsUsed < deps.cfg.PROPOSAL_STEP_BUDGET && !finished) {
    const result = await deps.chat.complete({
      system,
      messages,
      tools: tools.definitions,
      temperature: 0,
    });

    if (result.toolCalls.length === 0) {
      messages.push({ role: "assistant", content: result.text });
      messages.push({
        role: "user",
        content: "Call propose_* tools for each edit, then call done() when finished.",
      });
      stepsUsed++;
      continue;
    }

    stepsUsed++;
    messages.push({ role: "assistant", content: result.text, tool_calls: result.toolCalls });
    for (const call of result.toolCalls) {
      if (tools.isDone(call.name)) {
        finished = true;
        messages.push({
          role: "tool",
          content: tools.execute(call.name, call.arguments),
          tool_call_id: call.id,
        });
        break;
      }
      const output = tools.execute(call.name, call.arguments);
      log.info("proposal tool", { tool: call.name });
      messages.push({ role: "tool", content: output, tool_call_id: call.id });
    }
  }

  if (!finished && tools.getCollected().length === 0) {
    log.warn("proposal step budget exhausted with no actions");
  }

  return tools.getCollected();
}

export function makeProposingStep(deps: Stage3Deps) {
  return async (job: IngestionJob): Promise<StepResult> => {
    const report = job.stage_outputs.reconciliation;
    if (!report) return { next: "failed", error: "proposing_edits without reconciliation report" };
    const kb = await deps.repos.knowledgeBases.getById(job.knowledge_base_id);
    if (!kb) return { next: "failed", error: "knowledge base not found" };
    const log = logger.child({ ingestion_job_id: job.id, stage: "proposing_edits" });

    const existing = await deps.repos.proposedActions.listByJob(job.id);
    if (existing.length > 0) {
      const pendingReview = (await deps.repos.reviewItems.listByJob(job.id)).filter(
        (r) => r.status === "pending",
      );
      return { next: pendingReview.length > 0 ? "awaiting_review" : "applying_edits" };
    }

    const proposal = await collectProposals(deps, job, kb, report);
    const ctx = await buildActionContext(deps, job, false);
    let needsReview = 0;

    for (const candidate of proposal) {
      let { type, payload } = candidate;

      if (type === "create_document") {
        const parsed = CreateDocumentPayload.safeParse(payload);
        if (parsed.success) {
          const statements = parsed.data.sections
            .flatMap((s) => s.body_markdown.split(/(?<=[.!?])\s+/))
            .filter((s) => s.trim().length > 0);
          const decision = await deps.kbService.evaluatePageEligibility(
            kb.config.page_eligibility_rules,
            {
              entityName: parsed.data.title,
              entityKind: parsed.data.template_id,
              statements,
            },
          );
          if (!decision.earnsOwnPage && candidate.fallback_attach) {
            const target = await deps.repos.documents.getById(
              candidate.fallback_attach.document_id,
            );
            if (target) {
              const body = parsed.data.sections.map((s) => s.body_markdown.trim()).join("\n\n");
              const targetTemplate = kb.config.templates.find(
                (t) => t.id === (target.template_id ?? kb.config.default_template_id),
              );
              const sectionDef = targetTemplate?.sections.find(
                (s) => s.key === candidate.fallback_attach!.section_key,
              );
              type = "append_section";
              payload = AppendSectionPayload.parse({
                document_id: target.id,
                section: {
                  key: candidate.fallback_attach.section_key,
                  title: sectionDef?.title ?? candidate.fallback_attach.section_key,
                  body_markdown: `**${parsed.data.title}** — ${body}`,
                },
              });
              log.info("eligibility demoted create_document to append_section", {
                title: parsed.data.title,
                rationale: decision.rationale,
              });
            }
          } else if (!decision.earnsOwnPage) {
            const row = await deps.repos.proposedActions.create({
              knowledge_base_id: kb.id,
              ingestion_job_id: job.id,
              type,
              payload: payload as Record<string, unknown>,
              status: "proposed",
              confidence: candidate.confidence,
              reason: `${candidate.reason} | eligibility: ${decision.rationale}`,
            });
            await deps.repos.reviewItems.create({
              knowledge_base_id: kb.id,
              ingestion_job_id: job.id,
              kind: "proposed_action",
              payload: {
                proposed_action_id: row.id,
                type,
                issues: [{ code: "page_eligibility", message: decision.rationale }],
              },
              status: "pending",
              resolution: null,
            });
            needsReview++;
            continue;
          }
        }
      }

      const validated = await validateAction(type, payload, ctx);
      if (!validated.valid) {
        await deps.repos.proposedActions.create({
          knowledge_base_id: kb.id,
          ingestion_job_id: job.id,
          type,
          payload: (validated.payload ?? {}) as Record<string, unknown>,
          status: "rejected",
          confidence: candidate.confidence,
          reason: `${candidate.reason} | rejected: ${validated.issues.map((i) => i.message).join("; ")}`,
        });
        log.warn("action rejected by guardrails", { type, issues: validated.issues });
        continue;
      }

      const autoApprove =
        !validated.requiresReview &&
        candidate.confidence >= deps.cfg.AUTO_APPLY_CONFIDENCE_THRESHOLD;

      const row = await deps.repos.proposedActions.create({
        knowledge_base_id: kb.id,
        ingestion_job_id: job.id,
        type,
        payload: validated.payload as Record<string, unknown>,
        status: autoApprove ? "approved" : "proposed",
        confidence: candidate.confidence,
        reason: candidate.reason,
      });

      if (!autoApprove) {
        await deps.repos.reviewItems.create({
          knowledge_base_id: kb.id,
          ingestion_job_id: job.id,
          kind: validated.issues.some((i) => i.code === "taxonomy_change")
            ? "taxonomy_change"
            : "proposed_action",
          payload: {
            proposed_action_id: row.id,
            type,
            payload: validated.payload,
            confidence: candidate.confidence,
            reason: candidate.reason,
            issues: validated.issues,
          },
          status: "pending",
          resolution: null,
        });
        needsReview++;
      }
    }

    return { next: needsReview > 0 ? "awaiting_review" : "applying_edits" };
  };
}

/** Apply order: structure before references (tags → docs → content → promote → links → tagging). */
const APPLY_ORDER: Record<string, number> = {
  create_tag: 0,
  create_document: 1,
  append_section: 2,
  update_section: 2,
  promote_subsection: 3,
  upsert_link: 4,
  apply_tag: 5,
};

export function makeApplyingStep(deps: Stage3Deps) {
  return async (job: IngestionJob): Promise<StepResult> => {
    const approved = await deps.repos.proposedActions.listByJob(job.id, "approved");
    approved.sort((a, b) => (APPLY_ORDER[a.type] ?? 9) - (APPLY_ORDER[b.type] ?? 9));
    const log = logger.child({ ingestion_job_id: job.id, stage: "applying_edits" });

    for (const action of approved) {
      const reviews = await deps.repos.reviewItems.listByJob(job.id);
      const humanApproved = reviews.some(
        (r) =>
          (r.payload as { proposed_action_id?: string }).proposed_action_id === action.id &&
          r.status === "resolved" &&
          (r.resolution as { kind?: string } | null)?.kind === "approved",
      );
      const ctx = await buildActionContext(deps, job, humanApproved);
      try {
        const result = await applyAction(action.type, action.payload, ctx);
        await deps.repos.proposedActions.update(action.id, {
          status: "applied",
          applied_version_id: result.appliedVersionId,
        });
        log.info("action applied", { type: action.type, noop: result.noop, detail: result.detail });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { next: "failed", error: `applying ${action.type} failed: ${message}` };
      }
    }
    return { next: "completed" };
  };
}

export { actionRegistry };
