# ADR-0002: Local embeddings via provider abstraction; config-driven dimension

Status: Accepted

## Context
Embeddings come from LM Studio locally today, but models (and their dimensions) will change. pgvector columns and indexes are dimension-sensitive; baking a dimension into a migration couples the schema to one model forever.

## Decision
- `EmbeddingProvider` interface; LM Studio implementation fails loudly when a returned vector's dimension mismatches `EMBEDDING_DIMENSION`.
- The migration declares `chunk.embedding` as `vector` **without** a dimension. The HNSW index + column type pin is *generated* DDL (`pnpm db:vector-index` → `supabase/generated/vector_index.sql`) from config, applied separately.
- Every chunk row records `embedding_model` and `dimension`, so mixed/stale chunks are detectable and re-embeddable.

## Consequences
- Changing models = config change + regenerate index DDL + regenerate chunks; no migration rewrite.
- Generated DDL is gitignored output, not source; it must be re-applied per environment.
- Slight operational step beyond plain `db push` (documented in the README runbook).
