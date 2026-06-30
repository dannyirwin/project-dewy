# ADR-0005: Versioning, audit, and rollback on every document mutation

Status: Accepted

## Context
An LLM writes to this wiki. Mistakes are guaranteed; trust requires that every change is inspectable and reversible.

## Decision
All document mutations flow through `VersioningService.createVersion`: an immutable `document_version` row, repointing `current_version_id`, an `audit_log` entry (actor, reason, before/after, confidence, originating job), and chunk regeneration for retrieval. `rollback(toVersion)` restores any prior version *as a new version* (history is append-only). Versions record the KB `config_version` they were written under.

## Consequences
- Feature code must never write versions or repoint `current_version_id` directly.
- Storage grows with history — acceptable; pruning is a future concern.
- Retrieval correctness depends on chunk regeneration living inside the same service call (stale-chunk exclusion is tested).
