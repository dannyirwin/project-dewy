import { describe, expect, it } from "vitest";
import { type ActionContext, applyAction, validateAction } from "../src/actions/index.js";
import {
  buildTestStack,
  createKb,
  eligibilityTurn,
  seedDocument,
  type TestStack,
} from "./helpers.js";

async function makeCtx(
  stack: TestStack,
  kbId: string,
  humanApproved = false,
): Promise<ActionContext> {
  const kb = (await stack.repos.knowledgeBases.getById(kbId))!;
  return {
    repos: stack.repos,
    versioning: stack.pipeline.versioning,
    search: stack.pipeline.search,
    embeddings: stack.embeddings,
    knowledgeBaseId: kb.id,
    kbConfig: kb.config,
    configVersion: kb.config_version,
    jobId: null,
    actor: "test",
    humanApproved,
  };
}

describe("Phase 7 — action framework", () => {
  it("create_document → version 1, audit trail, chunks generated", async () => {
    const stack = buildTestStack();
    const kb = await createKb(stack);
    const ctx = await makeCtx(stack, kb.id);

    const payload = {
      title: "The Gilded Anchor",
      template_id: "place",
      sections: [
        { key: "overview", title: "Overview", body_markdown: "A tavern run by Bosun Pike." },
      ],
      tag_names: [],
      link_to: [],
    };
    const validated = await validateAction("create_document", payload, ctx);
    expect(validated.valid).toBe(true);

    const result = await applyAction("create_document", payload, ctx);
    expect(result.noop).toBe(false);

    const doc = await stack.repos.documents.getBySlug(kb.id, "the-gilded-anchor");
    expect(doc).not.toBeNull();
    const versions = await stack.repos.documentVersions.listByDocument(doc!.id);
    expect(versions).toHaveLength(1);
    expect(versions[0]!.body_markdown).toContain("Bosun Pike");

    const audits = await stack.repos.auditLogs.listByEntity("document", doc!.id);
    expect(audits.some((a) => a.action === "create_version")).toBe(true);

    const chunks = await stack.repos.chunks.listByDocument(doc!.id);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0]!.embedding_model).toBe("fake-embedding-v1");
    expect(chunks[0]!.dimension).toBe(64); // recorded per chunk (locked decision #2)

    // idempotent re-apply → no-op, still one version
    const again = await applyAction("create_document", payload, ctx);
    expect(again.noop).toBe(true);
    expect(await stack.repos.documentVersions.listByDocument(doc!.id)).toHaveLength(1);
  });

  it("append_section bumps the version, regenerates chunks, and is idempotent on identical content", async () => {
    const stack = buildTestStack();
    const kb = await createKb(stack);
    const docId = await seedDocument(stack, kb.id, "Thornwick", "A river town.", "place");
    const ctx = await makeCtx(stack, kb.id);

    const payload = {
      document_id: docId,
      section: { key: "history", title: "History", body_markdown: "Founded by river traders." },
    };
    await applyAction("append_section", payload, ctx);
    let versions = await stack.repos.documentVersions.listByDocument(docId);
    expect(versions).toHaveLength(2);

    const chunks = await stack.repos.chunks.listByDocument(docId);
    expect(chunks.every((c) => c.document_version_id === versions[1]!.id)).toBe(true); // regen on new version

    const again = await applyAction("append_section", payload, ctx);
    expect(again.noop).toBe(true);
    versions = await stack.repos.documentVersions.listByDocument(docId);
    expect(versions).toHaveLength(2);
  });

  it("guardrails: template violations, self/dangling links, taxonomy gating", async () => {
    const stack = buildTestStack();
    const kb = await createKb(stack);
    const docId = await seedDocument(stack, kb.id, "Thornwick", "A river town.", "place");
    const ctx = await makeCtx(stack, kb.id);

    // unknown section key on the place template
    const badSection = await validateAction(
      "append_section",
      { document_id: docId, section: { key: "loot_table", title: "Loot", body_markdown: "x" } },
      ctx,
    );
    expect(badSection.valid).toBe(false);
    expect(badSection.issues[0]!.code).toBe("unknown_sections");

    // missing required section on create
    const missingRequired = await validateAction(
      "create_document",
      {
        title: "X",
        template_id: "place",
        sections: [{ key: "history", title: "History", body_markdown: "y" }],
        tag_names: [],
        link_to: [],
      },
      ctx,
    );
    expect(missingRequired.valid).toBe(false);
    expect(missingRequired.issues.some((i) => i.code === "missing_required_sections")).toBe(true);

    // self-link
    const selfLink = await validateAction(
      "upsert_link",
      { from_document_id: docId, to_document_id: docId, relation: "related", anchor: null },
      ctx,
    );
    expect(selfLink.valid).toBe(false);
    expect(selfLink.issues[0]!.code).toBe("self_link");

    // dangling link
    const dangling = await validateAction(
      "upsert_link",
      {
        from_document_id: docId,
        to_document_id: "00000000-0000-4000-8000-00000000dead",
        relation: "related",
        anchor: null,
      },
      ctx,
    );
    expect(dangling.valid).toBe(false);
    expect(dangling.issues[0]!.code).toBe("dangling_link");

    // new category requires review (tag policy) — but a human approval lifts it
    const taxonomy = await validateAction(
      "create_tag",
      { name: "Factions", kind: "category", parent_name: null, description: null },
      ctx,
    );
    expect(taxonomy.valid).toBe(true);
    expect(taxonomy.requiresReview).toBe(true);
    const approvedCtx = await makeCtx(stack, kb.id, true);
    const lifted = await validateAction(
      "create_tag",
      { name: "Factions", kind: "category", parent_name: null, description: null },
      approvedCtx,
    );
    expect(lifted.requiresReview).toBe(false);
  });

  it("promote_subsection: new doc, link stub in source, reciprocal links — the showcase action", async () => {
    const stack = buildTestStack();
    const kb = await createKb(stack);
    const sourceId = await seedDocument(stack, kb.id, "Thornwick", "A river town.", "place");
    const ctx = await makeCtx(stack, kb.id);

    // grow a subsection worth promoting
    await applyAction(
      "append_section",
      {
        document_id: sourceId,
        section: {
          key: "notable_locations",
          title: "Notable Locations",
          body_markdown:
            "The Gilded Anchor is the main tavern, run by Bosun Pike. Smugglers meet in its cellar.",
        },
      },
      ctx,
    );

    const payload = {
      source_document_id: sourceId,
      section_key: "notable_locations",
      new_title: "The Gilded Anchor",
      template_id: "place",
    };
    expect((await validateAction("promote_subsection", payload, ctx)).valid).toBe(true);
    const result = await applyAction("promote_subsection", payload, ctx);
    expect(result.noop).toBe(false);

    // new document exists with the promoted content
    const newDoc = await stack.repos.documents.getBySlug(kb.id, "the-gilded-anchor");
    expect(newDoc).not.toBeNull();
    const newBody = (await stack.repos.documentVersions.getById(newDoc!.current_version_id!))!
      .body_markdown;
    expect(newBody).toContain("Bosun Pike");

    // source now carries a link stub instead of the content
    const source = (await stack.repos.documents.getById(sourceId))!;
    const sourceBody = (await stack.repos.documentVersions.getById(source.current_version_id!))!
      .body_markdown;
    expect(sourceBody).toContain(`doc:${newDoc!.id}`);
    expect(sourceBody).not.toContain("Smugglers meet in its cellar");

    // reciprocal links both ways
    const fromNew = await stack.repos.links.listFrom(newDoc!.id);
    expect(
      fromNew.some((l) => l.relation === "promoted_from" && l.to_document_id === sourceId),
    ).toBe(true);
    const fromSource = await stack.repos.links.listFrom(sourceId);
    expect(
      fromSource.some((l) => l.relation === "related" && l.to_document_id === newDoc!.id),
    ).toBe(true);

    // idempotent re-apply
    const again = await applyAction("promote_subsection", payload, ctx);
    expect(again.noop).toBe(true);
  });

  it("rollback restores an old version, audits it, and regenerates chunks", async () => {
    const stack = buildTestStack();
    const kb = await createKb(stack);
    const docId = await seedDocument(stack, kb.id, "Thornwick", "A river town.", "place");
    const ctx = await makeCtx(stack, kb.id);
    await applyAction(
      "update_section",
      { document_id: docId, section_key: "overview", body_markdown: "A burned-down ruin." },
      ctx,
    );

    const restored = await stack.pipeline.versioning.rollback({
      documentId: docId,
      toVersion: 1,
      actor: "human",
      reason: "bad edit",
    });
    const doc = (await stack.repos.documents.getById(docId))!;
    expect(doc.current_version_id).toBe(restored.id);
    expect(restored.body_markdown).toContain("river town");

    const audits = await stack.repos.auditLogs.listByEntity("document", docId);
    expect(audits.some((a) => a.action === "rollback")).toBe(true);

    const chunks = await stack.repos.chunks.listByDocument(docId);
    expect(chunks.every((c) => c.document_version_id === restored.id)).toBe(true);
  });
});

