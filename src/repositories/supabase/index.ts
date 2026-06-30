import type { SupabaseClient } from "@supabase/supabase-js";
import { emptyScratchpad } from "../../domain/schemas.js";
import type { Repositories } from "../interfaces.js";

/**
 * Supabase implementations of the repository interfaces. Thin row mappers —
 * all invariants (link integrity, template validation, idempotency) live in
 * deterministic guardrail code, not here, so memory and supabase impls stay
 * behaviorally equivalent.
 *
 * NOTE: verified by typecheck + the shared repository contract test suite when
 * run against `supabase start` (see README → "Integration tests"). This
 * environment has no Docker, so live verification is a runbook step.
 */

// biome-ignore lint/suspicious/noExplicitAny: row payloads come back untyped from supabase-js
type Row = any;

function one<T = Row>(res: { data: T[] | T | null; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message);
  const d = Array.isArray(res.data) ? res.data[0] : res.data;
  if (d == null) throw new Error("expected a row, got none");
  return d as T;
}

function maybe<T = Row>(res: { data: T | null; error: { message: string } | null }): T | null {
  if (res.error) {
    // PGRST116 = no rows for .single(); treat as null
    if (/0 rows|PGRST116/i.test(res.error.message)) return null;
    throw new Error(res.error.message);
  }
  return res.data;
}

function many<T = Row>(res: { data: T[] | null; error: { message: string } | null }): T[] {
  if (res.error) throw new Error(res.error.message);
  return res.data ?? [];
}

