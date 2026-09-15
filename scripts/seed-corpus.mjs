#!/usr/bin/env node
/**
 * Turn the public-domain manifest into generation jobs.
 *
 *   node scripts/seed-corpus.mjs --check              validate every URL, write nothing
 *   node scripts/seed-corpus.mjs --sql --limit 5      emit SQL for the first five
 *   node scripts/seed-corpus.mjs --sql --skip 5       emit SQL for everything after them
 *
 * **This script never touches the database, and holds no credential.** It validates and
 * prints SQL for a human to run as `postgres` — the SQL editor, or psql as a superuser.
 *
 * Not as `service_role`, which could not run it anyway: that role is a PostgREST role
 * with no USAGE on schema `pgmq`, and its absence there is deliberate — it is the whole
 * reason `enqueue_generation_job` exists as SECURITY DEFINER. Keeping the credential
 * out of the script is also what law 7 asks for, but the privilege argument alone
 * settles it.
 *
 * It also does not go through `enqueue_generation_job`. That RPC derives its requester
 * from `auth.uid()` and enforces a per-reader daily quota — 3 fast, 50 hard ceiling —
 * which is the right rule for a reader asking for a summary and the wrong one for an
 * operator seeding a library. The SQL mirrors what the RPC does (insert, then send in
 * the same statement) without the quota, and with a NULL requester: these are library
 * rows rather than anybody's.
 *
 *   ┌── manifest ──┐   --check    ┌── fetch each URL ──┐
 *   │ 101 sources  │ ──────────→  │ status · bytes     │ → report, non-zero on failure
 *   └──────────────┘              └────────────────────┘
 *          │         --sql
 *          └──────────────────→   INSERT generation_jobs + pgmq.send  → stdout
 *
 * Re-running is safe. `works.content_hash` carries a partial unique index and
 * `acquire` asks `findPublishedSummaryByHash` before calling any provider, so a source
 * already summarised is adopted rather than regenerated: the second run costs nothing.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST = join(HERE, 'corpus', 'public-domain.json');

/** Matches MAX_SOURCE_CHARS in `_shared/source.ts`. Past this, `acquire` truncates. */
const MAX_SOURCE_CHARS = 200_000;
/** Below this, `acquire` refuses: too little text to be worth summarising. */
const MIN_SOURCE_CHARS = 200;

/** Every `work_kind` Postgres will accept. Mirrors `pipeline.ts`'s WORK_KINDS. */
const WORK_KINDS = [
  'book',
  'film',
  'documentary',
  'podcast',
  'paper',
  'essay',
  'lecture',
  'video',
  'interview',
  'other',
];

const die = (message) => {
  console.error(message);
  process.exit(2);
};

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const valueOf = (flag, fallback) => {
  const i = args.indexOf(flag);
  if (i === -1) return fallback;
  const parsed = Number(args[i + 1]);
  // A missing or misspelled value yields NaN, and `slice(0, NaN)` is `[]` — which
  // prints a `values` clause with no rows and is discovered as a syntax error at a
  // psql prompt, several steps from the cause.
  if (!Number.isInteger(parsed) || parsed < 0) die(`${flag} needs a non-negative integer`);
  return parsed;
};

/**
 * Validate the manifest before anything is generated.
 *
 * This is a system boundary and the repo's convention is that shapes are checked at
 * one. Without it `lit(undefined)` becomes the SQL literal `'undefined'`: a job that
 * fetches a nonsense URL, fails `acquire`, burns three retries and dies with nothing
 * to show — exactly the failure `--check` exists to prevent, arriving through the
 * door `--check` does not cover. A misspelled `kind` is quieter still: `asWorkKind`
 * narrows anything unrecognised to `essay`, so the mistake never surfaces at all.
 */
