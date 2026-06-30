#!/usr/bin/env bash
# Mirror Plan Mode (and other agent) writes from ~/.cursor/plans/ into the workspace.
set -euo pipefail

input=$(cat)

file_path=$(echo "$input" | jq -r '.file_path // empty')
workspace_root=$(echo "$input" | jq -r '.workspace_roots[0] // empty')

if [[ -z "$file_path" || -z "$workspace_root" ]]; then
  exit 0
fi

home_plans="${HOME}/.cursor/plans"
workspace_plans="${workspace_root}/.cursor/plans"

mkdir -p "$home_plans" "$workspace_plans"

resolve_path() {
  local path="$1" root="$2"
  if [[ "$path" = /* ]]; then
    realpath -m "$path" 2>/dev/null || echo "$path"
  else
    realpath -m "${root}/${path}" 2>/dev/null || echo "${root}/${path}"
  fi
}

abs_source=$(resolve_path "$file_path" "$workspace_root")
abs_home_plans=$(realpath -m "$home_plans")
abs_workspace_plans=$(realpath -m "$workspace_plans")

# Only sync files under the user Cursor plans directory.
if [[ "$abs_source" != "$abs_home_plans" && "$abs_source" != "$abs_home_plans/"* ]]; then
  exit 0
fi

# Avoid copying workspace-local plans back onto themselves.
if [[ "$abs_source" == "$abs_workspace_plans" || "$abs_source" == "$abs_workspace_plans/"* ]]; then
  exit 0
fi

if [[ ! -f "$abs_source" ]]; then
  exit 0
fi

rel="${abs_source#"${abs_home_plans}/"}"
if [[ "$rel" == "$abs_source" ]]; then
  rel=$(basename "$abs_source")
fi

dest="${abs_workspace_plans}/${rel}"
mkdir -p "$(dirname "$dest")"
cp -f "$abs_source" "$dest"

if [[ -n "${CURSOR_PLAN_SYNC_DEBUG:-}" ]]; then
  echo "[sync-plan] ${abs_source} -> ${dest}" >&2
fi

exit 0
