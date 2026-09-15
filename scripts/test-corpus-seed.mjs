import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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

// The start of a line, so adding a column to the manifest moves nothing here: a marker
// carrying the whole column list turned an ordinary catalogue change into "emitted no
// seeder statement", which points the contributor at a statement that is in fact there.
const MARKER = '\nwith target(';

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
 * And NOT a comparison against the committed migration, which an earlier revision of this
 * file did and which was a trap.
 *
 * `20260915010000_retry_incomplete_catalogue.sql` is generator output, so pinning it to
 * the generator's current output looks like the check CI runs for `database.types.ts` and
 * the BAML exports. It is the opposite of that. Those files are regenerated on every
 * build and are meant to track their source; a migration is applied once and is then
 * history, and law 6 says never to edit one that has been pushed. Adding a source to
 * `scripts/corpus/public-domain.json` -- which this script's own docstring calls the
 * normal way to add a source -- changed the generator's output and turned `pnpm db:test`
 * red against a historical file, with an error telling the contributor to edit it. A
 * check whose remedy is a law violation is worse than no check.
 *
 * So the migration is a snapshot and says so in its own header. What is tested here is
 * the live predicate, through the SQL the generator emits today, which is the thing a
 * future change can actually get wrong.
 */

const failed = 'A Source That Failed';
const never = 'A Source Never Tried';
const present = 'A Source Already Published';

/*
 * Fresh ids per run, which is what every SQL file in this chain does with
 * `extensions.gen_random_uuid()`. Hard-coded ones raise a duplicate key against any
 * database that is not freshly reset -- a previous run that aborted before its
 * `rollback`, a developer's own fixtures -- and the failure then names `auth.users`
 * rather than anything about the seeder, which is the hazard this file's own header
 * warns about for `DATABASE_URL`.
 */
const reader = randomUUID();
const failedWork = randomUUID();
const publishedWork = randomUUID();

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
values ('${reader}',
        '00000000-0000-0000-0000-000000000000',
        'corpus-seed-reader@example.test', 'authenticated', 'authenticated');

-- One source that failed after creating its work row -- the case this seeder is for --
-- and one that is already published with NO job at all, which is how nine works in this
-- catalogue actually arrived: seeded directly by migration. A predicate that asks only
-- about jobs re-queues every one of them.
insert into public.works(id, kind, title, slug, rights_status, source_url)
values ('${failedWork}', 'book', '${failed}',
        'failed-' || extensions.gen_random_uuid(), 'public_domain',
        'https://example.test/failed');
insert into public.generation_jobs(requester_id, target, status, visibility)
values (null, jsonb_build_object('title', '${failed}'), 'failed', 'public');

-- With its source_url, because that is the key: works.title is written from
-- summary.title, which a model chooses, and against the real manifest a title match
-- finds 7 rows where a URL match finds 10. The title here is deliberately NOT the
-- manifest's, so a predicate that went back to matching on it fails this case.
insert into public.works(id, kind, title, slug, rights_status, source_url)
values ('${publishedWork}', 'book', 'A Title The Model Chose',
        'present-' || extensions.gen_random_uuid(), 'public_domain',
        'https://example.test/published');
insert into public.summaries(work_id, title, status, visibility, published_at)
values ('${publishedWork}', 'A Title The Model Chose', 'published', 'public', now());

-- TWO rows queued by one statement, which is what the LATERAL sent and the
-- single-materialisation claim are about; a one-row fixture exercises neither.
${sql}
${queued(failed, 1)}
${queued(never, 1)}
${queued(present, 0)}

do $$ begin
  if (select count(*) from pgmq.q_generation m
      where m.message->>'jobId' in (
        select g.id::text from public.generation_jobs g
         where g.target->>'title' in ('${failed}', '${never}'))) <> 2 then
    raise exception 'two jobs were inserted but % messages were sent',
      (select count(*) from pgmq.q_generation m
        where m.message->>'jobId' in (
          select g.id::text from public.generation_jobs g
           where g.target->>'title' in ('${failed}', '${never}')));
  end if;
end $$;

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
       -- kind and author too: asWorkKind narrows an absent kind to 'essay', so
       -- dropping it from the target would never surface at runtime either, and the
       -- nullif on author is the reason attribute_work is not handed an empty string.
       and g.target->>'kind' = 'essay'
       and g.target->>'author' = 'A Nother'
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

