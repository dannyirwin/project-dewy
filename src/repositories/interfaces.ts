import type {
  AuditLog,
  Chunk,
  Document,
  DocumentTag,
  DocumentVersion,
  IngestionJob,
  IngestionSource,
  JobState,
  KbConfig,
  KnowledgeBase,
  Link,
  LinkRelation,
  ProposedAction,
  ReviewItem,
  ScratchpadType,
  StageOutputs,
  Tag,
} from "./types.js";

/**
 * Repository-isolated data layer (locked decision #4): business logic never
 * imports the Supabase client. Implementations live in ./memory (tests, demos)
 * and ./supabase (production).
 */

export interface KnowledgeBaseRepository {
  create(input: {
    name: string;
    slug: string;
    config: KnowledgeBase["config"];
  }): Promise<KnowledgeBase>;
  getById(id: string): Promise<KnowledgeBase | null>;
  getBySlug(slug: string): Promise<KnowledgeBase | null>;
  list(): Promise<KnowledgeBase[]>;
  updateConfig(
    id: string,
    config: KnowledgeBase["config"],
    version: number,
  ): Promise<KnowledgeBase>;
}

export interface KbConfigRepository {
  create(input: Omit<KbConfig, "id" | "created_at">): Promise<KbConfig>;
  getByVersion(knowledgeBaseId: string, version: number): Promise<KbConfig | null>;
  getLatest(knowledgeBaseId: string): Promise<KbConfig | null>;
  list(knowledgeBaseId: string): Promise<KbConfig[]>;
}

export interface DocumentRepository {
  create(input: {
    knowledge_base_id: string;
    title: string;
    slug: string;
    template_id: string | null;
    status?: Document["status"];
    content_hash?: string | null;
  }): Promise<Document>;
  getById(id: string): Promise<Document | null>;
  getBySlug(knowledgeBaseId: string, slug: string): Promise<Document | null>;
  list(knowledgeBaseId: string): Promise<Document[]>;
  update(
    id: string,
    patch: Partial<
      Pick<Document, "title" | "status" | "current_version_id" | "content_hash" | "template_id">
    >,
  ): Promise<Document>;
  /** Keyword leg of hybrid retrieval over *current* version bodies. */
  keywordSearch(
    knowledgeBaseId: string,
    query: string,
    limit: number,
  ): Promise<Array<{ document_id: string; snippet: string; rank: number }>>;
}

export interface DocumentVersionRepository {
  create(input: Omit<DocumentVersion, "id" | "created_at">): Promise<DocumentVersion>;
  getById(id: string): Promise<DocumentVersion | null>;
  listByDocument(documentId: string): Promise<DocumentVersion[]>;
  latestVersionNumber(documentId: string): Promise<number>;
}

export interface LinkRepository {
  upsert(input: {
    knowledge_base_id: string;
    from_document_id: string;
    to_document_id: string;
    relation: LinkRelation;
    anchor?: string | null;
  }): Promise<{ link: Link; created: boolean }>;
  listFrom(documentId: string): Promise<Link[]>;
  listTo(documentId: string): Promise<Link[]>;
  listByKb(knowledgeBaseId: string): Promise<Link[]>;
  delete(id: string): Promise<void>;
}

export interface TagRepository {
  create(input: {
    knowledge_base_id: string;
    name: string;
    kind: Tag["kind"];
    parent_id?: string | null;
    description?: string | null;
  }): Promise<Tag>;
  getByName(knowledgeBaseId: string, name: string): Promise<Tag | null>;
  listByKb(knowledgeBaseId: string): Promise<Tag[]>;
}

export interface DocumentTagRepository {
  attach(input: Omit<DocumentTag, "created_at">): Promise<DocumentTag>;
  listByDocument(documentId: string): Promise<DocumentTag[]>;
  detach(documentId: string, tagId: string): Promise<void>;
}

export interface ChunkRepository {
  insertMany(chunks: Array<Omit<Chunk, "id" | "created_at">>): Promise<Chunk[]>;
  deleteByDocument(documentId: string): Promise<number>;
  listByDocument(documentId: string): Promise<Chunk[]>;
  /** Semantic leg of hybrid retrieval; only current-version chunks are matched. */
  similaritySearch(
    knowledgeBaseId: string,
    embedding: number[],
    limit: number,
  ): Promise<Array<{ chunk_id: string; document_id: string; text: string; similarity: number }>>;
}

export interface IngestionJobRepository {
  create(input: {
    knowledge_base_id: string;
    source: IngestionSource;
    source_hash: string;
  }): Promise<IngestionJob>;
  getById(id: string): Promise<IngestionJob | null>;
  listByKb(knowledgeBaseId: string): Promise<IngestionJob[]>;
  findBySourceHash(knowledgeBaseId: string, hash: string): Promise<IngestionJob[]>;
  update(
    id: string,
    patch: Partial<{
      state: JobState;
      stage_outputs: StageOutputs;
      scratchpad: ScratchpadType;
      error: string | null;
    }>,
  ): Promise<IngestionJob>;
}

export interface ReviewItemRepository {
  create(input: Omit<ReviewItem, "id" | "created_at" | "updated_at">): Promise<ReviewItem>;
  getById(id: string): Promise<ReviewItem | null>;
  listByJob(jobId: string): Promise<ReviewItem[]>;
  listPending(knowledgeBaseId: string): Promise<ReviewItem[]>;
  update(
    id: string,
    patch: Partial<Pick<ReviewItem, "status" | "resolution">>,
  ): Promise<ReviewItem>;
}

export interface AuditLogRepository {
  append(input: Omit<AuditLog, "id" | "created_at">): Promise<AuditLog>;
  listByJob(jobId: string): Promise<AuditLog[]>;
  listByEntity(entityType: string, entityId: string): Promise<AuditLog[]>;
}

export interface ProposedActionRepository {
  create(
    input: Omit<ProposedAction, "id" | "created_at" | "updated_at" | "applied_version_id"> & {
      applied_version_id?: string | null;
    },
  ): Promise<ProposedAction>;
  getById(id: string): Promise<ProposedAction | null>;
  listByJob(jobId: string, status?: ProposedAction["status"]): Promise<ProposedAction[]>;
  update(
    id: string,
    patch: Partial<Pick<ProposedAction, "status" | "applied_version_id">>,
  ): Promise<ProposedAction>;
}

export interface Repositories {
  knowledgeBases: KnowledgeBaseRepository;
  kbConfigs: KbConfigRepository;
  documents: DocumentRepository;
  documentVersions: DocumentVersionRepository;
  links: LinkRepository;
  tags: TagRepository;
  documentTags: DocumentTagRepository;
  chunks: ChunkRepository;
  ingestionJobs: IngestionJobRepository;
  reviewItems: ReviewItemRepository;
  auditLogs: AuditLogRepository;
  proposedActions: ProposedActionRepository;
}
