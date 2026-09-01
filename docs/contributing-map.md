# Where to start

Work that is genuinely self-contained, roughly easiest first. Each of these is
something a maintainer would otherwise do; none needs context you cannot get from the
file it lives in.

Read `CONTRIBUTING.md` first for setup and the contribution policy — in particular:
one concern per PR, and you have to be able to explain the diff.

## No database needed

**Add a source to the corpus.** `scripts/corpus/public-domain.json`, then
`node scripts/seed-corpus.mjs --check`, which fetches the URL and compares the page
title against the expected work. The corpus is thin in economics, mathematics and
anything written outside Europe and North America, and the Delta is a better
demonstration the wider it spreads — a feed where everything sits near everything else
makes "you already knew this" meaningless. Public domain only, and short enough to
finish inside 200,000 characters. See the `$comment` at the top of that file; it is
worth reading before adding anything.

**Component tests.** There are none. `apps/web/src/routes/` is roughly 5,000 lines with
no automated coverage, and the pure logic those screens sit on is already split out and
tested — `feed-items.ts`, `stashes.ts`, `library.ts`, `search.ts`, `routes.ts`,
`title.ts`. What is missing is the wiring. `packages/ui/src/components/PullCard.test.ts`
shows the house approach: `renderToStaticMarkup` rather than a DOM library, and
`createElement` rather than JSX, because the Vitest preset includes `src/**/*.test.ts`
only and a `.tsx` test would silently never run. The most valuable ones are the state
machines the comments argue hardest about — `Review`'s four states, `Feed`'s read
counting, `Auth`'s four ways in.

**Focus management on navigation.** Nothing focuses the new view when a route opens,
and there is no route announcer, so a screen-reader user activating "Read it in its
source" gets focus dumped to `<body>` with no indication anything changed. The
`role="status"` sweep is done; this is the other half.

**The five native dialogs.** `Library.tsx` uses `prompt()` to name a collection and to
edit a note — a multi-sentence note, in a single-line box — and `confirm()` before a
destructive delete. `Source.tsx` uses `alert()`. All five are unstylable, cannot be
read in the app's voice, and on a phone look like they came from somewhere else. The
patterns to follow are in `Account.tsx`, which does its confirmations inline.

## Needs the local stack

**Sections have no URLs.** Library, Review, History and Preferences are component
state, so they cannot be bookmarked, shared, or reloaded into, and Back does not
traverse them. `App.tsx` argues that reading is tab state on purpose — a Pull is not a
page — and that argument holds for the feed and is weaker for the others, which are
places rather than modes. `DESTINATIONS` already shows the shape a routed screen takes.

**Scroll position is lost on Back.** `navigate` calls `scrollTo(0, 0)` unconditionally,
`popstate` restores nothing, and `history.scrollRestoration` is never set. Worse, the
feed is hidden with `hidden` (`display: none`), which collapses layout and clamps
scroll to 0 anyway — so the 20-line comment explaining that the feed stays mounted so a
reader "keeps their place" is half true: the state survives and the place does not.

**`plan_interleave` has no SQL-side test.** `packages/ranking` mirrors it in TypeScript
and asserts parity against a committed JSON fixture, captured by hand. Nothing in CI
ever calls the SQL function and compares, so a change to the planner passes green
unless someone remembers to regenerate the fixture. A `db:test` file that runs the SQL
over the fixture's inputs would close it.

## Bigger, and worth discussing in an issue first

**`refresh_knowledge_vector` has no caller.** `user_knowledge_vectors` is never
populated, so the `uvec` term — 18% of the ranking score — is a constant for every
reader. `docs/roadmap.md` describes the two options (a `pg_cron` tick, or dropping the
term and redistributing its weight) and why neither has been chosen.

**The Delta banner counts the pool, not the page.** It reports over an 800-row
candidate pool while the reader is looking at twenty cards, so a well-read reader can
be told "skipped 240 ideas you already know" above twenty. It is a true statement about
what the ranker considered and a false one about the page. A counting-scope decision
rather than a bug, and it needs a product answer before a patch.

**The Conviction Ledger has no read surface.** Stances are recorded by `Interrupt.tsx`
and read back by nothing, so the README feature — "you agreed with this in March; here
is the strongest case against it" — has data and no screen. `docs/roadmap.md` puts
resurfacing in round 3.

## What not to send

`CONTRIBUTING.md` has the full policy. The short version: no bulk PRs, no drive-by
dependency bumps, and no change made on the strength of a scanner finding nobody
reproduced. Those are welcome as issues with a reproduction.
