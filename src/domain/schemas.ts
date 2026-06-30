import { z } from "zod";

/**
 * Zod is the single source of truth (locked decision #10).
 * - TS types are derived via z.infer — no hand-written duplicates.
 * - Migration column types in supabase/migrations mirror these schemas.
 * - jsonb payload schemas are strict and versioned (`version` literal field).
 */

// ---------- shared ----------
export const uuid = z.uuid();
export const timestamps = {
  created_at: z.string(),
  updated_at: z.string(),
};

// ---------- knowledge_base & kb_config ----------
export const TemplateSectionSchema = z
  .object({
    key: z.string().min(1),
    title: z.string().min(1),
    required: z.boolean().default(false),
    description: z.string().optional(),
  })
  .strict();

export const TemplateSchema = z
  .object({
    id: z.string().min(1), // stable template key, e.g. "place", "person"
    name: z.string().min(1),
    version: z.number().int().positive(),
    sections: z.array(TemplateSectionSchema).min(1),
  })
  .strict();
export type Template = z.infer<typeof TemplateSchema>;

export const PageEligibilityRulesSchema = z
  .object({
    version: z.literal(1),
    /** Deterministic gate — all thresholds must pass before the LLM judgment runs. */
    min_statements: z.number().int().min(0).default(1),
    min_total_words: z.number().int().min(0).default(0),
    /** Entity kinds that always earn a page regardless of thresholds. */
    always_page_kinds: z.array(z.string()).default([]),
    /** Whether the gated LLM judgment step runs after the deterministic gate passes. */
    use_llm_judgment: z.boolean().default(true),
    /** Free-text guidance handed to the LLM judgment (per-KB granularity policy). */
    judgment_guidance: z.string().default(""),
  })
  .strict();
export type PageEligibilityRules = z.infer<typeof PageEligibilityRulesSchema>;

export const TagPolicySchema = z
  .object({
    version: z.literal(1),
    allow_new_tags: z.boolean().default(true),
    /** Structural taxonomy changes (new categories / hierarchy edits) gate to review. */
    new_category_requires_review: z.boolean().default(true),
    max_tags_per_document: z.number().int().positive().default(12),
  })
  .strict();
export type TagPolicy = z.infer<typeof TagPolicySchema>;

export const KbConfigPayloadSchema = z
  .object({
    version: z.literal(1),
    page_eligibility_rules: PageEligibilityRulesSchema,
    tag_policy: TagPolicySchema,
    templates: z.array(TemplateSchema).min(1),
    /** Template id used when nothing better matches. */
    default_template_id: z.string().min(1),
  })
  .strict();
export type KbConfigPayload = z.infer<typeof KbConfigPayloadSchema>;

export const KnowledgeBaseSchema = z
  .object({
    id: uuid,
    name: z.string().min(1),
    slug: z.string().min(1),
    config: KbConfigPayloadSchema,
    config_version: z.number().int().positive(),
    ...timestamps,
  })
  .strict();
export type KnowledgeBase = z.infer<typeof KnowledgeBaseSchema>;

export const KbConfigSchema = z
  .object({
    id: uuid,
    knowledge_base_id: uuid,
    version: z.number().int().positive(),
    page_eligibility_rules: PageEligibilityRulesSchema,
    tag_policy: TagPolicySchema,
    templates: z.array(TemplateSchema),
    default_template_id: z.string().min(1),
    created_at: z.string(),
  })
  .strict();
export type KbConfig = z.infer<typeof KbConfigSchema>;

// ---------- document & versions ----------
export const DocumentStatusSchema = z.enum(["draft", "published"]);

export const DocumentSchema = z
  .object({
    id: uuid,
    knowledge_base_id: uuid,
    title: z.string().min(1),
    slug: z.string().min(1),
    current_version_id: uuid.nullable(),
    template_id: z.string().nullable(),
    status: DocumentStatusSchema,
    content_hash: z.string().nullable(),
    ...timestamps,
  })
  .strict();
export type Document = z.infer<typeof DocumentSchema>;

export const SectionContentSchema = z
  .object({
    key: z.string().min(1),
    title: z.string().min(1),
    body_markdown: z.string(),
  })
  .strict();
