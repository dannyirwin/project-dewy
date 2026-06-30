import { describe, expect, it } from "vitest";
import {
  buildTestStack,
  classifyTurn,
  createKb,
  proposalTurn,
  reconcileFinalTurn,
} from "./helpers.js";

describe("Stage 1 — intake & classification (Phase 4)", () => {
  it("classifies into buckets with provenance offsets", async () => {
    const stack = buildTestStack();
    const kb = await createKb(stack);
    const raw =
      "Thornwick is a river town. The mayor might be someone named Venn? asdfkj 1234 garbage";
    stack.chat.push(
      classifyTurn({
        clear: ["Thornwick is a river town."],
        semi_clear: ["The mayor might be someone named Venn?"],
        unusable: ["asdfkj 1234 garbage"],
      }),
    );

    const job = await stack.pipeline.ingest(kb.id, {
      raw_text: raw,
      metadata: {},
      storage_ref: null,
    });
    await stack.pipeline.machine.advance(job.id); // received → classifying
    const after = await stack.pipeline.machine.advance(job.id); // classifying → classified

    expect(after.state).toBe("classified");
    const cls = after.stage_outputs.classification!;
    expect(cls.buckets.clear).toHaveLength(1);
    expect(cls.buckets.semi_clear).toHaveLength(1);
    expect(cls.buckets.unusable).toHaveLength(1);
    // provenance points back into the raw source
    const s = cls.buckets.clear[0]!;
    expect(raw.slice(s.provenance.start, s.provenance.end)).toBe(s.text);
    // ids are stable and unique
    const ids = [...cls.buckets.clear, ...cls.buckets.semi_clear, ...cls.buckets.unusable].map(
      (x) => x.id,
    );
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("short-circuits an exact duplicate import to completed (no LLM calls)", async () => {
    const stack = buildTestStack();
    const kb = await createKb(stack);
    const raw = "Thornwick is a river town.";

    // First import runs the whole pipeline (no actions proposed for brevity).
    stack.chat.push(classifyTurn({ clear: [raw] }));
    stack.chat.push(
      reconcileFinalTurn([
        {
          statement_id: "s1",
          statement_text: raw,
          status: "new",
          linked_document_ids: [],
          confidence: 0.9,
          rationale: "empty KB",
        },
      ]),
    );
    stack.chat.push(proposalTurn([]));
    const first = await stack.pipeline.ingest(kb.id, {
      raw_text: raw,
      metadata: {},
      storage_ref: null,
    });
    const firstDone = await stack.pipeline.machine.runToCompletion(first.id);
    expect(firstDone.state).toBe("completed");

    const callsBefore = stack.chat.calls.length;
    const second = await stack.pipeline.ingest(kb.id, {
      raw_text: raw,
      metadata: {},
      storage_ref: null,
    });
    const secondDone = await stack.pipeline.machine.runToCompletion(second.id);

    expect(secondDone.state).toBe("completed");
    expect(secondDone.stage_outputs.duplicate_of_job_id).toBe(first.id);
    expect(stack.chat.calls.length).toBe(callsBefore); // zero model calls
  });

  it("flags a near match (same normalized content) and continues processing", async () => {
    const stack = buildTestStack();
    const kb = await createKb(stack);
    const raw = "Thornwick is a river town.";
    stack.chat.push(classifyTurn({ clear: [raw] }));
    stack.chat.push(
      reconcileFinalTurn([
        {
          statement_id: "s1",
          statement_text: raw,
          status: "new",
          linked_document_ids: [],
          confidence: 0.9,
          rationale: "empty KB",
        },
      ]),
    );
    stack.chat.push(proposalTurn([]));
    const first = await stack.pipeline.ingest(kb.id, {
      raw_text: raw,
      metadata: {},
      storage_ref: null,
    });
    await stack.pipeline.machine.runToCompletion(first.id);

    // whitespace/punctuation variant → different raw hash, same normalized hash
    const variant = "thornwick   is a river town";
    const second = await stack.pipeline.ingest(kb.id, {
      raw_text: variant,
      metadata: {},
      storage_ref: null,
    });
    const afterReceived = await stack.pipeline.machine.advance(second.id);

    expect(afterReceived.state).toBe("classifying"); // continues, not short-circuited
    expect(afterReceived.stage_outputs.near_duplicate_of_job_id).toBe(first.id);
  });

  it("fails the job when nothing usable survives classification", async () => {
    const stack = buildTestStack();
    const kb = await createKb(stack);
    stack.chat.push(classifyTurn({ unusable: ["asdf"], input_quality: "low" }));
    const job = await stack.pipeline.ingest(kb.id, {
      raw_text: "asdf",
      metadata: {},
      storage_ref: null,
    });
    const done = await stack.pipeline.machine.runToCompletion(job.id);
    expect(done.state).toBe("failed");
    expect(done.error).toMatch(/no usable statements/);
  });
});
