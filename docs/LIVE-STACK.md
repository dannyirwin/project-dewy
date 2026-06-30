# Live stack checklist

Ordered steps to run KMS against a real Supabase database and LM Studio.
Not required for CI (`pnpm test` / `pnpm eval` stay fully offline).

## Prerequisites

- Node ≥ 22, pnpm ≥ 9
- [Supabase CLI](https://supabase.com/docs/guides/cli) + Docker
- [LM Studio](https://lmstudio.ai/) with local server enabled

## 1. Database

```bash
supabase start
supabase db push
pnpm db:vector-index
psql "$DATABASE_URL" -f supabase/generated/vector_index.sql
```

Copy `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` from `supabase status` into `.env`.

## 2. LM Studio models

Load models that match `.env`:

| Role | Example model | Env var | Notes |
|------|---------------|---------|-------|
| Chat | `qwen2.5-14b-instruct` | `CHAT_MODEL` | Tool calling + structured output capable |
| Embeddings | `text-embedding-nomic-embed-text-v1.5` | `EMBEDDING_MODEL` | Must match `EMBEDDING_DIMENSION` (768 for nomic v1.5) |

Start the LM Studio local server (default `http://127.0.0.1:1234/v1`).

## 3. Configure and run API

```bash
cp .env.example .env
# fill SUPABASE_* and optionally MCP_TOKEN / API_TOKEN
pnpm install
pnpm dev
```

Health check: `curl http://127.0.0.1:3000/healthz`

## 4. Seed or smoke

```bash
pnpm seed          # demo KB + full pipeline ingest (calls live LLM)
pnpm smoke:live    # creates ephemeral KB, asserts document + search hit
```

`smoke:live` exits nonzero on failure — use it after any stack change.

## 5. Docker API only (optional)

Database stays on `supabase start`; LM Studio stays on the host:

```bash
export SUPABASE_SERVICE_ROLE_KEY=...
docker compose up --build
```

See root `docker-compose.yml` — API reaches Supabase and LM Studio via `host.docker.internal`.

## Troubleshooting

| Symptom | Check |
|---------|--------|
| Embedding dimension mismatch | `EMBEDDING_DIMENSION` matches model; re-run vector index DDL |
| Connection refused on :1234 | LM Studio local server running |
| Supabase auth errors | `SUPABASE_SERVICE_ROLE_KEY` from `supabase status`, not placeholder |
| Ingestion `failed` | API logs; model too weak for tool calls — try a larger chat model |
