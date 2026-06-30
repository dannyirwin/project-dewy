import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { uuid } from "../domain/schemas.js";
import type { Repositories } from "../repositories/interfaces.js";
import type { SearchService } from "../retrieval/search.js";

/**
 * Read-only MCP surface for external AI clients (Cursor IDE, Claude Code, etc.).
 * Write paths stay on the HTTP API with human review gates.
 */

export interface McpDeps {
  repos: Repositories;
  search: SearchService;
}

function isUuid(value: string): boolean {
  return uuid.safeParse(value).success;
}

export function createMcpServer(deps: McpDeps): McpServer {
  const { repos, search } = deps;
  const server = new McpServer({ name: "kms", version: "0.1.0" });

  const kbIdSchema = z.object({
    knowledge_base_id: z.string().min(1).describe("Knowledge base UUID or slug"),
  });

  server.registerTool(
    "search_kb",
    {
      description: "Hybrid semantic + keyword search over a knowledge base.",
      inputSchema: kbIdSchema.extend({
        query: z.string().min(1),
        limit: z.number().int().min(1).max(50).default(10),
      }),
    },
    async ({ knowledge_base_id, query, limit }) => {
      const kb = isUuid(knowledge_base_id)
        ? await repos.knowledgeBases.getById(knowledge_base_id)
        : await repos.knowledgeBases.getBySlug(knowledge_base_id);
      if (!kb) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: "knowledge base not found" }) }],
        };
      }
      const hits = await search.search(kb.id, query, limit);
      const docs = await Promise.all(hits.map((h) => repos.documents.getById(h.document_id)));
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              hits.map((h, i) => ({
                document_id: h.document_id,
                title: docs[i]?.title ?? "(unknown)",
                score: h.score,
                snippets: h.snippets,
                sources: h.sources,
              })),
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    "get_document",
    {
      description: "Fetch a document's metadata and current body by UUID or slug.",
      inputSchema: z.object({
        knowledge_base_id: z.string().min(1),
        document: z.string().min(1).describe("Document UUID or slug"),
      }),
    },
    async ({ knowledge_base_id, document }) => {
      const kb = isUuid(knowledge_base_id)
        ? await repos.knowledgeBases.getById(knowledge_base_id)
        : await repos.knowledgeBases.getBySlug(knowledge_base_id);
      if (!kb) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: "knowledge base not found" }) }],
        };
      }
      const doc = isUuid(document)
        ? await repos.documents.getById(document)
        : await repos.documents.getBySlug(kb.id, document);
      if (!doc || doc.knowledge_base_id !== kb.id) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: "document not found" }) }],
        };
      }
      const current = doc.current_version_id
        ? await repos.documentVersions.getById(doc.current_version_id)
        : null;
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ document: doc, current_version: current }, null, 2),
          },
        ],
      };
    },
  );

  server.registerTool(
    "list_documents",
    {
      description: "List documents in a knowledge base.",
      inputSchema: kbIdSchema,
    },
    async ({ knowledge_base_id }) => {
      const kb = isUuid(knowledge_base_id)
        ? await repos.knowledgeBases.getById(knowledge_base_id)
        : await repos.knowledgeBases.getBySlug(knowledge_base_id);
      if (!kb) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: "knowledge base not found" }) }],
        };
      }
      const docs = await repos.documents.list(kb.id);
      return { content: [{ type: "text", text: JSON.stringify(docs, null, 2) }] };
    },
  );

  server.registerTool(
    "list_tags",
    {
      description: "List tags in a knowledge base with document counts.",
      inputSchema: kbIdSchema,
    },
    async ({ knowledge_base_id }) => {
      const kb = isUuid(knowledge_base_id)
        ? await repos.knowledgeBases.getById(knowledge_base_id)
        : await repos.knowledgeBases.getBySlug(knowledge_base_id);
      if (!kb) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: "knowledge base not found" }) }],
        };
      }
      const tags = await repos.tags.listByKb(kb.id);
      const docs = await repos.documents.list(kb.id);
      const counts = new Map<string, number>();
      for (const doc of docs) {
        const attached = await repos.documentTags.listByDocument(doc.id);
        for (const row of attached) {
          counts.set(row.tag_id, (counts.get(row.tag_id) ?? 0) + 1);
        }
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              tags.map((t) => ({ ...t, document_count: counts.get(t.id) ?? 0 })),
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    "get_document_versions",
    {
      description: "Full immutable version history for a document.",
      inputSchema: z.object({
        knowledge_base_id: z.string().min(1),
        document: z.string().min(1),
      }),
    },
    async ({ knowledge_base_id, document }) => {
      const kb = isUuid(knowledge_base_id)
        ? await repos.knowledgeBases.getById(knowledge_base_id)
        : await repos.knowledgeBases.getBySlug(knowledge_base_id);
      if (!kb) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: "knowledge base not found" }) }],
        };
      }
      const doc = isUuid(document)
        ? await repos.documents.getById(document)
        : await repos.documents.getBySlug(kb.id, document);
      if (!doc || doc.knowledge_base_id !== kb.id) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: "document not found" }) }],
        };
      }
      const versions = await repos.documentVersions.listByDocument(doc.id);
      return { content: [{ type: "text", text: JSON.stringify(versions, null, 2) }] };
    },
  );

  server.registerTool(
    "list_review_items",
    {
      description: "Pending review items for a knowledge base (conflicts, gated proposals, etc.).",
      inputSchema: kbIdSchema,
    },
    async ({ knowledge_base_id }) => {
      const kb = isUuid(knowledge_base_id)
        ? await repos.knowledgeBases.getById(knowledge_base_id)
        : await repos.knowledgeBases.getBySlug(knowledge_base_id);
      if (!kb) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: "knowledge base not found" }) }],
        };
      }
      const items = await repos.reviewItems.listPending(kb.id);
      return { content: [{ type: "text", text: JSON.stringify(items, null, 2) }] };
    },
  );

  return server;
}

/** Stateless Streamable HTTP handler for Hono `app.post("/mcp", ...)`. */
export async function handleMcpRequest(deps: McpDeps, request: Request): Promise<Response> {
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  const server = createMcpServer(deps);
  await server.connect(transport);
  return transport.handleRequest(request);
}
