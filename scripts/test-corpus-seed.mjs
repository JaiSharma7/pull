import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

/*
 * The catalogue seeder's eligibility rule, exercised through the SQL it actually emits.
 *
 * Not a second copy of the predicate: `seed-corpus.mjs --sql` is run and its output is
 * fed to psql, so a change to the emitter is a change to what this tests. The previous
 * version of this file asserted only that a published source is not re-queued, which a
 * bare join satisfies -- every condition the rule turns on could be deleted and it
 * stayed green. The cases below are the ones that tell the rule apart from nothing: a
 * failed job IS retried, a succeeded one is not, and neither is a withdrawal.
 */
const seeder = fileURLToPath(new URL('./seed-corpus.mjs', import.meta.url));
const emitted = execFileSync(process.execPath, [seeder, '--sql', '--limit', '1'], {
  encoding: 'utf8',
});

const MARKER = 'with target';
const start = emitted.indexOf(MARKER);
if (start === -1) {
  // Loudly, because the alternative is `slice(-1)`: a one-character `input`, no seeder
  // statement at all, and a count assertion below blaming the predicate for it.
  throw new Error(`seed-corpus.mjs --sql emitted no "${MARKER}" statement:\n${emitted}`);
}

const title = `Catalogue retry ${randomUUID()}`;
const work = randomUUID();

/*
 * The first manifest row is replaced whole rather than by reaching into its first quoted
 * field. `('Ain''t I a Woman?', ...` is already in the manifest, and a regex that stopped
 * at the first apostrophe turned that row into a different literal -- or, with `O'Brien`,
 * into a syntax error -- the moment a reorder made one of them `sources[0]`.
 */
const rows = emitted.slice(start);
const firstRow = rows.match(/\n\s{7}\((?:'(?:[^']|'')*'|[^)])*\)/);
if (!firstRow) throw new Error(`no manifest row found in:\n${rows.slice(0, 400)}`);
const sql = rows.replace(
  firstRow[0],
  `\n       ('${title}', 'essay', 'https://example.test/retry', 'A Nother')`,
);

const queued = (count) => `do $$ begin
  if (select count(*) from public.generation_jobs
      where target->>'title' = '${title}' and status = 'queued') <> ${count} then
    raise exception 'expected ${count} queued job(s) for the test title, found %',
      (select count(*) from public.generation_jobs
        where target->>'title' = '${title}' and status = 'queued');
  end if;
end $$;`;

const input = `begin;

-- A source that failed after creating its work row: the case this seeder exists for.
insert into public.works(id, kind, title, slug, rights_status)
values ('${work}', 'book', '${title}', '${work}', 'public_domain');
insert into public.generation_jobs(target, status, visibility)
values (jsonb_build_object('title', '${title}'), 'failed', 'public');

${sql}
${queued(1)}

-- What the job it queued has to be. A NULL requester is load-bearing: a reader named
-- here is charged the quota, becomes author of every summary -- and
-- summaries_author_update lets an author unpublish -- and gains sight of every job row
-- and per-step cost through the _own policies.
do $$ begin
  if not exists (
    select 1 from public.generation_jobs g
     where g.target->>'title' = '${title}' and g.status = 'queued'
       and g.requester_id is null
       and g.visibility = 'public'
       and g.target->>'rights_status' = 'public_domain'
       and g.target->>'url' = 'https://example.test/retry'
  ) then
    raise exception 'the queued job is not the canonical, unattributed, public one: %',
      (select to_jsonb(g) from public.generation_jobs g
        where g.target->>'title' = '${title}' and g.status = 'queued' limit 1);
  end if;
end $$;

-- And it was SENT. The insert and the sends are one statement precisely so a job cannot
-- exist unqueued; a row with no message is a source that never generates.
do $$ begin
  if (select count(*) from pgmq.q_generation m
      where m.message->>'jobId' in (
        select g.id::text from public.generation_jobs g
         where g.target->>'title' = '${title}')) < 1 then
    raise exception 'the job was inserted but no pgmq message was sent';
  end if;
end $$;

-- Re-running is safe: the job it just queued suppresses a second one.
${sql}
${queued(1)}

-- A SUCCEEDED job suppresses it, and keeps suppressing it once the summary is
-- withdrawn. Unpublishing after a copyright complaint must not be undone by a seeder
-- run, and a predicate that asked whether a readable summary exists did exactly that.
update public.generation_jobs set status = 'succeeded' where target->>'title' = '${title}';
insert into public.summaries(work_id, title, status, visibility, published_at)
values ('${work}', '${title}', 'published', 'public', now());
${sql}
${queued(0)}

update public.summaries set status = 'draft', published_at = null where work_id = '${work}';
${sql}
${queued(0)}

-- A CANCELLED job is somebody stopping it on purpose, so that is not a retry either.
update public.generation_jobs set status = 'cancelled' where target->>'title' = '${title}';
${sql}
${queued(0)}

-- And a model that titled the summary something of its own is still not a second job.
-- works.title is written from summary.title, so a predicate keyed on it finds nothing
-- matching the manifest and re-queues this source on every run, for ever.
update public.generation_jobs set status = 'succeeded' where target->>'title' = '${title}';
update public.works set title = 'On Lending at Interest' where id = '${work}';
${sql}
${queued(0)}

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
