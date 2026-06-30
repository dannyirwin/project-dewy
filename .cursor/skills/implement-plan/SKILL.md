---
name: implement-plan
description: Implement a plan file by orchestrating parallel subagents per phase, then verifying acceptance criteria. Use when the user says "implement this plan", "execute this plan", or provides a .md plan file path to implement.
disable-model-invocation: true
---
# Implement Plan

Implement a plan file using parallel composer subagents for large plans, a single subagent for small plans, then a verifier.

## 1. Read the plan

Read the file at the path provided. Extract:
- **Phases**: `##`-level sections, numbered top-level steps, or `### Phase N` headings
- **Tasks**: bullet/numbered items under each phase
- **Files**: any file paths mentioned per phase
- **Acceptance criteria**: section named "Acceptance criteria", "Test strategy", "Verification", "Risk", or the plan's numbered sequencing steps
- **Dependencies**: any explicit `depends on: Phase N` annotations or clear sequential ordering

If no acceptance criteria section exists, derive criteria from the plan's "after shape", "goal", or the final step's expected state.

## 2. Classify plan size

| Size | Condition | Action |
|------|-----------|--------|
| Small | ≤2 phases AND ≤6 tasks total | One `plan-phase-implementer` with the full plan |
| Large | 3+ phases OR 7+ tasks | Multiple `plan-phase-implementer` Tasks, one per independent phase group |

## 3. For large plans — identify parallelizable groups

- Phases that touch **different files** → run in parallel (separate Task calls in one response)
- Phases that share files, or where one `depends on` another → group together and run sequentially within a single implementer Task
- When file overlap is unclear, put each phase in its own group and let the implementer run them sequentially

## 4. Spawn implementers

For each independent group, fire a `Task` tool call using the `plan-phase-implementer` subagent.
Fire all independent groups **in the same response** (parallel).

Inject this prompt per Task:

```
Implement the following phase(s) of the plan.

**Your phases:**
[paste the phase title(s) + all task bullets from the plan for this group]

**Full plan for context (do not implement phases outside your group):**
[paste full plan text]

**Previously completed phases (do not re-implement):**
[list completed phase names, or "none"]

Report back: files changed, commands run, blockers.
```

Wait for all implementer Tasks to complete before continuing.

## 5. Collect results and check for blockers

Review each implementer's report. If any phase is `blocked`:
- Resolve the blocker (ask user if needed)
- Re-spawn just that group before continuing

Compile a change manifest: list of files changed across all groups.

## 6. Spawn verifier

Fire one `plan-verifier` Task with:

```
**Acceptance criteria from the plan:**
[paste extracted criteria]

**Files changed:**
[paste change manifest]
```

## 7. Fix verifier failures (if any)

If the verifier reports any `FAIL` criteria or code-review annotations requiring changes:

1. Identify which phases own the failing code
2. Spawn a new `plan-phase-implementer` Task for each failing group, passing:
   - The specific failing criteria as the "Acceptance criteria to fix"
   - The verifier's evidence / code-review annotations as context
3. Wait for the fix implementer(s) to complete, then re-run the verifier (step 6) once more
4. Repeat until the verifier passes or a criterion is explicitly marked `NEEDS-MANUAL`

## 8. Report to user and update PR

Summarize:
- Which phases ran and how (parallel groups or single)
- Verifier output: pass/fail per criterion
- Code-review findings from the verifier and whether they were resolved
- Outstanding blockers or follow-up items from the plan's "Out of scope" / "Follow-ups" section

**Add the full summary to the PR description.** If no PR exists yet, create one with `gh pr create` and include the summary in the body. To update an existing PR, use:

```bash
gh pr edit --body "$(cat <<'EOF'
[summary]
EOF
)"
```
