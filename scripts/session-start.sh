#!/usr/bin/env bash
# SessionStart hook: make a fresh session able to run checks immediately instead of
# spending its first minutes on setup. Best-effort — never fail the session.
set -uo pipefail
cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)" || exit 0

# Unconditional, not gated on `node_modules` existing. A container can arrive with a
# partial tree and that guard never repairs one: this environment shipped a node_modules
# without `@boundaryml/baml-bridge`, so `packages/prompts` could not typecheck and no
# BAML command ran, while the guard saw a directory and skipped. `--frozen-lockfile` is
# a ~1s no-op once the tree is complete, so paying it every session is cheaper than one
# session spent debugging a missing dependency.
#
# Frozen only, and no fallback to a plain `pnpm install`. With the directory guard gone
# this runs on every session start, and a non-frozen install would resolve and rewrite
# `pnpm-lock.yaml` on any branch whose lockfile is momentarily out of sync -- handing a
# contributor an unexplained lockfile diff produced by a hook, and a tree that no longer
# matches what CI installs from. Still best-effort (the session must not fail), but it
# says so rather than swallowing the status: silence is what made the partial tree above
# cost an afternoon.
echo "[what-a-pull] syncing dependencies…"
if ! pnpm install --frozen-lockfile >/dev/null 2>&1; then
  echo "[what-a-pull] dependency sync failed — run 'pnpm install' and read the output"
fi

echo "[what-a-pull] $(git branch --show-current 2>/dev/null || echo 'detached')"
echo "[what-a-pull] laws: CLAUDE.md · process: AGENTS.md · review gate: Codex → /code-review → merge"
exit 0
