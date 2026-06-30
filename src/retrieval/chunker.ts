/**
 * Chunking (open item "start simple, make it configurable"): paragraph-aware
 * packing into ~CHUNK_TARGET_TOKENS windows with CHUNK_OVERLAP_TOKENS overlap.
 * Token counting is a cheap whitespace approximation — fine for sizing.
 */

export interface ChunkOptions {
  targetTokens: number;
  overlapTokens: number;
}

export interface TextChunk {
  index: number;
  text: string;
  tokenCount: number;
}

export function approxTokens(text: string): number {
  // ~0.75 words per token is typical; whitespace split is close enough for sizing.
  return Math.ceil(text.split(/\s+/).filter(Boolean).length / 0.75);
}

export function chunkText(text: string, opts: ChunkOptions): TextChunk[] {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  const chunks: TextChunk[] = [];
  let current: string[] = [];
  let currentTokens = 0;

  const flush = () => {
    if (current.length === 0) return;
    const body = current.join("\n\n");
    chunks.push({ index: chunks.length, text: body, tokenCount: approxTokens(body) });
    // seed the next chunk with overlap from the tail of this one
    if (opts.overlapTokens > 0) {
      const words = body.split(/\s+/);
      const overlapWords = Math.min(words.length, Math.round(opts.overlapTokens * 0.75));
      const tail = words.slice(-overlapWords).join(" ");
      current = tail ? [tail] : [];
      currentTokens = approxTokens(tail);
    } else {
      current = [];
      currentTokens = 0;
    }
  };

  for (const para of paragraphs) {
    const t = approxTokens(para);
    if (t > opts.targetTokens) {
      // oversized paragraph: hard-split by sentences, then words
      flush();
      const sentences = para.split(/(?<=[.!?])\s+/);
      let buf: string[] = [];
      let bufTokens = 0;
      for (const s of sentences) {
        const st = approxTokens(s);
        if (bufTokens + st > opts.targetTokens && buf.length > 0) {
          const body = buf.join(" ");
          chunks.push({ index: chunks.length, text: body, tokenCount: approxTokens(body) });
          buf = [];
          bufTokens = 0;
        }
        buf.push(s);
        bufTokens += st;
      }
      if (buf.length > 0) {
        const body = buf.join(" ");
        chunks.push({ index: chunks.length, text: body, tokenCount: approxTokens(body) });
      }
      current = [];
      currentTokens = 0;
      continue;
    }
    if (currentTokens + t > opts.targetTokens && current.length > 0) flush();
    current.push(para);
    currentTokens += t;
  }
  if (current.length > 0) {
    const body = current.join("\n\n");
    chunks.push({ index: chunks.length, text: body, tokenCount: approxTokens(body) });
  }
  // re-number after overlap seeding edge cases
  return chunks.map((c, i) => ({ ...c, index: i }));
}