export type SectionContent = z.infer<typeof SectionContentSchema>;

export const DocumentVersionSchema = z
  .object({
    id: uuid,
    document_id: uuid,
    knowledge_base_id: uuid,
    version: z.number().int().positive(),
    body_markdown: z.string(),
    sections: z.array(SectionContentSchema),
    created_by_job_id: uuid.nullable(),
    reason: z.string(),
    config_version: z.number().int().positive().nullable(),
    created_at: z.string(),
  })
  .strict();
export type DocumentVersion = z.infer<typeof DocumentVersionSchema>;

// ---------- links & tags ----------
export const LinkRelationSchema = z.enum([
  "related",
  "mentions",
  "parent",
  "child",
  "promoted_from",
]);
export type LinkRelation = z.infer<typeof LinkRelationSchema>;

export const LinkSchema = z
  .object({
    id: uuid,
    knowledge_base_id: uuid,
    from_document_id: uuid,
    to_document_id: uuid,
    relation: LinkRelationSchema,
    anchor: z.string().nullable(),
    ...timestamps,
  })
  .strict();
export type Link = z.infer<typeof LinkSchema>;

export const TagKindSchema = z.enum(["category", "tag"]);

export const TagSchema = z
  .object({
    id: uuid,
    knowledge_base_id: uuid,
    name: z.string().min(1),
    kind: TagKindSchema,
    parent_id: uuid.nullable(),
    description: z.string().nullable(),
    ...timestamps,
  })
  .strict();
export type Tag = z.infer<typeof TagSchema>;

export const DocumentTagSchema = z
  .object({
    document_id: uuid,
    tag_id: uuid,
    confidence: z.number().min(0).max(1).nullable(),
    source: z.enum(["ai", "human"]),
    created_at: z.string(),
  })
  .strict();
export type DocumentTag = z.infer<typeof DocumentTagSchema>;

// ---------- chunks ----------
export const ChunkSchema = z
  .object({
    id: uuid,
    knowledge_base_id: uuid,
    document_id: uuid,
    document_version_id: uuid,
    chunk_index: z.number().int().min(0),
    text: z.string(),
    embedding: z.array(z.number()),
    embedding_model: z.string(),
    dimension: z.number().int().positive(),
    token_count: z.number().int().min(0),
    created_at: z.string(),
  })
  .strict();
export type Chunk = z.infer<typeof ChunkSchema>;

// ---------- pipeline: ingestion job ----------
export const JobStateSchema = z.enum([
  "received",
  "classifying",
  "classified",
  "reconciling",
  "reconciled",
  "awaiting_review",
  "proposing_edits",
  "applying_edits",
  "completed",
  "failed",
]);
export type JobState = z.infer<typeof JobStateSchema>;

export const StatementSchema = z
  .object({
    id: z.string().min(1), // stable within the job, e.g. "s1"
    text: z.string().min(1),
    provenance: z.object({ start: z.number().int().min(0), end: z.number().int().min(0) }).strict(),
  })
  .strict();
export type Statement = z.infer<typeof StatementSchema>;

export const ClassificationSchema = z
  .object({
    version: z.literal(1),
    input_quality: z.enum(["high", "medium", "low"]),
    buckets: z
      .object({
        clear: z.array(StatementSchema),
        semi_clear: z.array(StatementSchema),
        unusable: z.array(StatementSchema),
      })
      .strict(),
  })
  .strict();
export type Classification = z.infer<typeof ClassificationSchema>;

export const ReconciliationItemSchema = z
  .object({
    statement_id: z.string().min(1),
    statement_text: z.string().min(1),
    status: z.enum(["confirmed", "conflicts", "new", "needs_review"]),
    linked_document_ids: z.array(uuid),
    confidence: z.number().min(0).max(1),
    rationale: z.string(),
  })
  .strict();

export const ReconciliationReportSchema = z
  .object({
    version: z.literal(1),
    items: z.array(ReconciliationItemSchema),
  })
  .strict();
export type ReconciliationReport = z.infer<typeof ReconciliationReportSchema>;

