import { randomUUID } from "node:crypto";
import { emptyScratchpad } from "../../domain/schemas.js";
import type {
  AuditLogRepository,
  ChunkRepository,
  DocumentRepository,
  DocumentTagRepository,
  DocumentVersionRepository,
  IngestionJobRepository,
  KbConfigRepository,
  KnowledgeBaseRepository,
  LinkRepository,
  ProposedActionRepository,
  Repositories,
  ReviewItemRepository,
  TagRepository,
} from "../interfaces.js";
import type {
  AuditLog,
  Chunk,
  Document,
  DocumentTag,
  DocumentVersion,
  IngestionJob,
  KbConfig,
  KnowledgeBase,
  Link,
  ProposedAction,
  ReviewItem,
  Tag,
} from "../types.js";

/**
 * In-memory implementations. Used by unit/integration tests and the eval
 * harness; behaviorally equivalent to the Supabase implementations for
 * everything deterministic. Reads/writes deep-clone so callers can't mutate
 * stored state by reference.
 */

const now = () => new Date().toISOString();
const clone = <T>(v: T): T => structuredClone(v);

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function createInMemoryRepositories(): Repositories {
  const kbs = new Map<string, KnowledgeBase>();
  const kbConfigs = new Map<string, KbConfig>();
  const documents = new Map<string, Document>();
  const versions = new Map<string, DocumentVersion>();
  const links = new Map<string, Link>();
  const tags = new Map<string, Tag>();
  const documentTags: DocumentTag[] = [];
  const chunks = new Map<string, Chunk>();
  const jobs = new Map<string, IngestionJob>();
  const reviewItems = new Map<string, ReviewItem>();
  const audits: AuditLog[] = [];
  const proposedActions = new Map<string, ProposedAction>();

  const knowledgeBases: KnowledgeBaseRepository = {
    async create(input) {
      const kb: KnowledgeBase = {
        id: randomUUID(),
        name: input.name,
        slug: input.slug,
        config: clone(input.config),
        config_version: 1,
        created_at: now(),
        updated_at: now(),
      };
      kbs.set(kb.id, kb);
      return clone(kb);
    },
    async getById(id) {
      const kb = kbs.get(id);
      return kb ? clone(kb) : null;
    },
    async getBySlug(slug) {
      for (const kb of kbs.values()) if (kb.slug === slug) return clone(kb);
      return null;
    },
    async list() {
      return [...kbs.values()].map(clone);
    },
    async updateConfig(id, config, version) {
      const kb = kbs.get(id);
      if (!kb) throw new Error(`knowledge_base ${id} not found`);
      kb.config = clone(config);
      kb.config_version = version;
      kb.updated_at = now();
      return clone(kb);
    },
  };

  const kbConfigRepo: KbConfigRepository = {
    async create(input) {
      const row: KbConfig = { ...clone(input), id: randomUUID(), created_at: now() };
      kbConfigs.set(row.id, row);
      return clone(row);
    },
    async getByVersion(kbId, version) {
      for (const c of kbConfigs.values())
        if (c.knowledge_base_id === kbId && c.version === version) return clone(c);
      return null;
    },
    async getLatest(kbId) {
      const all = [...kbConfigs.values()].filter((c) => c.knowledge_base_id === kbId);
      if (all.length === 0) return null;
      all.sort((a, b) => b.version - a.version);
      return clone(all[0]!);
    },
    async list(kbId) {
      return [...kbConfigs.values()]
        .filter((c) => c.knowledge_base_id === kbId)
        .sort((a, b) => a.version - b.version)
        .map(clone);
    },
  };

  const documentRepo: DocumentRepository = {
    async create(input) {
      const existing = await documentRepo.getBySlug(input.knowledge_base_id, input.slug);
      if (existing) throw new Error(`document slug "${input.slug}" already exists in KB`);
      const doc: Document = {
        id: randomUUID(),
        knowledge_base_id: input.knowledge_base_id,
        title: input.title,
        slug: input.slug,
        current_version_id: null,
        template_id: input.template_id,
        status: input.status ?? "draft",
        content_hash: input.content_hash ?? null,
        created_at: now(),
        updated_at: now(),
      };
      documents.set(doc.id, doc);
      return clone(doc);
    },
    async getById(id) {
      const d = documents.get(id);
      return d ? clone(d) : null;
    },
    async getBySlug(kbId, slug) {
      for (const d of documents.values())
        if (d.knowledge_base_id === kbId && d.slug === slug) return clone(d);
      return null;
    },
    async list(kbId) {
      return [...documents.values()].filter((d) => d.knowledge_base_id === kbId).map(clone);
    },
    async update(id, patch) {
      const d = documents.get(id);
      if (!d) throw new Error(`document ${id} not found`);
      Object.assign(d, clone(patch), { updated_at: now() });
      return clone(d);
    },
    async keywordSearch(kbId, query, limit) {
      // Term-frequency scoring over current version bodies; exact-substring
      // boost so made-up proper nouns are found verbatim (Phase 3 acceptance).
      const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
      const results: Array<{ document_id: string; snippet: string; rank: number }> = [];
      for (const d of documents.values()) {
        if (d.knowledge_base_id !== kbId || !d.current_version_id) continue;
        const v = versions.get(d.current_version_id);
        if (!v) continue;
        const body = v.body_markdown;
        const lower = body.toLowerCase();
        let score = 0;
        let firstHit = -1;
        for (const t of terms) {
          let idx = lower.indexOf(t);
          while (idx !== -1) {
            score += 1;
            if (firstHit === -1) firstHit = idx;
            idx = lower.indexOf(t, idx + t.length);
          }
        }
        if (lower.includes(query.toLowerCase())) score += 5; // exact phrase boost
        if (score > 0) {
          const start = Math.max(0, firstHit - 60);
          results.push({
            document_id: d.id,
            snippet: body.slice(start, start + 200),
            rank: score,
          });
        }
      }
      results.sort((a, b) => b.rank - a.rank);
      return results.slice(0, limit);
    },
  };

  const documentVersionRepo: DocumentVersionRepository = {
    async create(input) {
      const row: DocumentVersion = { ...clone(input), id: randomUUID(), created_at: now() };
      versions.set(row.id, row);
      return clone(row);
    },
    async getById(id) {
      const v = versions.get(id);
      return v ? clone(v) : null;
    },
    async listByDocument(documentId) {
      return [...versions.values()]
        .filter((v) => v.document_id === documentId)
        .sort((a, b) => a.version - b.version)
        .map(clone);
    },
    async latestVersionNumber(documentId) {
      let max = 0;
      for (const v of versions.values())
        if (v.document_id === documentId && v.version > max) max = v.version;
      return max;
    },
  };

  const linkRepo: LinkRepository = {
    async upsert(input) {
      for (const l of links.values()) {
        if (
          l.from_document_id === input.from_document_id &&
          l.to_document_id === input.to_document_id &&
          l.relation === input.relation
        ) {
          return { link: clone(l), created: false };
        }
      }
      const link: Link = {
        id: randomUUID(),
        knowledge_base_id: input.knowledge_base_id,
        from_document_id: input.from_document_id,
        to_document_id: input.to_document_id,
        relation: input.relation,
        anchor: input.anchor ?? null,
        created_at: now(),
        updated_at: now(),
      };
      links.set(link.id, link);
      return { link: clone(link), created: true };
    },
    async listFrom(documentId) {
      return [...links.values()].filter((l) => l.from_document_id === documentId).map(clone);
    },
    async listTo(documentId) {
      return [...links.values()].filter((l) => l.to_document_id === documentId).map(clone);
    },
    async listByKb(kbId) {
      return [...links.values()].filter((l) => l.knowledge_base_id === kbId).map(clone);
    },
    async delete(id) {
      links.delete(id);
    },
  };

  const tagRepo: TagRepository = {
    async create(input) {
      const existing = await tagRepo.getByName(input.knowledge_base_id, input.name);
      if (existing) throw new Error(`tag "${input.name}" already exists in KB`);
      const tag: Tag = {
        id: randomUUID(),
        knowledge_base_id: input.knowledge_base_id,
        name: input.name,
        kind: input.kind,
        parent_id: input.parent_id ?? null,
        description: input.description ?? null,
        created_at: now(),
        updated_at: now(),
      };
      tags.set(tag.id, tag);
      return clone(tag);
    },
    async getByName(kbId, name) {
      for (const t of tags.values())
        if (t.knowledge_base_id === kbId && t.name.toLowerCase() === name.toLowerCase())
          return clone(t);
      return null;
    },
    async listByKb(kbId) {
      return [...tags.values()].filter((t) => t.knowledge_base_id === kbId).map(clone);
    },
  };

  const documentTagRepo: DocumentTagRepository = {
    async attach(input) {
      const existing = documentTags.find(
        (dt) => dt.document_id === input.document_id && dt.tag_id === input.tag_id,
      );
      if (existing) return clone(existing);
      const row: DocumentTag = { ...clone(input), created_at: now() };
      documentTags.push(row);
      return clone(row);
    },
    async listByDocument(documentId) {
      return documentTags.filter((dt) => dt.document_id === documentId).map(clone);
    },
    async detach(documentId, tagId) {
      const idx = documentTags.findIndex(
        (dt) => dt.document_id === documentId && dt.tag_id === tagId,
      );
      if (idx !== -1) documentTags.splice(idx, 1);
    },
  };

  const chunkRepo: ChunkRepository = {
    async insertMany(rows) {
      const created = rows.map((r) => ({ ...clone(r), id: randomUUID(), created_at: now() }));
      for (const c of created) chunks.set(c.id, c);
      return created.map(clone);
    },
    async deleteByDocument(documentId) {
      let n = 0;
      for (const [id, c] of chunks) {
        if (c.document_id === documentId) {
          chunks.delete(id);
          n++;
        }
      }
      return n;
    },
    async listByDocument(documentId) {
      return [...chunks.values()]
        .filter((c) => c.document_id === documentId)
        .sort((a, b) => a.chunk_index - b.chunk_index)
        .map(clone);
    },
    async similaritySearch(kbId, embedding, limit) {
      const scored: Array<{
        chunk_id: string;
        document_id: string;
        text: string;
        similarity: number;
      }> = [];
      for (const c of chunks.values()) {
        if (c.knowledge_base_id !== kbId) continue;
        const doc = documents.get(c.document_id);
        if (!doc || doc.current_version_id !== c.document_version_id) continue;
        scored.push({
          chunk_id: c.id,
          document_id: c.document_id,
          text: c.text,
          similarity: cosine(embedding, c.embedding),
        });
      }
      scored.sort((a, b) => b.similarity - a.similarity);
      return scored.slice(0, limit);
    },
  };

  const ingestionJobRepo: IngestionJobRepository = {
    async create(input) {
      const job: IngestionJob = {
        id: randomUUID(),
        knowledge_base_id: input.knowledge_base_id,
        source: clone(input.source),
        source_hash: input.source_hash,
        state: "received",
        stage_outputs: {},
        scratchpad: emptyScratchpad(),
        error: null,
        created_at: now(),
        updated_at: now(),
      };
      jobs.set(job.id, job);
      return clone(job);
    },
    async getById(id) {
      const j = jobs.get(id);
      return j ? clone(j) : null;
    },
    async listByKb(kbId) {
      return [...jobs.values()].filter((j) => j.knowledge_base_id === kbId).map(clone);
    },
    async findBySourceHash(kbId, hash) {
      return [...jobs.values()]
        .filter((j) => j.knowledge_base_id === kbId && j.source_hash === hash)
        .map(clone);
    },
    async update(id, patch) {
      const j = jobs.get(id);
      if (!j) throw new Error(`ingestion_job ${id} not found`);
      Object.assign(j, clone(patch), { updated_at: now() });
      return clone(j);
    },
  };

  const reviewItemRepo: ReviewItemRepository = {
    async create(input) {
      const row: ReviewItem = {
        ...clone(input),
        id: randomUUID(),
        created_at: now(),
        updated_at: now(),
      };
      reviewItems.set(row.id, row);
      return clone(row);
    },
    async getById(id) {
      const r = reviewItems.get(id);
      return r ? clone(r) : null;
    },
    async listByJob(jobId) {
      return [...reviewItems.values()].filter((r) => r.ingestion_job_id === jobId).map(clone);
    },
    async listPending(kbId) {
      return [...reviewItems.values()]
        .filter((r) => r.knowledge_base_id === kbId && r.status === "pending")
        .map(clone);
    },
    async update(id, patch) {
      const r = reviewItems.get(id);
      if (!r) throw new Error(`review_item ${id} not found`);
      Object.assign(r, clone(patch), { updated_at: now() });
      return clone(r);
    },
  };

  const auditLogRepo: AuditLogRepository = {
    async append(input) {
      const row: AuditLog = { ...clone(input), id: randomUUID(), created_at: now() };
      audits.push(row);
      return clone(row);
    },
    async listByJob(jobId) {
      return audits.filter((a) => a.ingestion_job_id === jobId).map(clone);
    },
    async listByEntity(entityType, entityId) {
      return audits
        .filter((a) => a.entity_type === entityType && a.entity_id === entityId)
        .map(clone);
    },
  };

  const proposedActionRepo: ProposedActionRepository = {
    async create(input) {
      const row: ProposedAction = {
        ...clone(input),
        applied_version_id: input.applied_version_id ?? null,
        id: randomUUID(),
        created_at: now(),
        updated_at: now(),
      };
      proposedActions.set(row.id, row);
      return clone(row);
    },
    async getById(id) {
      const a = proposedActions.get(id);
      return a ? clone(a) : null;
    },
    async listByJob(jobId, status) {
      return [...proposedActions.values()]
        .filter((a) => a.ingestion_job_id === jobId && (!status || a.status === status))
        .map(clone);
    },
    async update(id, patch) {
      const a = proposedActions.get(id);
      if (!a) throw new Error(`proposed_action ${id} not found`);
      Object.assign(a, clone(patch), { updated_at: now() });
      return clone(a);
    },
  };

  return {
    knowledgeBases,
    kbConfigs: kbConfigRepo,
    documents: documentRepo,
    documentVersions: documentVersionRepo,
    links: linkRepo,
    tags: tagRepo,
    documentTags: documentTagRepo,
    chunks: chunkRepo,
    ingestionJobs: ingestionJobRepo,
    reviewItems: reviewItemRepo,
    auditLogs: auditLogRepo,
    proposedActions: proposedActionRepo,
  };
}
