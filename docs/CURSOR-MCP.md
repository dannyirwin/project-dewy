# Cursor MCP connection

KMS exposes a read-only [Model Context Protocol](https://modelcontextprotocol.io/) endpoint at `POST /mcp`.
Cursor (or Claude Code) can query the knowledge base; writes go through the HTTP API with human review.

## Prerequisites

1. KMS running locally — see [LIVE-STACK.md](LIVE-STACK.md)
2. At least one knowledge base with content (`pnpm seed` or `pnpm smoke:live`)
3. Optional but recommended: set `MCP_TOKEN` in `.env` before connecting

## Configure Cursor

Add an MCP server in Cursor settings (or project `.cursor/mcp.json` if your Cursor version supports it):

```json
{
  "mcpServers": {
    "kms": {
      "url": "http://127.0.0.1:3000/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_MCP_TOKEN"
      }
    }
  }
}
```

Replace `YOUR_MCP_TOKEN` with the value of `MCP_TOKEN` from `.env`.
If `MCP_TOKEN` is empty (local dev only), omit the `headers` block.

## Available read tools

| Tool | Purpose |
|------|---------|
| `search_kb` | Hybrid semantic + keyword search |
| `get_document` | Full document + current version by slug or UUID |
| `list_documents` | All documents in a KB |
| `list_tags` | Tags with document counts |
| `get_document_versions` | Immutable version history |
| `list_review_items` | Pending human review items |

All tools take `knowledge_base_id` (UUID or slug).

## Writes (not on MCP)

| Action | HTTP route |
|--------|------------|
| Ingest content | `POST /knowledge-bases/{id}/ingestions` |
| Resolve review | `POST /review-items/{id}/{context\|skip\|approve\|reject}` |
| Rollback document | `POST /documents/{id}/rollback` |

When `API_TOKEN` is set, mutating routes require `Authorization: Bearer <API_TOKEN>`.
GET routes (search, list documents, etc.) stay public.

## Manual validation checklist

Use this after connecting MCP in Cursor:

- [ ] `search_kb` returns hits for seeded content (e.g. query "Thornwick")
- [ ] `get_document` returns body for a known slug
- [ ] `list_review_items` shows pending items after a conflict ingest (optional)

## Troubleshooting

| Issue | Fix |
|-------|-----|
| 401 Unauthorized | Set `MCP_TOKEN` in `.env`, restart API, match bearer header |
| Connection refused | `pnpm dev` running on port 3000 |
| Empty search results | Run `pnpm seed`; confirm `knowledge_base_id` slug/UUID |
| Tool not listed | Restart Cursor after MCP config change; check `/mcp` with curl initialize |
| SSL / remote host | Use HTTPS reverse proxy; set tokens; never expose unauthenticated MCP |

### curl smoke (initialize)

```bash
curl -sS -X POST http://127.0.0.1:3000/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H "authorization: Bearer $MCP_TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
```

Expect `"serverInfo":{"name":"kms",...}` in the response.
