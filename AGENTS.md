# AGENTS.md

Canonical instructions for AI coding agents (Claude Code, Cursor, Codex, Copilot, aider, …) working in this repository. `CLAUDE.md` and `.github/copilot-instructions.md` are pointers to this file — edit **this** file only.

## What this project is

An LLM-powered, wiki-style knowledge management system. Raw notes go through a persisted pipeline — classify → reconcile (tool-driven) → propose/apply structured edits — with human review gates, full versioning/audit/rollback, and hybrid retrieval (pgvector + FTS + RRF). Read `README.md` for the product view and `docs/ARCHITECTURE.md` for the technical map. Architecture decisions are recorded in `docs/adr/` — **read the relevant ADR before changing anything it covers; ADRs are binding until superseded by a new ADR.**

## Environment & commands

- Node ≥ 22, pnpm (not npm/yarn). TypeScript strict, **ESM**: relative imports require the `.js` extension even from `.ts` files (`import x from "./y.js"`).
- `pip`-style global installs don't apply; for Python anything, not this repo.

| Task | Command |
|---|---|
| Install | `pnpm install` |
| Typecheck | `pnpm typecheck` |
| Lint/format (Biome) | `pnpm lint` — auto-fix with `pnpm exec biome check --write src test scripts` |
| Tests (Vitest) | `pnpm test` — subset: `pnpm exec vitest run test/<file>.test.ts` |
| Golden evals | `pnpm eval` (nonzero exit on failure) |
| Run API (live stack) | `pnpm dev` / `pnpm start` |

**Definition of done for any change:** `pnpm typecheck && pnpm lint && pnpm test && pnpm eval` all pass. Tests and evals run fully offline (in-memory repos + mock providers) — never require a database or LLM to make the suite pass.

## Hard invariants (mechanically enforced — `test/architecture.test.ts` will fail your PR)

1. `@supabase/supabase-js` is imported (as a value) in exactly one file: `src/db/client.ts`. Business logic depends on `src/repositories/interfaces.ts` only.
2. The `openai` SDK is imported only in `src/providers/lmstudio.ts`. Everything else uses the `ChatProvider`/`EmbeddingProvider` interfaces.
3. `src/repositories/supabase/` is imported only by composition roots (`src/api/server.ts`, scripts).

## Invariants enforced by convention (do not break)

- **Every document mutation goes through `VersioningService`** (`src/versioning/`): immutable version rows + audit log + chunk regeneration. Never write `document_version` or update `current_version_id` directly from feature code.
- **Embedding dimension is config-driven** (`EMBEDDING_DIMENSION`). Never hardcode a vector dimension in migrations, schemas, or code. Chunks self-describe `embedding_model` + `dimension`. The pgvector index DDL is *generated* (`pnpm db:vector-index`), not in a migration.
- **`knowledge_base_id` on every domain table and every query.** No cross-KB reads or writes except explicit guardrails (e.g. `cross_kb_link` validation).
- **Zod schemas in `src/domain/schemas.ts` are the single source of truth.** DB rows, API request/response shapes, and LLM structured outputs all parse through them. This repo uses **Zod v4**: `z.uuid()`, `z.toJSONSchema(schema)`, `z.record(z.string(), z.unknown())`.
- **Pipeline steps must be idempotent.** The state machine re-runs the step for whatever state it finds after a crash; steps re-derive outputs (see the re-run guards in `src/pipeline/stages/*.ts`) rather than assume partial work.
- **LLM output is never trusted.** Structured outputs are schema-validated with bounded retries (`StructuredOutputError` on exhaustion). Proposed actions go through `validateAction` guardrails before `applyAction`. Don't add a code path that applies model output without deterministic validation.
- **Fail loud, fail safe.** Budget exhaustion → `needs_review`, not silence. Illegal state transitions → job `failed` with the error recorded.

## Testing conventions

- `test/helpers.ts` builds the offline stack (`buildTestStack`) and scripted turns. **`MockChatProvider` is strict FIFO** — push turns in the exact order the pipeline calls the model: classify → reconcile turns → proposal → eligibility (eligibility is consulted *after* the proposal turn, per `create_document` candidate, only when the deterministic gate passes and `use_llm_judgment` is true).
- Integration tests assert on transcripts (e.g. tool results reaching the model) via `kind: "fn"` turns.
- New behavior needs a test; new end-to-end behavioral contracts belong in `scripts/eval.ts` too.
- JSON log lines in test output are expected noise.

## Where to add things

| You want to… | Touch |
|---|---|
| New action type | `src/domain/schemas.ts` (ActionType), `src/actions/index.ts` (payload schema + validate + idempotent apply + registry), prompt list in `src/pipeline/stages/propose.ts`, tests in `test/actions.test.ts` |
| New reconciliation tool | `src/pipeline/reconciliation/tools.ts` (Zod-parameterized definition + deterministic execute) |
| Swap in OpenAI Agents SDK | Implement `ReconciliationEngine` (`src/pipeline/reconciliation/engine.ts`), inject via `buildPipeline({ reconciliationEngine })`. ADR-0001. |
| New repository method | `src/repositories/interfaces.ts` first, then BOTH `memory/` and `supabase/` implementations |
| New API endpoint | `src/api/app.ts` via `createRoute` with Zod schemas (OpenAPI is generated — never hand-edit a spec) |
| Schema change | New file in `supabase/migrations/` (never edit applied migrations) + `src/domain/schemas.ts` + both repository impls |
| New config knob | `src/config/index.ts` with a dev-safe default + `.env.example` |

## Things that look wrong but are deliberate

- `supabase/migrations/...init.sql` declares `embedding vector` with **no dimension** — see ADR-0002.
- `JobRunner` is a plain `setInterval` loop — the boundary is queue-shaped on purpose; see ADR and `src/jobs/runner.ts` header.
- `awaiting_review` is a **paused** state: `runToCompletion` won't advance it; only `ReviewService.maybeResume` takes the explicit step out.
- The repo runs from TS sources via `tsx` (no build/dist step).
- Docker compose runs only the API; `supabase start` owns the DB containers and LM Studio runs on the host.

## Scope & safety rails for agents

- Don't re-litigate ADR decisions in code; propose a superseding ADR instead.
- Don't commit `.env`, generated files (`supabase/generated/`), or `node_modules`.
- Don't weaken lint rules or delete failing tests to get green; fix the code or discuss in the PR.
- Keep diffs scoped; run the full gate before declaring done.
