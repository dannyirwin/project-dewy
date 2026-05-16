# ai-wiki

A content-agnostic, AI-agent-friendly wiki with provider-agnostic LLM,
a Postgres-backed job queue, and a focused-step agent that distills raw
content (transcripts, notes, summaries) into structured wiki documents.

```
                                              ┌──────────────────┐
                                              │  LLM provider    │
  ┌──────────────┐    ┌──────────────────┐    │  (Anthropic /    │
  │  Hono HTTP   │    │  Worker process  │ ── │   OpenAI /       │
  │              │    │                  │    │   Ollama / etc.) │
  │ POST /mcp    │    │  poll → handler  │    └──────────────────┘
  │ POST /tasks/ │    │  → agent → tools │
  │ GET  /health │    │                  │    ┌──────────────────┐
  └──────┬───────┘    └────────┬─────────┘    │  Embedding       │
         │                     │              │  provider        │
         │ enqueue             │              │  (one, pinned)   │
         ▼                     │              └──────────────────┘
  ┌──────────────────────────────────────────────────────────┐
  │  Postgres (Supabase): documents, chunks, relations,       │
  │  jobs, agent_runs + pgvector + full-text search           │
  └──────────────────────────────────────────────────────────┘
         ▲
         │ cron enqueues maintenance jobs
  ┌──────┴──────┐
  │  Scheduler  │
  └─────────────┘
```

## What's in the box

**Storage** — Supabase Postgres + pgvector. Five tables:
- `documents` — wiki pages with `metadata jsonb` (content-agnostic)
- `chunks` — embedded slices, hashed for change-detection
- `relations` — typed edges between documents (agent-generated)
- `jobs` — Postgres-backed work queue with SKIP LOCKED semantics
- `agent_runs` — audit log of every agent invocation with token usage

**Server** — Hono, runs anywhere Node runs (Fly, Lambda + Web Adapter, local).
- `POST /mcp` — MCP over HTTP (read-only tools)
- `POST /tasks/distill` — submit content for agent processing
- `POST /tasks/enqueue` — generic job enqueue

**Worker** — long-running process that polls the jobs table and dispatches.
- Atomic claim via `claim_next_job()` RPC
- Exponential backoff retry, max_attempts honored
- Handlers registered in `src/jobs/handlers.ts`

**Scheduler** — node-cron process that enqueues jobs on a schedule.
- 15-minute: re-embed any stale (NULL-embedding) chunks
- 03:00 UTC: nightly housekeeping hook

**Agents** — composed of focused single-purpose LLM calls.
- `classify` — propose title, summary line, tags, doc type
- `extract_entities` — typed entities (person, project, decision, etc.)
- `reconcile` — match each entity to existing docs (retrieval → LLM judge)
- `distill` — orchestrates the above, writes the doc, links relations

**Tools** — `src/tools/` — plain functions wrapped as AI SDK tools.
- Read: `search_kb`, `get_document`, `list_tags`, `list_documents`, `relations_for`
- Write: `create_document`, `update_document`, `link_documents`

## Setup

1. Create a Supabase project (free tier is fine). Open SQL editor → run `sql/schema.sql`.
2. `cp .env.example .env` and fill in.
3. `npm install`
4. `npm run ingest` — loads sample docs.
5. In three terminals:
   ```bash
   npm run dev:server     # Hono on :3000
   npm run dev:worker     # job runner
   npm run dev:scheduler  # cron enqueuer
   ```

## Provider-agnostic LLM

Pick one in `.env`:

```bash
# Anthropic
LLM_PROVIDER=anthropic
LLM_MODEL=claude-sonnet-4-5-20250929
ANTHROPIC_API_KEY=sk-ant-...

# OpenAI
LLM_PROVIDER=openai
LLM_MODEL=gpt-4o-mini
OPENAI_API_KEY=sk-...

# Anything OpenAI-compatible (Ollama, vLLM, LM Studio, OpenRouter, Together, Groq)
LLM_PROVIDER=openai-compatible
LLM_MODEL=llama3.1:8b
LLM_BASE_URL=http://localhost:11434/v1
LLM_API_KEY=ollama
```

