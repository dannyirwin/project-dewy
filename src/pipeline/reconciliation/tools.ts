import { z } from "zod";
import type { ToolDefinition } from "../../providers/interfaces.js";
import type { Repositories } from "../../repositories/interfaces.js";
import type { SearchService } from "../../retrieval/search.js";

/**
 * The four Stage-2 tools (plan §5). Implementations are deterministic code
 * over repositories/search; only the *orchestration* is LLM-driven. Defined
 * with Zod parameter schemas so they double as Agents-SDK function tools later.
 */

export interface ToolRuntime {
  definitions: ToolDefinition[];
  execute(name: string, args: unknown): Promise<string>;
}

/** Levenshtein distance for checkName fuzzy matching. */
export function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[] = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    let prev = dp[0]!;
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j]!;
      dp[j] = Math.min(dp[j]! + 1, dp[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[n]!;
}

export function createReconciliationTools(
  repos: Repositories,
  search: SearchService,
  knowledgeBaseId: string,
): ToolRuntime {
  const definitions: ToolDefinition[] = [
    {
      name: "searchKnowledge",
      description:
        "Hybrid (semantic + keyword) search over the knowledge base. Returns matching documents with snippets. Use for any statement to find what the KB already says.",
      parameters: z.object({
        query: z.string().min(1),
        limit: z.number().int().min(1).max(20).default(5),
      }),
    },
    {
      name: "getDocument",
      description:
        "Fetch a document's current content and its links by document id. Use after search to read full context.",
      parameters: z.object({ document_id: z.string() }),
    },
    {
      name: "findSimilarDocuments",
      description:
        "Given a candidate title/short description for a possibly-new entity, return existing documents ranked by semantic similarity. Use before concluding something is new.",
      parameters: z.object({
        text: z.string().min(1),
        limit: z.number().int().min(1).max(10).default(5),
      }),
    },
    {
      name: "checkName",
      description:
        "Fuzzy-match a proper noun against existing document titles (catches misspellings and variant spellings). Returns close matches with edit distance.",
      parameters: z.object({ name: z.string().min(1) }),
    },
  ];

  async function execute(name: string, rawArgs: unknown): Promise<string> {
    switch (name) {
      case "searchKnowledge": {
        const args = z
          .object({ query: z.string(), limit: z.number().int().default(5) })
          .parse(rawArgs ?? {});
        const hits = await search.search(knowledgeBaseId, args.query, args.limit);
        if (hits.length === 0) return JSON.stringify({ results: [] });
        const docs = await Promise.all(hits.map((h) => repos.documents.getById(h.document_id)));
        return JSON.stringify({
          results: hits.map((h, i) => ({
            document_id: h.document_id,
            title: docs[i]?.title ?? "(unknown)",
            score: Number(h.score.toFixed(4)),
            sources: h.sources,
            snippets: h.snippets.slice(0, 2),
          })),
        });
      }
      case "getDocument": {
        const args = z.object({ document_id: z.string() }).parse(rawArgs ?? {});
        const doc = await repos.documents.getById(args.document_id);
        if (!doc) return JSON.stringify({ error: "document not found" });
        const version = doc.current_version_id
          ? await repos.documentVersions.getById(doc.current_version_id)
          : null;
        const [outgoing, incoming] = await Promise.all([
          repos.links.listFrom(doc.id),
          repos.links.listTo(doc.id),
        ]);
        return JSON.stringify({
          document_id: doc.id,
          title: doc.title,
          template_id: doc.template_id,
          body_markdown: version?.body_markdown ?? "",
          links: {
            outgoing: outgoing.map((l) => ({ to: l.to_document_id, relation: l.relation })),
            incoming: incoming.map((l) => ({ from: l.from_document_id, relation: l.relation })),
          },
        });
      }
      case "findSimilarDocuments": {
        const args = z
          .object({ text: z.string(), limit: z.number().int().default(5) })
          .parse(rawArgs ?? {});
        const hits = await search.search(knowledgeBaseId, args.text, args.limit);
        const docs = await Promise.all(hits.map((h) => repos.documents.getById(h.document_id)));
        return JSON.stringify({
          results: hits.map((h, i) => ({
            document_id: h.document_id,
            title: docs[i]?.title ?? "(unknown)",
            score: Number(h.score.toFixed(4)),
          })),
        });
      }
      case "checkName": {
        const args = z.object({ name: z.string() }).parse(rawArgs ?? {});
        const docs = await repos.documents.list(knowledgeBaseId);
        const needle = args.name.toLowerCase();
        const matches = docs
          .map((d) => ({
            document_id: d.id,
            title: d.title,
            distance: editDistance(needle, d.title.toLowerCase()),
          }))
          .filter((m) => {
            const tolerance = Math.max(2, Math.floor(m.title.length * 0.34));
            return m.distance <= tolerance;
          })
          .sort((a, b) => a.distance - b.distance)
          .slice(0, 5);
        return JSON.stringify({
          query: args.name,
          matches,
          note:
            matches.length > 0
              ? "Close title matches exist — a small edit distance usually means a misspelling or variant of an existing entity, not a new one."
              : "No close title matches.",
        });
      }
      default:
        return JSON.stringify({ error: `unknown tool "${name}"` });
    }
  }

  return { definitions, execute };
}
