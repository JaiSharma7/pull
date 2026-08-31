#!/usr/bin/env bash
#
# Law 7, enforced rather than remembered.
#
# AGENTS.md says to grep the diff for credentials before every push. At 4am, on the
# eleventh push of a night, prose does not get read. This runs as a PreToolUse hook on
# `git commit` and `git push` (see .claude/settings.json) and blocks the call on a hit.
#
# It reports file and line number only -- never the matched text. A scanner that prints
# the secret it found has written it into the transcript, which is the thing law 7 is
# trying to prevent.
#
# Detection is `grep -E`, not awk: mawk 1.3.4 silently fails to match an open interval
# followed by a literal (`eyJ[A-Za-z0-9_-]{15,}\.` never matches), so half these rules
# would have been dead on a default Debian container while appearing to work. awk here
# only parses diff structure.
#
# Standalone:  ./scripts/secret-scan.sh [--staged | --push | --range <rev-range>]
# As a hook:   ./scripts/secret-scan.sh --hook   (reads the PreToolUse JSON on stdin)
# Exit: 0 clean · 2 credential found (blocks the tool call) · 0 on an internal error,
# because a broken scanner must never be the reason a night stalls.
set -uo pipefail
cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)" || exit 0

# Rules deliberately require the *shape of a value*, not the mention of a name.
# `service_role` and `sb_secret_` appear legitimately in docs, grants and this file;
# a scanner that cries wolf on those gets disabled within a night, and then protects
# nothing at all.
RULES=(
  'sb_secret_[A-Za-z0-9_-]{16,}	Supabase secret key'
  'AIza[0-9A-Za-z_-]{35}	Google AI API key'
  'AQ\.[A-Za-z0-9_-]{20,}	Supabase access token'
  'BEGIN [A-Z ]*PRIVATE KEY	private key block'
  'eyJ[A-Za-z0-9_-]{15,}\.eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{20,}	JWT — legacy service_role keys are JWTs'
  '(SERVICE_ROLE|SECRET_KEY|ACCESS_TOKEN|API_KEY)[A-Z_]*[[:space:]]*[:=][[:space:]]*.?[A-Za-z0-9/+_-]{24,}	credential assigned to an environment name'
)

mode="${1:---staged}"

# PreToolUse hook: decide from the Bash command what to scan, and stay out of the way of
# every command that is not a commit or a push.
if [ "$mode" = "--hook" ]; then
  payload="$(cat)"
  cmd="$(printf '%s' "$payload" | jq -r '.tool_input.command // ""' 2>/dev/null)"
  [ -z "$cmd" ] && cmd="$(printf '%s' "$payload" | node -e \
    'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s)?.tool_input?.command??"")}catch{}})' 2>/dev/null)"
  case "$cmd" in
    *"git commit"*) mode="--staged" ;;
    *"git push"*)   mode="--push" ;;
    *) exit 0 ;;
  esac
fi

range=""
case "$mode" in
  --range) range="${2:-}" ;;
  --push)
    branch="$(git branch --show-current 2>/dev/null || true)"
    if [ -n "$branch" ] && git rev-parse --verify --quiet "origin/$branch" >/dev/null; then
      range="origin/$branch..HEAD"
    elif git rev-parse --verify --quiet origin/main >/dev/null; then
      range="origin/main..HEAD"
    fi
    ;;
esac

if [ -n "$range" ]; then
  diff="$(git diff -U0 "$range" 2>/dev/null; git diff -U0 --cached 2>/dev/null)"
else
  # Staged, plus anything in the worktree that a `commit -a` would sweep up.
  diff="$(git diff -U0 --cached 2>/dev/null; git diff -U0 2>/dev/null)"
fi
[ -z "$diff" ] && exit 0

# Flatten the unified diff to `file<TAB>line<TAB>content`, added lines only -- removing a
# credential must never be blocked. awk sees no credential regex, only diff structure.
flat="$(
  printf '%s\n' "$diff" | awk '
    /^\+\+\+ b\// { file = substr($0, 7); next }
    /^@@ /        { split($0, h, "+"); split(h[2], s, /[, ]/); line = s[1] + 0; next }
    /^\+/         { printf "%s\t%d\t%s\n", file, line, substr($0, 2); line++ }
  ' 2>/dev/null
)"
[ -z "$flat" ] && exit 0

report=""
for rule in "${RULES[@]}"; do
  regex="${rule%%	*}"
  label="${rule#*	}"
  hits="$(printf '%s\n' "$flat" | grep -E -- "$regex" | cut -f1,2 | tr '\t' ':' | sort -u)"
  [ -n "$hits" ] && report+="$(printf '%s\n' "$hits" | sed "s|\$|  ${label}|")"$'\n'
done

[ -z "${report//[[:space:]]/}" ] && exit 0

{
  echo "BLOCKED — scripts/secret-scan.sh found a credential in the diff:"
  echo
  printf '%s' "$report"
  echo
  echo "A hit is a stop, not a judgement call (AGENTS.md · law 7 in CLAUDE.md)."
  echo "If the key is real it is ROTATED at the provider, not quietly removed from the"
  echo "diff — git history keeps it, and so does every clone. Then move it server-side:"
  echo "Edge Function secrets or Vault, never a VITE_* variable and never apps/web/."
  echo "The one credential that belongs in the browser is the Supabase publishable key."
} >&2
exit 2
