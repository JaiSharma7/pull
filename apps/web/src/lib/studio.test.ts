import { describe, expect, it } from 'vitest';
import {
  budgetLine,
  buildImportSource,
  checkSubmission,
  describeJob,
  isRunning,
  isWorthPolling,
  MAX_TEXT_CHARS,
  MIN_TEXT_CHARS,
  STALLED_AFTER_MS,
  type StudioJob,
} from './studio.js';
import type { ImportedItem } from './imports.js';

let seq = 0;
function highlight(body: string, locator: string | null = null): ImportedItem {
  seq += 1;
  return {
    id: `i${seq}`,
    importId: 'b1',
    pullId: `p${seq}`,
    headline: body.slice(0, 40),
    body,
    locator,
    workId: 'w1',
    workTitle: 'A book',
    workKind: 'book',
    createdAt: '2026-09-01T00:00:00Z',
  };
}

function job(over: Partial<StudioJob> = {}): StudioJob {
  return {
    id: 'j1',
    status: 'queued',
    currentStep: 'resolve_identity',
    workId: null,
    summaryId: null,
    error: null,
    createdAt: '2026-09-01T00:00:00Z',
    ...over,
  };
}

/** A fixed clock, so "how long has this been running" is not the wall clock's opinion. */
const NOW = Date.parse('2026-09-01T00:05:00Z');

describe('checkSubmission', () => {
  const long = 'x'.repeat(MIN_TEXT_CHARS);

  it('refuses text the pipeline would refuse, here rather than a minute later', () => {
    // `acquire` refuses under 200 characters four steps and a queue hop after the
    // press, so the reader would watch a job fail for a reason nothing said.
    const check = checkSubmission({ title: 'A thing', text: 'too short' });
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.error).toContain(String(MIN_TEXT_CHARS));
  });

  it('measures after trimming, so 199 characters and a newline is still 199', () => {
    const check = checkSubmission({ title: 'A thing', text: `${'x'.repeat(199)}\n` });
    expect(check.ok).toBe(false);
  });

  it('refuses more than one call may carry, and says what to do instead', () => {
    const check = checkSubmission({ title: 'A thing', text: 'x'.repeat(MAX_TEXT_CHARS + 1) });
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.error).toContain('parts');
  });

  it('needs a title, because it is how the reader finds it again', () => {
    expect(checkSubmission({ title: '   ', text: long }).ok).toBe(false);
  });

  it('refuses a title past the column it lands in', () => {
    expect(checkSubmission({ title: 'a'.repeat(201), text: long }).ok).toBe(false);
  });

  it('hands back what it measured, not what it was given', () => {
    const check = checkSubmission({ title: '  A thing  ', text: `  ${long}  ` });
    expect(check.ok).toBe(true);
    if (check.ok) {
      expect(check.title).toBe('A thing');
      expect(check.text).toBe(long);
    }
  });
});

describe('buildImportSource', () => {
  it('is deterministic, so two presses do not pay for one book twice', () => {
    // The pipeline hashes what it is given and reuses a summary of the same hash.
    const items = [highlight('One passage.'), highlight('Another passage.')];
    expect(buildImportSource(items)).toBe(buildImportSource(items));
  });

  it('keeps the order it was handed, which is the order they were kept', () => {
    const out = buildImportSource([highlight('First.'), highlight('Second.')]);
    expect(out.indexOf('First.')).toBeLessThan(out.indexOf('Second.'));
  });

  it('puts the locator on its own line, so it does not run into the passage', () => {
    expect(buildImportSource([highlight('The passage.', 'Location 412')])).toBe(
      'Location 412\nThe passage.',
    );
  });

  it('separates passages by a blank line rather than a glyph', () => {
    expect(buildImportSource([highlight('One.'), highlight('Two.')])).toBe('One.\n\nTwo.');
  });

  it('drops an empty highlight rather than emitting a gap', () => {
    expect(buildImportSource([highlight('One.'), highlight('   '), highlight('Two.')])).toBe(
      'One.\n\nTwo.',
    );
  });
});

