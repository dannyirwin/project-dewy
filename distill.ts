import { generateText } from "ai";
import { model } from "../llm/index.js";
import { supabase } from "../db.js";
import { listTags } from "../tools/search.js";
import { upsertDocument } from "../tools/documents.js";
import { linkDocuments } from "../tools/relations.js";
import { slugify, normalize } from "../content-hash.js";
import { providerKind, modelId } from "../llm/index.js";
import { classify } from "./classify.js";
import { extractEntities } from "./extract-entities.js";
import { reconcile } from "./reconcile.js";

// ---------------------------------------------------------------
// Distill: turn raw content (transcript, notes, ad-hoc summary)
// into a structured wiki document AND wire it to existing knowledge.
//
// Design principles:
//   * Many small focused LLM calls, not one big agent loop.
//   * Each call has a Zod schema (structured output).
//   * Deterministic pre/post-processing wherever possible.
//   * Embedding search filters candidates BEFORE LLM judgment.
//   * Every run is recorded in agent_runs for audit.
// ---------------------------------------------------------------

export type DistillInput = {
  content: string;
  source_type: "transcript" | "notes" | "summary" | "document";
  source?: string;                         // e.g. file path, calendar id
  metadata?: Record<string, unknown>;      // e.g. { date, participants }
  job_id?: string;                         // for audit linkage
};

export type DistillResult = {
  document_id: string;
  document_slug: string;
  relations_created: number;
  new_entity_stubs: number;
  usage: { promptTokens: number; completionTokens: number };
};

export async function distill(input: DistillInput): Promise<DistillResult> {
  const started = Date.now();
  const cleaned = normalize(input.content);

  let totalIn = 0;
  let totalOut = 0;
  const addUsage = (u: { promptTokens: number; completionTokens: number }) => {
    totalIn += u.promptTokens;
    totalOut += u.completionTokens;
  };

  // ----- Step 1: classify + title (1 LLM call) -----
  // Pass known tags so the model reuses vocabulary instead of inventing.
  const knownTags = (await listTags()).map((t) => t.tag);
  const { classification, usage: u1 } = await classify(
    cleaned,
    input.source_type,
    knownTags,
  );
  addUsage(u1);

  // ----- Step 2: extract entities (1 LLM call) -----
  const { entities, usage: u2 } = await extractEntities(cleaned);
  addUsage(u2);

  // ----- Step 3: reconcile each entity (1 retrieval + 1 LLM call each) -----
  // Done concurrently. For very large entity counts you'd want a small
  // semaphore here; for prototype use, the AI SDK + provider handle it.
  const reconciled = await Promise.all(entities.map((e) => reconcile(e)));
  for (const r of reconciled) addUsage(r.usage);

  // ----- Step 4: generate the distilled body (1 LLM call) -----
  // We give the model the classification, entities, and reconcile decisions
  // so it can write a precise summary AND inline references where helpful.
  const body = await writeBody({
    content: cleaned,
    classification,
    reconciled,
  });
  addUsage(body.usage);

  // ----- Step 5: apply deterministic side effects -----
  // Create the new doc.
  const doc = await upsertDocument({
    slug: slugify(classification.title),
    title: classification.title,
    body: body.markdown,
    tags: classification.tags,
    metadata: {
      ...(input.metadata ?? {}),
      source_type: input.source_type,
      doc_type: classification.doc_type,
      summary_line: classification.summary_line,
    },
    source: input.source ?? `agent:distill`,
  });

  // Wire relations to existing docs.
  let relationsCreated = 0;
  let newEntityStubs = 0;
  for (const r of reconciled) {
    if (
      (r.result.decision === "existing_match" || r.result.decision === "related_to") &&
      r.result.target_slug
    ) {
      // Look up the target doc by slug.
      const { data: tgt } = await supabase
        .from("documents")
        .select("id")
        .eq("slug", r.result.target_slug)
        .maybeSingle();
      if (tgt) {
        const kind =
          r.result.relation_kind ??
          (r.result.decision === "existing_match"
            ? "about"
            : entityKindToRelation(r.entity.type));
        await linkDocuments(doc.id, tgt.id, kind, {
          entity_name: r.entity.name,
          entity_type: r.entity.type,
          rationale: r.result.rationale,
        });
        relationsCreated++;
      }
    } else if (r.result.decision === "create_new") {
      // Create a stub doc for the new entity. The agent can revisit
      // stubs later (e.g. via a "fill stubs" cron) to flesh them out.
      const stubSlug = slugify(`${r.entity.type}-${r.entity.name}`);
      const { data: existing } = await supabase
        .from("documents")
        .select("id")
        .eq("slug", stubSlug)
        .maybeSingle();
      if (!existing) {
        const stub = await upsertDocument({
          slug: stubSlug,
          title: r.entity.name,
          body: `# ${r.entity.name}\n\n*Stub: ${r.entity.context}*\n\nFirst referenced in [${doc.title}](${doc.slug}).`,
          tags: ["stub", r.entity.type],
          metadata: { entity_type: r.entity.type, stub: true },
          source: `agent:distill:stub`,
        });
        await linkDocuments(doc.id, stub.id, entityKindToRelation(r.entity.type), {
          entity_name: r.entity.name,
        });
        newEntityStubs++;
        relationsCreated++;
      }
    }
  }

  // ----- Step 6: audit log -----
  await supabase.from("agent_runs").insert({
    job_id: input.job_id ?? null,
    agent: "distill",
    provider: providerKind(),
    model: modelId(),
    input: {
      source_type: input.source_type,
      content_length: cleaned.length,
      metadata: input.metadata ?? {},
    },
    output: {
      document_id: doc.id,
      document_slug: doc.slug,
      relations_created: relationsCreated,
      new_entity_stubs: newEntityStubs,
      entities: reconciled.map((r) => ({
        name: r.entity.name,
        type: r.entity.type,
        decision: r.result.decision,
      })),
    },
    tokens_in: totalIn,
    tokens_out: totalOut,
    duration_ms: Date.now() - started,
  });

  return {
    document_id: doc.id,
    document_slug: doc.slug,
    relations_created: relationsCreated,
    new_entity_stubs: newEntityStubs,
    usage: { promptTokens: totalIn, completionTokens: totalOut },
  };
}

