# ADR-0010: Stack — TypeScript strict ESM, pnpm, Hono + zod-openapi, Vitest, Supabase, Zod v4

Status: Accepted

## Context
We want one schema language end-to-end (DB rows, API shapes, LLM structured outputs), an HTTP layer whose OpenAPI document cannot drift from the code, and a fully offline test story.

## Decision
- TypeScript strict, NodeNext ESM (relative imports use `.js` extensions), run from source via `tsx` (no build step).
- **Zod v4** schemas in `src/domain/schemas.ts` are the single source of truth (`z.uuid()`, `z.toJSONSchema()`, `z.record(k, v)` two-arg form).
- Hono + `@hono/zod-openapi`: routes declared with Zod schemas; `/openapi.json` is generated, never hand-written.
- Vitest for tests; Biome for lint/format; pnpm for packages; Supabase CLI migrations for schema.
- LLM access through the `openai` SDK pointed at LM Studio's OpenAI-compatible server — isolated to one provider file.

## Consequences
- Schema drift between layers is structurally impossible without failing parses.
- Zod v4 API differences from v3 are a known trap for contributors (documented in AGENTS.md).
