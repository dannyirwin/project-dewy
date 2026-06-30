# ADR-0007: Human review via DB rows + HTTP endpoints

Status: Accepted

## Context
Conflicts, ambiguous facts, low-confidence proposals, and taxonomy changes need a human. We need durable, queryable review state without building a UI or adopting a workflow engine.

## Decision
`review_item` rows (kinds: `conflict`, `ambiguous_fact`, `proposed_action`, `taxonomy_change`) with payload + resolution, surfaced over Hono endpoints: list pending, `context`, `skip`, `approve`, `reject`. Resolving feeds the answer into the job scratchpad; when the last pending item for a parked job resolves, `ReviewService.maybeResume` takes the explicit step out of `awaiting_review` and lets the machine run.

## Consequences
- Any client (curl, future UI, an agent) can drive review; state survives restarts.
- Approval semantics are explicit: human approval flips the linked `proposed_action` and lifts review-gated policies (e.g. new tag categories) for that action only.
- Double-resolution is rejected (items must be pending).
