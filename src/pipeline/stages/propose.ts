import { z } from "zod";
import {
  type ActionContext,
  AppendSectionPayload,
  actionRegistry,
  applyAction,
  CreateDocumentPayload,
  validateAction,
} from "../../actions/index.js";
import type { AppConfig } from "../../config/index.js";
import { ActionTypeSchema, type IngestionJob } from "../../domain/schemas.js";
import type { KbConfigService } from "../../kb/index.js";
import { logger } from "../../logging/index.js";
import type { ChatProvider, EmbeddingProvider } from "../../providers/interfaces.js";
import type { Repositories } from "../../repositories/interfaces.js";
import type { SearchService } from "../../retrieval/search.js";
import type { VersioningService } from "../../versioning/index.js";
import { renderScratchpadMarkdown } from "../scratchpad.js";
import type { StepResult } from "../stateMachine.js";

/**
 * Stage 3 (plan §6): the LLM proposes structured actions; deterministic code
 * validates, gates, and applies them.
 * - Augment-first philosophy is enforced two ways: the prompt instructs it,
 *   and the page-eligibility rules engine (plan §9) can deterministically
 *   demote a create_document into an append_section fallback.
 * - confidence ≥ AUTO_APPLY_CONFIDENCE_THRESHOLD and no review-gated issues →
 *   auto-approved; otherwise → review_item (kind proposed_action) and the job
 *   parks in awaiting_review.
 */

const ProposalSchema = z
  .object({
    actions: z
      .array(
        z
          .object({
            type: ActionTypeSchema,
            payload: z.record(z.string(), z.unknown()),
            confidence: z.number().min(0).max(1),
            reason: z.string(),
            /** for create_document: where to attach instead if a page isn't warranted */
            fallback_attach: z
              .object({ document_id: z.uuid(), section_key: z.string().min(1) })
              .strict()
              .nullable()
              .default(null),
          })
          .strict(),
      )
      .max(30),
  })
  .strict();

export interface Stage3Deps {
  repos: Repositories;
  chat: ChatProvider;
  embeddings: EmbeddingProvider;
  search: SearchService;
  versioning: VersioningService;
  kbService: KbConfigService;
  cfg: Pick<AppConfig, "AUTO_APPLY_CONFIDENCE_THRESHOLD">;
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

export function makeProposingStep(deps: Stage3Deps) {
  return async (job: IngestionJob): Promise<StepResult> => {
    const report = job.stage_outputs.reconciliation;
    if (!report) return { next: "failed", error: "proposing_edits without reconciliation report" };
    const kb = await deps.repos.knowledgeBases.getById(job.knowledge_base_id);
    if (!kb) return { next: "failed", error: "knowledge base not found" };
    const log = logger.child({ ingestion_job_id: job.id, stage: "proposing_edits" });

    // Idempotent re-run guard: if proposals already exist, just re-route.
    const existing = await deps.repos.proposedActions.listByJob(job.id);
    if (existing.length > 0) {
      const pendingReview = (await deps.repos.reviewItems.listByJob(job.id)).filter(
        (r) => r.status === "pending",
      );
      return { next: pendingReview.length > 0 ? "awaiting_review" : "applying_edits" };
    }

    // Context for the model: documents referenced by the report.
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

    const result = await deps.chat.complete({
      system:
        "You translate a reconciliation report into concrete wiki edits, as structured actions.\n" +
        "PHILOSOPHY: augment first. Prefer append_section/update_section on existing documents over create_document. " +
        `New pages must satisfy the KB's eligibility rules (≥${rules.min_statements} statements, ≥${rules.min_total_words} words about the entity). ` +
        "For every create_document, ALSO supply fallback_attach (an existing document id + section key) so the system can attach the content as a subsection if the page is not warranted.\n" +
        "- confirmed statements: usually no action (maybe upsert_link if a relationship is implied)\n" +
        "- new statements: append/update sections on linked documents, or create_document when clearly warranted\n" +
        "- conflicts/needs_review with human context in the working notes: follow the human's guidance\n" +
        `Action types and payloads:\n` +
        `- create_document { title, template_id, sections: [{key,title,body_markdown}], tag_names, link_to: [{to_document_id, relation}] }\n` +
        `- append_section { document_id, section: {key,title,body_markdown} }\n` +
        `- update_section { document_id, section_key, body_markdown }\n` +
        `- upsert_link { from_document_id, to_document_id, relation: related|mentions|parent|child, anchor }\n` +
        `- create_tag { name, kind: category|tag, parent_name, description }\n` +
        `- apply_tag { document_id, tag_name, confidence }\n` +
        `- promote_subsection { source_document_id, section_key, new_title, template_id }\n` +
        "Use only document ids listed in the context. Set confidence honestly per action. " +
        'Respond as JSON: { "actions": [{ "type", "payload", "confidence", "reason", "fallback_attach" }] }',
      messages: [
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
      ],
      schema: ProposalSchema,
      temperature: 0,
    });
    const proposal = result.parsed!;

    const ctx = await buildActionContext(deps, job, false);
    let needsReview = 0;

    for (const candidate of proposal.actions) {
      let { type, payload } = candidate as { type: typeof candidate.type; payload: unknown };

      // Page-eligibility rules engine (plan §9): deterministic gate first; the
      // LLM judgment inside evaluatePageEligibility is itself gated.
      if (type === "create_document") {
        const parsed = CreateDocumentPayload.safeParse(payload);
        if (parsed.success) {
          const statements = parsed.data.sections
            .flatMap((s) => s.body_markdown.split(/(?<=[.!?])\s+/))
            .filter((s) => s.trim().length > 0);
          const decision = await deps.kbService.evaluatePageEligibility(rules, {
            entityName: parsed.data.title,
            entityKind: parsed.data.template_id,
            statements,
          });
          if (!decision.earnsOwnPage && candidate.fallback_attach) {
            const target = await deps.repos.documents.getById(
              candidate.fallback_attach.document_id,
            );
            if (target) {
              const body = parsed.data.sections.map((s) => s.body_markdown.trim()).join("\n\n");
              // Attach under the target template's canonical section header —
              // the entity name lives in the bolded lead-in, not the heading.
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
            // no fallback — a human has to decide
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
      // Human-approved actions get review-gated policies lifted.
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
