# Workspace plan mirror

Agent plans created in **Plan Mode** are saved under `~/.cursor/plans/` by default.
The hook in [`.cursor/hooks/sync-plan-to-workspace.sh`](../hooks/sync-plan-to-workspace.sh)
copies any file written or updated there into this directory (same relative path).

Use these paths with [`implement-plan`](../skills/implement-plan/SKILL.md), for review in git,
and for team sharing.

To debug sync: set `CURSOR_PLAN_SYNC_DEBUG=1` and check the Cursor **Hooks** output channel
after editing a plan.