export const ScratchpadSchema = z
  .object({
    version: z.literal(1),
    relevant_summaries: z
      .array(z.object({ document_id: uuid, title: z.string(), summary: z.string() }).strict())
      .default([]),
    entity_resolutions: z
      .array(
        z
          .object({
            mention: z.string(),
            document_id: uuid.nullable(),
            decision: z.string(),
            confidence: z.number().min(0).max(1),
          })
          .strict(),
      )
      .default([]),
    name_decisions: z
      .array(z.object({ original: z.string(), resolved: z.string(), reason: z.string() }).strict())
      .default([]),
    notes: z.array(z.string()).default([]),
    review_context: z
      .array(z.object({ review_item_id: uuid, context: z.string() }).strict())
      .default([]),
  })
  .strict();
export type Scratchpad = z.infer<typeof ScratchpadSchema>;

export const emptyScratchpad = (): Scratchpad => ScratchpadSchema.parse({ version: 1 });

export const StageOutputsSchema = z
  .object({
    classification: ClassificationSchema.optional(),
    reconciliation: ReconciliationReportSchema.optional(),
    near_duplicate_of_job_id: uuid.optional(),
    duplicate_of_job_id: uuid.optional(),
  })
  .strict();
export type StageOutputs = z.infer<typeof StageOutputsSchema>;

export const IngestionSourceSchema = z
  .object({
    raw_text: z.string().min(1),
    title_hint: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).default({}),
    storage_ref: z.string().nullable().default(null),
  })
  .strict();
export type IngestionSource = z.infer<typeof IngestionSourceSchema>;

export const IngestionJobSchema = z
  .object({
    id: uuid,
    knowledge_base_id: uuid,
    source: IngestionSourceSchema,
    source_hash: z.string(),
    state: JobStateSchema,
    stage_outputs: StageOutputsSchema,
    scratchpad: ScratchpadSchema,
    error: z.string().nullable(),
    ...timestamps,
  })
  .strict();
export type IngestionJob = z.infer<typeof IngestionJobSchema>;

// ---------- review ----------
export const ReviewKindSchema = z.enum([
  "ambiguous_fact",
  "conflict",
  "low_confidence",
  "needs_context",
  "taxonomy_change",
  "proposed_action",
]);

export const ReviewItemSchema = z
  .object({
    id: uuid,
    knowledge_base_id: uuid,
    ingestion_job_id: uuid,
    kind: ReviewKindSchema,
    payload: z.record(z.string(), z.unknown()),
    status: z.enum(["pending", "resolved", "skipped"]),
    resolution: z.record(z.string(), z.unknown()).nullable(),
    ...timestamps,
  })
  .strict();
export type ReviewItem = z.infer<typeof ReviewItemSchema>;

// ---------- audit ----------
export const AuditLogSchema = z
  .object({
    id: uuid,
    knowledge_base_id: uuid,
    ingestion_job_id: uuid.nullable(),
    entity_type: z.string().min(1),
    entity_id: z.string().min(1),
    action: z.string().min(1),
    before: z.record(z.string(), z.unknown()).nullable(),
    after: z.record(z.string(), z.unknown()).nullable(),
    reason: z.string(),
    confidence: z.number().min(0).max(1).nullable(),
    actor: z.string().min(1), // "pipeline:<stage>" | "human" | "system"
    created_at: z.string(),
  })
  .strict();
export type AuditLog = z.infer<typeof AuditLogSchema>;

// ---------- proposed actions ----------
export const ActionTypeSchema = z.enum([
  "create_document",
  "append_section",
  "update_section",
  "upsert_link",
  "create_tag",
  "apply_tag",
  "promote_subsection",
]);
export type ActionType = z.infer<typeof ActionTypeSchema>;

export const ProposedActionStatusSchema = z.enum(["proposed", "approved", "applied", "rejected"]);

export const ProposedActionSchema = z
  .object({
    id: uuid,
    knowledge_base_id: uuid,
    ingestion_job_id: uuid,
    type: ActionTypeSchema,
    payload: z.record(z.string(), z.unknown()),
    status: ProposedActionStatusSchema,
    confidence: z.number().min(0).max(1),
    reason: z.string(),
    applied_version_id: uuid.nullable(),
    ...timestamps,
  })
  .strict();
export type ProposedAction = z.infer<typeof ProposedActionSchema>;
