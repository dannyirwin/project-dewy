import { z } from "zod";
import {
  type ActionType,
  type KbConfigPayload,
  LinkRelationSchema,
  SectionContentSchema,
  type Template,
} from "../domain/schemas.js";
import { slugify } from "../domain/slug.js";
import type { EmbeddingProvider } from "../providers/interfaces.js";
import type { Repositories } from "../repositories/interfaces.js";
import type { SearchService } from "../retrieval/search.js";
import { extractSection, validateSections } from "../templates/index.js";
import type { VersioningService } from "../versioning/index.js";

/**
 * The action framework (locked decision #8, plan §8): every first-class
 * reviewable operation is `{ type, payloadSchema, validate, apply }`.
 * AI proposes payloads; this deterministic code disposes. Adding a new
 * capability = adding an entry to the registry.
 */

export interface ActionContext {
  repos: Repositories;
  versioning: VersioningService;
  search: SearchService;
  embeddings: EmbeddingProvider;
  knowledgeBaseId: string;
  kbConfig: KbConfigPayload;
  configVersion: number;
  jobId: string | null;
  actor: string;
  /** true when a human explicitly approved (lifts review-gated policies) */
  humanApproved: boolean;
}

export interface ValidationIssue {
  code: string;
  message: string;
  /** when true the action isn't invalid, it just must go through review */
  requiresReview?: boolean;
}

export interface ApplyResult {
  appliedVersionId: string | null;
  noop: boolean;
  detail: string;
}

export interface ActionDefinition<P> {
  type: ActionType;
  payloadSchema: z.ZodType<P>;
  validate(payload: P, ctx: ActionContext): Promise<ValidationIssue[]>;
  apply(payload: P, ctx: ActionContext): Promise<ApplyResult>;
}

function findTemplate(cfg: KbConfigPayload, id: string | null): Template {
  const t = cfg.templates.find((t) => t.id === (id ?? cfg.default_template_id));
  if (!t) throw new Error(`template "${id}" not found in KB config`);
  return t;
}

/** Near-duplicate guardrail threshold for proposed new documents (plan §8). */
export const NEAR_DUPLICATE_SIMILARITY = 0.93;

// ---------- payload schemas ----------
export const CreateDocumentPayload = z
  .object({
    title: z.string().min(1),
    template_id: z.string().min(1),
    sections: z.array(SectionContentSchema).min(1),
    tag_names: z.array(z.string()).default([]),
    link_to: z
      .array(z.object({ to_document_id: z.uuid(), relation: LinkRelationSchema }).strict())
      .default([]),
  })
  .strict();

export const AppendSectionPayload = z
  .object({
    document_id: z.uuid(),
    section: SectionContentSchema,
  })
  .strict();

export const UpdateSectionPayload = z
  .object({
    document_id: z.uuid(),
    section_key: z.string().min(1),
    body_markdown: z.string().min(1),
  })
  .strict();

export const UpsertLinkPayload = z
  .object({
    from_document_id: z.uuid(),
    to_document_id: z.uuid(),
    relation: LinkRelationSchema,
    anchor: z.string().nullable().default(null),
  })
  .strict();

export const CreateTagPayload = z
  .object({
    name: z.string().min(1),
    kind: z.enum(["category", "tag"]),
    parent_name: z.string().nullable().default(null),
    description: z.string().nullable().default(null),
  })
  .strict();

export const ApplyTagPayload = z
  .object({
    document_id: z.uuid(),
    tag_name: z.string().min(1),
    confidence: z.number().min(0).max(1).default(1),
  })
  .strict();

export const PromoteSubsectionPayload = z
  .object({
    source_document_id: z.uuid(),
    section_key: z.string().min(1),
    new_title: z.string().min(1),
    template_id: z.string().min(1),
  })
  .strict();

