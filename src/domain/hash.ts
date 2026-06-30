import { createHash } from "node:crypto";

/** Content-hash dedup (locked decision #9). */
export function contentHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Normalized hash for near-match detection: collapse whitespace, strip
 * punctuation noise, lowercase. Two imports with different raw hashes but the
 * same normalized hash are "near matches" → flagged for diff handling
 * (full diff/merge semantics are deferred per plan §13).
 */
export function normalizedHash(text: string): string {
  const norm = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  return createHash("sha256").update(norm, "utf8").digest("hex");
}