function entityKindToRelation(type: string): string {
  switch (type) {
    case "person": return "mentions-person";
    case "project": return "about-project";
    case "decision": return "records-decision";
    case "action_item": return "tracks-action";
    case "organization": return "mentions-org";
    default: return "references";
  }
}

// ---------------------------------------------------------------
// Body writer — last LLM call. Gets full context AND structured
// reconciliation info so it can write inline links.
// ---------------------------------------------------------------
async function writeBody(args: {
  content: string;
  classification: { title: string; doc_type: string };
  reconciled: { entity: any; result: any }[];
}) {
  const refLines = args.reconciled
    .filter((r) => r.result.target_slug)
    .map((r) => `- ${r.entity.name} (${r.entity.type}) → ${r.result.target_slug}`)
    .join("\n");

  const { text, usage } = await generateText({
    model: model(),
    system:
      "Write a clean, well-structured markdown document distilled from raw content. " +
      "Use H2/H3 sections appropriate to the doc type. " +
      "Be concise — no preamble, no recap of the prompt. " +
      "When mentioning entities for which a target slug is provided, link them inline " +
      "with markdown like [Name](slug). " +
      "Output ONLY the markdown body, no fenced code block around it.",
    prompt:
      `Doc type: ${args.classification.doc_type}\n` +
      `Title (already chosen): ${args.classification.title}\n\n` +
      (refLines ? `Known entity → slug mapping for inline links:\n${refLines}\n\n` : "") +
      `Raw content:\n\n${args.content}`,
  });
  return {
    markdown: text.trim(),
    usage: {
      promptTokens: usage?.promptTokens ?? 0,
      completionTokens: usage?.completionTokens ?? 0,
    },
  };
}