// ---------- actions ----------
const createDocument: ActionDefinition<z.infer<typeof CreateDocumentPayload>> = {
  type: "create_document",
  payloadSchema: CreateDocumentPayload,
  async validate(p, ctx) {
    const issues: ValidationIssue[] = [];
    let template: Template;
    try {
      template = findTemplate(ctx.kbConfig, p.template_id);
    } catch (e) {
      return [{ code: "unknown_template", message: (e as Error).message }];
    }
    const tv = validateSections(template, p.sections);
    if (!tv.ok) {
      if (tv.missingRequired.length)
        issues.push({
          code: "missing_required_sections",
          message: `missing required sections: ${tv.missingRequired.join(", ")}`,
        });
      if (tv.unknownSections.length)
        issues.push({
          code: "unknown_sections",
          message: `sections not in template "${template.id}": ${tv.unknownSections.join(", ")}`,
        });
    }
    // near-duplicate guardrail (dedup, plan §8) — vector similarity vs existing docs
    const body = p.sections.map((s) => s.body_markdown).join("\n\n");
    const { vectors } = await ctx.embeddings.embed([`${p.title}\n${body}`]);
    if (vectors[0]) {
      const similar = await ctx.repos.chunks.similaritySearch(ctx.knowledgeBaseId, vectors[0], 1);
      const top = similar[0];
      if (top && top.similarity >= NEAR_DUPLICATE_SIMILARITY) {
        issues.push({
          code: "near_duplicate",
          message: `proposed document is ${(top.similarity * 100).toFixed(0)}% similar to existing document ${top.document_id}`,
          requiresReview: true,
        });
      }
    }
    return issues;
  },
  async apply(p, ctx) {
    const slug = slugify(p.title);
    // idempotency: same slug already created (e.g. re-applied action) → no-op
    const existing = await ctx.repos.documents.getBySlug(ctx.knowledgeBaseId, slug);
    if (existing) {
      return {
        appliedVersionId: existing.current_version_id,
        noop: true,
        detail: `document "${slug}" already exists`,
      };
    }
    const doc = await ctx.repos.documents.create({
      knowledge_base_id: ctx.knowledgeBaseId,
      title: p.title,
      slug,
      template_id: p.template_id,
      status: "published",
    });
    const version = await ctx.versioning.createVersion({
      document: doc,
      sections: p.sections,
      reason: "create_document action",
      jobId: ctx.jobId,
      configVersion: ctx.configVersion,
      actor: ctx.actor,
    });
    for (const l of p.link_to) {
      await ctx.repos.links.upsert({
        knowledge_base_id: ctx.knowledgeBaseId,
        from_document_id: doc.id,
        to_document_id: l.to_document_id,
        relation: l.relation,
      });
    }
    for (const name of p.tag_names) {
      const tag = await ctx.repos.tags.getByName(ctx.knowledgeBaseId, name);
      if (tag)
        await ctx.repos.documentTags.attach({
          document_id: doc.id,
          tag_id: tag.id,
          confidence: null,
          source: "ai",
        });
    }
    return { appliedVersionId: version.id, noop: false, detail: `created document ${doc.id}` };
  },
};

const appendSection: ActionDefinition<z.infer<typeof AppendSectionPayload>> = {
  type: "append_section",
  payloadSchema: AppendSectionPayload,
  async validate(p, ctx) {
    const issues: ValidationIssue[] = [];
    const doc = await ctx.repos.documents.getById(p.document_id);
    if (!doc) return [{ code: "missing_document", message: `document ${p.document_id} not found` }];
    const template = findTemplate(ctx.kbConfig, doc.template_id);
    if (!template.sections.some((s) => s.key === p.section.key)) {
      issues.push({
        code: "unknown_sections",
        message: `section "${p.section.key}" not in template "${template.id}"`,
      });
    }
    return issues;
  },
  async apply(p, ctx) {
    const doc = await ctx.repos.documents.getById(p.document_id);
    if (!doc) throw new Error(`document ${p.document_id} not found`);
    const current = doc.current_version_id
      ? await ctx.repos.documentVersions.getById(doc.current_version_id)
      : null;
    const sections = current ? [...current.sections] : [];
    const existing = sections.find((s) => s.key === p.section.key);
    if (existing) {
      if (existing.body_markdown.includes(p.section.body_markdown.trim())) {
        // idempotency: re-applying the same append is a no-op
        return {
          appliedVersionId: doc.current_version_id,
          noop: true,
          detail: "content already present",
        };
      }
      existing.body_markdown = `${existing.body_markdown.trim()}\n\n${p.section.body_markdown.trim()}`;
    } else {
      sections.push(p.section);
    }
    const version = await ctx.versioning.createVersion({
      document: doc,
      sections,
      reason: `append_section "${p.section.key}"`,
      jobId: ctx.jobId,
      configVersion: ctx.configVersion,
      actor: ctx.actor,
    });
    return { appliedVersionId: version.id, noop: false, detail: `appended to ${p.section.key}` };
  },
};

