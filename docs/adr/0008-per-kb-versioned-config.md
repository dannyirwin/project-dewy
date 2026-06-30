# ADR-0008: Per-KB versioned config; promote_subsection as the showcase action

Status: Accepted

## Context
"What deserves its own page", which templates exist, and how tags may grow are *policy*, and policy differs per knowledge base and changes over time. Pipeline outputs must be explainable against the policy in force when they were produced.

## Decision
Each KB carries a versioned config (page-eligibility rules, templates, tag policy, default template). Updates bump `config_version` and are audited; document versions record the config version they were written under. Page eligibility is a **deterministic gate first** (min statements/words, always-page kinds), then an optional LLM judgment — the LLM can never overrule a failed gate. Failed gates demote `create_document` proposals into `append_section` on the proposal's fallback target. `promote_subsection` is the first-class reverse operation (subsection grows → its own page + link stub + reciprocal links), fully reviewable like any action.

## Consequences
- The same input produces a page in one KB and a subsection in another purely via config — covered by acceptance tests and evals.
- Demoted content lands under the target template's canonical section heading (entity name in a bolded lead-in), keeping pages template-valid.
