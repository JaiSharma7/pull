---
description: Run all checks, commit, push, and refresh the PR for the current branch.
---

Ship the current branch.

1. `pnpm check` — format, lint, typecheck, test. If the diff touches `supabase/`, also
   `pnpm db:lint`. Fix anything that fails before going further; do not push red.
2. Review your own diff adversarially: what would make CI reject this? Check it against
   the six laws in `CLAUDE.md` — especially a read-path model call, a gated free-tier
   feature, or a table without RLS.
3. Stage and commit with a conventional-commit message explaining _why_.
4. `git push -u origin <branch>`. On a network failure, retry up to 4 times with
   exponential backoff (2s, 4s, 8s, 16s).
5. If a PR is open, let CI run and follow the gate in `AGENTS.md`. If not, ask before
   opening one.
