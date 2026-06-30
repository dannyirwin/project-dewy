import { loadConfig } from "../src/config/index.js";
import type { KbConfigPayload, ReconciliationReport } from "../src/domain/schemas.js";
import { defaultKbConfig } from "../src/kb/index.js";
import { buildPipeline, type Pipeline } from "../src/pipeline/index.js";
import {
  FakeEmbeddingProvider,
  MockChatProvider,
  type ScriptedTurn,
} from "../src/providers/mock.js";
import type { Repositories } from "../src/repositories/interfaces.js";
import { createInMemoryRepositories } from "../src/repositories/memory/index.js";

export interface TestStack {
  repos: Repositories;
  chat: MockChatProvider;
  embeddings: FakeEmbeddingProvider;
  pipeline: Pipeline;
  cfg: ReturnType<typeof loadConfig>;
}

export function buildTestStack(env: Record<string, string> = {}): TestStack {
  const cfg = loadConfig({ ...env });
  const repos = createInMemoryRepositories();
  const chat = new MockChatProvider();
  const embeddings = new FakeEmbeddingProvider();
  const pipeline = buildPipeline({ repos, chat, embeddings, cfg });
  return { repos, chat, embeddings, pipeline, cfg };
}

export async function createKb(
  stack: TestStack,
  name = "Test KB",
  overrides?: Parameters<typeof defaultKbConfig>[0],
): Promise<{ id: string; config: KbConfigPayload }> {
  const kb = await stack.pipeline.kbService.createKnowledgeBase({
    name,
    slug: name.toLowerCase().replace(/\s+/g, "-"),
    config: defaultKbConfig(overrides),
  });
  return { id: kb.id, config: kb.config };
}

/** Seed a document directly through the action framework path (versioned + chunked). */
export async function seedDocument(
  stack: TestStack,
  kbId: string,
  title: string,
  overview: string,
  templateId = "generic",
): Promise<string> {
  const kb = await stack.repos.knowledgeBases.getById(kbId);
  if (!kb) throw new Error("kb missing");
  const doc = await stack.repos.documents.create({
    knowledge_base_id: kbId,
    title,
    slug: title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, ""),
    template_id: templateId,
    status: "published",
  });
  await stack.pipeline.versioning.createVersion({
    document: doc,
    sections: [{ key: "overview", title: "Overview", body_markdown: overview }],
    reason: "test seed",
    jobId: null,
    configVersion: kb.config_version,
    actor: "system",
  });
  return doc.id;
}

// ---------- scripted turn factories ----------

export function classifyTurn(buckets: {
  clear?: string[];
  semi_clear?: string[];
  unusable?: string[];
  input_quality?: "high" | "medium" | "low";
}): ScriptedTurn {
  return {
    kind: "parsed",
    value: {
      input_quality: buckets.input_quality ?? "high",
      clear: buckets.clear ?? [],
      semi_clear: buckets.semi_clear ?? [],
      unusable: buckets.unusable ?? [],
    },
  };
}

export function reconcileFinalTurn(
  items: ReconciliationReport["items"],
  scratchpadAdditions: Partial<{
    relevant_summaries: Array<{ document_id: string; title: string; summary: string }>;
    entity_resolutions: Array<{
      mention: string;
      document_id: string | null;
      decision: string;
      confidence: number;
    }>;
    name_decisions: Array<{ original: string; resolved: string; reason: string }>;
    notes: string[];
  }> = {},
): ScriptedTurn {
  return {
    kind: "parsed",
    value: {
      report: { version: 1, items },
      scratchpad_additions: {
        relevant_summaries: scratchpadAdditions.relevant_summaries ?? [],
        entity_resolutions: scratchpadAdditions.entity_resolutions ?? [],
        name_decisions: scratchpadAdditions.name_decisions ?? [],
        notes: scratchpadAdditions.notes ?? [],
      },
    },
  };
}

export function proposalTurn(
  actions: Array<{
    type: string;
    payload: Record<string, unknown>;
    confidence?: number;
    reason?: string;
    fallback_attach?: { document_id: string; section_key: string } | null;
  }>,
): ScriptedTurn {
  return {
    kind: "parsed",
    value: {
      actions: actions.map((a) => ({
        type: a.type,
        payload: a.payload,
        confidence: a.confidence ?? 0.95,
        reason: a.reason ?? "test action",
        fallback_attach: a.fallback_attach ?? null,
      })),
    },
  };
}

export function eligibilityTurn(earns: boolean, confidence = 0.9): ScriptedTurn {
  return {
    kind: "parsed",
    value: {
      earns_own_page: earns,
      confidence,
      rationale: earns ? "significant entity" : "minor detail",
    },
  };
}