describe('describeJob', () => {
  it('says waiting for a queued job, which is what a budget wait looks like', () => {
    // A job waiting on the day's cap stays `queued` while the worker re-sends its
    // step. It is early, not broken, and must not read as a failure.
    expect(describeJob(job(), NOW)).toBe('Waiting its turn.');
  });

  it('names the phase rather than the DAG node', () => {
    expect(describeJob(job({ status: 'running', currentStep: 'acquire' }), NOW)).toBe(
      'Reading the text.',
    );
    expect(describeJob(job({ status: 'running', currentStep: 'synthesize' }), NOW)).toBe(
      'Writing the summary.',
    );
    expect(describeJob(job({ status: 'running', currentStep: 'publish' }), NOW)).toBe(
      'Finishing up.',
    );
  });

  /*
   * The correction this file first got wrong.
   *
   * `dispatch_generation_step` sets `status = 'running'` on every hop, so a job parked
   * on the day's spent budget is `running`, not `queued` — and the worker re-sends its
   * step for up to 24 hours without touching the status. Saying "Writing the summary."
   * for a day is a screen lying at length, so a provider step that has been running
   * past any plausible duration says it is waiting instead.
   */
  it('stops claiming a summary is being written once that is implausible', () => {
    const stalled = job({ status: 'running', currentStep: 'synthesize' });
    const late = Date.parse(stalled.createdAt) + STALLED_AFTER_MS + 1;
    expect(describeJob(stalled, late)).toContain('budget may be spent');
    expect(describeJob(stalled, late)).not.toContain('Writing');
  });

  it('does not call a job stalled while it is still plausibly working', () => {
    const fresh = job({ status: 'running', currentStep: 'synthesize' });
    const soon = Date.parse(fresh.createdAt) + STALLED_AFTER_MS - 1;
    expect(describeJob(fresh, soon)).toBe('Writing the summary.');
  });

  it('quotes the reason a failure gives, and copes when it gives none', () => {
    expect(describeJob(job({ status: 'failed', error: 'the source is held' }), NOW)).toContain(
      'the source is held',
    );
    expect(describeJob(job({ status: 'failed' }), NOW)).toBe('That did not finish.');
  });

  it('says done when it is done', () => {
    expect(describeJob(job({ status: 'succeeded' }), NOW)).toBe('Done.');
  });
});

describe('isWorthPolling', () => {
  it('keeps asking about a job that is queued, however long it waits for its turn', () => {
    // The per-requester stagger can delay a START by hours, and that job is `queued`.
    const queued = job({ status: 'queued' });
    expect(isWorthPolling(queued, Date.parse(queued.createdAt) + 6 * 60 * 60 * 1000)).toBe(true);
  });

  it('stops asking about a job that has been running past any plausible duration', () => {
    // Not the same question as `isRunning`, and conflating them had the screen polling
    // every ten seconds for up to twenty-four hours against a job parked on the budget.
    const stalled = job({ status: 'running', currentStep: 'synthesize' });
    expect(isWorthPolling(stalled, Date.parse(stalled.createdAt) + STALLED_AFTER_MS + 1)).toBe(
      false,
    );
    expect(isWorthPolling(stalled, Date.parse(stalled.createdAt) + 1000)).toBe(true);
  });

  it('never asks about a job that has finished', () => {
    expect(isWorthPolling(job({ status: 'succeeded' }), NOW)).toBe(false);
    expect(isWorthPolling(job({ status: 'failed' }), NOW)).toBe(false);
  });
});

describe('isRunning', () => {
  it('is true only while there is something left to happen', () => {
    expect(isRunning(job({ status: 'queued' }))).toBe(true);
    expect(isRunning(job({ status: 'running' }))).toBe(true);
    expect(isRunning(job({ status: 'succeeded' }))).toBe(false);
    expect(isRunning(job({ status: 'failed' }))).toBe(false);
  });
});

describe('budgetLine', () => {
  it('says what is left, in money, because money is what the cap counts', () => {
    expect(budgetLine(50, 200)).toBe('About $1.50 of today’s shared generation budget is left.');
  });

  it('says the day is spent rather than showing a button that does nothing', () => {
    expect(budgetLine(200, 200)).toContain('spent');
    expect(budgetLine(240, 200)).toContain('spent');
  });
});
