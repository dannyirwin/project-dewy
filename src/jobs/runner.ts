import { logger } from "../logging/index.js";
import type { Pipeline } from "../pipeline/index.js";
import { PAUSED_STATES, TERMINAL_STATES } from "../pipeline/stateMachine.js";
import type { Repositories } from "../repositories/interfaces.js";

/**
 * Single-process job runner (plan §12 deferred queue): jobs advance via an
 * in-process loop. The boundary is queue-shaped — `tick` claims runnable jobs
 * and advances them one step at a time — so swapping in pg-boss/Graphile
 * Worker later means replacing this file, not the pipeline.
 */
export class JobRunner {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private repos: Repositories,
    private pipeline: Pipeline,
    private intervalMs = 1000,
  ) {}

  /** Advance every runnable job in a KB by as many steps as possible. */
  async drainKb(knowledgeBaseId: string): Promise<void> {
    const jobs = await this.repos.ingestionJobs.listByKb(knowledgeBaseId);
    for (const job of jobs) {
      if (TERMINAL_STATES.has(job.state) || PAUSED_STATES.has(job.state)) continue;
      await this.pipeline.machine.runToCompletion(job.id);
    }
  }

  /** One scheduler tick across all KBs. */
  async tick(): Promise<void> {
    const kbs = await this.repos.knowledgeBases.list();
    for (const kb of kbs) {
      try {
        await this.drainKb(kb.id);
      } catch (err) {
        logger.error("runner tick failed", {
          knowledge_base_id: kb.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref?.();
    logger.info("job runner started", { interval_ms: this.intervalMs });
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
