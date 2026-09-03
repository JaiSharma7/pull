#!/usr/bin/env bash
# SessionStart hook: make a fresh session able to run checks immediately instead of
# spending its first minutes on setup. Best-effort — never fail the session.
set -uo pipefail
cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)" || exit 0

# Unconditional, not gated on `node_modules` existing. A container can arrive with a
# partial tree and that guard never repairs one: this environment shipped a
# node_modules without `@boundaryml/baml-bridge`, so `packages/prompts` could not
# typecheck and no BAML command ran, while the guard saw a directory and skipped.
# `--frozen-lockfile` is a ~1s no-op once the tree is complete, so paying it every
# session is cheaper than one session debugging a missing dependency.
echo "[what-a-pull] syncing dependencies…"
pnpm install --frozen-lockfile >/dev/null 2>&1 || pnpm install >/dev/null 2>&1 || true

echo "[what-a-pull] $(git branch --show-current 2>/dev/null || echo 'detached')"
echo "[what-a-pull] laws: CLAUDE.md · process: AGENTS.md · review gate: Codex → /code-review → merge"
exit 0
