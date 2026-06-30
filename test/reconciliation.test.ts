import { describe, expect, it } from "vitest";
import { ThinLoopReconciliationEngine } from "../src/pipeline/reconciliation/thinLoop.js";
import { editDistance } from "../src/pipeline/reconciliation/tools.js";
import { buildTestStack, createKb, reconcileFinalTurn, seedDocument } from "./helpers.js";

describe("Stage 2 — thin-loop reconciliation (Phase 5)", () => {
  it("drives tools, surfaces a planted conflict, resolves a misspelled proper noun via checkName", async () => {
    const stack = buildTestStack();
    const kb = await createKb(stack);
    const thornwickId = await seedDocument(
      stack,
      kb.id,
      "Thornwick",
      "Thornwick is a river town. The mayor of Thornwick is Aldra Venn.",
      "place",
    );

    // Scripted model behavior: search → checkName("Thornwik") → final report.
    stack.chat.push({
      kind: "tool_calls",
      calls: [{ name: "searchKnowledge", arguments: { query: "mayor of Thornwick", limit: 5 } }],
    });
    stack.chat.push({
      kind: "tool_calls",
      calls: [{ name: "checkName", arguments: { name: "Thornwik" } }],
    });
    stack.chat.push({
      kind: "fn",
      fn: (args) => {
        // The tool outputs must have been fed back as tool messages.
        const toolMsgs = args.messages.filter((m) => m.role === "tool");
        if (toolMsgs.length < 2) throw new Error("expected two tool results in the transcript");
        if (!toolMsgs[1]!.content.includes("Thornwick"))
          throw new Error("checkName should have found the existing title");
        return reconcileFinalTurn(
          [
            {
              statement_id: "s1",
              statement_text: "The mayor of Thornwik is Doran Hale.",
              status: "conflicts",
              linked_document_ids: [thornwickId],
              confidence: 0.85,
              rationale: "KB says the mayor is Aldra Venn; input says Doran Hale.",
            },
          ],
          {
            name_decisions: [
              {
                original: "Thornwik",
                resolved: "Thornwick",
                reason: "edit distance 1 to existing title",
              },
            ],
          },
        );
      },
    });

    const engine = new ThinLoopReconciliationEngine(
      stack.chat,
      stack.repos,
      stack.pipeline.search,
      stack.cfg,
    );
    const classification = {
      version: 1 as const,
      input_quality: "high" as const,
      buckets: {
        clear: [
          {
            id: "s1",
            text: "The mayor of Thornwik is Doran Hale.",
            provenance: { start: 0, end: 36 },
          },
        ],
        semi_clear: [],
        unusable: [],
      },
    };
    const kbRow = (await stack.repos.knowledgeBases.getById(kb.id))!;
    const out = await engine.reconcile({
      kb: kbRow,
      jobId: "00000000-0000-4000-8000-000000000001",
      classification,
      scratchpad: {
        version: 1,
        relevant_summaries: [],
        entity_resolutions: [],
        name_decisions: [],
        notes: [],
        review_context: [],
      },
    });

    expect(out.report.items[0]!.status).toBe("conflicts");
    expect(out.report.items[0]!.linked_document_ids).toContain(thornwickId);
    expect(out.scratchpad.name_decisions[0]!.resolved).toBe("Thornwick");
    expect(out.stepsUsed).toBe(2); // two tool rounds
  });

  it("enforces the step budget and marks unaddressed statements needs_review", async () => {
    const stack = buildTestStack({ RECONCILIATION_STEP_BUDGET: "2" });
    const kb = await createKb(stack);
    await seedDocument(stack, kb.id, "Thornwick", "A river town.");

    // The model keeps calling tools forever…
    stack.chat.push({
      kind: "tool_calls",
      calls: [{ name: "searchKnowledge", arguments: { query: "a" } }],
    });
    stack.chat.push({
      kind: "tool_calls",
      calls: [{ name: "searchKnowledge", arguments: { query: "b" } }],
    });
    // …budget hits, the engine demands a final answer, model returns an empty report.
    stack.chat.push(reconcileFinalTurn([]));

    const engine = new ThinLoopReconciliationEngine(
      stack.chat,
      stack.repos,
      stack.pipeline.search,
      stack.cfg,
    );
    const kbRow = (await stack.repos.knowledgeBases.getById(kb.id))!;
    const out = await engine.reconcile({
      kb: kbRow,
      jobId: "00000000-0000-4000-8000-000000000002",
      classification: {
        version: 1,
        input_quality: "medium",
        buckets: {
          clear: [{ id: "s1", text: "Unverified claim.", provenance: { start: 0, end: 17 } }],
          semi_clear: [],
          unusable: [],
        },
      },
      scratchpad: {
        version: 1,
        relevant_summaries: [],
        entity_resolutions: [],
        name_decisions: [],
        notes: [],
        review_context: [],
      },
    });

    expect(out.stepsUsed).toBe(2); // budget respected
    expect(out.report.items).toHaveLength(1); // safety net filled the gap
    expect(out.report.items[0]!.status).toBe("needs_review");
    expect(out.report.items[0]!.rationale).toMatch(/not addressed/);
  });

  it("editDistance handles the fuzzy-name cases checkName relies on", () => {
    expect(editDistance("thornwik", "thornwick")).toBe(1);
    expect(editDistance("aldra ven", "aldra venn")).toBe(1);
    expect(editDistance("abc", "xyz")).toBe(3);
    expect(editDistance("", "abc")).toBe(3);
  });
});
