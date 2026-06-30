# KMS — LLM-powered wiki-style knowledge management system

Drop raw notes in; get a maintained, interlinked, versioned wiki out. An LLM ingestion pipeline classifies incoming text, reconciles it against what the knowledge base already says (using tools, not vibes), and proposes structured edits that deterministic code validates and applies — with human review gates, full audit/rollback, and hybrid (semantic + keyword) retrieval.

Built per the agreed build plan; the locked decisions below are implemented as specified and not re-litigated in code comments.

## The pipeline at a glance

```
received → classifying → classified → reconciling → reconciled
        ↘ completed (exact duplicate)            ↓
                              ┌────────── awaiting_review ──────────┐
                              ↓                                      ↓
                       proposing_edits ───────────────────→ applying_edits → completed
                              ↘ awaiting_review (gated proposals) ↗        ↘ failed
```

- **Stage 1 — classify** (`src/pipeline/stages/classify.ts`): atomic statements bucketed `clear` / `semi_clear` / `unusable`, each with provenance offsets into the source. Exact-duplicate imports (content hash) short-circuit to `completed` with `duplicate_of_job_id`; normalized-hash near matches are flagged and continue.
- **Stage 2 — reconcile** (`src/pipeline/reconciliation/`): a thin tool-call loop drives four deterministic tools — `searchKnowledge` (hybrid search), `getDocument`, `findSimilarDocuments`, `checkName` (edit-distance fuzzy titles, so "Thornwik" resolves to "Thornwick" instead of becoming a new entity). Output: a report marking every statement `confirmed` / `conflicts` / `new` / `needs_review`, plus scratchpad additions. A config-driven step budget bounds the loop; on exhaustion, unaddressed statements fail safe into `needs_review`.
- **Review gate** (`src/review/`): conflicts and ambiguities become `review_item` rows; the job parks in `awaiting_review`. Humans answer over the API (`context` / `skip` / `approve` / `reject`); answers land in the job scratchpad and the pipeline resumes automatically when nothing pending remains.
- **Stage 3 — propose & apply** (`src/pipeline/stages/propose.ts` + `src/actions/`): the LLM proposes typed actions (`create_document`, `append_section`, `update_section`, `upsert_link`, `create_tag`, `apply_tag`, `promote_subsection`); deterministic code validates them (template guardrails, link integrity, tag policy, near-duplicate title check) and applies them through the versioning service. Confidence ≥ `AUTO_APPLY_CONFIDENCE_THRESHOLD` auto-applies; everything else parks for approval. **Augment-first**: page eligibility is a deterministic gate (+ optionally a gated LLM judgment); failed gates demote `create_document` into an `append_section` on the proposal's `fallback_attach` target — same input, different KB config, different wiki shape.

## Locked architecture decisions (implemented)

