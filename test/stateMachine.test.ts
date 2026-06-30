import { describe, expect, it } from "vitest";
import { defaultKbConfig } from "../src/kb/index.js";
import { IngestionStateMachine } from "../src/pipeline/stateMachine.js";
import { createInMemoryRepositories } from "../src/repositories/memory/index.js";

async function setup() {
  const repos = createInMemoryRepositories();
  const kb = await repos.knowledgeBases.create({
    name: "KB",
    slug: "kb",
    config: defaultKbConfig(),
  });
  const job = await repos.ingestionJobs.create({
    knowledge_base_id: kb.id,
    source: { raw_text: "x", metadata: {}, storage_ref: null },
    source_hash: "h",
  });
  return { repos, job };
}

describe("persisted state machine (Phase 4)", () => {
  it("advances through registered steps and persists state", async () => {
    const { repos, job } = await setup();
    const machine = new IngestionStateMachine(repos)
      .register("received", async () => ({ next: "classifying" }))
      .register("classifying", async () => ({ next: "classified" }));
    await machine.advance(job.id);
    expect((await repos.ingestionJobs.getById(job.id))!.state).toBe("classifying");
    await machine.advance(job.id);
    expect((await repos.ingestionJobs.getById(job.id))!.state).toBe("classified");
  });

  it("rejects illegal transitions by failing the job loudly", async () => {
    const { repos, job } = await setup();
    const machine = new IngestionStateMachine(repos).register("received", async () => ({
      next: "applying_edits", // not legal from received
    }));
    const after = await machine.advance(job.id);
    expect(after.state).toBe("failed");
    expect(after.error).toMatch(/illegal transition/);
  });

  it("resumes from whatever state is persisted (kill/restart simulation)", async () => {
    const { repos, job } = await setup();
    // simulate a worker that crashed after persisting "reconciling"
    await repos.ingestionJobs.update(job.id, { state: "reconciling" });
    let reconcilingRan = 0;
    const machine = new IngestionStateMachine(repos)
      .register("received", async () => ({ next: "classifying" }))
      .register("reconciling", async () => {
        reconcilingRan++;
        return { next: "reconciled" };
      });
    const after = await machine.advance(job.id);
    expect(reconcilingRan).toBe(1); // picked up at the persisted step, not the start
    expect(after.state).toBe("reconciled");
  });

  it("a throwing step fails the job with the error recorded", async () => {
    const { repos, job } = await setup();
    const machine = new IngestionStateMachine(repos).register("received", async () => {
      throw new Error("boom");
    });
    const after = await machine.advance(job.id);
    expect(after.state).toBe("failed");
    expect(after.error).toBe("boom");
  });

  it("terminal states are no-ops", async () => {
    const { repos, job } = await setup();
    await repos.ingestionJobs.update(job.id, { state: "completed" });
    const machine = new IngestionStateMachine(repos);
    const after = await machine.advance(job.id);
    expect(after.state).toBe("completed");
  });

  it("runToCompletion pauses at awaiting_review", async () => {
    const { repos, job } = await setup();
    const machine = new IngestionStateMachine(repos)
      .register("received", async () => ({ next: "classifying" }))
      .register("classifying", async () => ({ next: "classified" }))
      .register("classified", async () => ({ next: "reconciling" }))
      .register("reconciling", async () => ({ next: "reconciled" }))
      .register("reconciled", async () => ({ next: "awaiting_review" }));
    const after = await machine.runToCompletion(job.id);
    expect(after.state).toBe("awaiting_review");
  });
});