const updateSection: ActionDefinition<z.infer<typeof UpdateSectionPayload>> = {
  type: "update_section",
  payloadSchema: UpdateSectionPayload,
  async validate(p, ctx) {
    const doc = await ctx.repos.documents.getById(p.document_id);
    if (!doc) return [{ code: "missing_document", message: `document ${p.document_id} not found` }];
    const template = findTemplate(ctx.kbConfig, doc.template_id);
    if (!template.sections.some((s) => s.key === p.section_key)) {
      return [
        {
          code: "unknown_sections",
          message: `section "${p.section_key}" not in template "${template.id}"`,
        },
      ];
    }
    return [];
  },
  async apply(p, ctx) {
    const doc = await ctx.repos.documents.getById(p.document_id);
    if (!doc) throw new Error(`document ${p.document_id} not found`);
    const current = doc.current_version_id
      ? await ctx.repos.documentVersions.getById(doc.current_version_id)
      : null;
    const sections = current ? [...current.sections] : [];
    const target = sections.find((s) => s.key === p.section_key);
    if (target && target.body_markdown === p.body_markdown) {
      return { appliedVersionId: doc.current_version_id, noop: true, detail: "no change" };
    }
    if (target) target.body_markdown = p.body_markdown;
    else {
      const template = findTemplate(ctx.kbConfig, doc.template_id);
      const def = template.sections.find((s) => s.key === p.section_key);
      sections.push({
        key: p.section_key,
        title: def?.title ?? p.section_key,
        body_markdown: p.body_markdown,
      });
    }
    const version = await ctx.versioning.createVersion({
      document: doc,
      sections,
      reason: `update_section "${p.section_key}"`,
      jobId: ctx.jobId,
      configVersion: ctx.configVersion,
      actor: ctx.actor,
    });
    return { appliedVersionId: version.id, noop: false, detail: `updated ${p.section_key}` };
  },
};

const upsertLink: ActionDefinition<z.infer<typeof UpsertLinkPayload>> = {
  type: "upsert_link",
  payloadSchema: UpsertLinkPayload,
  async validate(p, ctx) {
    // Link integrity (plan §8): both endpoints exist, no self-links, same KB.
    const issues: ValidationIssue[] = [];
    if (p.from_document_id === p.to_document_id)
      issues.push({ code: "self_link", message: "self-links are not allowed" });
    const [from, to] = await Promise.all([
      ctx.repos.documents.getById(p.from_document_id),
      ctx.repos.documents.getById(p.to_document_id),
    ]);
    if (!from)
      issues.push({
        code: "dangling_link",
        message: `from endpoint ${p.from_document_id} missing`,
      });
    if (!to)
      issues.push({ code: "dangling_link", message: `to endpoint ${p.to_document_id} missing` });
    if (from && from.knowledge_base_id !== ctx.knowledgeBaseId)
      issues.push({ code: "cross_kb_link", message: "from endpoint is in another KB" });
    if (to && to.knowledge_base_id !== ctx.knowledgeBaseId)
      issues.push({ code: "cross_kb_link", message: "to endpoint is in another KB" });
    return issues;
  },
  async apply(p, ctx) {
    const { created } = await ctx.repos.links.upsert({
      knowledge_base_id: ctx.knowledgeBaseId,
      from_document_id: p.from_document_id,
      to_document_id: p.to_document_id,
      relation: p.relation,
      anchor: p.anchor,
    });
    return {
      appliedVersionId: null,
      noop: !created,
      detail: created ? "link created" : "link existed",
    };
  },
};

