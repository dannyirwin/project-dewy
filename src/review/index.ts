import type { ReviewItem } from "../domain/schemas.js";
import { mergeScratchpad } from "../pipeline/scratchpad.js";
import type { IngestionStateMachine } from "../pipeline/stateMachine.js";
import type { Repositories } from "../repositories/interfaces.js";

/**
 * Review workflow (Phase 6, plan §11): review items are DB rows surfaced over
 * the API. Resolving feeds context back into the job scratchpad; when the last
 * pending item for a parked job resolves, the pipeline resumes.
 */
export class ReviewService {
  constructor(
    private repos: Repositories,
    private machine: IngestionStateMachine,
  ) {}

  listPending(knowledgeBaseId: string): Promise<ReviewItem[]> {
    return this.repos.reviewItems.listPending(knowledgeBaseId);
  }

  listForJob(jobId: string): Promise<ReviewItem[]> {
    return this.repos.reviewItems.listByJob(jobId);
  }

  /** Human answers a question / adds context. Lands in the job scratchpad. */
  async provideContext(reviewItemId: string, context: string): Promise<ReviewItem> {
    const item = await this.requirePending(reviewItemId);
    const updated = await this.repos.reviewItems.update(item.id, {
      status: "resolved",
      resolution: { kind: "context", context },
    });
    await this.appendScratchpadContext(item, context);
    await this.audit(item, "review_context", { context });
    await this.maybeResume(item.ingestion_job_id);
    return updated;
  }

  /** Human skips — pipeline proceeds with its best guess. */
  async skip(reviewItemId: string): Promise<ReviewItem> {
    const item = await this.requirePending(reviewItemId);
    const updated = await this.repos.reviewItems.update(item.id, {
      status: "skipped",
      resolution: { kind: "skipped" },
    });
    await this.appendScratchpadContext(
      item,
      "Reviewer skipped this question; proceed with best judgment.",
    );
    await this.audit(item, "review_skip", {});
    await this.maybeResume(item.ingestion_job_id);
    return updated;
  }

  /** Approve/reject a reviewable item (e.g. a gated proposed_action). */
  async decide(reviewItemId: string, approve: boolean, note?: string): Promise<ReviewItem> {
    const item = await this.requirePending(reviewItemId);
    const updated = await this.repos.reviewItems.update(item.id, {
      status: "resolved",
      resolution: { kind: approve ? "approved" : "rejected", note: note ?? null },
    });

    // Gated proposed_action items carry the action id; flip its status.
    const actionId = (item.payload as { proposed_action_id?: string }).proposed_action_id;
    if (item.kind === "proposed_action" && actionId) {
      await this.repos.proposedActions.update(actionId, {
        status: approve ? "approved" : "rejected",
      });
    }
    if (note) await this.appendScratchpadContext(item, note);
    await this.audit(item, approve ? "review_approve" : "review_reject", { note: note ?? null });
    await this.maybeResume(item.ingestion_job_id);
    return updated;
  }

  /** Resume a parked job once nothing pending remains for it. */
  async maybeResume(jobId: string): Promise<void> {
    const job = await this.repos.ingestionJobs.getById(jobId);
    if (job?.state !== "awaiting_review") return;
    const pending = (await this.repos.reviewItems.listByJob(jobId)).filter(
      (r) => r.status === "pending",
    );
    if (pending.length > 0) return;
    // runToCompletion treats awaiting_review as paused, so explicitly take the
    // one step out of the paused state, then let the machine run.
    await this.machine.advance(jobId);
    await this.machine.runToCompletion(jobId);
  }

  private async requirePending(reviewItemId: string): Promise<ReviewItem> {
    const item = await this.repos.reviewItems.getById(reviewItemId);
    if (!item) throw new Error(`review_item ${reviewItemId} not found`);
    if (item.status !== "pending") throw new Error(`review_item ${reviewItemId} is not pending`);
    return item;
  }

  private async appendScratchpadContext(item: ReviewItem, context: string): Promise<void> {
    const job = await this.repos.ingestionJobs.getById(item.ingestion_job_id);
    if (!job) return;
    await this.repos.ingestionJobs.update(job.id, {
      scratchpad: mergeScratchpad(job.scratchpad, {
        review_context: [{ review_item_id: item.id, context }],
      }),
    });
  }

  private async audit(item: ReviewItem, action: string, after: Record<string, unknown>) {
    await this.repos.auditLogs.append({
      knowledge_base_id: item.knowledge_base_id,
      ingestion_job_id: item.ingestion_job_id,
      entity_type: "review_item",
      entity_id: item.id,
      action,
      before: { status: "pending" },
      after,
      reason: `human ${action}`,
      confidence: null,
      actor: "human",
    });
  }
}