function validate(entries) {
  entries.forEach((source, i) => {
    const where = `sources[${i}] (${source?.title ?? 'untitled'})`;
    if (!source?.title?.trim()) die(`${where}: missing title`);
    if (!WORK_KINDS.includes(source.kind))
      die(`${where}: kind "${source.kind}" is not a work_kind`);
    let parsed;
    try {
      parsed = new URL(source.url);
    } catch {
      die(`${where}: url is not a URL`);
    }
    if (parsed.protocol !== 'https:') die(`${where}: url must be https`);
  });

  const urls = new Set(entries.map((s) => s.url));
  if (urls.size !== entries.length) die('duplicate urls in the manifest');

  /*
   * Also reject the same work reached by two different URLs.
   *
   * The URL check alone passes it, and nothing downstream catches it either:
   * `works.content_hash` is unique, but two archives' renderings of one text differ
   * in whitespace and boilerplate, so the hashes differ and `acquire`'s reuse lookup
   * misses. The result is two paid generations and two feed cards for one essay —
   * a law 2 failure that never raises. Common Sense was in here twice, from
   * Wikisource and Gutenberg, and only a title comparison found it.
   */
  const byTitle = new Map();
  for (const entry of entries) {
    const key = entry.title.trim().toLowerCase();
    const first = byTitle.get(key);
    if (first) die(`duplicate title in the manifest: "${entry.title}"\n  ${first}\n  ${entry.url}`);
    byTitle.set(key, entry.url);
  }
  return entries;
}

/*
 * `--manifest` exists for one caller: `scripts/test-corpus-seed.mjs`, which needs a
 * small, known catalogue to assert against. Without it the test had to splice a
 * replacement row into the emitted `values` clause with a regex, which re-derived SQL
 * literal quoting in JavaScript and broke on the apostrophe in "Ain't I a Woman?" the
 * moment a reorder made that entry first. A flag on the generator is the seam; a regex
 * over its output was a workaround for not having one.
 */
const pathOf = (flag, fallback) => {
  const i = args.indexOf(flag);
  if (i === -1) return fallback;
  const value = args[i + 1];
  if (!value || value.startsWith('--')) die(`${flag} needs a path`);
  return value;
};

const manifest = pathOf('--manifest', MANIFEST);
let parsed;
try {
  parsed = JSON.parse(readFileSync(manifest, 'utf8'));
} catch (e) {
  // Through `die`, like every other input here. A missing file or a stray comma
  // otherwise arrives as a raw ENOENT or a `SyntaxError` stack, and `validate`'s own
  // docstring calls this the system boundary where shapes get checked.
  die(`could not read ${manifest}: ${e instanceof Error ? e.message : String(e)}`);
}
const sources = parsed?.sources;
if (!Array.isArray(sources)) die(`${manifest} has no "sources" array`);
validate(sources);

const skip = valueOf('--skip', 0);
const selected = sources.slice(skip, skip + valueOf('--limit', sources.length));

/** Rough stand-in for `extractText`, good enough to judge whether a page has prose. */
function visibleTextLength(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim().length;
}

async function check() {
  let failures = 0;

  for (const source of selected) {
    let line;
    try {
      const response = await fetch(source.url, {
        headers: { accept: 'text/html' },
        signal: AbortSignal.timeout(20_000),
      });

      if (!response.ok) {
        failures += 1;
        line = `FAIL ${String(response.status).padEnd(4)}`;
      } else {
        const chars = visibleTextLength(await response.text());
        // A 404 on Wikisource still returns 200 with a "no text" stub, so status
        // alone proves nothing. Length is what distinguishes a page from a stub.
        if (chars < MIN_SOURCE_CHARS) {
          failures += 1;
          line = `EMPTY ${String(chars).padStart(6)}c`;
        } else if (chars > MAX_SOURCE_CHARS) {
          // Not a failure: `acquire` truncates and records that it did. Worth
          // seeing, because a truncated source is summarised from its opening only.
          line = `LONG  ${String(chars).padStart(6)}c`;
        } else {
          line = `ok    ${String(chars).padStart(6)}c`;
        }
      }
    } catch (e) {
      failures += 1;
      line = `ERROR ${e instanceof Error ? e.name : 'unknown'}`;
    }

    console.log(`${line}  ${source.title}`);
  }

  console.log(`\n${selected.length - failures}/${selected.length} usable`);
  if (failures) {
    console.log('Fix or remove the failures before seeding — a bad URL is a job that');
    console.log('burns three retries and fails with nothing to show for it.');
    process.exitCode = 1;
  }
}