const createTag: ActionDefinition<z.infer<typeof CreateTagPayload>> = {
  type: "create_tag",
  payloadSchema: CreateTagPayload,
  async validate(p, ctx) {
    const issues: ValidationIssue[] = [];
    const policy = ctx.kbConfig.tag_policy;
    if (!policy.allow_new_tags)
      issues.push({ code: "tag_policy", message: "KB policy forbids new tags" });
    // Structural taxonomy change (new category) gates to review (plan §6/§9).
    if (p.kind === "category" && policy.new_category_requires_review && !ctx.humanApproved) {
      issues.push({
        code: "taxonomy_change",
        message: "new categories require human review per KB tag policy",
        requiresReview: true,
      });
    }
    if (p.parent_name) {
      const parent = await ctx.repos.tags.getByName(ctx.knowledgeBaseId, p.parent_name);
      if (!parent)
        issues.push({
          code: "missing_parent_tag",
          message: `parent tag "${p.parent_name}" not found`,
        });
    }
    return issues;
  },
  async apply(p, ctx) {
    const existing = await ctx.repos.tags.getByName(ctx.knowledgeBaseId, p.name);
    if (existing) return { appliedVersionId: null, noop: true, detail: "tag existed" };
    const parent = p.parent_name
      ? await ctx.repos.tags.getByName(ctx.knowledgeBaseId, p.parent_name)
      : null;
    const tag = await ctx.repos.tags.create({
      knowledge_base_id: ctx.knowledgeBaseId,
      name: p.name,
      kind: p.kind,
      parent_id: parent?.id ?? null,
      description: p.description,
    });
    return { appliedVersionId: null, noop: false, detail: `created tag ${tag.id}` };
  },
};

const applyTag: ActionDefinition<z.infer<typeof ApplyTagPayload>> = {
  type: "apply_tag",
  payloadSchema: ApplyTagPayload,
  async validate(p, ctx) {
    const issues: ValidationIssue[] = [];
    const doc = await ctx.repos.documents.getById(p.document_id);
    if (!doc)
      issues.push({ code: "missing_document", message: `document ${p.document_id} not found` });
    const tag = await ctx.repos.tags.getByName(ctx.knowledgeBaseId, p.tag_name);
    if (!tag) issues.push({ code: "missing_tag", message: `tag "${p.tag_name}" not found` });
    if (doc) {
      const current = await ctx.repos.documentTags.listByDocument(p.document_id);
      if (current.length >= ctx.kbConfig.tag_policy.max_tags_per_document) {
        issues.push({
          code: "tag_policy",
          message: `document already has max ${ctx.kbConfig.tag_policy.max_tags_per_document} tags`,
        });
      }
    }
    return issues;
  },
  async apply(p, ctx) {
    const tag = await ctx.repos.tags.getByName(ctx.knowledgeBaseId, p.tag_name);
    if (!tag) throw new Error(`tag "${p.tag_name}" not found`);
    await ctx.repos.documentTags.attach({
      document_id: p.document_id,
      tag_id: tag.id,
      confidence: p.confidence,
      source: ctx.humanApproved ? "human" : "ai",
    });
    return { appliedVersionId: null, noop: false, detail: `tagged with ${p.tag_name}` };
  },
};

/**
 * Showcase action (locked decision #8): promote a subsection to its own
 * document, replace the original location with a link, create reciprocal
 * links — all one reviewable operation.
 */
