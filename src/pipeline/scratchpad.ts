import { type Scratchpad, ScratchpadSchema } from "../domain/schemas.js";

/**
 * Scratchpad (locked decision #6): structured jsonb on the ingestion_job row.
 * All writes go through these helpers so the shape always validates; a
 * markdown rendering is derivable for prompts and the review UI.
 */

export function mergeScratchpad(base: Scratchpad, patch: Partial<Scratchpad>): Scratchpad {
  return ScratchpadSchema.parse({
    version: 1,
    relevant_summaries: [...base.relevant_summaries, ...(patch.relevant_summaries ?? [])],
    entity_resolutions: [...base.entity_resolutions, ...(patch.entity_resolutions ?? [])],
    name_decisions: [...base.name_decisions, ...(patch.name_decisions ?? [])],
    notes: [...base.notes, ...(patch.notes ?? [])],
    review_context: [...base.review_context, ...(patch.review_context ?? [])],
  });
}

export function renderScratchpadMarkdown(sp: Scratchpad): string {
  const parts: string[] = ["# Working notes"];
  if (sp.relevant_summaries.length) {
    parts.push("## Relevant existing documents");
    for (const s of sp.relevant_summaries)
      parts.push(`- **${s.title}** (${s.document_id}): ${s.summary}`);
  }
  if (sp.entity_resolutions.length) {
    parts.push("## Entity resolutions");
    for (const e of sp.entity_resolutions)
      parts.push(
        `- "${e.mention}" → ${e.document_id ?? "no existing document"} (${e.decision}, confidence ${e.confidence})`,
      );
  }
  if (sp.name_decisions.length) {
    parts.push("## Name decisions");
    for (const n of sp.name_decisions)
      parts.push(`- "${n.original}" → "${n.resolved}": ${n.reason}`);
  }
  if (sp.review_context.length) {
    parts.push("## Human review context");
    for (const r of sp.review_context) parts.push(`- ${r.context}`);
  }
  if (sp.notes.length) {
    parts.push("## Notes");
    for (const n of sp.notes) parts.push(`- ${n}`);
  }
  return parts.join("\n");
}
