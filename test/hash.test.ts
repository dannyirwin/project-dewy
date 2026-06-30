import { describe, expect, it } from "vitest";
import { contentHash, normalizedHash } from "../src/domain/hash.js";

describe("content hashing / dedup (locked decision #9)", () => {
  it("identical text → identical hash", () => {
    expect(contentHash("hello world")).toBe(contentHash("hello world"));
  });
  it("different text → different hash", () => {
    expect(contentHash("hello world")).not.toBe(contentHash("hello world!"));
  });
  it("normalized hash treats whitespace/punctuation/case variants as near matches", () => {
    const a = "The  Mayor, Aldra Venn,\nrules Thornwick.";
    const b = "the mayor aldra venn rules thornwick";
    expect(contentHash(a)).not.toBe(contentHash(b));
    expect(normalizedHash(a)).toBe(normalizedHash(b));
  });
});
