# ADR-0004: Repository-isolated data layer; pgvector hard dependency

Status: Accepted

## Context
Business logic that imports a DB client directly is untestable offline and unswappable. At the same time, pretending we might leave Postgres/pgvector would cost real capability (vector + FTS in one store).

## Decision
- All data access behind interfaces in `src/repositories/interfaces.ts`. Two implementations: in-memory (tests, full semantics incl. cosine similarity over current-version chunks) and Supabase (thin row mappers + RPCs).
- `@supabase/supabase-js` is imported in exactly one file (`src/db/client.ts`); `src/repositories/supabase/` is imported only by composition roots. **Enforced mechanically** by `test/architecture.test.ts`.
- pgvector is a hard dependency; we do not abstract the vector store itself.

## Consequences
- The whole pipeline runs offline in tests; live verification is a runbook step.
- New repository methods must be implemented twice (interface → memory → supabase) — accepted cost.
- Semantic drift between the two implementations is the main risk; contract-style tests in `test/repositories.test.ts` mitigate it.
