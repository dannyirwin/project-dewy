import type { AppConfig } from "../config/index.js";
import type { DocumentVersion } from "../domain/schemas.js";
import type { EmbeddingProvider } from "../providers/interfaces.js";
import type { Repositories } from "../repositories/interfaces.js";
import { chunkText } from "./chunker.js";

/**
 * Hybrid retrieval (plan §7): semantic (pgvector / in-memory cosine) + keyword
 * (FTS / term scoring) fused with reciprocal rank fusion. Weighting is
 * config-driven. Keyword matters for made-up proper nouns that embeddings smear.
 */

export interface SearchHit {
  document_id: string;
  score: number;
  snippets: string[];
  sources: Array<"semantic" | "keyword">;
}

const RRF_K = 60;

export function reciprocalRankFusion(
  rankedLists: Array<{
    weight: number;
    source: "semantic" | "keyword";
    items: Array<{ document_id: string; snippet: string }>;
  }>,
): SearchHit[] {
  const byDoc = new Map<string, SearchHit>();
  for (const list of rankedLists) {
    list.items.forEach((item, rank) => {
      const hit = byDoc.get(item.document_id) ?? {
        document_id: item.document_id,
        score: 0,
        snippets: [],
        sources: [],
      };
      hit.score += list.weight * (1 / (RRF_K + rank + 1));
      if (item.snippet && !hit.snippets.includes(item.snippet)) hit.snippets.push(item.snippet);
      if (!hit.sources.includes(list.source)) hit.sources.push(list.source);
      byDoc.set(item.document_id, hit);
    });
  }
  return [...byDoc.values()].sort((a, b) => b.score - a.score);
}

export class SearchService {
  constructor(
    private repos: Repositories,
    private embeddings: EmbeddingProvider,
    private cfg: Pick<
      AppConfig,
      | "SEARCH_SEMANTIC_WEIGHT"
      | "SEARCH_KEYWORD_WEIGHT"
      | "CHUNK_TARGET_TOKENS"
      | "CHUNK_OVERLAP_TOKENS"
    >,
  ) {}

  async search(knowledgeBaseId: string, query: string, limit = 10): Promise<SearchHit[]> {
    const perLeg = Math.max(limit * 2, 10);

    const [semantic, keyword] = await Promise.all([
      (async () => {
        const { vectors } = await this.embeddings.embed([query]);
        const v = vectors[0];
        if (!v) return [];
        const hits = await this.repos.chunks.similaritySearch(knowledgeBaseId, v, perLeg);
        return hits.map((h) => ({ document_id: h.document_id, snippet: h.text.slice(0, 240) }));
      })(),
      this.repos.documents
        .keywordSearch(knowledgeBaseId, query, perLeg)
        .then((rows) => rows.map((r) => ({ document_id: r.document_id, snippet: r.snippet }))),
    ]);

    return reciprocalRankFusion([
      { weight: this.cfg.SEARCH_SEMANTIC_WEIGHT, source: "semantic", items: semantic },
      { weight: this.cfg.SEARCH_KEYWORD_WEIGHT, source: "keyword", items: keyword },
    ]).slice(0, limit);
  }

  /**
   * Chunk write path: regenerate a document's chunks from a version (plan §6:
   * any document version change enqueues chunk regeneration — delete old, embed
   * new body, insert with current embedding_model/dimension).
   */
  async regenerateChunks(version: DocumentVersion): Promise<number> {
    await this.repos.chunks.deleteByDocument(version.document_id);
    const pieces = chunkText(version.body_markdown, {
      targetTokens: this.cfg.CHUNK_TARGET_TOKENS,
      overlapTokens: this.cfg.CHUNK_OVERLAP_TOKENS,
    });
    if (pieces.length === 0) return 0;
    const { vectors, model, dimension } = await this.embeddings.embed(pieces.map((p) => p.text));
    const rows = pieces.map((p, i) => ({
      knowledge_base_id: version.knowledge_base_id,
      document_id: version.document_id,
      document_version_id: version.id,
      chunk_index: p.index,
      text: p.text,
      embedding: vectors[i] ?? [],
      embedding_model: model,
      dimension,
      token_count: p.tokenCount,
    }));
    await this.repos.chunks.insertMany(rows);
    return rows.length;
  }
}