const promoteSubsection: ActionDefinition<z.infer<typeof PromoteSubsectionPayload>> = {
  type: "promote_subsection",
  payloadSchema: PromoteSubsectionPayload,
  async validate(p, ctx) {
    const doc = await ctx.repos.documents.getById(p.source_document_id);
    if (!doc)
      return [{ code: "missing_document", message: `document ${p.source_document_id} not found` }];
    if (!doc.current_version_id)
      return [{ code: "empty_document", message: "source document has no content" }];
    const version = await ctx.repos.documentVersions.getById(doc.current_version_id);
    const { section } = extractSection(version?.sections ?? [], p.section_key);
    if (!section)
      return [
        {
          code: "missing_section",
          message: `section "${p.section_key}" not found on source document`,
        },
      ];
    try {
      findTemplate(ctx.kbConfig, p.template_id);
    } catch (e) {
      return [{ code: "unknown_template", message: (e as Error).message }];
    }
    const slug = slugify(p.new_title);
    const clash = await ctx.repos.documents.getBySlug(ctx.knowledgeBaseId, slug);
    if (clash)
      return [{ code: "slug_clash", message: `a document with slug "${slug}" already exists` }];
    return [];
  },
  async apply(p, ctx) {
    const source = await ctx.repos.documents.getById(p.source_document_id);
    if (!source?.current_version_id) throw new Error("source document missing or empty");
    const sourceVersion = await ctx.repos.documentVersions.getById(source.current_version_id);
    const { section, rest } = extractSection(sourceVersion?.sections ?? [], p.section_key);

    const slug = slugify(p.new_title);
    const already = await ctx.repos.documents.getBySlug(ctx.knowledgeBaseId, slug);
    if (already) {
      return {
        appliedVersionId: already.current_version_id,
        noop: true,
        detail: "already promoted",
      };
    }
    if (!section) throw new Error(`section "${p.section_key}" vanished between validate and apply`);

    // 1) create the new document from the subsection content
    const newDoc = await ctx.repos.documents.create({
      knowledge_base_id: ctx.knowledgeBaseId,
      title: p.new_title,
      slug,
      template_id: p.template_id,
      status: "published",
    });
    const newVersion = await ctx.versioning.createVersion({
      document: newDoc,
      sections: [{ key: "overview", title: "Overview", body_markdown: section.body_markdown }],
      reason: `promoted from "${source.title}" § ${section.title}`,
      jobId: ctx.jobId,
      configVersion: ctx.configVersion,
      actor: ctx.actor,
    });

    // 2) replace the original location with a link stub
    const stub = `See [[${p.new_title}]](doc:${newDoc.id}) — this topic now has its own page.`;
    const updatedSections = [
      ...rest.map((s) => (s.key === p.section_key ? s : s)),
      { key: section.key, title: section.title, body_markdown: stub },
    ].sort((a, b) => {
      const order = (sourceVersion?.sections ?? []).map((s) => s.key);
      return order.indexOf(a.key) - order.indexOf(b.key);
    });
    await ctx.versioning.createVersion({
      document: source,
      sections: updatedSections,
      reason: `subsection "${section.title}" promoted to its own page`,
      jobId: ctx.jobId,
      configVersion: ctx.configVersion,
      actor: ctx.actor,
    });

    // 3) reciprocal links
    await ctx.repos.links.upsert({
      knowledge_base_id: ctx.knowledgeBaseId,
      from_document_id: newDoc.id,
      to_document_id: source.id,
      relation: "promoted_from",
      anchor: section.key,
    });
    await ctx.repos.links.upsert({
      knowledge_base_id: ctx.knowledgeBaseId,
      from_document_id: source.id,
      to_document_id: newDoc.id,
      relation: "related",
      anchor: section.key,
    });

    return {
      appliedVersionId: newVersion.id,
      noop: false,
      detail: `promoted "${section.title}" to document ${newDoc.id} with reciprocal links`,
    };
  },
};

// ---------- registry ----------
// biome-ignore lint/suspicious/noExplicitAny: heterogeneous registry, payloads validated per-entry
export const actionRegistry: Record<ActionType, ActionDefinition<any>> = {
  create_document: createDocument,
  append_section: appendSection,
  update_section: updateSection,
  upsert_link: upsertLink,
  create_tag: createTag,
  apply_tag: applyTag,
  promote_subsection: promoteSubsection,
};

export interface ValidatedAction {
  type: ActionType;
  payload: unknown;
  issues: ValidationIssue[];
  valid: boolean;
  requiresReview: boolean;
}

/** Action validation guardrail (plan §8): Zod parse + per-action validate(). */
export async function validateAction(
  type: ActionType,
  rawPayload: unknown,
  ctx: ActionContext,
): Promise<ValidatedAction> {
  const def = actionRegistry[type];
  const parsed = def.payloadSchema.safeParse(rawPayload);
  if (!parsed.success) {
    return {
      type,
      payload: rawPayload,
      issues: [{ code: "invalid_payload", message: parsed.error.message }],
      valid: false,
      requiresReview: false,
    };
  }
  const issues = await def.validate(parsed.data, ctx);
  const hard = issues.filter((i) => !i.requiresReview);
  return {
    type,
    payload: parsed.data,
    issues,
    valid: hard.length === 0,
    requiresReview: issues.some((i) => i.requiresReview),
  };
}

export async function applyAction(
  type: ActionType,
  payload: unknown,
  ctx: ActionContext,
): Promise<ApplyResult> {
  const def = actionRegistry[type];
  return def.apply(def.payloadSchema.parse(payload), ctx);
}
