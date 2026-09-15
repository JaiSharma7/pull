import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/*
 * The catalogue seeder's eligibility rule, exercised through the SQL it actually emits.
 *
 * Not a second copy of the predicate: `seed-corpus.mjs --sql` is run and its output is
 * fed to psql, so a change to the emitter is a change to what this tests. An earlier
 * version asserted only that an already-published source is not re-queued, which a bare
 * join satisfies -- every condition the rule turns on could be deleted and it stayed
 * green. The cases below are the ones that tell the rule apart from nothing, and each
 * one has been checked by breaking that leg of the predicate and watching this fail.
 *
 * Two manifest rows rather than one, through `--manifest`, so the multi-row path runs:
 * `sent` is a LATERAL because `count(pgmq.send(...))` fails at parse analysis, and the
 * final count claims a data-modifying CTE is materialised once. Neither is a statement
 * about a single row.
 */
const seeder = fileURLToPath(new URL('./seed-corpus.mjs', import.meta.url));
const manifestPath = fileURLToPath(new URL('./corpus/test-fixture.json', import.meta.url));

// The whole opening line, not just "with target": the migration's header quotes that
// phrase while explaining what follows it, so a shorter marker finds prose.
const MARKER = '\nwith target(title, kind, url, author) as (values';

const emitted = execFileSync(process.execPath, [seeder, '--sql', '--manifest', manifestPath], {
  encoding: 'utf8',
});
const start = emitted.indexOf(MARKER);
if (start === -1) {
  // Loudly, because the alternative is `slice(-1)`: a one-character `input`, no seeder
  // statement at all, and a count assertion below blaming the predicate for it.
  throw new Error(`seed-corpus.mjs --sql emitted no seeder statement:\n${emitted}`);
}
const sql = emitted.slice(start + 1);

/*
 * And the committed migration is still that same statement.
 *
 * `20260915010000_retry_incomplete_catalogue.sql` is generator output copied in by hand,
 * and nothing in CI regenerates it and diffs it the way it does for `database.types.ts`
 * and the BAML exports. This is that check: run the generator over the real manifest and
 * compare from the first statement down. A predicate changed in one and not the other is
 * a migration doing something the script it is documented to come from does not.
 */
const migrationPath = fileURLToPath(
  new URL('../supabase/migrations/20260915010000_retry_incomplete_catalogue.sql', import.meta.url),
);
const committed = readFileSync(migrationPath, 'utf8');
const real = execFileSync(process.execPath, [seeder, '--sql'], { encoding: 'utf8' });
if (committed.slice(committed.indexOf(MARKER)) !== real.slice(real.indexOf(MARKER))) {
  throw new Error(
    '20260915010000_retry_incomplete_catalogue.sql is stale.\n' +
      'Regenerate its body with `node scripts/seed-corpus.mjs --sql`, keeping the header.',
  );
}

const failed = 'A Source That Failed';
const present = 'A Source Already Published';

/** Canonical queued jobs for one title. A reader's own job is not the library's. */
const queued = (title, count) => `do $$ begin
  if (select count(*) from public.generation_jobs
      where target->>'title' = '${title}' and status = 'queued'
        and requester_id is null) <> ${count} then
    raise exception 'expected ${count} queued job(s) for %, found %', '${title}',
      (select count(*) from public.generation_jobs
        where target->>'title' = '${title}' and status = 'queued' and requester_id is null);
  end if;
end $$;`;

