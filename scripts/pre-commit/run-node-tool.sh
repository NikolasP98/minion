#!/usr/bin/env bash
set -euo pipefail

# Locate the main repo root via the common git dir so we can find package.json
# and lock files. We do NOT cd there for execution — tools like oxfmt/oxlint
# receive paths relative to the caller's working directory (the worktree), so
# changing to the main repo root would break file resolution in linked worktrees.
_GIT_COMMON_DIR="$(git rev-parse --git-common-dir 2>/dev/null || true)"
if [[ -n "$_GIT_COMMON_DIR" ]]; then
  ROOT_DIR="$(cd "${_GIT_COMMON_DIR}/.." && pwd)"
else
  ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fi

if [[ $# -lt 1 ]]; then
  echo "usage: run-node-tool.sh <tool> [args...]" >&2
  exit 2
fi

tool="$1"
shift

_NODE_BIN="$ROOT_DIR/node_modules/.bin/$tool"
if [[ -f "$ROOT_DIR/pnpm-lock.yaml" ]] || { [[ -f "$ROOT_DIR/bun.lockb" ]] || [[ -f "$ROOT_DIR/bun.lock" ]]; }; then
  if [[ -x "$_NODE_BIN" ]]; then
    # Run the binary directly from ROOT_DIR's node_modules so the working
    # directory stays as the caller's cwd — critical for worktree correctness:
    # oxfmt/oxlint receive paths relative to the worktree, not the main repo.
    exec "$_NODE_BIN" "$@"
  fi
fi

if [[ -f "$ROOT_DIR/pnpm-lock.yaml" ]] && command -v pnpm >/dev/null 2>&1; then
  cd "$ROOT_DIR"
  exec pnpm exec "$tool" "$@"
fi

if { [[ -f "$ROOT_DIR/bun.lockb" ]] || [[ -f "$ROOT_DIR/bun.lock" ]]; } && command -v bun >/dev/null 2>&1; then
  cd "$ROOT_DIR"
  exec bunx --bun "$tool" "$@"
fi

if command -v npm >/dev/null 2>&1; then
  cd "$ROOT_DIR"
  exec npm exec -- "$tool" "$@"
fi

if command -v npx >/dev/null 2>&1; then
  exec npx "$tool" "$@"
fi

echo "Missing package manager: pnpm, bun, or npm required." >&2
exit 1
