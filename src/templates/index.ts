import type { SectionContent, Template } from "../domain/schemas.js";

/**
 * Template engine (plan §9): templates describe the sections a document type
 * can have; sections may be omitted when no data exists, but required sections
 * must be present and unknown sections are rejected.
 */

export interface TemplateValidationResult {
  ok: boolean;
  missingRequired: string[];
  unknownSections: string[];
}

export function validateSections(
  template: Template,
  sections: SectionContent[],
): TemplateValidationResult {
  const allowed = new Set(template.sections.map((s) => s.key));
  const present = new Set(sections.map((s) => s.key));
  const missingRequired = template.sections
    .filter((s) => s.required && !present.has(s.key))
    .map((s) => s.key);
  const unknownSections = sections.filter((s) => !allowed.has(s.key)).map((s) => s.key);
  return {
    ok: missingRequired.length === 0 && unknownSections.length === 0,
    missingRequired,
    unknownSections,
  };
}

/** Render structured sections to the canonical body_markdown. */
export function renderBody(title: string, sections: SectionContent[]): string {
  const parts = [`# ${title}`];
  for (const s of sections) {
    parts.push(`## ${s.title}\n\n${s.body_markdown.trim()}`);
  }
  return `${parts.join("\n\n")}\n`;
}

/** Pull one section out of a body (used by promote_subsection). */
export function extractSection(
  sections: SectionContent[],
  key: string,
): { section: SectionContent | null; rest: SectionContent[] } {
  const section = sections.find((s) => s.key === key) ?? null;
  return { section, rest: sections.filter((s) => s.key !== key) };
}

export const genericTemplate: Template = {
  id: "generic",
  name: "Generic entry",
  version: 1,
  sections: [
    { key: "overview", title: "Overview", required: true },
    { key: "details", title: "Details", required: false },
    { key: "relationships", title: "Relationships", required: false },
    { key: "history", title: "History", required: false },
    { key: "notes", title: "Notes", required: false },
  ],
};

export const placeTemplate: Template = {
  id: "place",
  name: "Place",
  version: 1,
  sections: [
    { key: "overview", title: "Overview", required: true },
    { key: "notable_locations", title: "Notable Locations", required: false },
    { key: "people", title: "People", required: false },
    { key: "history", title: "History", required: false },
    { key: "hooks", title: "Hooks", required: false },
  ],
};

export const personTemplate: Template = {
  id: "person",
  name: "Person",
  version: 1,
  sections: [
    { key: "overview", title: "Overview", required: true },
    { key: "appearance", title: "Appearance", required: false },
    { key: "relationships", title: "Relationships", required: false },
    { key: "history", title: "History", required: false },
    { key: "secrets", title: "Secrets", required: false },
  ],
};

export const defaultTemplates: Template[] = [genericTemplate, placeTemplate, personTemplate];
