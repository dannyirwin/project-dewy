# ADR-0001: Self-owned persisted state machine; reconciliation behind an engine interface

Status: Accepted

## Context
The ingestion pipeline is long-running, must survive process crashes, pauses for human review, and has exactly one genuinely agentic stage (reconciliation, which needs a tool loop). Agent frameworks (OpenAI Agents SDK, LangGraph, …) offer orchestration but add a dependency whose persistence/review semantics would have to be bent to ours.

## Decision
Own the orchestration: a persisted state machine (`src/pipeline/stateMachine.ts`) whose state lives on the `ingestion_job` row. Each transition is an idempotent step function keyed on the current state; a legality map rejects bad transitions by failing the job loudly. `received → classifying → classified → reconciling → reconciled → (awaiting_review) → proposing_edits → applying_edits → completed | failed`. `awaiting_review` is a *paused* state the runner never advances past; only the review workflow resumes it.

Stage 2 sits behind the `ReconciliationEngine` interface (`src/pipeline/reconciliation/engine.ts`). The default implementation is a thin tool-call loop (`thinLoop.ts`) over our provider abstraction with a config-driven step budget. Tool definitions are Zod-parameterized so they double as Agents-SDK function tools.

## Consequences
- Crash recovery = re-read the row, re-run the step; steps must re-derive outputs (re-run guards exist in each stage).
- Swapping in the Agents SDK later is a one-file implementation injected via `buildPipeline({ reconciliationEngine })`; nothing else moves.
- We pay for our own loop/budget/safety-net code (≈150 lines) instead of a framework dependency.
- Budget exhaustion fails safe: unaddressed statements become `needs_review`, never silently dropped.
