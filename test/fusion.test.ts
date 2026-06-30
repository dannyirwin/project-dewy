import { describe, expect, it } from "vitest";
import { reciprocalRankFusion } from "../src/retrieval/search.js";

describe("reciprocal rank fusion (Phase 3)", () => {
  it("ranks documents appearing in both legs above single-leg hits", () => {
    const fused = reciprocalRankFusion([
      {
        weight: 1,
        source: "semantic",
        items: [
          { document_id: "a", snippet: "sa" },
          { document_id: "b", snippet: "sb" },
        ],
      },
      {
        weight: 1,
        source: "keyword",
        items: [
          { document_id: "b", snippet: "kb" },
          { document_id: "c", snippet: "kc" },
        ],
      },
    ]);
    expect(fused[0]!.document_id).toBe("b");
    expect(fused[0]!.sources.sort()).toEqual(["keyword", "semantic"]);
    expect(fused[0]!.snippets).toEqual(["sb", "kb"]);
  });

  it("respects leg weights (keyword boost can outrank semantic)", () => {
    const fused = reciprocalRankFusion([
      { weight: 0.1, source: "semantic", items: [{ document_id: "a", snippet: "" }] },
      { weight: 5, source: "keyword", items: [{ document_id: "z", snippet: "" }] },
    ]);
    expect(fused[0]!.document_id).toBe("z");
  });
});
