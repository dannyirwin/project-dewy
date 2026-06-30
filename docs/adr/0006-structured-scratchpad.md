# ADR-0006: Structured jsonb scratchpad on the ingestion job

Status: Accepted

## Context
The pipeline accumulates working knowledge across stages (entity resolutions, name decisions, human review answers). Free-text notes would be unparseable; a separate table would be overkill for job-scoped, append-mostly data.

## Decision
A Zod-validated structured scratchpad (`relevant_summaries`, `entity_resolutions`, `name_decisions`, `notes`, `review_context`) stored as jsonb on the `ingestion_job` row. All writes go through `mergeScratchpad` (validates shape); `renderScratchpadMarkdown` derives a prompt/UI rendering. Human review answers land here and reach the Stage-3 prompt.

## Consequences
- Cross-stage memory is typed, auditable, and visible in the job row.
- The scratchpad is job-scoped by design; durable KB knowledge belongs in documents, not scratchpads.
