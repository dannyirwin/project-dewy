import { z } from "zod";
import {
  type KbConfigPayload,
  KbConfigPayloadSchema,
  type KnowledgeBase,
  type PageEligibilityRules,
  type TagPolicy,
  type Template,
} from "../domain/schemas.js";
import type { ChatProvider } from "../providers/interfaces.js";
import type { Repositories } from "../repositories/interfaces.js";
import { defaultTemplates } from "../templates/index.js";

/**
 * Per-KB config + rules engine (locked decision #8, plan §9).
 * Config is versioned: every change writes a kb_config row and is audited;
 * documents record the config_version that governed them.
 */

export function defaultKbConfig(overrides?: {
  page_eligibility_rules?: Partial<PageEligibilityRules>;
  tag_policy?: Partial<TagPolicy>;
  templates?: Template[];
  default_template_id?: string;
}): KbConfigPayload {
  return KbConfigPayloadSchema.parse({
    version: 1,
    page_eligibility_rules: {
      version: 1,
      min_statements: 2,
      min_total_words: 30,
      always_page_kinds: [],
      use_llm_judgment: true,
      judgment_guidance:
        "Prefer augmenting existing entries over creating new pages. Only grant a page to entities with independent significance.",
      ...(overrides?.page_eligibility_rules ?? {}),
    },
    tag_policy: { version: 1, ...(overrides?.tag_policy ?? {}) },
    templates: overrides?.templates ?? defaultTemplates,
    default_template_id: overrides?.default_template_id ?? "generic",
  });
}

const EligibilityJudgmentSchema = z
  .object({
    earns_own_page: z.boolean(),
    confidence: z.number().min(0).max(1),
    rationale: z.string(),
  })
  .strict();

export interface EligibilityInput {
  entityName: string;
  entityKind: string;
  statements: string[];
}

export interface EligibilityDecision {
  earnsOwnPage: boolean;
  gatePassed: boolean;
  llmConsulted: boolean;
  confidence: number;
  rationale: string;
}

export class KbConfigService {
  constructor(
    private repos: Repositories,
    private chat: ChatProvider,
  ) {}

  async createKnowledgeBase(input: {
    name: string;
    slug: string;
    config?: KbConfigPayload;
  }): Promise<KnowledgeBase> {
    const config = KbConfigPayloadSchema.parse(input.config ?? defaultKbConfig());
    const kb = await this.repos.knowledgeBases.create({
      name: input.name,
      slug: input.slug,
      config,
    });
    await this.repos.kbConfigs.create({
      knowledge_base_id: kb.id,
      version: 1,
      page_eligibility_rules: config.page_eligibility_rules,
      tag_policy: config.tag_policy,
      templates: config.templates,
      default_template_id: config.default_template_id,
    });
    await this.repos.auditLogs.append({
      knowledge_base_id: kb.id,
      ingestion_job_id: null,
      entity_type: "knowledge_base",
      entity_id: kb.id,
      action: "create",
      before: null,
      after: { name: kb.name, slug: kb.slug, config_version: 1 },
      reason: "knowledge base created",
      confidence: null,
      actor: "human",
    });
    return kb;
  }

  /** Config changes are themselves audited and versioned (plan §9). */
  async updateConfig(kbId: string, config: KbConfigPayload, actor: string): Promise<KnowledgeBase> {
    const parsed = KbConfigPayloadSchema.parse(config);
    const latest = await this.repos.kbConfigs.getLatest(kbId);
    const nextVersion = (latest?.version ?? 0) + 1;
    await this.repos.kbConfigs.create({
      knowledge_base_id: kbId,
      version: nextVersion,
      page_eligibility_rules: parsed.page_eligibility_rules,
      tag_policy: parsed.tag_policy,
      templates: parsed.templates,
      default_template_id: parsed.default_template_id,
    });
    const kb = await this.repos.knowledgeBases.updateConfig(kbId, parsed, nextVersion);
    await this.repos.auditLogs.append({
      knowledge_base_id: kbId,
      ingestion_job_id: null,
      entity_type: "knowledge_base",
      entity_id: kbId,
      action: "update_config",
      before: { config_version: latest?.version ?? 0 },
      after: { config_version: nextVersion },
      reason: "kb config updated",
      confidence: null,
      actor,
    });
    return kb;
  }

  /**
   * Page eligibility (plan §9): a deterministic gate, then an LLM judgment step
   * *gated by* that gate. The LLM never overrules a failed gate.
   */
  async evaluatePageEligibility(
    rules: PageEligibilityRules,
    input: EligibilityInput,
  ): Promise<EligibilityDecision> {
    if (rules.always_page_kinds.includes(input.entityKind)) {
      return {
        earnsOwnPage: true,
        gatePassed: true,
        llmConsulted: false,
        confidence: 1,
        rationale: `kind "${input.entityKind}" always earns a page per KB rules`,
      };
    }

    const totalWords = input.statements.join(" ").split(/\s+/).filter(Boolean).length;
    const gatePassed =
      input.statements.length >= rules.min_statements && totalWords >= rules.min_total_words;

    if (!gatePassed) {
      return {
        earnsOwnPage: false,
        gatePassed: false,
        llmConsulted: false,
        confidence: 1,
        rationale: `deterministic gate failed: ${input.statements.length} statements / ${totalWords} words (need ≥${rules.min_statements} / ≥${rules.min_total_words})`,
      };
    }

    if (!rules.use_llm_judgment) {
      return {
        earnsOwnPage: true,
        gatePassed: true,
        llmConsulted: false,
        confidence: 1,
        rationale: "deterministic gate passed; LLM judgment disabled for this KB",
      };
    }

    const result = await this.chat.complete({
      system:
        "You decide whether an entity earns its own wiki page in a knowledge base. " +
        `KB policy: ${rules.judgment_guidance || "(none)"} ` +
        "Respond as JSON: { earns_own_page, confidence, rationale }.",
      messages: [
        {
          role: "user",
          content: `Entity: ${input.entityName} (kind: ${input.entityKind})\nKnown statements:\n${input.statements.map((s) => `- ${s}`).join("\n")}`,
        },
      ],
      schema: EligibilityJudgmentSchema,
    });
    const judgment = result.parsed!;
    return {
      earnsOwnPage: judgment.earns_own_page,
      gatePassed: true,
      llmConsulted: true,
      confidence: judgment.confidence,
      rationale: judgment.rationale,
    };
  }
}