describe("Phase 8 — KB rules drive page vs subsection (acceptance)", () => {
  const TAVERN_NOTE = "The Gilded Anchor is a tavern in Thornwick run by Bosun Pike.";

  async function runScenario(
    stack: TestStack,
    kbId: string,
    thornwickId: string,
    afterProposal: import("../src/providers/mock.js").ScriptedTurn[] = [],
  ) {
    const { classifyTurn, reconcileFinalTurn, proposalTurn } = await import("./helpers.js");
    stack.chat.push(classifyTurn({ clear: [TAVERN_NOTE] }));
    stack.chat.push(
      reconcileFinalTurn([
        {
          statement_id: "s1",
          statement_text: TAVERN_NOTE,
          status: "new",
          linked_document_ids: [thornwickId],
          confidence: 0.9,
          rationale: "new entity",
        },
      ]),
    );
    stack.chat.push(
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
                body_markdown: "A tavern in Thornwick run by Bosun Pike.",
              },
            ],
            tag_names: [],
            link_to: [{ to_document_id: thornwickId, relation: "related" }],
          },
          confidence: 0.95,
          reason: "new place entity",
          fallback_attach: { document_id: thornwickId, section_key: "notable_locations" },
        },
      ]),
    );
    for (const turn of afterProposal) stack.chat.push(turn);
    const job = await stack.pipeline.ingest(kbId, {
      raw_text: TAVERN_NOTE,
      metadata: {},
      storage_ref: null,
    });
    return stack.pipeline.machine.runToCompletion(job.id);
  }

  it("permissive config → the same input becomes a standalone page", async () => {
    const stack = buildTestStack();
    const kb = await createKb(stack, "Loose KB", {
      page_eligibility_rules: { min_statements: 1, min_total_words: 0, use_llm_judgment: true },
    });
    const thornwickId = await seedDocument(stack, kb.id, "Thornwick", "A river town.", "place");

    // eligibility is consulted AFTER the proposal turn (FIFO order matters)
    const done = await runScenario(stack, kb.id, thornwickId, [eligibilityTurn(true)]);
    expect(done.state).toBe("completed");
    expect(await stack.repos.documents.getBySlug(kb.id, "the-gilded-anchor")).not.toBeNull();
  });

  it("strict config → the same input is attached as a subsection instead", async () => {
    const stack = buildTestStack();
    const kb = await createKb(stack, "Strict KB", {
      page_eligibility_rules: { min_statements: 5, min_total_words: 200, use_llm_judgment: true },
    });
    const thornwickId = await seedDocument(stack, kb.id, "Thornwick", "A river town.", "place");
    // deterministic gate fails → LLM never consulted → demoted to fallback

    const done = await runScenario(stack, kb.id, thornwickId);
    expect(done.state).toBe("completed");
    expect(await stack.repos.documents.getBySlug(kb.id, "the-gilded-anchor")).toBeNull();

    const thornwick = (await stack.repos.documents.getById(thornwickId))!;
    const body = (await stack.repos.documentVersions.getById(thornwick.current_version_id!))!
      .body_markdown;
    expect(body).toContain("Notable Locations");
    expect(body).toContain("Bosun Pike");
  });
});
