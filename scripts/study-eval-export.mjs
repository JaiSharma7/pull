import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/*
 * Export a study generation run in the shape `scripts/study-eval.mjs` reads.
 *
 * The point is the ledger gate. `study-eval.mjs` certifies ledger completeness only
 * against a provider-attempt inventory that was NOT reconstructed from the attempts or
 * the ledger (docs/eval/study-quality.md). Here the two come from different writers:
 *
 *   providerAttemptIds   `provider_calls`, written by the transport BEFORE each request
 *   attempts, ledger     `cost_ledger`, written by the accounting AFTER each request
 *
 * A ledger row with no journal id (the step-level fallback for a recording that failed)
 * is exported as an attempt of its own, which cannot match the inventory, so the gate
 * fails -- correctly, because per-attempt accounting did fail for that step.
 *
 * Human judgements are not in the database. They come from a reviews file, keyed by item
 * id, and an item without one is exported unreviewed, which the evaluator counts against
 * release readiness.
 *
 * Usage:
 *   node scripts/study-eval-export.mjs --manifest m.json [--reviews r.json] --jobs id,id,...
 *
 * The manifest names each fixture source by the exact set of version ids its course was
 * generated from, with its rights and categories:
 *   { "sources": [{ "id": "qualified-trial", "versionIds": ["..."], "rights": "self-authored",
 *                   "categories": ["notes", "qualified"] }] }
 *
 * Reads with `psql` against DATABASE_URL (the local stack by default). It exports ids,
 * statuses and costs -- never source text, and never a reader's answers.
 */

function sameSet(a, b) {
  return a.length === b.length && [...a].sort().join(',') === [...b].sort().join(',');
}

/** Pure: rows in, evaluator input out. Exported for the test. */
export function buildStudyEvalRun({ manifest, generations, items, calls, ledger, reviews = {} }) {
  const sources = manifest?.sources;
  if (!Array.isArray(sources) || sources.length === 0) {
    throw new Error('the manifest needs a nonempty sources array');
  }

  const sourceOfJob = new Map();
  const sourceOfGeneration = new Map();
  for (const generation of generations) {
    const source = sources.find((s) => sameSet(s.versionIds ?? [], generation.versionIds));
    if (!source) {
      throw new Error(
        `generation ${generation.generationId} (job ${generation.jobId}) matches no manifest source`,
      );
    }
    sourceOfJob.set(generation.jobId, source.id);
    sourceOfGeneration.set(generation.generationId, source.id);
  }

  const attempts = [];
  const ledgerRows = [];
  for (const row of ledger) {
    const sourceId = sourceOfJob.get(row.jobId);
    if (!sourceId) continue;
    const attemptId = row.providerCallId ?? `ledger-${row.id}`;
    attempts.push({ id: attemptId, sourceId, stage: row.step });
    ledgerRows.push({ attemptId, costCents: Number(row.costCents) });
  }

  const providerAttemptIds = calls.filter((c) => sourceOfJob.has(c.jobId)).map((c) => c.id);

  const exportedItems = items
    .filter((item) => sourceOfGeneration.has(item.generationId))
    .map((item) => {
      const review = reviews[item.id] ?? {};
      return {
        id: item.id,
        sourceId: sourceOfGeneration.get(item.generationId),
        // `draft` is what validation will decide whether to show; `rejected` never is.
        status: item.status === 'draft' ? 'visible' : 'quarantined',
        adversarial: review.adversarial === true,
        reviewers: Array.isArray(review.reviewers) ? review.reviewers : [],
        ...(review.adjudicated ? { adjudicated: review.adjudicated } : {}),
      };
    });

  return {
    sources: sources.map(({ id, rights, categories }) => ({ id, rights, categories })),
    items: exportedItems,
    attempts,
    ledger: ledgerRows,
    providerAttemptIds,
  };
}

function psqlJson(sql) {
  const url = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
  const out = execFileSync('psql', [url, '-v', 'ON_ERROR_STOP=1', '-Atq', '-c', sql], {
    encoding: 'utf8',
  }).trim();
  return JSON.parse(out || '[]');
}

function argument(name) {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const manifestPath = argument('--manifest');
  const jobList = argument('--jobs');
  if (!manifestPath || !jobList) {
    process.stderr.write(
      'Usage: node scripts/study-eval-export.mjs --manifest m.json [--reviews r.json] --jobs id,id\n',
    );
    process.exit(2);
  }
  const jobs = jobList.split(',').map((j) => j.trim());
  if (!jobs.every((j) => /^[0-9a-f-]{36}$/.test(j))) {
    throw new Error('--jobs takes comma-separated job uuids');
  }
  const inList = jobs.map((j) => `'${j}'`).join(',');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const reviewsPath = argument('--reviews');
  const reviews = reviewsPath ? JSON.parse(readFileSync(reviewsPath, 'utf8')) : {};

  const run = buildStudyEvalRun({
    manifest,
    reviews,
    generations: psqlJson(`
      select coalesce(json_agg(json_build_object(
        'generationId', g.id, 'jobId', g.job_id,
        'versionIds', (select json_agg(s.source_version_id order by s.position)
                       from public.study_generation_sources s where s.generation_id = g.id))), '[]')
      from public.study_generations g where g.job_id in (${inList});`),
    items: psqlJson(`
      select coalesce(json_agg(json_build_object(
        'id', i.id, 'generationId', i.generation_id, 'status', i.status)), '[]')
      from public.study_items i join public.study_generations g on g.id = i.generation_id
      where g.job_id in (${inList});`),
    calls: psqlJson(`
      select coalesce(json_agg(json_build_object('id', pc.id, 'jobId', pc.job_id)), '[]')
      from public.provider_calls pc where pc.job_id in (${inList});`),
    ledger: psqlJson(`
      select coalesce(json_agg(json_build_object(
        'id', cl.id, 'jobId', cl.job_id, 'step', cl.operation,
        'providerCallId', cl.provider_call_id, 'costCents', cl.cost_cents)), '[]')
      from public.cost_ledger cl where cl.job_id in (${inList});`),
  });
  process.stdout.write(JSON.stringify(run, null, 2) + '\n');
}
