import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
  DocumentSchema,
  DocumentVersionSchema,
  IngestionJobSchema,
  KbConfigPayloadSchema,
  KnowledgeBaseSchema,
  ProposedActionSchema,
  ReviewItemSchema,
} from "../domain/schemas.js";
import type { JobRunner } from "../jobs/runner.js";
import type { Pipeline } from "../pipeline/index.js";
import type { Repositories } from "../repositories/interfaces.js";

/**
 * HTTP layer (plan §11): Hono + @hono/zod-openapi. Every route is described by
 * Zod schemas (single source of truth), so /openapi.json is generated, not
 * hand-written. The app is a factory over injected deps — tests run it with
 * in-memory repositories via app.request().
 */

export interface ApiDeps {
  repos: Repositories;
  pipeline: Pipeline;
  runner: JobRunner;
}

const ErrorSchema = z.object({ error: z.string() }).openapi("Error");
const IdParam = z.object({ id: z.string().openapi({ param: { name: "id", in: "path" } }) });

const json = <T extends z.ZodType>(schema: T, description: string) => ({
  content: { "application/json": { schema } },
  description,
});

export function createApp(deps: ApiDeps) {
  const { repos, pipeline, runner } = deps;
  const app = new OpenAPIHono({
    defaultHook: (result, c) => {
      if (!result.success) {
        return c.json({ error: `validation failed: ${result.error.message}` }, 400);
      }
    },
  });

  // ---------- health ----------
  app.openapi(
    createRoute({
      method: "get",
      path: "/healthz",
      responses: { 200: json(z.object({ ok: z.boolean() }), "service is up") },
    }),
    (c) => c.json({ ok: true }, 200),
  );

  // ---------- knowledge bases ----------
  app.openapi(
    createRoute({
      method: "post",
      path: "/knowledge-bases",
      request: {
        body: {
          content: {
            "application/json": {
              schema: z.object({
                name: z.string().min(1),
                slug: z.string().min(1),
                config: KbConfigPayloadSchema.optional(),
              }),
            },
          },
        },
      },
      responses: {
        201: json(KnowledgeBaseSchema, "created"),
        409: json(ErrorSchema, "slug taken"),
      },
    }),
    async (c) => {
      const body = c.req.valid("json");
      const existing = await repos.knowledgeBases.getBySlug(body.slug);
      if (existing) return c.json({ error: `slug "${body.slug}" already exists` }, 409);
      const kb = await pipeline.kbService.createKnowledgeBase(body);
      return c.json(kb, 201);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/knowledge-bases",
      responses: { 200: json(z.array(KnowledgeBaseSchema), "all knowledge bases") },
    }),
    async (c) => c.json(await repos.knowledgeBases.list(), 200),
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/knowledge-bases/{id}",
      request: { params: IdParam },
      responses: {
        200: json(KnowledgeBaseSchema, "knowledge base"),
        404: json(ErrorSchema, "not found"),
      },
    }),
    async (c) => {
      const kb = await repos.knowledgeBases.getById(c.req.valid("param").id);
      if (!kb) return c.json({ error: "not found" }, 404);
      return c.json(kb, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "put",
      path: "/knowledge-bases/{id}/config",
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: KbConfigPayloadSchema } } },
      },
      responses: { 200: json(KnowledgeBaseSchema, "updated"), 404: json(ErrorSchema, "not found") },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const kb = await repos.knowledgeBases.getById(id);
      if (!kb) return c.json({ error: "not found" }, 404);
      const updated = await pipeline.kbService.updateConfig(id, c.req.valid("json"), "human");
      return c.json(updated, 200);
    },
  );

  // ---------- ingestion ----------
  app.openapi(
    createRoute({
      method: "post",
      path: "/knowledge-bases/{id}/ingestions",
      request: {
        params: IdParam,
        body: {
          content: {
            "application/json": {
              schema: z.object({
                raw_text: z.string().min(1),
                title_hint: z.string().optional(),
                metadata: z.record(z.string(), z.unknown()).optional(),
                /** advance the pipeline synchronously (useful in dev/tests) */
                run: z.boolean().default(true),
              }),
            },
          },
        },
      },
      responses: {
        201: json(IngestionJobSchema, "job created"),
        404: json(ErrorSchema, "kb not found"),
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const kb = await repos.knowledgeBases.getById(id);
      if (!kb) return c.json({ error: "knowledge base not found" }, 404);
      const body = c.req.valid("json");
      const job = await pipeline.ingest(id, {
        raw_text: body.raw_text,
        title_hint: body.title_hint,
        metadata: body.metadata ?? {},
        storage_ref: null,
      });
      const result = body.run ? await pipeline.machine.runToCompletion(job.id) : job;
      return c.json(result, 201);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/ingestions/{id}",
      request: { params: IdParam },
      responses: { 200: json(IngestionJobSchema, "job"), 404: json(ErrorSchema, "not found") },
    }),
    async (c) => {
      const job = await repos.ingestionJobs.getById(c.req.valid("param").id);
      if (!job) return c.json({ error: "not found" }, 404);
      return c.json(job, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/ingestions/{id}/advance",
      request: { params: IdParam },
      responses: {
        200: json(IngestionJobSchema, "job after one step"),
        404: json(ErrorSchema, "not found"),
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const job = await repos.ingestionJobs.getById(id);
      if (!job) return c.json({ error: "not found" }, 404);
      return c.json(await pipeline.machine.advance(id), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/ingestions/{id}/actions",
      request: { params: IdParam },
      responses: { 200: json(z.array(ProposedActionSchema), "proposed actions for the job") },
    }),
    async (c) => c.json(await repos.proposedActions.listByJob(c.req.valid("param").id), 200),
  );

  // ---------- review ----------
  app.openapi(
    createRoute({
      method: "get",
      path: "/knowledge-bases/{id}/review-items",
      request: { params: IdParam },
      responses: { 200: json(z.array(ReviewItemSchema), "pending review items") },
    }),
    async (c) => c.json(await pipeline.review.listPending(c.req.valid("param").id), 200),
  );

  const reviewBody = (schema: z.ZodType) => ({
    content: { "application/json": { schema } },
  });

  app.openapi(
    createRoute({
      method: "post",
      path: "/review-items/{id}/context",
      request: { params: IdParam, body: reviewBody(z.object({ context: z.string().min(1) })) },
      responses: {
        200: json(ReviewItemSchema, "resolved with context"),
        400: json(ErrorSchema, "bad state"),
      },
    }),
    async (c) => {
      try {
        const item = await pipeline.review.provideContext(
          c.req.valid("param").id,
          (c.req.valid("json") as { context: string }).context,
        );
        return c.json(item, 200);
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
      }
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/review-items/{id}/skip",
      request: { params: IdParam },
      responses: { 200: json(ReviewItemSchema, "skipped"), 400: json(ErrorSchema, "bad state") },
    }),
    async (c) => {
      try {
        return c.json(await pipeline.review.skip(c.req.valid("param").id), 200);
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
      }
    },
  );

  for (const decision of ["approve", "reject"] as const) {
    app.openapi(
      createRoute({
        method: "post",
        path: `/review-items/{id}/${decision}`,
        request: {
          params: IdParam,
          body: {
            content: { "application/json": { schema: z.object({ note: z.string().optional() }) } },
            required: false,
          },
        },
        responses: { 200: json(ReviewItemSchema, decision), 400: json(ErrorSchema, "bad state") },
      }),
      async (c) => {
        try {
          let note: string | undefined;
          try {
            note = ((await c.req.json()) as { note?: string }).note;
          } catch {
            note = undefined;
          }
          return c.json(
            await pipeline.review.decide(c.req.valid("param").id, decision === "approve", note),
            200,
          );
        } catch (err) {
          return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
        }
      },
    );
  }

  // ---------- documents ----------
  app.openapi(
    createRoute({
      method: "get",
      path: "/knowledge-bases/{id}/documents",
      request: { params: IdParam },
      responses: { 200: json(z.array(DocumentSchema), "documents in the KB") },
    }),
    async (c) => c.json(await repos.documents.list(c.req.valid("param").id), 200),
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/documents/{id}",
      request: { params: IdParam },
      responses: {
        200: json(
          z.object({ document: DocumentSchema, current_version: DocumentVersionSchema.nullable() }),
          "document with current version",
        ),
        404: json(ErrorSchema, "not found"),
      },
    }),
    async (c) => {
      const doc = await repos.documents.getById(c.req.valid("param").id);
      if (!doc) return c.json({ error: "not found" }, 404);
      const current = doc.current_version_id
        ? await repos.documentVersions.getById(doc.current_version_id)
        : null;
      return c.json({ document: doc, current_version: current }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/documents/{id}/versions",
      request: { params: IdParam },
      responses: { 200: json(z.array(DocumentVersionSchema), "full version history") },
    }),
    async (c) => c.json(await repos.documentVersions.listByDocument(c.req.valid("param").id), 200),
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/documents/{id}/rollback",
      request: {
        params: IdParam,
        body: reviewBody(
          z.object({
            to_version: z.number().int().positive(),
            reason: z.string().default("manual rollback"),
          }),
        ),
      },
      responses: {
        200: json(DocumentVersionSchema, "now-current version"),
        400: json(ErrorSchema, "failed"),
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const body = c.req.valid("json") as { to_version: number; reason: string };
      try {
        const version = await pipeline.versioning.rollback({
          documentId: id,
          toVersion: body.to_version,
          actor: "human",
          reason: body.reason,
        });
        return c.json(version, 200);
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
      }
    },
  );

  // ---------- search ----------
  app.openapi(
    createRoute({
      method: "get",
      path: "/knowledge-bases/{id}/search",
      request: {
        params: IdParam,
        query: z.object({
          q: z.string().min(1),
          limit: z.coerce.number().int().min(1).max(50).default(10),
        }),
      },
      responses: {
        200: json(
          z.array(
            z.object({
              document_id: z.string(),
              title: z.string(),
              score: z.number(),
              snippets: z.array(z.string()),
              sources: z.array(z.enum(["semantic", "keyword"])),
            }),
          ),
          "hybrid search hits",
        ),
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const { q, limit } = c.req.valid("query");
      const hits = await pipeline.search.search(id, q, limit);
      const docs = await Promise.all(hits.map((h) => repos.documents.getById(h.document_id)));
      return c.json(
        hits.map((h, i) => ({ ...h, title: docs[i]?.title ?? "(unknown)" })),
        200,
      );
    },
  );

  // ---------- runner control (dev convenience) ----------
  app.openapi(
    createRoute({
      method: "post",
      path: "/knowledge-bases/{id}/drain",
      request: { params: IdParam },
      responses: { 200: json(z.object({ ok: z.boolean() }), "all runnable jobs advanced") },
    }),
    async (c) => {
      await runner.drainKb(c.req.valid("param").id);
      return c.json({ ok: true }, 200);
    },
  );

  // ---------- OpenAPI document + docs UI ----------
  app.doc("/openapi.json", {
    openapi: "3.1.0",
    info: {
      title: "KMS — LLM-powered knowledge management system",
      version: "0.1.0",
      description:
        "Wiki-style knowledge base with an LLM ingestion pipeline: classify → reconcile → propose/apply, with human review gates, versioning, and hybrid retrieval.",
    },
  });

  app.get("/docs", (c) =>
    c.html(
      `<!doctype html><html><head><title>KMS API</title></head><body>
      <h1>KMS API</h1>
      <p>The OpenAPI document lives at <a href="/openapi.json">/openapi.json</a>.
      Point any OpenAPI viewer (Swagger UI, Scalar, Redoc) at it.</p>
      </body></html>`,
    ),
  );

  return app;
}
