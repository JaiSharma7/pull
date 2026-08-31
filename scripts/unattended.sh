#!/usr/bin/env bash
#
# Take the prompts out of a night, and put them back in the morning.
#
# The app's most permissive permission mode is `auto`; `bypassPermissions` is not offered
# on the web at all. But no mode helps with the thing that actually stalls an unattended
# run: rules are evaluated deny -> ask -> allow across every settings file pooled
# together, so an `ask` rule prompts even when a broader `allow` rule matches the same
# call -- in `auto` mode too. Nine `ask` entries in .claude/settings.json are therefore
# nine ways for a 3am session to hang until morning.
#
# `on` moves each of them to `allow` or `deny`, so every call is decided rather than
# asked. It does this as an UNCOMMITTED working-tree change, backed up, with the backup
# hidden from git via .git/info/exclude. That is deliberate: Codex's P1 finding on PR #10
# was that a committed self-merge grant outlives the one night it was written for, and it
# was right. This grant expires when you run `off`.
#
# Usage: ./scripts/unattended.sh on | off | status
set -uo pipefail
cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)" || { echo "not a git repository"; exit 1; }

SETTINGS=.claude/settings.json
BACKUP=.claude/.settings-daytime.json
EXCLUDE=.git/info/exclude

# Irreversible, or forbidden by docs/overnight-plan.md §10. Denied rather than granted:
# with nobody awake, "ask" is not a safeguard, it is a stall -- but that is an argument
# for deciding these in advance, not for allowing them.
DENY=(
  "Bash(supabase db push:*)"
  "mcp__Supabase__create_project"
  "mcp__Supabase__pause_project"
  "mcp__Supabase__restore_project"
  "mcp__Supabase__create_branch"
  "mcp__Supabase__delete_branch"
  "mcp__Supabase__merge_branch"
  "mcp__Supabase__reset_branch"
  "mcp__Supabase__rebase_branch"
  "mcp__Vercel__pause_project"
  "mcp__Vercel__unpause_project"
  "mcp__Vercel__create_git_project"
  "mcp__Vercel__update_project_deployment_protection"
)

usage() { echo "usage: $0 on | off | status" >&2; exit 1; }
[ $# -eq 1 ] || usage

case "$1" in
  on)
    if [ -f "$BACKUP" ]; then
      echo "Already on — $BACKUP exists. Run '$0 off' first, or '$0 status'."
      exit 1
    fi
    if ! git diff --quiet -- "$SETTINGS" || ! git diff --cached --quiet -- "$SETTINGS"; then
      echo "$SETTINGS has uncommitted changes. Commit or revert them first, so that"
      echo "'off' restores what you actually meant to keep."
      exit 1
    fi

    cp "$SETTINGS" "$BACKUP"
    grep -qxF "$BACKUP" "$EXCLUDE" 2>/dev/null || echo "$BACKUP" >> "$EXCLUDE"

    DENY_JSON="$(printf '%s\n' "${DENY[@]}" | python3 -c 'import json,sys; print(json.dumps([l.rstrip("\n") for l in sys.stdin if l.strip()]))')"
    DENY_JSON="$DENY_JSON" python3 - "$SETTINGS" <<'PY'
import collections, json, os, sys

path = sys.argv[1]
cfg = json.loads(open(path).read(), object_pairs_hook=collections.OrderedDict)
perms = cfg.setdefault('permissions', collections.OrderedDict())
ask = list(perms.get('ask', []))
deny_set = set(json.loads(os.environ['DENY_JSON']))

allow, deny = perms.setdefault('allow', []), perms.setdefault('deny', [])
moved_allow, moved_deny = [], []
for rule in ask:
    target, moved = (deny, moved_deny) if rule in deny_set else (allow, moved_allow)
    if rule not in target:
        target.append(rule)
        moved.append(rule)

# Never ask a question nobody is awake to answer. This is standing rule 1 of the
# overnight skill, made structural rather than aspirational.
if 'AskUserQuestion' not in deny:
    deny.append('AskUserQuestion')
    moved_deny.append('AskUserQuestion')

perms['ask'] = []
open(path, 'w').write(json.dumps(cfg, indent=2) + '\n')

print(f"  granted ({len(moved_allow)}):")
for r in moved_allow:
    print(f"    + {r}")
print(f"  hard-denied ({len(moved_deny)}):")
for r in moved_deny:
    print(f"    - {r}")
PY
    rc=$?
    [ $rc -eq 0 ] || { echo "failed to rewrite $SETTINGS; restoring"; cp "$BACKUP" "$SETTINGS"; rm -f "$BACKUP"; exit 1; }

    echo
    echo "Unattended permissions are ON. The ask list is empty, so nothing prompts."
    echo "$SETTINGS is a TRACKED, UNCOMMITTED change — do not commit it."
    echo "Run '$0 off' in the morning to restore it. The backup is at $BACKUP,"
    echo "hidden from git via $EXCLUDE."
    ;;

  off)
    if [ ! -f "$BACKUP" ]; then
      echo "Not on — no $BACKUP to restore from."
      exit 1
    fi
    cp "$BACKUP" "$SETTINGS"
    rm -f "$BACKUP"
    if [ -f "$EXCLUDE" ]; then
      grep -vxF "$BACKUP" "$EXCLUDE" > "$EXCLUDE.tmp" 2>/dev/null && mv "$EXCLUDE.tmp" "$EXCLUDE"
    fi
    echo "Restored $SETTINGS. Daytime prompts are back."
    git status --short -- "$SETTINGS" | grep -q . \
      && echo "WARNING: $SETTINGS still differs from HEAD — inspect it." \
      || echo "Working tree matches HEAD for $SETTINGS."
    ;;

  status)
    if [ -f "$BACKUP" ]; then echo "unattended: ON  (backup at $BACKUP)"; else echo "unattended: off"; fi
    python3 - "$SETTINGS" <<'PY'
import json, sys
p = json.loads(open(sys.argv[1]).read()).get('permissions', {})
for k in ('allow', 'ask', 'deny'):
    print(f"  {k:5} {len(p.get(k, []))}")
if p.get('ask'):
    print("  -> a non-empty ask list prompts in EVERY permission mode, auto included.")
PY
    echo "  hooks:"
    python3 - <<'PY'
import json
h = json.loads(open('.claude/settings.json').read()).get('hooks', {})
for event, entries in h.items():
    for e in entries:
        for hook in e.get('hooks', []):
            print(f"    {event}: {hook.get('command')}")
PY
    ;;

  *) usage ;;
esac
