import type { IngestionJob } from "../../domain/schemas.js";
import type { Repositories } from "../../repositories/interfaces.js";
import type { ReconciliationEngine } from "../reconciliation/engine.js";
import type { StepResult } from "../stateMachine.js";

/**
 * Stage-2 pipeline steps: run the ReconciliationEngine (reconciling), then
 * gate on the report (reconciled): conflicts and needs_review items become
 * review_item rows and park the job in awaiting_review (plan §5/§6).
 */

export function makeReconcilingStep(repos: Repositories, engine: ReconciliationEngine) {
  return async (job: IngestionJob): Promise<StepResult> => {
    const classification = job.stage_outputs.classification;
    if (!classification)
      return { next: "failed", error: "reconciling without classification output" };
    const kb = await repos.knowledgeBases.getById(job.knowledge_base_id);
    if (!kb) return { next: "failed", error: "knowledge base not found" };

    const { report, scratchpad } = await engine.reconcile({
      kb,
      jobId: job.id,
      classification,
      scratchpad: job.scratchpad,
    });

    return {
      next: "reconciled",
      patch: { stage_outputs: { ...job.stage_outputs, reconciliation: report }, scratchpad },
    };
  };
}

export function makeReconciledStep(repos: Repositories) {
  return async (job: IngestionJob): Promise<StepResult> => {
    const report = job.stage_outputs.reconciliation;
    if (!report) return { next: "failed", error: "reconciled without reconciliation report" };

    // Idempotent re-run guard: don't duplicate review items for the same statement.
    const existing = await repos.reviewItems.listByJob(job.id);
    const alreadyRaised = new Set(
      existing.map((r) => (r.payload as { statement_id?: string }).statement_id).filter(Boolean),
    );

    for (const item of report.items) {
      if (item.status !== "conflicts" && item.status !== "needs_review") continue;
      if (alreadyRaised.has(item.statement_id)) continue;
      await repos.reviewItems.create({
        knowledge_base_id: job.knowledge_base_id,
        ingestion_job_id: job.id,
        kind: item.status === "conflicts" ? "conflict" : "ambiguous_fact",
        payload: {
          statement_id: item.statement_id,
          statement_text: item.statement_text,
          status: item.status,
          linked_document_ids: item.linked_document_ids,
          confidence: item.confidence,
          rationale: item.rationale,
        },
        status: "pending",
        resolution: null,
      });
    }

    const pending = (await repos.reviewItems.listByJob(job.id)).filter(
      (r) => r.status === "pending",
    );
    return { next: pending.length > 0 ? "awaiting_review" : "proposing_edits" };
  };
}

/**
 * awaiting_review step runs only when the ReviewService resumes the job (the
 * runner treats awaiting_review as paused). It routes to the right next stage.
 */
export function makeAwaitingReviewStep(repos: Repositories) {
  return async (job: IngestionJob): Promise<StepResult> => {
    const pending = (await repos.reviewItems.listByJob(job.id)).filter(
      (r) => r.status === "pending",
    );
    if (pending.length > 0) {
      // Defensive: resumed too early. Fail loud rather than silently proceed.
      return { next: "failed", error: "resumed awaiting_review with pending review items" };
    }
    const actions = await repos.proposedActions.listByJob(job.id);
    // If actions already exist we were parked on action review → go apply.
    return { next: actions.length > 0 ? "applying_edits" : "proposing_edits" };
  };
}
