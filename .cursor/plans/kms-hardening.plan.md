# KMS hardening and Cursor integration plan

Make KMS mergeable, CI-gated, live-verified against Supabase + LM Studio, and safely usable from Cursor via authenticated MCP.

**Prerequisite:** [PR #3](https://github.com/dannyirwin/project-dewy/pull/3) (`cursor/kms-migration-4e38`) merged or rebased onto `main`.

**Provider decision (locked):** LM Studio remains the pipeline LLM. No Anthropic/multi-provider facade in this plan.

---

## Goal (after shape)

- `main` runs the full offline gate in GitHub Actions on every PR.
- A human can stand up the live stack locally (Supabase + LM Studio) and complete one real ingestion end-to-end.
- Cursor connects to `POST /mcp` with bearer auth; read tools return KB data.
- `.env.example` documents all config knobs including `PROPOSAL_STEP_BUDGET`.

---

## Phase 1 — CI and repo hygiene

**Depends on:** nothing.

### Tasks

1. Add `.github/workflows/ci.yml`:
   - `pnpm install`
   - `pnpm typecheck && pnpm lint && pnpm test && pnpm eval`
   - Node 22, pnpm cache
2. Add `PROPOSAL_STEP_BUDGET` to `.env.example` (missing from migration).
3. Branch protection recommendation in PR description (require CI green before merge).

### Gate

Same commands as CI locally.

---

## Phase 2 — Live stack smoke (manual + scripted)

**Depends on:** Phase 1 (CI green on branch).

### Tasks

1. Add `docs/LIVE-STACK.md` (or extend README runbook) with ordered checklist:
   - `supabase start` → `supabase db push` → `pnpm db:vector-index` → apply generated DDL
   - LM Studio: load chat + embedding models matching `.env`
   - `pnpm dev` → `pnpm seed` (or curl ingest example)
2. Add `scripts/smoke-live.ts` (optional but preferred):
   - Requires `SUPABASE_*` + LM Studio env
   - Creates KB, ingests short note, asserts document + search hit
   - Exits nonzero on failure; **not** run in CI (needs live stack)
3. Document expected LM Studio models in README (chat + embed dims must match `EMBEDDING_DIMENSION`).

### Acceptance

Human (or agent with Docker + LM Studio) runs smoke script successfully once.

---

## Phase 3 — API and MCP authentication

**Depends on:** Phase 1.
**Can run in parallel with:** Phase 2.

### Problem

`/mcp` and write HTTP routes are unauthenticated. Unsafe before any remote deploy or shared network.

### Tasks

1. Add env vars to `src/config/index.ts` + `.env.example`:
   - `MCP_TOKEN` (required for `POST /mcp` when set; dev-safe: empty = auth disabled for local tests)
   - `API_TOKEN` (bearer auth for all mutating routes: ingestions, review-items, rollback, config updates)
2. Apply `bearerAuth` from Hono:
   - `POST /mcp` when `MCP_TOKEN` set
   - Mutating routes when `API_TOKEN` set
   - `GET` routes remain open OR also gated (document choice in ADR)
3. Update `test/api.test.ts` and MCP smoke test to pass token when env set in test config.
4. Add `docs/CURSOR-MCP.md`:
   - Example Cursor `mcp.json` / settings pointing at `http://localhost:3000/mcp`
   - Header: `Authorization: Bearer <MCP_TOKEN>`
   - List read tools and remind: writes via HTTP API only

### Gate

`pnpm typecheck && pnpm lint && pnpm test && pnpm eval` (offline gate unchanged).

---

## Phase 4 — Cursor end-to-end validation

**Depends on:** Phases 2 and 3.

### Tasks

1. With KMS running locally and MCP auth configured, connect Cursor MCP.
2. Verify from Cursor agent:
   - `search_kb` finds seeded content
   - `list_review_items` returns pending items after a conflict ingest
3. Capture any tool schema / transport issues; fix in `src/mcp/server.ts`.
4. Add troubleshooting section to `docs/CURSOR-MCP.md`.

### Acceptance

Manual checklist in plan PR description marked complete.

---

## Phase 5 — Deploy path (optional, pick one)

**Depends on:** Phase 3.

Choose one target; do not block Phases 1–4.

| Option | Work |
|--------|------|
| **Fly.io** | `fly.toml`, secrets for Supabase + tokens + LM Studio URL (or drop LM Studio for later) |
| **Local-only** | Document docker-compose + host LM Studio; no cloud deploy |

LM Studio on the host does not fly to cloud easily. For cloud deploy, either:
- Run LM Studio on a home machine and tunnel, or
- Defer cloud deploy until a cheap `openai-compatible` provider plan exists (separate future plan).

---

## Commits (suggested)

| Commit | Phase |
|--------|-------|
| `ci: add GitHub Actions gate and env.example fix` | 1 |
| `docs: live stack runbook and smoke script` | 2 |
| `feat: bearer auth for MCP and write API routes` | 3 |
| `docs: Cursor MCP connection guide` | 3–4 |

---

## Acceptance criteria

| # | Criterion | Verify |
|---|-----------|--------|
| 1 | CI runs offline gate on PRs | Green workflow on GitHub |
| 2 | `.env.example` complete | `PROPOSAL_STEP_BUDGET` + auth tokens documented |
| 3 | Live smoke script exists | `scripts/smoke-live.ts` or documented curl flow |
| 4 | MCP requires token when configured | 401 without bearer; 200 with |
| 5 | Write routes require token when configured | ingest without token → 401 |
| 6 | Offline tests still pass | 53+ tests, eval 4/4, zero API keys |
| 7 | Cursor MCP doc exists | `docs/CURSOR-MCP.md` with working example |

---

## Out of scope (later plans)

- Multi-provider facade (Anthropic / OpenAI / Groq)
- Real job queue (pg-boss / Graphile Worker)
- Review workflow UI
- Live-model eval harness (point `pnpm eval` at LM Studio for regression)
- Near-duplicate merge semantics
- Cheap cloud LLM for deploy without LM Studio

---

## Recommended execution order

```
Phase 1 (CI)
    ↓
Phase 2 ─┬─ Phase 3 (parallel)
         ↓
Phase 4 (Cursor validation)
    ↓
Phase 5 (optional deploy)
```

To implement: `/implement-plan .cursor/plans/kms-hardening.plan.md`
