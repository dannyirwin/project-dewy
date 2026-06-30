---
name: code-review
description: Non-interactive code review of current diff against repo conventions. The agent reads the diff itself and produces a structured findings report. Use when the user says /code-review, "review my changes", "review the diff", or when called by the plan-verifier agent.
---

# Code Review

Read the diff and produce a structured review.
No browser, no external tools - the agent performs the review autonomously.

## Steps

1. Determine the integration branch from `AGENTS.md ## Project` or default to `main`
2. Run `git diff <integration-branch>...HEAD` to get the full diff
3. Read each changed file in full for context where the diff alone is insufficient
4. Review against the checklist below plus any project rules in `AGENTS.md` and `.cursor/rules/`
5. Output a structured findings report

## Review checklist

**General (all projects)**
- [ ] No `any` types where the project uses TypeScript strictly
- [ ] No new barrel `index.ts` files unless the project convention allows them
- [ ] No commented-out code left behind
- [ ] Completed TODO comments are removed
- [ ] Docs updated if behaviour changed

**Project-specific**
- [ ] Conventions in `AGENTS.md ## Project` are followed
- [ ] Cursor rules under `.cursor/rules/` are honoured when applicable

Add domain-specific checklist items in the target repo's `AGENTS.md ## Project`
section after `apply-project.sh`.

## Output format

```
### Code Review

**Overall:** PASS | PASS WITH SUGGESTIONS | FAIL

**Findings:**
| Severity | File | Line | Issue |
|----------|------|------|-------|
| error / warning / suggestion | `path/to/file.ts` | ~N | [description] |

**Summary:**
[One paragraph. If PASS, say so explicitly.]
```

Severity levels:
- **error** - violates a hard convention; must be fixed before merge
- **warning** - likely problem; should be fixed
- **suggestion** - style or improvement; optional
