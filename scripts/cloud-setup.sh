#!/usr/bin/env bash
# Setup script for a Claude Code cloud environment. Put `bash scripts/cloud-setup.sh` in
# the "Setup script" field of the environment dialog rather than maintaining a copy of
# this in a web textarea; the repository is cloned before the setup script runs.
#
# Not the SessionStart hook. `scripts/session-start.sh` is committed and runs everywhere,
# including on a contributor's laptop, so it must not download a 40 MB toolchain. This
# runs only in a cloud environment that opts into it.
#
# Unlike the hook, this fails loudly: a setup script that half-works hands the agent a
# container where `pnpm baml:fmt` is missing, and the first thing that notices is CI.
set -euo pipefail

root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "$root" ]; then
  echo "error: not inside a git checkout (cwd: $PWD)." >&2
  echo "       run this from the repository, which the environment clones before setup." >&2
  exit 1
fi
cd "$root"

# Match CI's package manager before installing anything with it. `packageManager` in
# package.json pins pnpm, and corepack is what honours it; a container shipping a
# different pnpm major can resolve a tree CI never had. Best-effort -- a container that
# already ships the pinned pnpm does not need it, and `--frozen-lockfile` below is the
# loud failure if the resolution disagrees anyway.
corepack enable pnpm 2>/dev/null || true

# Workspace dependencies. `@boundaryml/baml-bridge` and its native addon are what
# `packages/prompts` typechecks against, and a fresh container has arrived without them.
pnpm install --frozen-lockfile

# The toolchain, pinned to `.baml-version` and put on PATH. Shared with CI check 2 so
# the two cannot drift -- see the comments in that script for why both halves matter.
bash scripts/install-baml.sh

# A local copy of the agent-skill source, so the generated `baml-core` skill can be
# refreshed with `baml agent install --source /opt/baml-skill` (run from the repo root).
# Without it the command fails: it fetches from codeload.github.com, which is authorised
# per repository against the session's GitHub scope, so a third-party repository returns
# 403 rather than a network error. See docs/baml.md.
if [ -d /opt/baml-skill/.git ]; then
  git -C /opt/baml-skill fetch --depth 1 origin main
  git -C /opt/baml-skill reset --hard FETCH_HEAD
else
  git clone --depth 1 https://github.com/BoundaryML/baml-skill /opt/baml-skill
fi
