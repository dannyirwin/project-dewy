import type { IngestionJob, JobState } from "../domain/schemas.js";
import { logger } from "../logging/index.js";
import type { Repositories } from "../repositories/interfaces.js";

/**
 * Self-owned persisted state machine (locked decision #1). State lives on the
 * ingestion_job row; each transition is an idempotent step function keyed on
 * the *current* state. A crashed/restarted worker re-reads the row and
 * re-runs the step for whatever state it finds — steps must therefore be safe
 * to re-run (they re-derive outputs rather than assume partial work).
 */

export type StepResult =
  | { next: JobState; patch?: Partial<Pick<IngestionJob, "stage_outputs" | "scratchpad">> }
  | { next: "failed"; error: string };

export type StepFn = (job: IngestionJob) => Promise<StepResult>;

/** Legal transitions; anything else is a bug and throws. */
const LEGAL: Record<JobState, JobState[]> = {
  received: ["classifying", "completed", "failed"], // received→completed = exact-duplicate short-circuit
  classifying: ["classified", "failed"],
  classified: ["reconciling", "failed"],
  reconciling: ["reconciled", "failed"],
  reconciled: ["awaiting_review", "proposing_edits", "failed"],
  awaiting_review: ["proposing_edits", "applying_edits", "failed"],
  proposing_edits: ["awaiting_review", "applying_edits", "failed"],
  applying_edits: ["completed", "failed"],
  completed: [],
  failed: [],
};

export const TERMINAL_STATES: ReadonlySet<JobState> = new Set(["completed", "failed"]);
/** States the runner must not advance past without external input. */
export const PAUSED_STATES: ReadonlySet<JobState> = new Set(["awaiting_review"]);

export class IngestionStateMachine {
  private steps = new Map<JobState, StepFn>();

  constructor(private repos: Repositories) {}

  register(state: JobState, fn: StepFn): this {
    this.steps.set(state, fn);
    return this;
  }

  /** Run exactly one step for the job's current state. Returns the updated job. */
  async advance(jobId: string): Promise<IngestionJob> {
    const job = await this.repos.ingestionJobs.getById(jobId);
    if (!job) throw new Error(`ingestion_job ${jobId} not found`);
    if (TERMINAL_STATES.has(job.state)) return job;

    const step = this.steps.get(job.state);
    if (!step) throw new Error(`no step registered for state "${job.state}"`);

    const log = logger.child({
      ingestion_job_id: job.id,
      stage: job.state,
      knowledge_base_id: job.knowledge_base_id,
    });
    log.info("step start");
    try {
      const result = await step(job);
      if (result.next === "failed" && "error" in result) {
        log.error("step failed", { error: result.error });
        return this.repos.ingestionJobs.update(job.id, { state: "failed", error: result.error });
      }
      if (!LEGAL[job.state].includes(result.next)) {
        throw new Error(`illegal transition ${job.state} → ${result.next}`);
      }
      log.info("step done", { next: result.next });
      return this.repos.ingestionJobs.update(job.id, {
        state: result.next,
        ...("patch" in result && result.patch ? result.patch : {}),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("step threw", { error: message });
      return this.repos.ingestionJobs.update(job.id, { state: "failed", error: message });
    }
  }

  /** Advance until the job parks (review), completes, or fails. */
  async runToCompletion(jobId: string, maxSteps = 25): Promise<IngestionJob> {
    let job = await this.repos.ingestionJobs.getById(jobId);
    if (!job) throw new Error(`ingestion_job ${jobId} not found`);
    for (let i = 0; i < maxSteps; i++) {
      if (TERMINAL_STATES.has(job.state) || PAUSED_STATES.has(job.state)) return job;
      job = await this.advance(jobId);
    }
    return job;
  }
}
