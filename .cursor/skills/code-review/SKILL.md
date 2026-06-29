---
name: code-review
description: Non-interactive code review of current diff against repo conventions. The agent reads the diff itself and produces a structured findings report. Use when the user says /code-review, "review my changes", "review the diff", or when called by the plan-verifier agent.
---

# Code Review

Read the diff and produce a structured review. No browser, no external tools — the agent performs the review autonomously.

## Steps

1. Run `git diff develop...HEAD` to get the full diff against the local `develop` branch
2. Read each changed file in full for context where the diff alone is insufficient
3. Review against the checklist below
4. Output a structured findings report

## Review checklist

**Backend**
- [ ] No Prisma queries directly in route handlers — all DB access via a service function
- [ ] Multi-step DB operations wrapped in `prisma.$transaction()`
- [ ] All wallet mutations go through `walletLedgerService.applyWalletDelta()` — no direct balance writes
- [ ] Game balance values read from `packages/backend/src/config/gameplay.ts` — no hardcoded numbers
- [ ] Operational errors thrown as `AppError`; structured logging via `logger` (Pino)
- [ ] No `any` types; strict TypeScript throughout
- [ ] New endpoints have Zod validation on request body/params
- [ ] No PII (emails, raw coordinates, IP addresses) in log statements

**Frontend**
- [ ] Theme tokens via `useTheme()` — no inline hex colours, hardcoded radii or spacing
- [ ] Buttons built from `components/conqr-cx/*` primitives — no ad-hoc `TouchableOpacity`/`Pressable` in guarded dirs
- [ ] No `console.log` in production paths — gated behind `isDevBuild` + `EXPO_PUBLIC_DEBUG_*`
- [ ] No auth tokens stored in `AsyncStorage` — SecureStore only
- [ ] `pnpm` used, not `npm`/`npx`

**General**
- [ ] No new barrel `index.ts` files
- [ ] No commented-out code left behind
- [ ] TODO comments that were completed are removed
- [ ] Docs updated if behaviour changed (relevant files in `docs/`)

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
- **error** — violates a hard convention; must be fixed before merge
- **warning** — likely problem; should be fixed
- **suggestion** — style or improvement; optional
