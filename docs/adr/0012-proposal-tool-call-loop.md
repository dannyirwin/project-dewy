# ADR-0012: Stage 3 proposal via tool-call loop

Status: Accepted

## Context

Stage 3 originally asked the LLM for one structured-output JSON blob containing up to 30 proposed actions.
A single invalid action in that array caused the entire proposal to fail validation, wasting good actions and making self-correction impossible without re-running the whole step.

Stage 2 reconciliation already uses a thin tool-call loop (`ThinLoopReconciliationEngine`) with per-tool Zod validation and error responses the model can read on the next turn.

## Decision

Replace the batch `ProposalSchema` structured output with a **tool-call loop**:

- Seven `propose_*` tools (one per action type) plus `done()`.
- Each tool validates its payload immediately via the existing action payload Zod schemas in `src/actions/index.ts`.
- Invalid tool arguments return a JSON error in the tool response; the model retries without discarding prior accepted proposals.
- `PROPOSAL_STEP_BUDGET` (config, default 20) bounds the loop, mirroring `RECONCILIATION_STEP_BUDGET`.
- Deterministic guardrails (`validateAction`, page-eligibility demotion, review gating) remain unchanged after collection.

Implementation: `src/pipeline/stages/propose-tools.ts` + `collectProposals()` in `propose.ts`.

## Consequences

- Tests script Stage 3 as FIFO `tool_calls` turns (`proposalTurn` in `test/helpers.ts`), not a single parsed JSON blob.
- MCP read tools and HTTP write paths are unaffected; only the internal pipeline LLM interaction changes.
- Adding a new action type requires a new `propose_*` tool registration alongside the action registry entry.

## Alternatives considered

- Keep batch structured output with partial acceptance: rejected because the model cannot see which array index failed without custom parsing.
- OpenAI Agents SDK for Stage 3: deferred; same extension point as reconciliation (ADR-0001).
