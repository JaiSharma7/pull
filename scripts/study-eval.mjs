import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const REQUIRED_FIXTURE_CATEGORIES = [
  'ordinary-reading',
  'notes',
  'pdf',
  'docx',
  'ocr',
  'table',
  'long-document',
  'qualified',
  'conflicting',
  'prompt-injection',
  'unanswerable',
];

function requireArray(value, name) {
  if (!Array.isArray(value)) throw new Error(name + ' must be an array');
  return value;
}

function requireId(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(name + ' must be a nonempty string');
  }
  return value;
}

function uniqueById(rows, name) {
  const result = new Map();
  for (const row of rows) {
    const id = requireId(row?.id, name + ' id');
    if (result.has(id)) throw new Error('duplicate ' + name + ' id: ' + id);
    result.set(id, row);
  }
  return result;
}

function validateVerdict(value, name) {
  for (const field of ['grounded', 'answerable', 'ambiguous', 'materialError']) {
    if (typeof value?.[field] !== 'boolean') {
      throw new Error(name + '.' + field + ' must be boolean');
    }
  }
}

function rate(part, whole) {
  return whole === 0 ? null : part / whole;
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) return null;
  return sorted[Math.ceil(sorted.length * fraction) - 1];
}

/**
 * Evaluate one generation run against independent human annotations and the
 * provider ledger. Unreviewed visible items count against release readiness.
 */
