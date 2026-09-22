# Where to start

Contributions are open. Read [`CONTRIBUTING.md`](../CONTRIBUTING.md) first, choose one
focused concern, and open either an issue or a pull request. The categories below tell
you what environment and discussion a change needs; they are not permission tiers.

The list is intentionally short. It includes work that is current, reproducible, and
reviewable without private context. If an item has already been claimed or fixed, choose
another rather than widening the pull request.

## No backend access required

### Add a public-domain source

Add one entry to `scripts/corpus/public-domain.json`, then run:

```bash
node scripts/seed-corpus.mjs --check
```

The check fetches the URL and verifies its title. The corpus is thinnest outside Europe
and North America and in subjects such as economics and mathematics. Read the
`$comment` at the top of the manifest: sources must be unambiguously public domain and
short enough to finish inside `MAX_SOURCE_CHARS`.

### Add focused route wiring coverage

The pure logic under `apps/web/src/lib/` has broad coverage and several routes now have
tests. Focused wiring coverage is still useful for an untested behavior in `Review`,
`Feed`, or `Auth`—for example, a state transition or visible error that can regress
while its helper remains correct.

Follow the existing house style: prove one observed behavior, use
`renderToStaticMarkup` when a DOM is unnecessary, and use `.test.ts` or `.test.tsx`
so the current Vitest include pattern runs the file. Do not submit a blanket "increase coverage" change.

### Improve focus and navigation accessibility

A focused fix that moves focus or announces a newly opened view can be developed without
Supabase. Include a regression test for the exact navigation path and verify that the
change does not steal focus during ordinary reading.

### Restore scroll position on Back

The feed remains mounted to preserve reading state, but `navigate` resets scroll and
`popstate` does not restore it. A fix should cover both forward navigation and browser
Back, including the fact that a hidden feed collapses layout.

## Local Supabase stack required

### Prove SQL and TypeScript interleave parity

`plan_interleave` is mirrored in `packages/ranking` and compared with a committed JSON
fixture, but CI does not call the SQL function over those fixture inputs. Add a
`supabase/tests/` regression that makes `pnpm db:test` fail when the SQL planner
diverges from the TypeScript mirror.

Use [`docs/supabase-contributing.md`](./supabase-contributing.md). Contributors and
reviewers validate this work locally; hosted-project access is not required.

## Discuss in an issue first

- Changes to routing or the product model for Library, Review, History, Preferences, or
  individual Pulls. Component state is deliberate today; turning those concepts into
  URLs is an architectural decision, not a beginner task.
- Changes to what the Delta banner counts. It currently describes the candidate pool,
  not only the visible page, so the right scope needs a product decision before code.
- Authentication, authorization, RLS, destructive migrations, data backfills, hosted
  infrastructure, provider integrations, or a new source host.
- Original summaries, commentary, or translations. The project does not yet have a
  contribution agreement for original editorial content.

## What not to send

No bulk typo or refactor pull requests, drive-by dependency churn, production
configuration, generated files edited by hand, or code changes based only on an
unreproduced scanner or model finding. A verified finding is welcome as an issue.

Security vulnerabilities belong in the private channel described by
[`SECURITY.md`](../SECURITY.md), never in a public issue.
