import { describe, expect, it } from "vitest";
import {
  buildTestStack,
  classifyTurn,
  createKb,
  proposalTurn,
  reconcileFinalTurn,
  seedDocument,
} from "./helpers.js";

describe("Phase 6 — human review gate", () => {
  it("parks a conflicting ingestion, accepts human context, resumes and applies the guided edit", async () => {
    const stack = buildTestStack();
    const kb = await createKb(stack);
    const thornwickId = await seedDocument(
      stack,
      kb.id,
      "Thornwick",
      "Thornwick is a river town. The mayor of Thornwick is Aldra Venn.",
      "place",
    );

    const statement = "The mayor of Thornwick is Doran Hale.";
    stack.chat.push(classifyTurn({ clear: [statement] }));
    stack.chat.push(
      reconcileFinalTurn([
        {
          statement_id: "s1",
          statement_text: statement,
          status: "conflicts",
          linked_document_ids: [thornwickId],
          confidence: 0.8,
          rationale: "KB names Aldra Venn as mayor",
        },
      ]),
    );

    const job = await stack.pipeline.ingest(kb.id, {
      raw_text: statement,
      metadata: {},
      storage_ref: null,
    });
    const parked = await stack.pipeline.machine.runToCompletion(job.id);

    // 1) job parks; a conflict review item exists
    expect(parked.state).toBe("awaiting_review");
    const pending = await stack.pipeline.review.listPending(kb.id);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.kind).toBe("conflict");
    expect((pending[0]!.payload as { statement_text: string }).statement_text).toBe(statement);

    // 2) script the post-resume turns: the proposal follows the human guidance
    stack.chat.push({
      kind: "fn",
      fn: (args) => {
        const prompt = args.messages.map((m) => m.content).join("\n");
        if (!prompt.includes("Venn was deposed last month")) {
          throw new Error(
            "human review context must reach the proposing prompt via the scratchpad",
          );
        }
        return proposalTurn([
          {
            type: "update_section",
            payload: {
              document_id: thornwickId,
              section_key: "overview",
              body_markdown:
                "Thornwick is a river town. The mayor of Thornwick is Doran Hale (Aldra Venn was deposed).",
            },
            confidence: 0.95,
            reason: "human confirmed the new information supersedes the KB",
          },
        ]);
      },
    });

    // 3) human provides context → job resumes automatically
    const resolved = await stack.pipeline.review.provideContext(
      pending[0]!.id,
      "The new note is correct: Venn was deposed last month, Doran Hale is mayor now. Update the page.",
    );
    expect(resolved.status).toBe("resolved");

    const done = await stack.repos.ingestionJobs.getById(job.id);
    expect(done!.state).toBe("completed");
    // scratchpad carries the review context (locked decision #6)
    expect(done!.scratchpad.review_context[0]!.context).toMatch(/deposed/);

    // 4) the edit was applied through versioning (v1 seed → v2 update)
    const versions = await stack.repos.documentVersions.listByDocument(thornwickId);
    expect(versions).toHaveLength(2);
    expect(versions[1]!.body_markdown).toContain("Doran Hale");
    const actions = await stack.repos.proposedActions.listByJob(job.id);
    expect(actions[0]!.status).toBe("applied");
  });

  it("skip resolves the item and resumes with best-guess guidance in the scratchpad", async () => {
    const stack = buildTestStack();
    const kb = await createKb(stack);
    const docId = await seedDocument(stack, kb.id, "Thornwick", "A river town.", "place");

    stack.chat.push(classifyTurn({ semi_clear: ["Someone named Pike runs a tavern?"] }));
    stack.chat.push(
      reconcileFinalTurn([
        {
          statement_id: "s1",
          statement_text: "Someone named Pike runs a tavern?",
          status: "needs_review",
          linked_document_ids: [docId],
          confidence: 0.4,
          rationale: "ambiguous referent",
        },
      ]),
    );
    const job = await stack.pipeline.ingest(kb.id, {
      raw_text: "Someone named Pike runs a tavern?",
      metadata: {},
      storage_ref: null,
    });
    const parked = await stack.pipeline.machine.runToCompletion(job.id);
    expect(parked.state).toBe("awaiting_review");
    const [item] = await stack.pipeline.review.listForJob(job.id);

    stack.chat.push(proposalTurn([])); // model proposes nothing after the skip
    await stack.pipeline.review.skip(item!.id);

    const done = await stack.repos.ingestionJobs.getById(job.id);
    expect(done!.state).toBe("completed");
    expect(done!.scratchpad.review_context[0]!.context).toMatch(/skipped/i);
    expect((await stack.pipeline.review.listForJob(job.id))[0]!.status).toBe("skipped");
  });

  it("low-confidence proposals park for approval; rejection drops them, approval applies them", async () => {
    const stack = buildTestStack();
    const kb = await createKb(stack);
    const docId = await seedDocument(stack, kb.id, "Thornwick", "A river town.", "place");

    const statement = "Thornwick has a hidden smugglers' dock.";
    stack.chat.push(classifyTurn({ clear: [statement] }));
    stack.chat.push(
      reconcileFinalTurn([
        {
          statement_id: "s1",
          statement_text: statement,
          status: "new",
          linked_document_ids: [docId],
          confidence: 0.9,
          rationale: "new detail",
        },
      ]),
    );
    stack.chat.push(
      proposalTurn([
        {
          type: "append_section",
          payload: {
            document_id: docId,
            section: { key: "hooks", title: "Hooks", body_markdown: "A hidden smugglers' dock." },
          },
          confidence: 0.5, // below AUTO_APPLY_CONFIDENCE_THRESHOLD
          reason: "uncertain placement",
        },
      ]),
    );
    const job = await stack.pipeline.ingest(kb.id, {
      raw_text: statement,
      metadata: {},
      storage_ref: null,
    });
    const parked = await stack.pipeline.machine.runToCompletion(job.id);
    expect(parked.state).toBe("awaiting_review");

    const items = await stack.pipeline.review.listForJob(job.id);
    expect(items[0]!.kind).toBe("proposed_action");

    await stack.pipeline.review.decide(items[0]!.id, true, "looks right");
    const done = await stack.repos.ingestionJobs.getById(job.id);
    expect(done!.state).toBe("completed");

    const versions = await stack.repos.documentVersions.listByDocument(docId);
    expect(versions.at(-1)!.body_markdown).toContain("smugglers");
    const actions = await stack.repos.proposedActions.listByJob(job.id);
    expect(actions[0]!.status).toBe("applied");
  });
});
