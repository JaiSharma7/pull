import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { evaluateStudyRun } from './study-eval.mjs';

const verdict = (changes = {}) => ({
  grounded: true,
  answerable: true,
  ambiguous: false,
  materialError: false,
  ...changes,
});

function run(changes = {}) {
  return {
    sources: [{ id: 'source-1', rights: 'self-authored' }],
    items: [
      {
        id: 'item-1',
        sourceId: 'source-1',
        status: 'visible',
        adversarial: false,
        reviewers: [
          { reviewerId: 'reader-a', ...verdict() },
          { reviewerId: 'reader-b', ...verdict() },
        ],
        adjudicated: verdict(),
      },
    ],
    attempts: [{ id: 'attempt-1', sourceId: 'source-1', stage: 'synthesis' }],
    ledger: [{ attemptId: 'attempt-1', costCents: 2.5 }],
    ...changes,
  };
}

describe('study generation evaluation', () => {
  it('reports visible quality and billed cost without calling a small fixture release-ready', () => {
    const result = evaluateStudyRun(run());

    assert.deepEqual(result.counts, {
      sources: 1,
      visibleItems: 1,
      quarantinedItems: 0,
      doubleReviewedVisible: 1,
      usableVisibleItems: 1,
      materialErrors: 0,
      ambiguousVisible: 0,
      adversarialLeaks: 0,
    });
    assert.deepEqual(result.quality, {
      groundedRate: 1,
      answerableRate: 1,
      ambiguousRate: 0,
    });
    assert.deepEqual(result.cost, {
      totalCents: 2.5,
      centsPerSource: 2.5,
      centsPerUsableItem: 2.5,
      p50SourceCents: 2.5,
      p95SourceCents: 2.5,
    });
    assert.equal(result.gates.minimumFixture, false);
    assert.equal(result.gates.ready, false);
  });

  it('counts unreviewed visible items as unverified, not grounded', () => {
    const data = run();
    data.items[0].reviewers = [data.items[0].reviewers[0]];
    delete data.items[0].adjudicated;

    const result = evaluateStudyRun(data);
    assert.equal(result.counts.doubleReviewedVisible, 0);
    assert.equal(result.counts.usableVisibleItems, 0);
    assert.equal(result.quality.groundedRate, 0);
    assert.equal(result.gates.answersSupported, false);
    assert.equal(result.cost.centsPerUsableItem, null);
  });

  it('fails the answer gate for a reviewed but unsupported visible answer', () => {
    const data = run();
    data.items[0].adjudicated = verdict({ grounded: false, materialError: true });

    const result = evaluateStudyRun(data);
    assert.equal(result.counts.materialErrors, 1);
    assert.equal(result.gates.answersSupported, false);
  });

  it('fails the adversarial gate when an attack item reaches the learner', () => {
    const data = run();
    data.items[0].adversarial = true;

    const result = evaluateStudyRun(data);
    assert.equal(result.counts.adversarialLeaks, 1);
    assert.equal(result.gates.adversarial, false);
  });

  it('keeps failed provider attempts in cost and refuses an unledgered call', () => {
    const data = run({
      attempts: [
        { id: 'attempt-1', sourceId: 'source-1', stage: 'synthesis' },
        { id: 'attempt-2', sourceId: 'source-1', stage: 'retry' },
      ],
      ledger: [
        { attemptId: 'attempt-1', costCents: 2.5 },
        { attemptId: 'attempt-2', costCents: 0.75 },
      ],
    });
    assert.equal(evaluateStudyRun(data).cost.totalCents, 3.25);
    data.ledger.pop();
    assert.throws(() => evaluateStudyRun(data), /attempt-2.*ledger/);
  });

  it('refuses duplicate reviewers and orphan ledger rows', () => {
    const data = run();
    data.items[0].reviewers[1].reviewerId = 'reader-a';
    assert.throws(() => evaluateStudyRun(data), /independent reviewers/);

    const extra = run();
    extra.ledger.push({ attemptId: 'unknown', costCents: 1 });
    assert.throws(() => evaluateStudyRun(extra), /orphan ledger/);
  });
});