-- From here each case sets one title's job rows outright and asks what the seeder does
-- with that state. They use "A Source Never Tried", which has no works row, so the last
-- leg of the predicate is satisfied by that alone and each case isolates the one thing
-- it is about. The counter looks at canonical rows only: a suppressed title reads 0.

-- A SUCCEEDED job suppresses it, whatever was done to the summary afterwards.
delete from public.generation_jobs where target->>'title' = '${never}';
insert into public.generation_jobs(requester_id, target, status, visibility)
values (null, jsonb_build_object('title', '${never}'), 'succeeded', 'public');
${sql}
${queued(never, 0)}

-- A CANCELLED job is somebody stopping it on purpose, so that is not a retry either.
update public.generation_jobs set status = 'cancelled' where target->>'title' = '${never}';
${sql}
${queued(never, 0)}

-- CASE INSENSITIVE, which the manifest needs: it carries "Democracy and Education:
-- Chapter Iv" and its siblings.
delete from public.generation_jobs where target->>'title' = '${never}';
insert into public.generation_jobs(requester_id, target, status, visibility)
values (null, jsonb_build_object('title', upper('${never}')), 'succeeded', 'public');
${sql}
${queued(never, 0)}

-- A READER'S job is not the library's. enqueue_generation_job writes a caller's target
-- verbatim, so without this one reader asking the Studio about a manifest title would
-- remove it from the catalogue for ever. Attributed AND public, which nothing produces
-- today, because the requester test is what the rule means and it should not rest on a
-- column default staying where it is.
delete from public.generation_jobs
 where target->>'title' in ('${never}', upper('${never}'));
insert into public.generation_jobs(requester_id, target, status, visibility)
values ('${reader}', jsonb_build_object('title', '${never}'), 'succeeded', 'public');
${sql}
${queued(never, 1)}

-- And a CANONICAL job that is not public does not speak for the catalogue either.
-- Nothing writes one today -- the column defaults to private and only this statement
-- sets it -- which is exactly why the test holds the condition in place rather than
-- letting the requester test carry it alone.
delete from public.generation_jobs where target->>'title' = '${never}';
insert into public.generation_jobs(requester_id, target, status, visibility)
values (null, jsonb_build_object('title', '${never}'), 'succeeded', 'private');
${sql}
${queued(never, 1)}

-- THE SWEEPER'S failures are not attempts. sweep_stranded_generation_jobs fails every
-- job whose message went missing, so one dispatch outage fails the whole batch at once;
-- counting those, three outages would disqualify the entire catalogue for ever, with
-- nothing telling a dead URL from a quiet afternoon.
delete from public.generation_jobs where target->>'title' = '${never}';
insert into public.generation_jobs(requester_id, target, status, visibility, error)
select null, jsonb_build_object('title', '${never}'), 'failed', 'public',
       'stranded: nothing queued for step resolve_identity since 2026-01-01'
  from generate_series(1, 5);
${sql}
${queued(never, 1)}

-- AND IT TERMINATES. A source that dies after synthesis has been paid for leaves a
-- failed job and no published summary, so without a bound it is re-queued on every run
-- and repaid for every time.
delete from public.generation_jobs where target->>'title' = '${never}';
insert into public.generation_jobs(requester_id, target, status, visibility)
select null, jsonb_build_object('title', '${never}'), 'failed', 'public'
  from generate_series(1, 3);
${sql}
${queued(never, 0)}

-- THE WORK IS FOUND BY URL, not by title. works.title is written from summary.title,
-- which a model chooses -- against the real manifest a title match finds 7 rows where a
-- URL match finds 10 -- and the manifest is full of one-word titles (Art, Love, Meno) a
-- model could emit for some other source. This row is titled something else entirely, so
-- a predicate that went back to matching on the title would not find it. The failed job
-- is what makes this case about leg 2 alone: without it the last leg suppresses anyway.
insert into public.generation_jobs(requester_id, target, status, visibility)
values (null, jsonb_build_object('title', '${present}'), 'failed', 'public');
${sql}
${queued(present, 0)}

-- A WITHDRAWAL of a work this seeder never produced is not a gap to fill. Ten works in
-- the real catalogue arrived by migration with no job at all; unpublishing one after a
-- copyright complaint leaves the works row and takes the readable summary away, and
-- without the last leg the next run regenerates and republishes it. The job from the
-- case above goes, because this one is about a work with none.
delete from public.generation_jobs where target->>'title' = '${present}';
update public.summaries set status = 'draft', published_at = null
 where work_id = '${publishedWork}';
${sql}
${queued(present, 0)}

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
