import { describe, expect, it } from "vitest";
import {
  extractSection,
  genericTemplate,
  renderBody,
  validateSections,
} from "../src/templates/index.js";

describe("template guardrails (plan §8/§9)", () => {
  it("flags missing required sections", () => {
    const r = validateSections(genericTemplate, [
      { key: "details", title: "Details", body_markdown: "x" },
    ]);
    expect(r.ok).toBe(false);
    expect(r.missingRequired).toEqual(["overview"]);
  });

  it("rejects sections not in the template", () => {
    const r = validateSections(genericTemplate, [
      { key: "overview", title: "Overview", body_markdown: "x" },
      { key: "loot_table", title: "Loot", body_markdown: "y" },
    ]);
    expect(r.ok).toBe(false);
    expect(r.unknownSections).toEqual(["loot_table"]);
  });

  it("renders canonical markdown with title and section headers", () => {
    const body = renderBody("Thornwick", [
      { key: "overview", title: "Overview", body_markdown: "A river town." },
    ]);
    expect(body).toContain("# Thornwick");
    expect(body).toContain("## Overview");
    expect(body).toContain("A river town.");
  });

  it("extractSection splits one section out", () => {
    const sections = [
      { key: "overview", title: "Overview", body_markdown: "a" },
      { key: "history", title: "History", body_markdown: "b" },
    ];
    const { section, rest } = extractSection(sections, "history");
    expect(section?.body_markdown).toBe("b");
    expect(rest.map((s) => s.key)).toEqual(["overview"]);
  });
});