/** Single-quote escaping for SQL literals. The manifest is committed, but titles have apostrophes. */
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;

function sql() {
  console.log('-- Generated by scripts/seed-corpus.mjs.');
  console.log('--');
  console.log('-- RUN AS `postgres` — the Supabase SQL editor, or psql as a superuser.');
  console.log('-- NOT as service_role, which cannot run this at all: it is a PostgREST role');
  console.log('-- with no USAGE on schema pgmq and no SELECT on auth.users. That absence is');
  console.log('-- deliberate and is the whole reason enqueue_generation_job is SECURITY');
  console.log('-- DEFINER, so it is not something to grant around.');
  console.log('--');
  console.log('-- Mirrors enqueue_generation_job without its per-reader quota: the insert and');
  console.log('-- the sends are one statement, so a job either exists and is queued or neither');
  console.log('-- happened. visibility=public with rights_status=public_domain is what lets the');
  console.log('-- result clear resolve_identity and moderate and reach the feed.');
  console.log('--');
  console.log('-- requester_id is NULL on purpose. These are canonical summaries belonging to');
  console.log('-- the library rather than to a person, and attributing them to a reader has');
  console.log('-- three consequences: it spends their daily quota -- the manifest is several');
  console.log('-- times the ceiling of 50, so it does not merely lock them out for the day,');
  console.log('-- it cannot complete at all -- it makes them author of every');
  console.log('-- summary — and summaries_author_update permits an author to unpublish, so one');
  console.log('-- PATCH per row would empty the public feed — and it exposes every job row,');
  console.log('-- step output and per-step cost to them through the _own policies.');
  console.log('');
  console.log('with target(title, kind, url, author) as (values');

  console.log(
    selected
      .map((s) => `       (${lit(s.title)}, ${lit(s.kind)}, ${lit(s.url)}, ${lit(s.author ?? '')})`)
      .join(',\n'),
  );

  console.log('     ),');
  console.log('     -- Only what is genuinely missing: a title whose every job FAILED.');
  console.log('     --');
  console.log('     -- Without a test like this the statement enqueues the whole manifest');
  console.log('     -- every time it runs -- duplicate works in the feed and duplicate model');
  console.log('     -- spend, which is the one cost law 2 is written to avoid. Re-running a');
  console.log('     -- seeder is the normal way to add a source, so it has to be safe.');
  console.log('     --');
  console.log('     -- THE TEST IS THE JOB, not the work. Two earlier versions asked about');
  console.log('     -- `works`, and both were wrong in ways that never converge:');
  console.log('     --');
  console.log('     --   "a works row with this title exists" skipped every source that died');
  console.log('     --   after resolve_identity, which is exactly the row this seeder is for.');
  console.log('     --');
  console.log('     --   "a works row with a published public summary" reads a title column');
  console.log('     --   the MODEL writes -- pipeline.ts stores `summary.title` -- so a source');
  console.log('     --   that generated perfectly under a title of its own choosing looks');
  console.log('     --   missing forever, and is re-queued on every run, for ever. It also');
  console.log('     --   silently undoes a WITHDRAWAL: unpublish a work after a copyright');
  console.log('     --   complaint and the next run regenerates and republishes it.');
  console.log('     --');
  console.log("     -- `generation_jobs.target->>'title'` is the manifest title verbatim,");
  console.log('     -- written by this statement and never by a model, so the counts below');
  console.log('     -- are over jobs THIS seeder is responsible for. CANONICAL ONLY:');
  console.log('     -- enqueue_generation_job writes a reader-supplied target verbatim, so');
  console.log('     -- without the requester and visibility tests one signed-in reader asking');
  console.log('     -- the Studio about "Nature" -- a real manifest entry -- would retire');
  console.log('     -- Emerson from this seeder permanently.');
  console.log('     --');
  console.log('     -- `live` is a job already coming or already arrived: queued, running,');
  console.log('     -- succeeded, or cancelled because somebody stopped it on purpose. Any of');
  console.log('     -- those and there is nothing to retry.');
  console.log('     --');
  console.log('     -- `tried` is a real attempt that failed, and it EXCLUDES the sweeper.');
  console.log('     -- sweep_stranded_generation_jobs fails every job whose message went');
  console.log('     -- missing -- a dispatch outage fails the whole batch at once -- and');
  console.log('     -- counting those, three outages would disqualify the entire catalogue');
  console.log('     -- for ever, with nothing telling a dead URL from a quiet afternoon.');
  console.log('     -- Three real attempts is the ceiling the worker gives a job internally,');
  console.log('     -- and it is what makes "retry" terminate: a source that dies AFTER');
  console.log('     -- synthesis is paid for would otherwise be bought again on every run.');
  console.log('     --');
  console.log('     -- Then two things about the WORK, both keyed on the URL rather than on');
  console.log('     -- the title. `works.title` is written from `summary.title`, which a model');
  console.log('     -- chooses: against this manifest a title match finds 7 rows and a URL');
  console.log('     -- match finds 10, and the manifest is full of one-word titles -- Art,');
  console.log('     -- Love, Circles, Apology, Meno -- that a model could plausibly emit for a');
  console.log('     -- different source and so suppress the real one for ever. `source_url` is');
  console.log('     -- exact, and no model writes it.');
  console.log('     --');
  console.log('     -- Nothing a reader can already OPEN, which is the leg that covers rows no');
  console.log('     -- job produced: ten works here were seeded directly by migration, and a');
  console.log('     -- predicate that asked only about jobs re-queued seven of them on a');
  console.log('     -- database replayed from zero. Each one is a duplicate work, a duplicate');
  console.log('     -- feed card and a second generation paid for.');
  console.log('     --');
  console.log('     -- And nothing that ARRIVED WITHOUT ONE OF OUR JOBS. Unpublishing a work');
  console.log('     -- after a copyright complaint leaves the works row and takes away the');
  console.log('     -- readable summary, so for a migration-seeded row -- which has no job to');
  console.log('     -- speak for it -- the two legs above both fall silent and the next run');
  console.log('     -- regenerates and republishes it. A source that no job of ours produced');
  console.log("     -- is not this seeder's to retry, whatever state it is in.");
  console.log('     --');
  console.log('     -- Matched on lower(title) for the jobs because that is what the manifest');
  console.log('     -- guarantees is unique. A URL match there would miss the same work reached');
  console.log('     -- by two hosts, which has already happened: Common Sense arrived from');
  console.log('     -- Wikisource and Gutenberg and was published twice.');
  console.log('     missing as (');
  console.log('       select t.* from target t');
  console.log('       -- ONE pass over generation_jobs per target, not two: the counts');
  console.log("       -- below share a predicate, and neither lower(target->>'title') nor");
  console.log('       -- lower(works.title) has an expression index to lean on.');
  console.log('       cross join lateral (');
  console.log('         select');
  console.log('           count(*) as jobs,');
  console.log("           count(*) filter (where g.status <> 'failed') as live,");
  console.log("           count(*) filter (where g.status = 'failed'");
  console.log(
    "                              and coalesce(g.error, '') not like 'stranded:%') as tried",
  );
  console.log('         from public.generation_jobs g');
  console.log("         where lower(g.target->>'title') = lower(t.title)");
  console.log('           and g.requester_id is null');
  console.log("           and g.visibility = 'public'");
  console.log('       ) j');
  console.log('       where j.live = 0');
  console.log('         and j.tried < 3');
  console.log('         and not exists (');
  console.log('           select 1 from public.works w');
  console.log('           join public.summaries s on s.work_id = w.id');
  console.log('           where w.source_url = t.url');
  console.log("             and s.status = 'published' and s.visibility = 'public'");
  console.log('         )');
  console.log('         and (');
  console.log('           j.jobs > 0');
  console.log('           or not exists (');
  console.log('             select 1 from public.works w where w.source_url = t.url');
  console.log('           )');
  console.log('         )');
  console.log('     ),');
  console.log('     queued as (');
  console.log(
    '       insert into public.generation_jobs (requester_id, target, status, visibility)',
  );
  console.log('       select null,');
  console.log('              jsonb_build_object(');
  console.log("                'title', missing.title,");
  console.log("                'kind', missing.kind,");
  console.log("                'url', missing.url,");
  console.log("                'author', nullif(missing.author, ''),");
  console.log("                'rights_status', 'public_domain'");
  console.log('              ),');
  console.log("              'queued', 'public'");
  console.log('       from missing');
  console.log('       returning id');
  console.log('     ),');
  console.log('     -- LATERAL, not count(pgmq.send(...)). `send` returns SETOF bigint, and');
  console.log('     -- Postgres has rejected set-returning functions inside aggregate arguments');
  console.log('     -- since v10 — so the aggregate form fails at parse analysis and inserts');
  console.log('     -- nothing. Every migration reaches pgmq through `perform`, which discards');
  console.log('     -- a result set; count() cannot. This is the shape that runs.');
  console.log('     sent as (');
  console.log('       select s.msg_id');
  console.log('       from queued q');
  console.log('       cross join lateral pgmq.send(');
  console.log("         'generation',");
  console.log("         jsonb_build_object('jobId', q.id, 'step', 'resolve_identity'),");
  console.log('         0');
  console.log('       ) as s(msg_id)');
  console.log('     )');
  console.log('-- One count, not two: a data-modifying CTE is materialised once, so every');
  console.log('-- inserted job is represented here exactly once.');
  console.log('select count(*) as queued_and_sent from sent;');
}

