# ADR-0009: Content-hash dedup on import; near matches flagged

Status: Accepted

## Context
Re-importing the same note must not re-run the pipeline or duplicate content; trivially reformatted re-imports shouldn't masquerade as new information either.

## Decision
At the `received` step: an identical raw content hash matching a prior **completed** job short-circuits to `completed` with `duplicate_of_job_id` (zero model calls). An identical *normalized* hash (case/whitespace/punctuation-insensitive) with a different raw hash flags `near_duplicate_of_job_id` and processing continues. Full diff/merge semantics for near-duplicates are explicitly deferred.

## Consequences
- Idempotent imports are cheap and audited.
- Near-duplicate handling is conservative (flag-and-continue) until a diff/merge ADR supersedes this one.