The rest of the code never touches a provider SDK — it imports `model()` from
`src/llm/index.ts`. Same agent, same prompts, same tool definitions across
providers.

**Caveat on local models:** the agents use Zod-schema structured outputs and
tool calling. Frontier models nail both; smaller local models (≤13B) are weaker.
The architecture mitigates this by keeping each LLM call small and
single-purpose — each step asks for one Zod object, not a multi-step agentic
plan. A 7B model can hit that reliably even if it would fall over on a
monolithic prompt.

## Embeddings: pinned, not swappable

Each provider produces vectors in its own space and dimension. You can't mix
them in one pgvector column. So you pick one embedding model at project start
and commit:

| Model | Dim | Provider |
|---|---|---|
| `text-embedding-3-small` (default) | 1536 | OpenAI |
| `text-embedding-3-large` | 3072 | OpenAI |
| `nomic-embed-text` | 768 | Ollama |
| `mxbai-embed-large` | 1024 | Ollama |

To switch later: change `EMBEDDING_DIM` in `.env`, change `vector(N)` in
`sql/schema.sql` (two places), recreate the schema, re-ingest everything.

## Submitting work to the agent

Three ways, same result:

```bash
# 1. CLI, runs inline (no queue) — great for iterating on prompts
npm run distill -- content/examples/meeting-q3-solar-pricing.txt transcript

# 2. REST, enqueues
curl -X POST http://localhost:3000/tasks/distill \
  -H 'Content-Type: application/json' \
  -d "$(jq -n --rawfile content content/examples/meeting-q3-solar-pricing.txt \
         '{content: $content, source_type: "transcript"}')"

# 3. From your own code
import { enqueue } from "./jobs/enqueue.js";
await enqueue({
  kind: "distill",
  payload: { content, source_type: "notes", metadata: { date: "..." } },
  idempotencyKey: `mtg-${meetingId}`,
});
```

The worker picks it up, runs the agent, creates docs and relations, and
writes an `agent_runs` row with token usage.

## What the distill agent actually does

For the sample meeting transcript:

1. **Classify** (one LLM call, JSON schema)
   → title="Q3 Solar Pricing Review", doc_type="meeting-notes",
     tags=["pricing", "solar", "california"]
2. **Extract entities** (one LLM call, JSON schema)
   → [Sara (person), Marcus (person), Priya (person), Tom (person),
      NEM 3.0 (topic), Q3 Pricing Review (project), bundled-default decision (decision), ...]
3. **Reconcile each entity** (1 embedding search + 1 LLM call each)
   → "NEM 3.0" matches existing `solar-ca-nem3`. New people get stub docs.
4. **Generate the doc body** (one LLM call, free-form markdown)
   → Sections for context, decisions, action items, with inline links to
     matched docs.
5. **Apply deterministically** — `upsertDocument`, `linkDocuments` for each
   reconciled entity. Stubs for new entities. Audit row in `agent_runs`.

Total: ~7 small LLM calls, each with a tight schema. Compare to a single
"do everything" prompt: less reliable, harder to debug, harder to swap models.

## Token-conscious patterns used in the code

The user said "as much deterministic as possible, token-conscious." Concrete
applications throughout the code:

- **Hash-based chunk dedupe** — `rebuildChunks` hashes each chunk; embedding
  calls happen only for changed chunks. Edit workflows save the majority of
  embedding spend.
- **Retrieval before LLM judgment** — `reconcile` does an embedding search
  first, then passes only the top 5 candidates to the LLM. Constant-size
  prompt regardless of KB size.
- **Structured outputs everywhere** — `generateObject` with Zod schemas means
  shorter completions and no prose parsing.
- **Short-circuit when results are empty** — `reconcile` skips the LLM
  entirely if there are zero candidates; the answer is deterministically
  "create_new".
