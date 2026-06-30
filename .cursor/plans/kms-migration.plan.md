# KMS migration plan

Replace the legacy ai-wiki staging tree with the KMS codebase, fix ADR-0005,
extend Stage 3 to a tool-call loop, add a read-only MCP server, and update docs.
**LM Studio stays the default LLM provider** — no Anthropic/multi-provider facade in this pass.

## Handoff

### Start here

```bash
git fetch origin
git checkout cursor/dotfiles-agent-setup-4e38   # or branch from it
# implement:
/implement-plan .cursor/plans/kms-migration.plan.md
```

### Current repo state (as of handoff)

| Item | Status |
|------|--------|
| Branch `cursor/dotfiles-agent-setup-4e38` | Dotfiles + skills committed; PR #2 |
| `kms/` extracted from `kms.zip` | Present locally, **not** at repo root yet |
| `ai-wiki/` legacy tree | Still at repo root / zip — **remove in Phase 1** |
| Agent bundle | `.cursor/skills/implement-plan`, `code-review`, subagents, plan-sync hook |
| External skills | `skills-lock.json` + `npx skills experimental_install` |
| KMS baseline | `cd kms && pnpm install && pnpm typecheck && pnpm lint && pnpm test && pnpm eval` — 52 tests, 4 eval scenarios, all offline |

### Provider decision (locked for this plan)

- **Keep** `LmStudioChatProvider` / `LmStudioEmbeddingProvider` in `src/providers/lmstudio.ts`.
- **Do not** add Anthropic default or `@ai-sdk/*` facade in this pass.
- LM Studio via `openai-compatible` URLs is the dev/prod default until a later plan.
- Cursor IDE is the MCP **client**, not an inference backend for the KMS pipeline.
- Tests use `MockChatProvider` — gate must pass with **zero** API keys.

### Parallelization (for implement-plan)

```
Phase 1 (sequential first — blocks everything)
    ↓
Phase 2 ─┬─ Phase 5   (parallel after Phase 1)
         └─ (Phase 3 skipped)
    ↓
Phase 4 (depends on Phase 1; touches propose stage + tests)
    ↓
Phase 6 (docs — after 2, 4, 5 land)
    ↓
Phase 7 (commits / PR — continuous during work, summarized at end)
```

---

## Phase 1 — Replace codebase

**Depends on:** nothing (run first).

### Tasks

1. Copy the `kms/` tree to the **repository root** (not a `kms/` subdirectory).
2. Merge dotfiles scaffolding from `cursor/dotfiles-agent-setup-4e38`:
   - Keep: `.cursor/`, `.agents/`, `skills-lock.json`, skills-related `.gitignore` entries.
   - Use **KMS's `AGENTS.md`** as the project agent file (Phase 6 will extend it).
3. Delete all legacy ai-wiki artifacts:
   - `ai-wiki.zip`, `kms.zip`
   - `ai-wiki/` directory
   - Root stubs: `distill.ts`, `index.ts`, `schema.sql`, old `README.md`
   - `mnt/user-data/outputs/ai-wiki/` if present
4. Run gate from repo root:

```bash
pnpm install
pnpm typecheck && pnpm lint && pnpm test && pnpm eval
```

All **52 tests** and **4 eval scenarios** must pass offline before continuing.

---

## Phase 2 — Fix ADR-0005

**Depends on:** Phase 1.
**Can run in parallel with:** Phase 5 (after Phase 1).

### Tasks

1. Read `src/versioning/index.ts` — `rollback()` **repoints** `current_version_id` to an existing `document_version` row; it does **not** create a new version row.
2. Update `docs/adr/0005-versioning-audit-rollback.md` to describe the repoint implementation accurately.
3. Do **not** change `VersioningService.rollback()` behavior unless tests prove the ADR intent was code, not docs (it is docs-only).

---

## Phase 3 — Multi-provider facade

**Status: DEFERRED — skip entirely for this plan.**

LM Studio (`src/providers/lmstudio.ts`) remains the only live provider.
Document in Phase 6 only.

---

## Phase 4 — Extend tool calls into Stage 3 (propose)

**Depends on:** Phase 1.

### Problem

Stage 3 currently calls `chat.complete({ schema: ProposalSchema })` and expects one JSON blob with up to 30 actions.
One invalid action invalidates the whole proposal.

### Solution

Replace structured-output batch with a **tool-call loop** (same pattern as `src/pipeline/reconciliation/thinLoop.ts`).

### Before / after

```
Before: chat.complete({ schema: ProposalSchema })  →  [array of up to 30 raw actions]

After:  tool-call loop where the LLM calls:
          propose_create_document(payload)
          propose_append_section(payload)
          propose_update_section(payload)
          propose_upsert_link(payload)
          propose_create_tag(payload)
          propose_apply_tag(payload)
          propose_promote_subsection(payload)
          done()   ← signals end of proposal turn
```

Each `propose_*` tool validates its payload with the existing Zod schemas from `src/domain/schemas.ts` / `src/actions/index.ts` immediately.
Invalid payloads return an error in the tool response so the LLM can self-correct.
`done()` ends the loop.

### Tasks

