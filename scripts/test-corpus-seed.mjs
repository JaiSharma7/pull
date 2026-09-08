import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

// Exercise the emitted SQL, not a second copy of its eligibility predicate.
const emitted = execFileSync(
  process.execPath,
  ['scripts/seed-corpus.mjs', '--sql', '--limit', '1'],
  {
    encoding: 'utf8',
  },
);
const title = `Catalogue retry ${randomUUID()}`;
const work = randomUUID();
const sql = emitted
  .slice(emitted.indexOf('with target'))
  .replace(/\(values\s*\('[^']*'/, `(values ('${title}'`);
const assertCount = (count) => `do $$ begin
  if (select count(*) from public.generation_jobs
      where target->>'title' = '${title}' and status = 'queued') <> ${count} then
    raise exception 'Unexpected catalogue queue count: expected ${count}';
  end if;
end $$;`;
const input = `begin;
insert into public.works(id, kind, title, slug, rights_status)
values ('${work}', 'book', '${title}', '${work}', 'public_domain');
insert into public.generation_jobs(target, status, visibility)
values (jsonb_build_object('title', '${title}'), 'failed', 'public');
${sql}
${assertCount(1)}
${sql}
${assertCount(1)}
update public.generation_jobs set status = 'failed' where target->>'title' = '${title}';
insert into public.summaries(work_id, title, status, visibility, published_at)
values ('${work}', '${title}', 'published', 'public', now());
${sql}
${assertCount(0)}
rollback;
`;
const result = spawnSync(
  'psql',
  [
    process.env.DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:54322/postgres',
    '-v',
    'ON_ERROR_STOP=1',
    '-q',
  ],
  { input, encoding: 'utf8', stdio: ['pipe', 'inherit', 'inherit'] },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
