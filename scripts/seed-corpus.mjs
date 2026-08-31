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
 *   │  38 sources  │ ──────────→  │ status · bytes     │ → report, non-zero on failure
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

const { sources } = JSON.parse(readFileSync(MANIFEST, 'utf8'));
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
  console.log('-- three consequences: it spends their daily quota (38 jobs against a ceiling');
  console.log('-- of 50, locking them out on the day they seed), it makes them author of every');
  console.log('-- summary — and summaries_author_update permits an author to unpublish, so one');
  console.log('-- PATCH per row would empty the public feed — and it exposes every job row,');
  console.log('-- step output and per-step cost to them through the _own policies.');
  console.log('');
  console.log('with target(title, kind, url) as (values');

  console.log(
    selected.map((s) => `       (${lit(s.title)}, ${lit(s.kind)}, ${lit(s.url)})`).join(',\n'),
  );

  console.log('     ),');
  console.log('     -- Only what is genuinely missing.');
  console.log('     --');
  console.log('     -- Without this the statement enqueues every entry in the manifest every');
  console.log('     -- time it runs, including the ones already published — duplicate works in');
  console.log('     -- the feed and duplicate model spend, which is the one cost law 2 is');
  console.log('     -- written to avoid. Re-running a seeder is the normal way to add a source,');
  console.log('     -- so it has to be safe to do.');
  console.log('     --');
  console.log('     -- Matched on lower(title) because that is what the manifest guarantees is');
  console.log('     -- unique. A URL match would miss the same work reached by two hosts, which');
  console.log('     -- has already happened once here: Common Sense arrived from Wikisource and');
  console.log('     -- Gutenberg and was published twice.');
  console.log('     missing as (');
  console.log('       select t.* from target t');
  console.log('       where not exists (');
  console.log('         select 1 from public.works w where lower(w.title) = lower(t.title)');
  console.log('       )');
  console.log('       and not exists (');
  console.log('         select 1 from public.generation_jobs g');
  console.log("         where lower(g.target->>'title') = lower(t.title)");
  console.log("           and g.status in ('queued', 'running')");
  console.log('       )');
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

if (has('--check')) await check();
else if (has('--sql')) sql();
else {
  console.log('Usage: seed-corpus.mjs (--check | --sql) [--limit N] [--skip N]');
  process.exitCode = 2;
}