- **Many small calls vs. one big agent loop** — easier to use cheap models
  for triage steps and expensive ones for synthesis. Easier to cache. Easier
  to debug.
- **Token usage recorded per run** — `agent_runs.tokens_in / tokens_out`
  per agent invocation. Query this table to find hot spots.

## Deployment

### Fly.io

Hono + node-server runs unchanged in a container. The server, worker, and
scheduler are three Node processes — deploy as either:
- Three Fly Machines (cleanest separation), or
- One container running all three via a process manager (simpler, fine at small scale)

Minimal Dockerfile:

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
RUN npm run build
CMD ["node", "dist/server.js"]
```

### AWS Lambda

The Hono `app` exports cleanly:

```ts
// src/lambda.ts
import { handle } from "hono/aws-lambda";
import { app } from "./server.js";
export const handler = handle(app);
```

Two caveats:
- The `/mcp` route uses `c.env.incoming`/`c.env.outgoing` from `@hono/node-server`.
  On Lambda use the **Lambda Web Adapter** extension to keep that code path
  unchanged — it gives the function a Node HTTP server inside.
- The worker is a long-running poll loop, not Lambda-shaped. Either:
  - Keep the worker on Fly / ECS / a small VM, or
  - Replace polling with **EventBridge Pipes** from a Postgres stream, or
  - Skip the queue table and trigger handler Lambdas directly from API Gateway
    (loses retry/audit nicety).

### Auth before you deploy

The `/mcp` and `/tasks/*` endpoints are unauthenticated. Add bearer auth
before exposing publicly:

```ts
import { bearerAuth } from "hono/bearer-auth";
app.use("/mcp", bearerAuth({ token: process.env.MCP_TOKEN! }));
app.use("/tasks/*", bearerAuth({ token: process.env.TASK_TOKEN! }));
```

## Scaling notes

| Stage | What changes |
|---|---|
| Prototype (≤ 10k chunks) | Supabase free, single Node process for everything. |
| Small prod (≤ 100k chunks) | Supabase Pro. Server / worker / scheduler in separate Fly Machines. |
| Medium (≤ 1M chunks) | Tune HNSW; multiple workers (skip-locked already supports this); cache hot search queries. |
| Large | Move embeddings to Turbopuffer / Pinecone; documents stay in Postgres. The MCP and agent code don't change. |

## Layout

```
ai-wiki/
├── sql/schema.sql
├── src/
│   ├── server.ts                  # Hono entrypoint
│   ├── worker.ts                  # worker entrypoint
│   ├── scheduler.ts               # cron entrypoint
│   ├── ingest.ts                  # markdown → docs
│   ├── query.ts                   # CLI search
│   ├── content-hash.ts            # sha256, slugify, normalize
│   ├── db.ts                      # Supabase client
│   ├── llm/index.ts               # provider-agnostic LLM facade
│   ├── embeddings/index.ts        # embedding facade
│   ├── tools/
│   │   ├── index.ts               # AI SDK tool wrappers
│   │   ├── search.ts              # searchKb, listTags, listDocuments
│   │   ├── documents.ts           # CRUD + chunking + hash-dedupe
│   │   └── relations.ts           # typed edges
│   ├── agents/
│   │   ├── classify.ts            # focused LLM call
│   │   ├── extract-entities.ts    # focused LLM call
│   │   ├── reconcile.ts           # retrieval + LLM
│   │   └── distill.ts             # orchestrator
│   ├── jobs/
│   │   ├── enqueue.ts             # insert into jobs table
│   │   ├── runner.ts              # poll loop
│   │   └── handlers.ts            # registered handlers
│   └── cli/distill.ts             # run distill inline, no queue
└── content/
    ├── solar-itc-federal.md       # sample wiki docs
    ├── solar-ca-nem3.md
    └── examples/
        └── meeting-q3-solar-pricing.txt   # sample input for distill
```