1. **Hybrid orchestration** — self-owned persisted state machine (`src/pipeline/stateMachine.ts`); Stage 2 behind the `ReconciliationEngine` interface with a thin tool-call loop default. The OpenAI Agents SDK can be dropped in later: implement `ReconciliationEngine`, pass it to `buildPipeline({ reconciliationEngine })` — the tool definitions are already Zod-parameterized function-tool shapes. Nothing else moves.
2. **Local embeddings via provider abstraction** — LM Studio behind `EmbeddingProvider`; every chunk records `embedding_model` + `dimension`; the dimension is config-driven (`EMBEDDING_DIMENSION`), never hardcoded in the schema (the migration declares `vector` without a dimension; the index DDL is generated — see runbook).
3. **Multi-tenant** — `knowledge_base_id` on every domain table; all queries scoped.
4. **Repository-isolated data layer** — business logic depends on `src/repositories/interfaces.ts` only. `@supabase/supabase-js` is imported in exactly one file (`src/db/client.ts`); the architecture test enforces this mechanically. pgvector is a hard dependency.
5. **Versioning + audit + rollback** — every document mutation goes through `VersioningService`: immutable `document_version` rows, audit log entries, chunk regeneration; `rollback` restores any version as a new current version.
6. **Scratchpad** — structured jsonb on the ingestion job (`relevant_summaries`, `entity_resolutions`, `name_decisions`, `notes`, `review_context`) with a markdown rendering for prompts and review UI.
7. **Review via DB rows + API** — no bespoke queue; `review_item` rows + Hono endpoints.
8. **Per-KB versioned config** — page-eligibility rules, templates, tag policy; config updates bump `config_version` and are audited; versions record which config they were written under. `promote_subsection` is the first-class showcase action: new page + link stub in the source + reciprocal links, all reviewable.
9. **Content-hash dedup** on import; normalized near matches flagged (full diff/merge semantics deferred).
10. **Stack** — TypeScript strict ESM, pnpm, Hono + `@hono/zod-openapi` (OpenAPI generated from the Zod schemas at `/openapi.json`), Vitest, Supabase CLI migrations, Zod v4 as the single source of truth for domain shapes.

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — technical map: control flow, module guide, data model, testing architecture
- [docs/adr/](docs/adr/) — Architecture Decision Records for every locked decision (binding; supersede, don't diverge)
- [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) — workflow, definition of done, recipes for common changes
- [AGENTS.md](AGENTS.md) — canonical instructions for AI coding agents (Claude Code / Cursor / Codex / Copilot read this; `CLAUDE.md` and `.github/copilot-instructions.md` are pointers)

## Repository map

```
src/
  config/            env-driven config (Zod-validated, dev-safe defaults)
  domain/            Zod schemas (single source of truth), hashing, slugs
  db/client.ts       the ONLY file importing @supabase/supabase-js
  repositories/      interfaces + in-memory impl (tests) + Supabase impl (prod)
  providers/         ChatProvider/EmbeddingProvider; LM Studio impl; mocks
  retrieval/         chunker + hybrid search (pgvector semantic + FTS keyword + RRF)
  templates/         section templates, guardrail validation, markdown rendering
  versioning/        immutable versions, audit, rollback, chunk regeneration
  kb/                KB creation, versioned config updates, page-eligibility engine
  actions/           the 7 action types: payload schemas, validation, idempotent apply
  pipeline/          state machine, scratchpad, stages, reconciliation engine
  review/            review workflow + automatic job resume
  jobs/runner.ts     in-process scheduler with a queue-shaped boundary
  api/               Hono app factory (createApp) + production server entrypoint
supabase/migrations/ schema (vector column WITHOUT fixed dimension; FTS; RPCs)
scripts/             generate-vector-index, seed, eval (golden scenarios)
test/                Vitest suite incl. architecture guards
```

## Runbook

### Prerequisites
- Node ≥ 22, pnpm ≥ 9
- Docker (for `supabase start`, and optionally for running the API container)
- Supabase CLI
- LM Studio with a **chat** model and an **embedding** model loaded, local server enabled

See [docs/LIVE-STACK.md](docs/LIVE-STACK.md) for the full checklist and [docs/CURSOR-MCP.md](docs/CURSOR-MCP.md) for Cursor integration.

Default models (override in `.env`):

| Role | Default | Dimension |
|------|---------|-----------|
| Chat | `qwen2.5-14b-instruct` | n/a |
| Embeddings | `text-embedding-nomic-embed-text-v1.5` | 768 (`EMBEDDING_DIMENSION`) |

### 1. Install & verify
```bash
pnpm install
pnpm typecheck && pnpm test && pnpm eval   # all offline; no DB or LLM needed
```

### 2. Database
```bash
supabase start                 # local stack (Postgres + PostgREST + Studio)
supabase db push               # apply migrations (pgvector, schema, FTS, RPCs)
pnpm db:vector-index           # generate index DDL from EMBEDDING_DIMENSION
psql "$DATABASE_URL" -f supabase/generated/vector_index.sql
```
The migration intentionally leaves `chunk.embedding` as dimension-less `vector`; the generated DDL pins the column type and builds the HNSW index for the configured dimension (locked decision #2).

> This repo was authored in an environment without a Docker daemon, so `supabase db push` and the live Supabase repositories were written to spec but not executed against a running stack here. The unit/integration suite covers the same repository contracts via the in-memory implementation; run the commands above for live verification.

### 3. Configuration
Copy `.env.example` → `.env` and fill in (loaded automatically on `pnpm dev` / `pnpm start`):
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` — from `supabase status`, or a hosted project URL + service role key
- `CHAT_BASE_URL`, `CHAT_API_KEY`, `CHAT_MODEL` — LM Studio local server (default `http://127.0.0.1:1234/v1`)
- `EMBEDDING_BASE_URL`, `EMBEDDING_API_KEY`, `EMBEDDING_MODEL`, `EMBEDDING_DIMENSION` — must match loaded embedding model (768 for nomic v1.5)
- `MCP_TOKEN`, `API_TOKEN` — optional; set before shared-network or Cursor MCP access

### 4. Run
```bash
pnpm dev        # watch mode
# or
pnpm start      # tsx src/api/server.ts
pnpm seed       # optional: demo "Campaign Notes" KB through the full pipeline
```
API docs: `GET /openapi.json` (generated), human entry at `/docs`. Key endpoints: `POST /knowledge-bases`, `POST /knowledge-bases/:id/ingestions` (`run:false` to let the background runner advance it), `GET /knowledge-bases/:id/review-items`, `POST /review-items/:id/{context|skip|approve|reject}`, `GET /knowledge-bases/:id/search?q=…`, `GET /documents/:id/versions`, `POST /documents/:id/rollback`.

### 5. Docker (local dev, optional)
The database stack stays with `supabase start` (it already runs its own containers) and LM Studio stays on the host; the compose file runs just the KMS API and reaches both via `host.docker.internal`:
```bash
supabase start
export SUPABASE_SERVICE_ROLE_KEY=...   # from `supabase status`
docker compose up --build
```
`Dockerfile` is a multi-stage Node 22 build running the API via tsx; on Linux the compose file maps `host.docker.internal` to the host gateway (Docker Desktop provides it natively). Written to spec in a daemon-less environment — expect to smoke-test the first build.

## MCP (read-only external access)

`POST /mcp` exposes a [Model Context Protocol](https://modelcontextprotocol.io/) Streamable HTTP endpoint for external AI clients (Cursor IDE, Claude Code, etc.).

**Read tools:** `search_kb`, `get_document`, `list_documents`, `list_tags`, `get_document_versions`, `list_review_items`.

**Writes are intentionally not on MCP.** Ingest content via `POST /knowledge-bases/:id/ingestions`; resolve review via `POST /review-items/:id/{context|skip|approve|reject}`.

LM Studio remains the pipeline LLM provider (`src/providers/lmstudio.ts`). MCP is a query surface only.

Set `MCP_TOKEN` in `.env` before connecting from Cursor (see [docs/CURSOR-MCP.md](docs/CURSOR-MCP.md)).
Mutating HTTP routes accept `API_TOKEN` when set; GET routes stay public.

> Leave tokens empty for local dev and offline tests. Set both before shared-network or remote deploy.

## Testing & evals
- `pnpm test` — 53 tests: unit (config, chunker, RRF, hashing, templates), contract (repositories, structured-output retry/bounded-failure), pipeline integration (dedup short-circuit, planted-conflict reconciliation with scripted tool transcripts, park/resume review flows, page-eligibility flip, proposal tool-call loop), API smoke over `app.request` (including MCP initialize), and architecture guards (client-import isolation enforced by reading the source tree).
- `pnpm eval` — golden end-to-end scenarios with deterministic pass/fail and nonzero exit for CI gating. Same harness can be pointed at live providers later for model-regression checks.
- Mock model turns are strict FIFO; tests assert on the transcript (e.g. that `checkName` results actually reached the model before it resolved a misspelling).

## Operating notes
- **Changing embedding models**: update `EMBEDDING_MODEL` + `EMBEDDING_DIMENSION`, re-run `pnpm db:vector-index` + apply, then regenerate chunks (re-save current versions through `VersioningService` or write a backfill that calls `SearchService.regenerateChunks`). Chunks self-describe their model/dimension, so stale rows are detectable.
- **Step budget / thresholds**: `RECONCILIATION_STEP_BUDGET`, `PROPOSAL_STEP_BUDGET`, `AUTO_APPLY_CONFIDENCE_THRESHOLD`, chunk sizing, and search leg weights are env-tunable (see `.env.example`).
- **Swapping in the Agents SDK**: implement `ReconciliationEngine` (`src/pipeline/reconciliation/engine.ts`) using the SDK, reuse `createReconciliationTools` definitions as function tools, inject via `buildPipeline`.
- **Queue**: `JobRunner` is deliberately queue-shaped (claim → advance one step). Replacing it with pg-boss/Graphile Worker touches `src/jobs/runner.ts` only.

## Deferred (per plan §13)
Auth/multi-user permissions on the API; a real job queue; rich diff/merge for near-duplicate re-imports (currently flag-and-continue); pgvector index tuning beyond the generated HNSW defaults; live-model eval harness wiring; UI.
