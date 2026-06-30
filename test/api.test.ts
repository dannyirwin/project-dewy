import { describe, expect, it } from "vitest";
import { createApp } from "../src/api/app.js";
import { JobRunner } from "../src/jobs/runner.js";
import { buildTestStack, classifyTurn, proposalTurn, reconcileFinalTurn } from "./helpers.js";

function buildApi() {
  const stack = buildTestStack();
  const runner = new JobRunner(stack.repos, stack.pipeline, 60_000);
  const app = createApp({ repos: stack.repos, pipeline: stack.pipeline, runner });
  return { stack, app };
}

describe("HTTP API (plan §11)", () => {
  it("healthz + generated OpenAPI document", async () => {
    const { app } = buildApi();
    const health = await app.request("/healthz");
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true });

    const doc = await app.request("/openapi.json");
    expect(doc.status).toBe(200);
    const spec = (await doc.json()) as { openapi: string; paths: Record<string, unknown> };
    expect(spec.openapi).toBe("3.1.0");
    for (const path of [
      "/knowledge-bases",
      "/knowledge-bases/{id}/ingestions",
      "/knowledge-bases/{id}/review-items",
      "/documents/{id}/rollback",
      "/knowledge-bases/{id}/search",
    ]) {
      expect(spec.paths[path], `missing ${path} in OpenAPI doc`).toBeDefined();
    }
  });

  it("end-to-end over HTTP: create KB → ingest → documents → search → versions", async () => {
    const { stack, app } = buildApi();

    // create KB
    const createRes = await app.request("/knowledge-bases", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Campaign", slug: "campaign" }),
    });
    expect(createRes.status).toBe(201);
    const kb = (await createRes.json()) as { id: string };

    // duplicate slug → 409
    const dup = await app.request("/knowledge-bases", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Campaign 2", slug: "campaign" }),
    });
    expect(dup.status).toBe(409);

    // script the model: classify → reconcile(new) → propose create_document → (gate passes deterministically? min_statements default 3) …
    // default rules need ≥3 statements; provide 3 and disable llm judgment via config update
    const cfgRes = await app.request(`/knowledge-bases/${kb.id}/config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...((await (await app.request(`/knowledge-bases/${kb.id}`)).json()) as { config: object })
          .config,
        page_eligibility_rules: {
          version: 1,
          min_statements: 1,
          min_total_words: 0,
          use_llm_judgment: false,
        },
      }),
    });
    expect(cfgRes.status).toBe(200);

    const note = "Thornwick is a river town ruled by Mayor Aldra Venn.";
    stack.chat.push(classifyTurn({ clear: [note] }));
    stack.chat.push(
      reconcileFinalTurn([
        {
          statement_id: "s1",
          statement_text: note,
          status: "new",
          linked_document_ids: [],
          confidence: 0.9,
          rationale: "empty KB",
        },
      ]),
    );
    stack.chat.push(
      proposalTurn([
        {
          type: "create_document",
          payload: {
            title: "Thornwick",
            template_id: "place",
            sections: [{ key: "overview", title: "Overview", body_markdown: note }],
            tag_names: [],
            link_to: [],
          },
        },
      ]),
    );

    // ingest with run:true → completes synchronously
    const ingestRes = await app.request(`/knowledge-bases/${kb.id}/ingestions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ raw_text: note }),
    });
    expect(ingestRes.status).toBe(201);
    const job = (await ingestRes.json()) as { id: string; state: string };
    expect(job.state).toBe("completed");

    // job is retrievable with its actions
    const jobRes = await app.request(`/ingestions/${job.id}`);
    expect(jobRes.status).toBe(200);
    const actionsRes = await app.request(`/ingestions/${job.id}/actions`);
    const actions = (await actionsRes.json()) as Array<{ type: string; status: string }>;
    expect(actions[0]).toMatchObject({ type: "create_document", status: "applied" });

    // documents listing + document fetch with current version
    const docsRes = await app.request(`/knowledge-bases/${kb.id}/documents`);
    const docs = (await docsRes.json()) as Array<{ id: string; title: string }>;
    expect(docs).toHaveLength(1);
    const docRes = await app.request(`/documents/${docs[0]!.id}`);
    const docBody = (await docRes.json()) as { current_version: { body_markdown: string } };
    expect(docBody.current_version.body_markdown).toContain("Aldra Venn");

    // hybrid search over HTTP
    const searchRes = await app.request(
      `/knowledge-bases/${kb.id}/search?q=${encodeURIComponent("who rules Thornwick")}`,
    );
    expect(searchRes.status).toBe(200);
    const hits = (await searchRes.json()) as Array<{ document_id: string; title: string }>;
    expect(hits[0]!.title).toBe("Thornwick");

    // version history endpoint
    const versionsRes = await app.request(`/documents/${docs[0]!.id}/versions`);
    expect(((await versionsRes.json()) as unknown[]).length).toBe(1);

    // validation error shape (defaultHook)
    const bad = await app.request(`/knowledge-bases/${kb.id}/ingestions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toMatch(/validation failed/);
  });

  it("MCP endpoint accepts initialize and lists read tools", async () => {
    const { app } = buildApi();
    const init = await app.request("/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "kms-test", version: "0.1.0" },
        },
      }),
    });
    expect(init.status).toBe(200);
    const initBody = (await init.json()) as { result?: { serverInfo?: { name: string } } };
    expect(initBody.result?.serverInfo?.name).toBe("kms");

    const tools = await app.request("/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      }),
    });
    expect(tools.status).toBe(200);
    const listed = (await tools.json()) as { result?: { tools?: Array<{ name: string }> } };
    const names = (listed.result?.tools ?? []).map((t) => t.name).sort();
    expect(names).toEqual([
      "get_document",
      "get_document_versions",
      "list_documents",
      "list_review_items",
      "list_tags",
      "search_kb",
    ]);
  });

  it("review endpoints drive the park/resume loop over HTTP", async () => {
    const { stack, app } = buildApi();
    const createRes = await app.request("/knowledge-bases", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "R", slug: "r" }),
    });
    const kb = (await createRes.json()) as { id: string };

    const note = "Unverifiable rumor about a dragon.";
    stack.chat.push(classifyTurn({ semi_clear: [note] }));
    stack.chat.push(
      reconcileFinalTurn([
        {
          statement_id: "s1",
          statement_text: note,
          status: "needs_review",
          linked_document_ids: [],
          confidence: 0.3,
          rationale: "no corroboration",
        },
      ]),
    );
    const ingestRes = await app.request(`/knowledge-bases/${kb.id}/ingestions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ raw_text: note }),
    });
    const job = (await ingestRes.json()) as { id: string; state: string };
    expect(job.state).toBe("awaiting_review");

    const itemsRes = await app.request(`/knowledge-bases/${kb.id}/review-items`);
    const items = (await itemsRes.json()) as Array<{ id: string; kind: string }>;
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe("ambiguous_fact");

    stack.chat.push(proposalTurn([])); // nothing to do after skip
    const skipRes = await app.request(`/review-items/${items[0]!.id}/skip`, { method: "POST" });
    expect(skipRes.status).toBe(200);

    const after = await app.request(`/ingestions/${job.id}`);
    expect(((await after.json()) as { state: string }).state).toBe("completed");

    // double-resolve → 400
    const again = await app.request(`/review-items/${items[0]!.id}/skip`, { method: "POST" });
    expect(again.status).toBe(400);
  });
});
