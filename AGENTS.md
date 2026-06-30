<!-- dotfiles:shared-agents -->

# Agent instructions

These are common instructions for Danny's agents across all scenarios.

## General Guidelines

- Never use the em dash (—).
  Use a plain hyphen (-) instead.
- When writing commit messages, never auto-add your agent name as co-author.
- Never manually modify CHANGELOG.md files or any files that are marked as
  auto-generated.
- When writing or substantially editing long Markdown files, put each full
  sentence on its own line.
  Preserve normal Markdown structure, but avoid wrapping multiple sentences
  onto one physical line.
- When making technical decisions, do not give much weight to development cost.
  Instead, prefer quality, simplicity, robustness, scalability, and long-term
  maintainability.
- When doing bug fixes, always start by reproducing the bug in an E2E setting
  that matches how an end user would interact.
  This makes sure you find the real problem so your fix will actually solve it.
- When end-to-end testing a product, be picky about the UI you see and be
  obsessed with pixel perfection.
  If something clearly looks off, even if it is not directly related to what you
  are doing, try to get it fixed along the way.
- Apply the same high standard to engineering excellence: lint, test failures,
  and test flakiness.
  If you see one, even if it is not caused by what you are working on right now,
  still get it fixed.

## Danny's Opinions

When work would benefit from Danny's taste or beliefs, read `.agents/OPINIONS.md`.
Start with the engineering and tooling sections; treat empty sections as unsettled.

## Project

**ai-wiki** — Postgres-backed wiki with a job queue and focused-step LLM agents
that distill raw content into structured documents.

### Commands

```bash
npm install
npm run dev:server      # Hono on :3000
npm run dev:worker      # job runner
npm run dev:scheduler   # cron enqueuer
npm run distill -- <file> <source_type>   # inline distill (no queue)
npm run ingest          # load sample docs
```

Requires Supabase Postgres with `sql/schema.sql` applied and a filled `.env`
(see README).

### Architecture

- **Server** (`src/server.ts`) — Hono HTTP: `/mcp`, `/tasks/distill`, `/tasks/enqueue`
- **Worker** (`src/worker.ts`) — polls `jobs` table, dispatches handlers
- **Agents** (`src/agents/`) — small single-purpose LLM calls (classify, extract,
  reconcile, distill)
- **LLM** — provider-agnostic via `src/llm/index.ts` (`LLM_PROVIDER`, `LLM_MODEL`)

### Cursor Cloud

- Agent bundle: `implement-plan` (skills, subagents, plan-sync hook)
- Shared opinions: `.agents/OPINIONS.md`
- Plans live under `.cursor/plans/` when using the implement-plan workflow

### Agent skills

Bundled orchestration skills (committed under `.cursor/skills/`):

- `implement-plan` — parse a plan file, spawn phase implementers, run verifier
- `code-review` — diff review invoked by `plan-verifier`

Locked external skills (`skills-lock.json`; installed to `.agents/skills/`):

- `gh-axi`, `lavish`, `skill-creator`

After clone, restore external skills:

```bash
npx skills experimental_install
```

Re-apply the dotfiles bundle (without skipping skills):

```bash
bash ~/dotfiles/scripts/apply-project.sh ~/src/project-dewy
```