const input = `begin;

-- The owner, and nothing else. The SQL files in this chain that assert a reader role do
-- it because RLS is invisible to an owner-role query; this file is the inverse and needs
-- saying just as plainly, because a seeder is an owner-role write path and a
-- DATABASE_URL pointing at a reader would fail below for reasons that look like the
-- predicate.
do $$ begin
  if current_user <> 'postgres' then
    raise exception 'test-corpus-seed.mjs must run as the owner, not as %', current_user;
  end if;
end $$;

-- A reader to attribute jobs to. auth.users is empty on a freshly reset database, and
-- selecting one would quietly hand back NULL -- which is precisely the
-- value the canonical test looks for, so the reader cases would pass by being the thing
-- they are meant to be distinguished from.
insert into auth.users (id, instance_id, email, aud, role)
values ('22222222-2222-4222-8222-222222222222',
        '00000000-0000-0000-0000-000000000000',
        'corpus-seed-reader@example.test', 'authenticated', 'authenticated');

-- One source that failed after creating its work row -- the case this seeder is for --
-- and one that is already published with NO job at all, which is how nine works in this
-- catalogue actually arrived: seeded directly by migration. A predicate that asks only
-- about jobs re-queues every one of them.
insert into public.works(id, kind, title, slug, rights_status)
values ('33333333-3333-4333-8333-333333333333', 'book', '${failed}',
        'failed-' || extensions.gen_random_uuid(), 'public_domain');
insert into public.generation_jobs(requester_id, target, status, visibility)
values (null, jsonb_build_object('title', '${failed}'), 'failed', 'public');

insert into public.works(id, kind, title, slug, rights_status)
values ('11111111-1111-4111-8111-111111111111', 'book', '${present}',
        'present-' || extensions.gen_random_uuid(), 'public_domain');
insert into public.summaries(work_id, title, status, visibility, published_at)
values ('11111111-1111-4111-8111-111111111111', '${present}', 'published', 'public', now());

${sql}
${queued(failed, 1)}
${queued(present, 0)}

-- What the job it queued has to be. A NULL requester is load-bearing: a reader named
-- here is charged the quota, becomes author of every summary -- and
-- summaries_author_update lets an author unpublish -- and gains sight of every job row
-- and per-step cost through the _own policies.
do $$ begin
  if not exists (
    select 1 from public.generation_jobs g
     where g.target->>'title' = '${failed}' and g.status = 'queued'
       and g.requester_id is null
       and g.visibility = 'public'
       and g.target->>'rights_status' = 'public_domain'
       and g.target->>'url' = 'https://example.test/failed'
  ) then
    raise exception 'the queued job is not the canonical, unattributed, public one: %',
      (select to_jsonb(g) from public.generation_jobs g
        where g.target->>'title' = '${failed}' and g.status = 'queued' limit 1);
  end if;
end $$;

-- And it was SENT, exactly once. The insert and the sends are one statement precisely so
-- a job cannot exist unqueued; a row with no message is a source that never generates,
-- and two messages is a source generated twice.
do $$ begin
  if (select count(*) from pgmq.q_generation m
      where m.message->>'jobId' in (
        select g.id::text from public.generation_jobs g
         where g.target->>'title' = '${failed}')) <> 1 then
    raise exception 'expected exactly one pgmq message for the queued job, found %',
      (select count(*) from pgmq.q_generation m
        where m.message->>'jobId' in (
          select g.id::text from public.generation_jobs g
           where g.target->>'title' = '${failed}'));
  end if;
end $$;

-- Re-running is safe: the job it just queued suppresses a second one.
${sql}
${queued(failed, 1)}

-- From here each case sets this title's job rows outright and asks what the seeder does
-- with that state, rather than accumulating. The counter looks at canonical rows only,
-- so a suppressed title reads 0 and an unsuppressed one reads 1.

-- A SUCCEEDED job suppresses it, and keeps suppressing it once the summary is withdrawn.
-- Unpublishing after a copyright complaint must not be undone by a seeder run, and a
-- predicate that asked only whether a readable summary exists did exactly that.
delete from public.generation_jobs where target->>'title' = '${failed}';
insert into public.generation_jobs(requester_id, target, status, visibility)
values (null, jsonb_build_object('title', '${failed}'), 'succeeded', 'public');
${sql}
${queued(failed, 0)}

-- A CANCELLED job is somebody stopping it on purpose, so that is not a retry either.
update public.generation_jobs set status = 'cancelled' where target->>'title' = '${failed}';
${sql}
${queued(failed, 0)}

-- CASE INSENSITIVE, which the emitted comment argues at length for and which the
-- manifest needs: it carries "Democracy and Education: Chapter Iv" and its siblings.
delete from public.generation_jobs where target->>'title' = '${failed}';
insert into public.generation_jobs(requester_id, target, status, visibility)
values (null, jsonb_build_object('title', upper('${failed}')), 'succeeded', 'public');
${sql}
${queued(failed, 0)}

-- A READER'S job is not the library's. enqueue_generation_job writes a caller's target
-- verbatim, so without this one reader asking the Studio about a manifest title would
-- remove it from the catalogue for ever. Attributed AND public, which nothing produces
-- today -- the column defaults to private -- because the requester test is what the rule
-- means and it should not rest on a default staying put.
delete from public.generation_jobs
 where target->>'title' in ('${failed}', upper('${failed}'));
insert into public.generation_jobs(requester_id, target, status, visibility)
values ('22222222-2222-4222-8222-222222222222',
        jsonb_build_object('title', '${failed}'), 'succeeded', 'public');
${sql}
${queued(failed, 1)}

-- AND IT TERMINATES. A source that dies after synthesis has been paid for leaves a
-- failed job and no published summary, so without a bound it is re-queued on every run
-- and repaid for every time.
delete from public.generation_jobs where target->>'title' = '${failed}';
insert into public.generation_jobs(requester_id, target, status, visibility)
select null, jsonb_build_object('title', '${failed}'), 'failed', 'public'
  from generate_series(1, 3);
${sql}
${queued(failed, 0)}

rollback;
`;

const result = spawnSync(
  'psql',
  [
    process.env.DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:54322/postgres',
    // -X so a contributor's ~/.psqlrc cannot change how this transaction behaves.
    // ON_ERROR_ROLLBACK or AUTOCOMMIT there would make the run pass or fail for reasons
    // that have nothing to do with the predicate, and only on their machine.
    '-X',
    '-v',
    'ON_ERROR_STOP=1',
    '-q',
  ],
  { input, encoding: 'utf8', stdio: ['pipe', 'inherit', 'inherit'] },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
