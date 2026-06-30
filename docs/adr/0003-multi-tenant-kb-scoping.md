# ADR-0003: Multi-tenancy via `knowledge_base_id` on every domain table

Status: Accepted

## Context
The system hosts many independent knowledge bases (different domains, different per-KB policies). Cross-KB leakage in retrieval or linking would be a correctness and privacy bug.

## Decision
Every domain table carries `knowledge_base_id`; every repository query is KB-scoped. Cross-KB references are invalid by construction — link validation includes a `cross_kb_link` guardrail. Per-KB behavior (templates, eligibility, tag policy) lives in the KB's versioned config (ADR-0008).

## Consequences
- Slightly denormalized (child tables repeat the KB id) in exchange for simple, safe scoping and easy future RLS.
- Search, reconciliation tools, and actions all take the KB id explicitly; tests create isolated KBs freely.
