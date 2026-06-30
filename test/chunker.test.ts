import { describe, expect, it } from "vitest";
import { approxTokens, chunkText } from "../src/retrieval/chunker.js";

describe("chunker (Phase 3)", () => {
  it("packs paragraphs into target-sized chunks", () => {
    const para = "alpha beta gamma delta epsilon zeta eta theta.";
    const text = Array.from({ length: 30 }, () => para).join("\n\n");
    const chunks = chunkText(text, { targetTokens: 50, overlapTokens: 0 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.tokenCount).toBeLessThanOrEqual(60);
    expect(chunks.map((c) => c.index)).toEqual([...chunks.keys()]);
  });

  it("seeds overlap between consecutive chunks", () => {
    const text = Array.from({ length: 20 }, (_, i) => `paragraph number ${i} with words`).join(
      "\n\n",
    );
    const chunks = chunkText(text, { targetTokens: 30, overlapTokens: 10 });
    expect(chunks.length).toBeGreaterThan(1);
    const tail = chunks[0]!.text.split(/\s+/).slice(-3).join(" ");
    expect(chunks[1]!.text).toContain(tail.split(" ")[0]);
  });

  it("splits oversized paragraphs by sentence", () => {
    const giant = Array.from({ length: 40 }, (_, i) => `Sentence ${i} keeps going on.`).join(" ");
    const chunks = chunkText(giant, { targetTokens: 40, overlapTokens: 0 });
    expect(chunks.length).toBeGreaterThan(1);
  });

  it("approxTokens is monotone in word count", () => {
    expect(approxTokens("one two three")).toBeGreaterThan(approxTokens("one"));
  });
});
