import { z } from "zod";
import {
  AppendSectionPayload,
  ApplyTagPayload,
  CreateDocumentPayload,
  CreateTagPayload,
  PromoteSubsectionPayload,
  UpdateSectionPayload,
  UpsertLinkPayload,
} from "../../actions/index.js";
import type { ActionType } from "../../domain/schemas.js";
import type { ToolDefinition } from "../../providers/interfaces.js";

/**
 * Stage-3 proposal tools: one action per tool call (ADR-0012).
 * Payload schemas validate immediately; invalid args return an error string
 * so the model can self-correct on the next turn.
 */

export interface ProposalCandidate {
  type: ActionType;
  payload: unknown;
  confidence: number;
  reason: string;
  fallback_attach: { document_id: string; section_key: string } | null;
}

const metaFields = {
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1),
  fallback_attach: z
    .object({ document_id: z.uuid(), section_key: z.string().min(1) })
    .strict()
    .nullable()
    .default(null),
};

export interface ProposalToolRuntime {
  definitions: ToolDefinition[];
  execute(name: string, args: unknown): string;
  isDone(name: string): boolean;
  getCollected(): ProposalCandidate[];
}

export function createProposalTools(): ProposalToolRuntime {
  const collected: ProposalCandidate[] = [];

  const definitions: ToolDefinition[] = [
    {
      name: "propose_create_document",
      description:
        "Propose creating a new wiki page. Supply fallback_attach for augment-first demotion.",
      parameters: CreateDocumentPayload.extend(metaFields).strict(),
    },
    {
      name: "propose_append_section",
      description: "Propose appending a section to an existing document.",
      parameters: AppendSectionPayload.extend(metaFields).strict(),
    },
    {
      name: "propose_update_section",
      description: "Propose updating an existing section body.",
      parameters: UpdateSectionPayload.extend(metaFields).strict(),
    },
    {
      name: "propose_upsert_link",
      description: "Propose a typed link between two documents.",
      parameters: UpsertLinkPayload.extend(metaFields).strict(),
    },
    {
      name: "propose_create_tag",
      description: "Propose a new tag or category.",
      parameters: CreateTagPayload.extend(metaFields).strict(),
    },
    {
      name: "propose_apply_tag",
      description: "Propose applying a tag to a document.",
      parameters: ApplyTagPayload.extend(metaFields).strict(),
    },
    {
      name: "propose_promote_subsection",
      description: "Propose promoting a subsection into its own page.",
      parameters: PromoteSubsectionPayload.extend(metaFields).strict(),
    },
    {
      name: "done",
      description: "Signal that you have finished proposing actions for this ingestion.",
      parameters: z.object({}).strict(),
    },
  ];

  const toolToType: Record<string, ActionType> = {
    propose_create_document: "create_document",
    propose_append_section: "append_section",
    propose_update_section: "update_section",
    propose_upsert_link: "upsert_link",
    propose_create_tag: "create_tag",
    propose_apply_tag: "apply_tag",
    propose_promote_subsection: "promote_subsection",
  };

  const payloadSchemas: Record<string, z.ZodType> = {
    propose_create_document: CreateDocumentPayload,
    propose_append_section: AppendSectionPayload,
    propose_update_section: UpdateSectionPayload,
    propose_upsert_link: UpsertLinkPayload,
    propose_create_tag: CreateTagPayload,
    propose_apply_tag: ApplyTagPayload,
    propose_promote_subsection: PromoteSubsectionPayload,
  };

  function execute(name: string, rawArgs: unknown): string {
    if (name === "done") {
      return JSON.stringify({ ok: true, finished: true });
    }
    const type = toolToType[name];
    const payloadSchema = payloadSchemas[name];
    if (!type || !payloadSchema) {
      return JSON.stringify({ ok: false, error: `unknown tool: ${name}` });
    }
    const meta = z
      .object({
        confidence: metaFields.confidence,
        reason: metaFields.reason,
        fallback_attach: metaFields.fallback_attach,
      })
      .safeParse(rawArgs ?? {});
    if (!meta.success) {
      return JSON.stringify({ ok: false, error: meta.error.message });
    }
    const { confidence, reason, fallback_attach } = meta.data;
    const payloadOnly = { ...(rawArgs as Record<string, unknown>) };
    delete payloadOnly.confidence;
    delete payloadOnly.reason;
    delete payloadOnly.fallback_attach;
    const parsed = payloadSchema.safeParse(payloadOnly);
    if (!parsed.success) {
      return JSON.stringify({ ok: false, error: parsed.error.message });
    }
    collected.push({
      type,
      payload: parsed.data,
      confidence,
      reason,
      fallback_attach,
    });
    return JSON.stringify({ ok: true, type, accepted: true });
  }

  return {
    definitions,
    execute,
    isDone: (name) => name === "done",
    getCollected: () => [...collected],
  };
}