export function createSupabaseRepositories(sb: SupabaseClient): Repositories {
  return {
    knowledgeBases: {
      async create(input) {
        return one(
          await sb
            .from("knowledge_base")
            .insert({ name: input.name, slug: input.slug, config: input.config, config_version: 1 })
            .select(),
        );
      },
      async getById(id) {
        return maybe(await sb.from("knowledge_base").select().eq("id", id).maybeSingle());
      },
      async getBySlug(slug) {
        return maybe(await sb.from("knowledge_base").select().eq("slug", slug).maybeSingle());
      },
      async list() {
        return many(await sb.from("knowledge_base").select());
      },
      async updateConfig(id, configPayload, version) {
        return one(
          await sb
            .from("knowledge_base")
            .update({
              config: configPayload,
              config_version: version,
              updated_at: new Date().toISOString(),
            })
            .eq("id", id)
            .select(),
        );
      },
    },

    kbConfigs: {
      async create(input) {
        return one(await sb.from("kb_config").insert(input).select());
      },
      async getByVersion(kbId, version) {
        return maybe(
          await sb
            .from("kb_config")
            .select()
            .eq("knowledge_base_id", kbId)
            .eq("version", version)
            .maybeSingle(),
        );
      },
      async getLatest(kbId) {
        const rows = many(
          await sb
            .from("kb_config")
            .select()
            .eq("knowledge_base_id", kbId)
            .order("version", { ascending: false })
            .limit(1),
        );
        return rows[0] ?? null;
      },
      async list(kbId) {
        return many(
          await sb.from("kb_config").select().eq("knowledge_base_id", kbId).order("version"),
        );
      },
    },

    documents: {
      async create(input) {
        return one(
          await sb
            .from("document")
            .insert({
              knowledge_base_id: input.knowledge_base_id,
              title: input.title,
              slug: input.slug,
              template_id: input.template_id,
              status: input.status ?? "draft",
              content_hash: input.content_hash ?? null,
            })
            .select(),
        );
      },
      async getById(id) {
        return maybe(await sb.from("document").select().eq("id", id).maybeSingle());
      },
      async getBySlug(kbId, slug) {
        return maybe(
          await sb
            .from("document")
            .select()
            .eq("knowledge_base_id", kbId)
            .eq("slug", slug)
            .maybeSingle(),
        );
      },
      async list(kbId) {
        return many(await sb.from("document").select().eq("knowledge_base_id", kbId));
      },
      async update(id, patch) {
        return one(
          await sb
            .from("document")
            .update({ ...patch, updated_at: new Date().toISOString() })
            .eq("id", id)
            .select(),
        );
      },
      async keywordSearch(kbId, query, limit) {
        const rows = many<Row>(
          await sb.rpc("keyword_search", { p_kb: kbId, p_query: query, p_count: limit }),
        );
        return rows.map((r: Row) => ({
          document_id: r.document_id,
          snippet: r.snippet ?? "",
          rank: r.rank ?? 0,
        }));
      },
    },

    documentVersions: {
      async create(input) {
        return one(await sb.from("document_version").insert(input).select());
      },
      async getById(id) {
        return maybe(await sb.from("document_version").select().eq("id", id).maybeSingle());
      },
      async listByDocument(documentId) {
        return many(
          await sb.from("document_version").select().eq("document_id", documentId).order("version"),
        );
      },
      async latestVersionNumber(documentId) {
        const rows = many<Row>(
          await sb
            .from("document_version")
            .select("version")
            .eq("document_id", documentId)
            .order("version", { ascending: false })
            .limit(1),
        );
        return rows[0]?.version ?? 0;
      },
    },

    links: {
      async upsert(input) {
        const existing = maybe<Row>(
          await sb
            .from("link")
            .select()
            .eq("from_document_id", input.from_document_id)
            .eq("to_document_id", input.to_document_id)
            .eq("relation", input.relation)
            .maybeSingle(),
        );
        if (existing) return { link: existing, created: false };
        const link = one(
          await sb
            .from("link")
            .insert({ ...input, anchor: input.anchor ?? null })
            .select(),
        );
        return { link, created: true };
      },
      async listFrom(documentId) {
        return many(await sb.from("link").select().eq("from_document_id", documentId));
      },
      async listTo(documentId) {
        return many(await sb.from("link").select().eq("to_document_id", documentId));
      },
      async listByKb(kbId) {
        return many(await sb.from("link").select().eq("knowledge_base_id", kbId));
      },
      async delete(id) {
        const { error } = await sb.from("link").delete().eq("id", id);
        if (error) throw new Error(error.message);
      },
    },

    tags: {
      async create(input) {
        return one(
          await sb
            .from("tag")
            .insert({
              knowledge_base_id: input.knowledge_base_id,
              name: input.name,
              kind: input.kind,
              parent_id: input.parent_id ?? null,
              description: input.description ?? null,
            })
            .select(),
        );
      },
      async getByName(kbId, name) {
        return maybe(
          await sb
            .from("tag")
            .select()
            .eq("knowledge_base_id", kbId)
            .ilike("name", name)
            .maybeSingle(),
        );
      },
      async listByKb(kbId) {
        return many(await sb.from("tag").select().eq("knowledge_base_id", kbId));
      },
    },

    documentTags: {
      async attach(input) {
        return one(
          await sb
            .from("document_tag")
            .upsert(input, { onConflict: "document_id,tag_id" })
            .select(),
        );
      },
      async listByDocument(documentId) {
        return many(await sb.from("document_tag").select().eq("document_id", documentId));
      },
      async detach(documentId, tagId) {
        const { error } = await sb
          .from("document_tag")
          .delete()
          .eq("document_id", documentId)
          .eq("tag_id", tagId);
        if (error) throw new Error(error.message);
      },
    },

    chunks: {
      async insertMany(rows) {
        if (rows.length === 0) return [];
        return many(await sb.from("chunk").insert(rows).select());
      },
      async deleteByDocument(documentId) {
        const { data, error } = await sb
          .from("chunk")
          .delete()
          .eq("document_id", documentId)
          .select("id");
        if (error) throw new Error(error.message);
        return data?.length ?? 0;
      },
      async listByDocument(documentId) {
        return many(
          await sb.from("chunk").select().eq("document_id", documentId).order("chunk_index"),
        );
      },
      async similaritySearch(kbId, embedding, limit) {
        const rows = many<Row>(
          await sb.rpc("match_chunks", { p_kb: kbId, p_embedding: embedding, p_count: limit }),
        );
        return rows.map((r: Row) => ({
          chunk_id: r.chunk_id,
          document_id: r.document_id,
          text: r.text,
          similarity: r.similarity,
        }));
      },
    },

    ingestionJobs: {
      async create(input) {
        return one(
          await sb
            .from("ingestion_job")
            .insert({
              knowledge_base_id: input.knowledge_base_id,
              source: input.source,
              source_hash: input.source_hash,
              state: "received",
              stage_outputs: {},
              scratchpad: emptyScratchpad(),
            })
            .select(),
        );
      },
      async getById(id) {
        return maybe(await sb.from("ingestion_job").select().eq("id", id).maybeSingle());
      },
      async listByKb(kbId) {
        return many(await sb.from("ingestion_job").select().eq("knowledge_base_id", kbId));
      },
      async findBySourceHash(kbId, hash) {
        return many(
          await sb
            .from("ingestion_job")
            .select()
            .eq("knowledge_base_id", kbId)
            .eq("source_hash", hash),
        );
      },
      async update(id, patch) {
        return one(
          await sb
            .from("ingestion_job")
            .update({ ...patch, updated_at: new Date().toISOString() })
            .eq("id", id)
            .select(),
        );
      },
    },

    reviewItems: {
      async create(input) {
        return one(await sb.from("review_item").insert(input).select());
      },
      async getById(id) {
        return maybe(await sb.from("review_item").select().eq("id", id).maybeSingle());
      },
      async listByJob(jobId) {
        return many(await sb.from("review_item").select().eq("ingestion_job_id", jobId));
      },
      async listPending(kbId) {
        return many(
          await sb
            .from("review_item")
            .select()
            .eq("knowledge_base_id", kbId)
            .eq("status", "pending"),
        );
      },
      async update(id, patch) {
        return one(
          await sb
            .from("review_item")
            .update({ ...patch, updated_at: new Date().toISOString() })
            .eq("id", id)
            .select(),
        );
      },
    },

    auditLogs: {
      async append(input) {
        return one(await sb.from("audit_log").insert(input).select());
      },
      async listByJob(jobId) {
        return many(await sb.from("audit_log").select().eq("ingestion_job_id", jobId));
      },
      async listByEntity(entityType, entityId) {
        return many(
          await sb
            .from("audit_log")
            .select()
            .eq("entity_type", entityType)
            .eq("entity_id", entityId),
        );
      },
    },

    proposedActions: {
      async create(input) {
        return one(await sb.from("proposed_action").insert(input).select());
      },
      async getById(id) {
        return maybe(await sb.from("proposed_action").select().eq("id", id).maybeSingle());
      },
      async listByJob(jobId, status) {
        let q = sb.from("proposed_action").select().eq("ingestion_job_id", jobId);
        if (status) q = q.eq("status", status);
        return many(await q);
      },
      async update(id, patch) {
        return one(
          await sb
            .from("proposed_action")
            .update({ ...patch, updated_at: new Date().toISOString() })
            .eq("id", id)
            .select(),
        );
      },
    },
  };
}
