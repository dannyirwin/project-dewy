# Architecture Decision Records

These ADRs document the locked decisions from the build plan. They are **binding**: code must not silently diverge from an accepted ADR. To change a decision, write a new ADR that supersedes the old one (set the old one's status to `Superseded by ADR-NNNN`) and update the code in the same change set.

Format: lightweight [MADR](https://adr.github.io/)-style — Status / Context / Decision / Consequences.

| # | Title | Status |
|---|---|---|
| [0001](0001-hybrid-orchestration-state-machine.md) | Self-owned persisted state machine; reconciliation behind an engine interface | Accepted |
| [0002](0002-config-driven-embeddings.md) | Local embeddings via provider abstraction; config-driven dimension | Accepted |
| [0003](0003-multi-tenant-kb-scoping.md) | Multi-tenancy via `knowledge_base_id` on every domain table | Accepted |
| [0004](0004-repository-isolated-data-layer.md) | Repository-isolated data layer; pgvector hard dependency | Accepted |
| [0005](0005-versioning-audit-rollback.md) | Versioning, audit, and rollback on every document mutation | Accepted |
| [0006](0006-structured-scratchpad.md) | Structured jsonb scratchpad on the ingestion job | Accepted |
| [0007](0007-review-via-db-rows-and-api.md) | Human review via DB rows + HTTP endpoints | Accepted |
| [0008](0008-per-kb-versioned-config.md) | Per-KB versioned config; promote_subsection as showcase action | Accepted |
| [0009](0009-content-hash-dedup.md) | Content-hash dedup on import; near matches flagged | Accepted |
| [0010](0010-stack-choices.md) | Stack: TypeScript strict ESM, pnpm, Hono+zod-openapi, Vitest, Supabase, Zod v4 | Accepted |
| [0011](0011-docker-for-local-dev.md) | Docker runs the API only; Supabase CLI owns the DB stack | Accepted |
| [0012](0012-proposal-tool-call-loop.md) | Stage 3 proposal via tool-call loop (not batch JSON) | Accepted |
