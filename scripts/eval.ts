/**
 * Golden ingestion evals (plan §3): each scenario runs the FULL pipeline
 * (in-memory repos + scripted model turns + fake embeddings) and asserts the
 * expected outcome deterministically. Run: `pnpm eval`. Exits nonzero on any
 * failure so it can gate CI.
 *
 * These complement the unit/integration tests: the suite asserts mechanisms,
 * the evals assert end-to-end *behavioral contracts* of the pipeline. When a
 * live LM Studio model regresses on these flows, port the same scenarios to a
 * live harness by swapping buildTestStack for real providers.
 */
import {
  buildTestStack,
  classifyTurn,
  createKb,
  eligibilityTurn,
  proposalTurn,
  reconcileFinalTurn,
  seedDocument,
} from "../test/helpers.js";

interface Scenario {
  name: string;
  run(): Promise<void>;
}

function expect(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

const scenarios: Scenario[] = [
  {
    name: "exact re-import short-circuits as duplicate with zero model calls",
    async run() {
      const stack = buildTestStack();
      const kb = await createKb(stack, "Eval Dup KB");
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

      const calls = stack.chat.calls.length;
      const second = await stack.pipeline.ingest(kb.id, {
        raw_text: raw,
        metadata: {},
        storage_ref: null,
      });
      const done = await stack.pipeline.machine.runToCompletion(second.id);
      expect(done.state === "completed", `expected completed, got ${done.state}`);
      expect(
        done.stage_outputs.duplicate_of_job_id === first.id,
        "duplicate_of_job_id not recorded",
      );
      expect(stack.chat.calls.length === calls, "duplicate import must not call the model");
    },
  },
  {
    name: "conflict parks for review; human context steers the applied edit",
    async run() {
      const stack = buildTestStack();
      const kb = await createKb(stack, "Eval Conflict KB");
      const docId = await seedDocument(
        stack,
        kb.id,
        "Thornwick",
        "The mayor of Thornwick is Aldra Venn.",
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
            linked_document_ids: [docId],
            confidence: 0.8,
            rationale: "contradicts KB",
          },
        ]),
      );
      const job = await stack.pipeline.ingest(kb.id, {
        raw_text: statement,
        metadata: {},
        storage_ref: null,
      });
      const parked = await stack.pipeline.machine.runToCompletion(job.id);
      expect(parked.state === "awaiting_review", `expected awaiting_review, got ${parked.state}`);

      const [item] = await stack.pipeline.review.listPending(kb.id);
      expect(item !== undefined && item.kind === "conflict", "expected a conflict review item");

      stack.chat.push(
        proposalTurn([
          {
            type: "update_section",
            payload: {
              document_id: docId,
              section_key: "overview",
              body_markdown: "The mayor of Thornwick is Doran Hale.",
            },
            confidence: 0.95,
          },
        ]),
      );
      await stack.pipeline.review.provideContext(item!.id, "Hale deposed Venn; the new note wins.");
      const done = await stack.repos.ingestionJobs.getById(job.id);
      expect(done!.state === "completed", `expected completed, got ${done!.state}`);
      const doc = (await stack.repos.documents.getById(docId))!;
      const body = (await stack.repos.documentVersions.getById(doc.current_version_id!))!
        .body_markdown;
      expect(body.includes("Doran Hale"), "edit guided by human context was not applied");
      const versions = await stack.repos.documentVersions.listByDocument(docId);
      expect(versions.length === 2, "expected versioned edit (v1 → v2)");
    },
  },
  {
    name: "page-eligibility config flips the same input between page and subsection",
    async run() {
      const note = "The Gilded Anchor is a tavern in Thornwick run by Bosun Pike.";
      const proposal = (thornwickId: string) =>
        proposalTurn([
          {
            type: "create_document",
            payload: {
              title: "The Gilded Anchor",
              template_id: "place",
              sections: [
                {
                  key: "overview",
                  title: "Overview",
                  body_markdown: "A tavern run by Bosun Pike.",
                },
              ],
              tag_names: [],
              link_to: [],
            },
            confidence: 0.95,
            fallback_attach: { document_id: thornwickId, section_key: "notable_locations" },
          },
        ]);

      // permissive KB → page
      const loose = buildTestStack();
      const looseKb = await createKb(loose, "Eval Loose KB", {
        page_eligibility_rules: { min_statements: 1, min_total_words: 0, use_llm_judgment: true },
      });
      const looseThornwick = await seedDocument(
        loose,
        looseKb.id,
        "Thornwick",
        "A river town.",
        "place",
      );
      loose.chat.push(classifyTurn({ clear: [note] }));
      loose.chat.push(
        reconcileFinalTurn([
          {
            statement_id: "s1",
            statement_text: note,
            status: "new",
            linked_document_ids: [looseThornwick],
            confidence: 0.9,
            rationale: "new entity",
          },
        ]),
      );
      loose.chat.push(proposal(looseThornwick));
      loose.chat.push(eligibilityTurn(true));
      const looseJob = await loose.pipeline.ingest(looseKb.id, {
        raw_text: note,
        metadata: {},
        storage_ref: null,
      });
      const looseDone = await loose.pipeline.machine.runToCompletion(looseJob.id);
      expect(looseDone.state === "completed", `loose: expected completed, got ${looseDone.state}`);
      expect(
        (await loose.repos.documents.getBySlug(looseKb.id, "the-gilded-anchor")) !== null,
        "loose config should produce a standalone page",
      );

      // strict KB → subsection on Thornwick
      const strict = buildTestStack();
      const strictKb = await createKb(strict, "Eval Strict KB", {
        page_eligibility_rules: { min_statements: 5, min_total_words: 200, use_llm_judgment: true },
      });
      const strictThornwick = await seedDocument(
        strict,
        strictKb.id,
        "Thornwick",
        "A river town.",
        "place",
      );
      strict.chat.push(classifyTurn({ clear: [note] }));
      strict.chat.push(
        reconcileFinalTurn([
          {
            statement_id: "s1",
            statement_text: note,
            status: "new",
            linked_document_ids: [strictThornwick],
            confidence: 0.9,
            rationale: "new entity",
          },
        ]),
      );
      strict.chat.push(proposal(strictThornwick));
      const strictJob = await strict.pipeline.ingest(strictKb.id, {
        raw_text: note,
        metadata: {},
        storage_ref: null,
      });
      const strictDone = await strict.pipeline.machine.runToCompletion(strictJob.id);
      expect(
        strictDone.state === "completed",
        `strict: expected completed, got ${strictDone.state}`,
      );
      expect(
        (await strict.repos.documents.getBySlug(strictKb.id, "the-gilded-anchor")) === null,
        "strict config must not create a page",
      );
      const thornwick = (await strict.repos.documents.getById(strictThornwick))!;
      const body = (await strict.repos.documentVersions.getById(thornwick.current_version_id!))!
        .body_markdown;
      expect(
        body.includes("Notable Locations") && body.includes("Bosun Pike"),
        "strict config should attach the content as a subsection",
      );
    },
  },
  {
    name: "low-confidence proposal requires approval before applying",
    async run() {
      const stack = buildTestStack();
      const kb = await createKb(stack, "Eval Approval KB");
      const docId = await seedDocument(stack, kb.id, "Thornwick", "A river town.", "place");
      const note = "Thornwick has a hidden smugglers' dock.";
      stack.chat.push(classifyTurn({ clear: [note] }));
      stack.chat.push(
        reconcileFinalTurn([
          {
            statement_id: "s1",
            statement_text: note,
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
            confidence: 0.4,
          },
        ]),
      );
      const job = await stack.pipeline.ingest(kb.id, {
        raw_text: note,
        metadata: {},
        storage_ref: null,
      });
      const parked = await stack.pipeline.machine.runToCompletion(job.id);
      expect(parked.state === "awaiting_review", `expected awaiting_review, got ${parked.state}`);
      const versionsBefore = await stack.repos.documentVersions.listByDocument(docId);
      expect(versionsBefore.length === 1, "nothing may be applied before approval");

      const [item] = await stack.pipeline.review.listForJob(job.id);
      await stack.pipeline.review.decide(item!.id, true, "approved");
      const done = await stack.repos.ingestionJobs.getById(job.id);
      expect(done!.state === "completed", `expected completed, got ${done!.state}`);
      const versionsAfter = await stack.repos.documentVersions.listByDocument(docId);
      expect(versionsAfter.length === 2, "approved action must be applied");
    },
  },
];

let failed = 0;
for (const scenario of scenarios) {
  try {
    await scenario.run();
    console.log(`PASS  ${scenario.name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL  ${scenario.name}`);
    console.error(`      ${err instanceof Error ? err.message : String(err)}`);
  }
}
console.log(`\n${scenarios.length - failed}/${scenarios.length} eval scenarios passed`);
if (failed > 0) process.exit(1);
