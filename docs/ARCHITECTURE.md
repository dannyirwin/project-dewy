# Architecture

Technical map of the KMS codebase. Product-level overview: [README.md](../README.md). Decisions and their rationale: [docs/adr/](adr/). Agent/contributor rules: [AGENTS.md](../AGENTS.md).

## System shape

```
                 ┌────────────────────────────────────────────────────────┐
 HTTP (Hono)     │  src/api/app.ts  — createApp(deps), OpenAPI generated  │
                 └───────┬───────────────────────────────┬────────────────┘
                         │                               │
                  Pipeline (composition root:            │ ReviewService
                  src/pipeline/index.ts)                 │ (park/resume)
                         │                               │
   ┌─────────────────────┴───────────────────────────────┴─────────────┐
   │ IngestionStateMachine (persisted on ingestion_job.state)          │
   │ received → classifying → classified → reconciling → reconciled    │
   │   → (awaiting_review) → proposing_edits → applying_edits          │
   │   → completed | failed                                            │
   └───────┬──────────────────┬──────────────────────┬─────────────────┘
           │ Stage 1          │ Stage 2              │ Stage 3
   classify.ts          ReconciliationEngine    propose.ts + actions/
   (buckets +           (thinLoop default;      (validate → gate →
    provenance,          4 tools, step budget)   auto-apply or review)
    hash dedup)               │
                              ▼
            ┌──────────────────────────────────────────┐
            │ Services: SearchService (hybrid+RRF),    │
            │ VersioningService, KbConfigService       │
            └──────────────────┬───────────────────────┘
                               ▼
            Repositories (interfaces) ── memory impl (tests)
                               └──────── supabase impl (prod, PostgREST)
            Providers (interfaces) ───── LM Studio impl (prod)
                               └──────── Mock/Fake impls (tests)
```

Everything depends on interfaces; `buildPipeline` and `createApp` are the only places concrete implementations meet. Tests and production run the **same wiring** with different injections.

## Module guide

| Module | Responsibility | Key invariants |
|---|---|---|
| `src/config` | Env-driven config, Zod-validated, dev-safe defaults | Fail loud on invalid env; everything tunable lives here |
| `src/domain` | Zod schemas (single source of truth), content/normalized hashing, slugs | All layers parse through these; Zod v4 |
| `src/repositories` | Data access. `interfaces.ts` is the contract; `memory/` mirrors full semantics (cosine over current-version chunks, TF keyword search, uniqueness guards); `supabase/` is thin row mappers + RPCs | supabase-js confined to `src/db/client.ts` (ADR-0004; enforced by test) |
| `src/providers` | `ChatProvider.complete<T>` (structured outputs, tools), `EmbeddingProvider`. LM Studio impl: JSON-schema response format, fence-tolerant extraction, bounded corrective retries → `StructuredOutputError`; dimension mismatch fails loud | `openai` SDK confined to `lmstudio.ts` |
| `src/retrieval` | Paragraph-packing chunker (token target + overlap, sentence-split oversize); hybrid search = semantic + keyword legs fused with weighted RRF (k=60); `regenerateChunks(version)` | Search only ever sees current-version chunks |
| `src/templates` | Section templates, `validateSections` (missing-required / unknown keys), canonical `renderBody`, `extractSection` | Pages stay template-valid |
| `src/versioning` | `createVersion` (immutable row + repoint + audit + chunk regen), `rollback` (restores as a *new* version) | The only write path for document content (ADR-0005) |
| `src/kb` | KB creation, versioned config updates (audited), `evaluatePageEligibility`: deterministic gate FIRST, gated LLM judgment second — LLM never overrules a failed gate | ADR-0008 |
| `src/actions` | 7 action types: payload schemas, `validateAction` (template guardrails, `self_link`/`dangling_link`/`cross_kb_link`, near-duplicate title ≥0.93, taxonomy gating lifted only by human approval), idempotent `applyAction` | LLM output never applied without validation |
| `src/pipeline` | State machine, scratchpad helpers, stage steps, reconciliation engine + tools | Steps idempotent; legality map; budget exhaustion → `needs_review` |
| `src/review` | Review items lifecycle; resolutions feed the scratchpad; `maybeResume` is the only exit from `awaiting_review` | Double-resolution rejected |
| `src/jobs` | `JobRunner`: interval loop with a queue-shaped boundary (claim → advance) | Swap for pg-boss/Graphile by replacing this file (plan §12) |
| `src/api` | `createApp(deps)` (testable via `app.request`), production `server.ts` | OpenAPI generated from route schemas |

## Data model (migration `00000000000001_init.sql`)

- `knowledge_base` — name, slug, `config` jsonb, `config_version`
- `document` — KB-scoped, slug-unique per KB, `template_id`, `current_version_id`
- `document_version` — immutable; `version` int, `body_markdown`, `sections` jsonb, `created_by_job_id`, `reason`, `config_version`; FTS generated tsvector
- `link` — typed relations: `related | mentions | parent | child | promoted_from`; deduped per (from, to, relation)
- `tag` / `document_tag` — `kind: category|tag`, per-KB unique names; attachments carry confidence + source
- `chunk` — per document version; `embedding vector` (dimension-less by design, ADR-0002), `embedding_model`, `dimension`, `token_count`
- `ingestion_job` — `state`, `source` jsonb, `source_hash`, `stage_outputs` jsonb (classification, reconciliation report, dedup flags), `scratchpad` jsonb, `error`
- `review_item` — kind, payload, status, resolution
- `proposed_action` — type, payload, status (`proposed → approved/rejected → applied`), confidence, reason, `applied_version_id`
- `audit_log` — append-only; entity, action, before/after, actor, reason, confidence
- RPCs: `match_chunks` (pgvector cosine), `keyword_search` (FTS) — fused in app code via RRF

## Control-flow details worth knowing

- **Dedup short-circuit** happens in the `received` step: exact hash vs prior *completed* jobs → `completed` + `duplicate_of_job_id`, zero model calls. Normalized-hash near match → flag + continue (ADR-0009).
- **Reconciliation safety net**: every classified statement must appear in the report; missing ones are appended as `needs_review` with rationale `not addressed…`.
- **Stage 3 ordering**: eligibility evaluation runs per `create_document` *before* guardrail validation; apply order is `create_tag → create_document → append/update_section → promote_subsection → upsert_link → apply_tag` so references always resolve.
- **Human approval scope**: approval of a gated `proposed_action` flips that row and lifts review-gated policies (e.g. new tag category) for that action only, detected at apply time from resolved review items.
- **Pause semantics**: `runToCompletion` stops at `awaiting_review`; `ReviewService.maybeResume` performs one explicit `advance` (running the `awaiting_review` router step) and then resumes the machine.

## Testing architecture

Offline by construction: in-memory repositories + `MockChatProvider` (strict FIFO scripted turns: `parsed` / `text` / `tool_calls` / `fn`-with-transcript-assertions) + `FakeEmbeddingProvider` (deterministic trigram-hash vectors, dim 64). `test/helpers.ts` is the shared harness; `scripts/eval.ts` reuses it for golden end-to-end behavioral contracts (CI-gateable). `test/architecture.test.ts` mechanically enforces the import-isolation invariants by reading the source tree.