1. New file: `src/pipeline/stages/propose-tools.ts` — seven proposal tools + `done`.
2. Add `PROPOSAL_STEP_BUDGET` to `src/config/index.ts` (dev-safe default, mirror `RECONCILIATION_STEP_BUDGET`).
3. Update `src/pipeline/stages/propose.ts` to use the tool-call loop instead of `generateObject` / `ProposalSchema` batch.
4. Update `test/helpers.ts` scripted turns for Stage 3 tool-call sequences.
5. Update `test/actions.test.ts` and `test/stateMachine.test.ts` as needed.
6. Update `scripts/eval.ts` golden scenarios if proposal transcript shape changed.

### Gate

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm eval
```

---

## Phase 5 — MCP server (read-only external access)

**Depends on:** Phase 1.
**Can run in parallel with:** Phase 2 (after Phase 1).

### Separation of concerns

| Layer | Purpose |
|-------|---------|
| **MCP** | External AI clients (Cursor IDE, Claude Code) querying the KB |
| **Pipeline tool calls** | Internal LLM loops (reconciliation, proposal) |

MCP tools are **read-only**.
Writes go through HTTP API (`POST /knowledge-bases/{id}/ingestions`, `POST /review-items/{id}/{approve|reject|skip|context}`) — human-gated, not exposed on MCP.

### Tasks

1. `pnpm add @modelcontextprotocol/sdk`
2. New file: `src/mcp/server.ts` — MCP factory injected with `Repositories` (+ `SearchService` if needed).
3. MCP read tools:

| Tool | KMS capability |
|------|----------------|
| `search_kb` | Hybrid semantic + FTS, KB-scoped |
| `get_document` | Full body + metadata by slug or UUID |
| `list_documents` | KB-scoped document list |
| `list_tags` | Tag list with counts |
| `get_document_versions` | Full version history |
| `list_review_items` | Pending review items for human triage |

4. Mount at `POST /mcp` in `src/api/app.ts`.
5. Add API smoke test in `test/api.test.ts`.

Note: MCP is intentionally unauthenticated for now; document auth follow-up in README.

---

## Phase 6 — Docs update

**Depends on:** Phases 2, 4, 5.

### Tasks

1. **`AGENTS.md`** (KMS base + additions):
   - `## Cursor Cloud` section: no `~/.agents` symlink; use committed `.agents/`; restore skills via `npx skills experimental_install`.
   - Note on `POST /mcp` endpoint.
   - Where-to-add table rows:
     - New MCP tool → `src/mcp/server.ts`
     - New proposal tool → `src/pipeline/stages/propose-tools.ts`
   - LM Studio as default provider (not Anthropic).

2. **`README.md`**: KMS runbook, LM Studio provider config, MCP section.

3. **`docs/adr/0005`**: rollback description fix (if not done in Phase 2).

4. **New `docs/adr/0012-proposal-tool-call-loop.md`**: document Stage 3 change from structured-output batch to tool-call-per-action, with rationale.

---

## Phase 7 — Commits and PR

Each commit only after its phase gate passes.

| Commit message | Phase |
|----------------|-------|
| `chore: replace ai-wiki with KMS codebase` | 1 |
| `docs: fix ADR-0005 rollback description` | 2 |
| `feat: extend Stage 3 proposal to tool-call loop` | 4 |
| `feat: add read-only MCP server endpoint` | 5 |
| `docs: update AGENTS.md, README, add ADR-0012` | 6 |

Open PR against `main`.
Branch name: `cursor/kms-migration-4e38` (or continue on `cursor/dotfiles-agent-setup-4e38` if preferred).

---

## Acceptance criteria

| # | Criterion | How to verify |
|---|-----------|---------------|
| 1 | KMS is the repo root codebase (no `kms/` subdir, no ai-wiki artifacts) | `ls` root; `git ls-files` has `src/`, `supabase/`, no `ai-wiki.zip` |
| 2 | Dotfiles scaffolding present | `.cursor/skills/implement-plan/`, `skills-lock.json`, `.agents/OPINIONS.md` |
| 3 | All 52+ tests pass offline | `pnpm test` exits 0 |
| 4 | Eval passes offline | `pnpm eval` exits 0, 4/4 scenarios |
| 5 | Typecheck + lint clean | `pnpm typecheck && pnpm lint` |
| 6 | ADR-0005 matches `VersioningService.rollback()` repoint behavior | Read ADR + `src/versioning/index.ts` |
| 7 | Stage 3 uses tool-call loop, not batch `ProposalSchema` | `propose-tools.ts` exists; `propose.ts` has loop |
| 8 | MCP mounted at `POST /mcp` with 6 read tools | `src/mcp/server.ts`; smoke test in `test/api.test.ts` |
| 9 | LM Studio provider unchanged | `src/providers/lmstudio.ts` still wired in `src/api/server.ts` |
| 10 | Docs updated | `AGENTS.md`, `README.md`, `docs/adr/0012-*.md` |

---

## Out of scope (follow-ups)

- Anthropic / OpenAI multi-provider facade (`@ai-sdk/*`)
- MCP authentication (bearer token)
- Real job queue (pg-boss / Graphile)
- UI for review workflow
