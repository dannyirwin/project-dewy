# Contributing

Human or agent, the rules are the same. Canonical agent instructions: [AGENTS.md](../AGENTS.md). Architecture: [docs/ARCHITECTURE.md](ARCHITECTURE.md). Decisions: [docs/adr/](adr/) — binding until superseded.

## Setup

```bash
pnpm install
pnpm typecheck && pnpm test && pnpm eval   # fully offline; should be green before you touch anything
```

Live stack (only needed for `pnpm dev`/`pnpm seed`, never for tests): see the README runbook (`supabase start`, vector index generation, LM Studio, or the Docker compose path).

## Definition of done

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm eval
```

All four, locally, before any PR. The suite must stay runnable with no database and no LLM.

## Workflow expectations

- **Read the relevant ADR first.** Changing versioning behavior? ADR-0005. Touching the data layer? ADR-0004. Disagree with a decision → write a superseding ADR in the same PR, don't silently diverge.
- **Migrations are append-only.** New schema = new timestamped file in `supabase/migrations/`. Never edit an applied migration. Schema changes ride with matching updates to `src/domain/schemas.ts` and **both** repository implementations.
- **Schemas first.** New shapes start in `src/domain/schemas.ts`; everything else parses through them.
- **Formatting/lint** is Biome: `pnpm exec biome check --write src test scripts` to auto-fix, `pnpm lint` must be clean. Don't relax rules to get green.
- **Tests accompany behavior.** Mechanism changes → unit/integration test; end-to-end behavioral contracts → also a scenario in `scripts/eval.ts`. When scripting `MockChatProvider`, remember it's strict FIFO — push turns in the exact order the pipeline calls the model (classify → reconcile → proposal → eligibility-per-create_document).
- **Commits/PRs**: small and scoped; explain *why* in the description; reference ADRs where relevant.

## Common recipes

**Add an action type**
1. Extend `ActionTypeSchema` in `src/domain/schemas.ts`.
2. In `src/actions/index.ts`: payload schema, `validate` (guardrails; set `requiresReview` for policy-gated cases), idempotent `apply`, register in `actionRegistry`.
3. Add it to the prompt's action list in `src/pipeline/stages/propose.ts` and to `APPLY_ORDER`.
4. Tests in `test/actions.test.ts` (validate + apply + idempotent re-apply + guardrails).

**Add a reconciliation tool**
1. `src/pipeline/reconciliation/tools.ts`: Zod-parameterized definition + deterministic `execute` branch.
2. Mention it in the engine's system prompt if the model should be steered toward it.
3. Test via a scripted `tool_calls` turn asserting on the tool result reaching the transcript.

**Add a repository method**
`interfaces.ts` → `memory/` (full semantics) → `supabase/` (mapper/RPC) → contract test in `test/repositories.test.ts`.

**Add an endpoint**
`src/api/app.ts` with `createRoute` + Zod request/response schemas (OpenAPI regenerates itself); smoke-test via `app.request` in `test/api.test.ts`.

**Add config**
`src/config/index.ts` with a dev-safe default + document it in `.env.example`.

## Project conventions

- ESM with `.js` extensions on relative imports (yes, from `.ts` files).
- Zod **v4** API: `z.uuid()`, `z.toJSONSchema(schema)`, `z.record(z.string(), z.unknown())`.
- No build step — `tsx` runs sources; don't add `dist/` artifacts.
- Structured JSON logging via `src/logging`; log lines in test output are expected.
- Never commit `.env`, `supabase/generated/`, or `node_modules`.