/**
 * Emit SQL that gives already-generated works the attribution they were created without.
 *
 * `works.source_url` and the `contributors` join arrived in 20260901160000, which means
 * every work generated before it has neither — 102 of 108 on the hosted project at the
 * time of writing. New jobs carry both through from the manifest; these rows predate
 * the column and no amount of re-running the seeder reaches them, because the seeder
 * correctly skips a source that already exists.
 *
 * Matched on `lower(title)`, the same key the `missing` CTE uses and for the same
 * stated reason: the manifest guarantees title uniqueness, and a URL match would miss
 * a work reached by two hosts. It is not a perfect key — a generated title that drifted
 * from the manifest's simply will not match — and the statement reports how many rows
 * it touched so that is visible rather than assumed.
 *
 * Only fills what is empty (`where w.source_url is null`), so it is idempotent and
 * cannot redirect a link that already points somewhere. That matters more than it
 * sounds: the outbound link is what law 4's argument rests on, and a backfill that
 * could overwrite one is a backfill that could quietly point a citation at the wrong
 * text.
 */
function backfill() {
  // `selected` is module scope, already honouring --skip/--limit, and already
  // validated at load. Recomputing it here was a second, wrong copy of that.

  console.log('-- Generated by scripts/seed-corpus.mjs --backfill. Run as the owner.');
  console.log('--');
  console.log('-- Attribution for works generated before 20260901160000 added the columns.');
  console.log('-- Idempotent: fills only what is empty, so re-running is a no-op.');
  console.log('');
  console.log('with manifest(title, url, author) as (values');
  console.log(
    selected
      .map((s) => `       (${lit(s.title)}, ${lit(s.url)}, ${lit(s.author ?? '')})`)
      .join(',\n'),
  );
  console.log('     ),');
  console.log('     linked as (');
  console.log('       update public.works w');
  console.log('          set source_url = m.url');
  console.log('         from manifest m');
  console.log('        where lower(w.title) = lower(m.title)');
  console.log('          and w.source_url is null');
  console.log('        returning w.id, m.author');
  console.log('     ),');
  console.log('     credited as (');
  console.log("       select public.attribute_work(l.id, nullif(l.author, ''))");
  console.log('       from linked l');
  console.log('     )');
  console.log('select (select count(*) from linked)   as source_urls_filled,');
  console.log('       (select count(*) from credited) as authors_credited;');
}

if (has('--check')) await check();
else if (has('--sql')) sql();
else if (has('--backfill')) backfill();
else {
  console.log(
    'Usage: seed-corpus.mjs (--check | --sql | --backfill) [--limit N] [--skip N] [--manifest PATH]',
  );
  process.exitCode = 2;
}