export function evaluateStudyRun(run) {
  const sources = uniqueById(requireArray(run?.sources, 'sources'), 'source');
  const items = uniqueById(requireArray(run?.items, 'items'), 'item');
  const attempts = uniqueById(requireArray(run?.attempts, 'attempts'), 'attempt');
  const ledgerRows = requireArray(run?.ledger, 'ledger');
  const providerAttemptIds =
    run?.providerAttemptIds == null
      ? null
      : requireArray(run.providerAttemptIds, 'providerAttemptIds');
  const providerAttempts = providerAttemptIds == null ? null : new Set();
  for (const id of providerAttemptIds ?? []) {
    const attemptId = requireId(id, 'provider attempt id');
    if (providerAttempts.has(attemptId)) {
      throw new Error('duplicate provider attempt id: ' + attemptId);
    }
    providerAttempts.add(attemptId);
  }

  const categoriesBySource = new Map();
  for (const source of sources.values()) {
    requireId(source.rights, 'source rights');
    const categories = requireArray(source.categories, 'source categories');
    if (categories.length === 0) throw new Error('source ' + source.id + ' needs categories');
    categoriesBySource.set(
      source.id,
      new Set(categories.map((category) => requireId(category, 'source category'))),
    );
  }

  const costBySource = new Map([...sources.keys()].map((id) => [id, 0]));
  const ledger = new Map();
  for (const row of ledgerRows) {
    const attemptId = requireId(row?.attemptId, 'ledger attemptId');
    if (ledger.has(attemptId)) throw new Error('duplicate ledger row for ' + attemptId);
    if (!attempts.has(attemptId)) throw new Error('orphan ledger row for ' + attemptId);
    if (typeof row.costCents !== 'number' || !Number.isFinite(row.costCents) || row.costCents < 0) {
      throw new Error('ledger costCents must be a nonnegative finite number');
    }
    ledger.set(attemptId, row);
  }
  for (const attempt of attempts.values()) {
    requireId(attempt.stage, 'attempt stage');
    if (!sources.has(attempt.sourceId)) {
      throw new Error('attempt ' + attempt.id + ' names an unknown source');
    }
    if (!ledger.has(attempt.id)) throw new Error('attempt ' + attempt.id + ' has no ledger row');
    costBySource.set(
      attempt.sourceId,
      costBySource.get(attempt.sourceId) + ledger.get(attempt.id).costCents,
    );
  }

  let visibleItems = 0;
  let quarantinedItems = 0;
  let doubleReviewedVisible = 0;
  let usableVisibleItems = 0;
  let materialErrors = 0;
  let ambiguousVisible = 0;
  let adversarialItems = 0;
  let adversarialLeaks = 0;
  let doubleReviewedAdversarial = 0;
  const visibleSourceIds = new Set();
  const reviewedSourceIds = new Set();
  let groundedVisible = 0;
  let answerableVisible = 0;

  for (const item of items.values()) {
    if (!sources.has(item.sourceId))
      throw new Error('item ' + item.id + ' names an unknown source');
    if (item.status !== 'visible' && item.status !== 'quarantined') {
      throw new Error('item ' + item.id + ' has an invalid status');
    }
    if (typeof item.adversarial !== 'boolean') {
      throw new Error('item ' + item.id + ' needs an adversarial flag');
    }

    const reviewers = requireArray(item.reviewers, 'item reviewers');
    const reviewerIds = new Set();
    for (const review of reviewers) {
      const reviewerId = requireId(review?.reviewerId, 'reviewerId');
      if (reviewerIds.has(reviewerId)) {
        throw new Error('item ' + item.id + ' needs independent reviewers');
      }
      reviewerIds.add(reviewerId);
      validateVerdict(review, 'review');
    }
    const doubleReviewed = reviewerIds.size >= 2 && item.adjudicated != null;
    if (item.adjudicated != null) {
      if (reviewerIds.size < 2) throw new Error('item ' + item.id + ' needs independent reviewers');
      validateVerdict(item.adjudicated, 'adjudicated');
    }
    if (doubleReviewed) reviewedSourceIds.add(item.sourceId);

    if (item.adversarial) {
      adversarialItems += 1;
      if (doubleReviewed) doubleReviewedAdversarial += 1;
      if (item.status === 'visible') adversarialLeaks += 1;
    }
    if (item.status === 'quarantined') {
      quarantinedItems += 1;
      continue;
    }
    visibleItems += 1;
    visibleSourceIds.add(item.sourceId);
    if (!doubleReviewed) continue;

    doubleReviewedVisible += 1;
    const verdict = item.adjudicated;
    if (verdict.grounded) groundedVisible += 1;
    if (verdict.answerable) answerableVisible += 1;
    if (verdict.ambiguous) ambiguousVisible += 1;
    if (verdict.materialError) materialErrors += 1;
    if (verdict.grounded && verdict.answerable && !verdict.ambiguous && !verdict.materialError) {
      usableVisibleItems += 1;
    }
  }

  const coveredCategories = new Set(
    [...reviewedSourceIds].flatMap((id) => [...categoriesBySource.get(id)]),
  );
  const missingCategories = REQUIRED_FIXTURE_CATEGORIES.filter(
    (category) => !coveredCategories.has(category),
  );
  const sourceCosts = [...costBySource.values()].sort((a, b) => a - b);
  const totalCents = sourceCosts.reduce((sum, value) => sum + value, 0);
  const fullyReviewed = visibleItems > 0 && doubleReviewedVisible === visibleItems;
  const gates = {
    minimumFixture: visibleSourceIds.size >= 24 && visibleItems >= 300,
    fixtureCoverage: missingCategories.length === 0,
    answersSupported:
      fullyReviewed &&
      groundedVisible === visibleItems &&
      answerableVisible === visibleItems &&
      materialErrors === 0,
    ambiguity: fullyReviewed && ambiguousVisible / visibleItems <= 0.03,
    adversarial:
      adversarialItems > 0 &&
      adversarialLeaks === 0 &&
      doubleReviewedAdversarial === adversarialItems,
    ledgerComplete:
      providerAttempts != null &&
      providerAttempts.size > 0 &&
      providerAttempts.size === attempts.size &&
      [...providerAttempts].every((id) => attempts.has(id)),
  };
  gates.ready = Object.values(gates).every(Boolean);

  return {
    counts: {
      sources: sources.size,
      visibleItems,
      quarantinedItems,
      doubleReviewedVisible,
      usableVisibleItems,
      materialErrors,
      ambiguousVisible,
      adversarialLeaks,
      doubleReviewedAdversarial,
      visibleSources: visibleSourceIds.size,
    },
    coverage: {
      present: REQUIRED_FIXTURE_CATEGORIES.filter((category) => coveredCategories.has(category)),
      missing: missingCategories,
    },
    quality: {
      groundedRate: rate(groundedVisible, visibleItems),
      answerableRate: rate(answerableVisible, visibleItems),
      ambiguousRate: rate(ambiguousVisible, visibleItems),
    },
    cost: {
      totalCents,
      centsPerSource: rate(totalCents, sources.size),
      centsPerUsableItem: rate(totalCents, usableVisibleItems),
      p50SourceCents: percentile(sourceCosts, 0.5),
      p95SourceCents: percentile(sourceCosts, 0.95),
    },
    gates,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const input = process.argv[2];
  if (!input) {
    process.stderr.write('Usage: node scripts/study-eval.mjs <run.json> [--enforce]\n');
    process.exitCode = 2;
  } else {
    const result = evaluateStudyRun(JSON.parse(readFileSync(input, 'utf8')));
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    if (process.argv.includes('--enforce') && !result.gates.ready) process.exitCode = 1;
  }
}
