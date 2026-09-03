#!/usr/bin/env bash
# Setup script for a Claude Code cloud environment. Paste `bash scripts/cloud-setup.sh`
# into the "Setup script" field of the environment dialog rather than maintaining a copy
# of this in a web textarea; the repository is cloned before the setup script runs.
#
# Not the SessionStart hook. `scripts/session-start.sh` is committed and runs everywhere,
# including on a contributor's laptop, so it must not download a 40 MB toolchain. This
# runs only in the cloud environment that opts into it.
#
# Unlike the hook, this DOES fail loudly: a setup script that half-works hands the agent
# a container where `pnpm baml:fmt` is missing, and the first thing that notices is CI.
set -euo pipefail

cd "$(git rev-parse --show-toplevel 2>/dev/null || echo /home/user/pull)"

# Workspace dependencies. `@boundaryml/baml-bridge` and its native addon are what
# `packages/prompts` typechecks against, and a fresh container has arrived without them.
pnpm install --frozen-lockfile

# The BAML toolchain, pinned to `packages/prompts/.baml-version` -- the same single
# source CI installs from, so a session cannot regenerate with a build CI does not use.
# Pinned rather than the channel: `canary` is re-cut under one version string.
curl -fsSL https://pkg.boundaryml.com/install.sh \
  | sh -s -- --yes --no-modify-path --version "$(cat packages/prompts/.baml-version)"

# Put it on PATH where a non-interactive shell will find it. The installer's own
# mechanism appends `. "$HOME/.baml/env"` to ~/.bashrc, which an agent's shell never
# reads -- so `baml` is reported as not found despite a successful install, and every
# BAML command needs `export PATH` in front of it. `--no-modify-path` above declines
# that mechanism; this replaces it.
ln -sf "$HOME/.baml/bin/baml" /usr/local/bin/baml

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

baml --version
