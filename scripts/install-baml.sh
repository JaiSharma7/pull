#!/usr/bin/env bash
# The one place the BAML toolchain installer lives. Called by CI check 2 and by
# scripts/cloud-setup.sh, so the pin and the PATH handling cannot drift between them.
#
# Fails loudly. A half-installed toolchain means `pnpm baml:fmt` is missing, and the
# first thing that notices is the check-2 gate that runs it.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

# `packages/prompts/.baml-version` is the single source for the version. Read it into a
# variable and check it first: inlining `$(cat …)` into the installer's argument would
# not trip `set -e` if the file were missing or renamed -- the substitution yields an
# empty string, the installer falls back to its default `canary` channel, and the
# container ends up holding a build that merely calls itself the pinned version. That is
# the exact hazard pinning exists to prevent, and `export.mjs`'s pin assertion cannot
# catch it, because it compares the reported version string, which would match.
version_file=packages/prompts/.baml-version
[ -f "$version_file" ] || { echo "error: $version_file not found" >&2; exit 1; }
version="$(tr -d '[:space:]' < "$version_file")"
[ -n "$version" ] || { echo "error: $version_file is empty" >&2; exit 1; }

# Pinned, not the channel: `canary` is re-cut under the same version string, and
# `baml generate` embeds compiled bytecode, so an unpinned toolchain resolves to a
# different build over time. `manifest/v1/version/<v>.json` is sha256-pinned.
#
# `-o pipefail` (from `set` above) is load-bearing: without it a failed download feeds
# empty stdin to `sh`, which exits 0, and the failure surfaces two steps later as
# `baml: command not found`.
curl -fsSL https://pkg.boundaryml.com/install.sh \
  | sh -s -- --yes --no-modify-path --version "$version"

# Put it where a non-interactive shell will find it. `--no-modify-path` above declines
# the installer's own mechanism, which appends `. "$HOME/.baml/env"` to ~/.bashrc -- a
# file an agent's or a CI step's shell never reads, so an install that fully succeeded
# still reports `baml: command not found`.
if [ -n "${GITHUB_PATH:-}" ]; then
  echo "$HOME/.baml/bin" >> "$GITHUB_PATH"
elif [ -w /usr/local/bin ]; then
  ln -sf "$HOME/.baml/bin/baml" /usr/local/bin/baml
elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
  sudo ln -sf "$HOME/.baml/bin/baml" /usr/local/bin/baml
else
  echo "error: installed to $HOME/.baml/bin but cannot expose it on PATH." >&2
  echo "       /usr/local/bin is not writable and sudo is unavailable." >&2
  echo "       add \"\$HOME/.baml/bin\" to PATH, or re-run where one of those holds." >&2
  exit 1
fi

"$HOME/.baml/bin/baml" --version
