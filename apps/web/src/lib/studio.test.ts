import { describe, expect, it } from 'vitest';
import {
  budgetLine,
  checkSubmission,
  describeJob,
  fitImportSource,
  isRunning,
  isWorthPolling,
  MAX_TEXT_CHARS,
  MIN_TEXT_CHARS,
  POLL_FOR_MS,
  STALLED_AFTER_MS,
  truncationNote,
  waitMinutes,
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
    updatedAt: '2026-09-01T00:00:00Z',
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

describe('fitImportSource: the text it builds', () => {
  /** What the whole book comes out as, since every assertion here is about the text. */
  const built = (items: Parameters<typeof fitImportSource>[0]) => fitImportSource(items).text;

  it('is deterministic, so two presses do not pay for one book twice', () => {
    // The pipeline hashes what it is given and reuses a summary of the same hash.
    const items = [highlight('One passage.'), highlight('Another passage.')];
    expect(built(items)).toBe(built(items));
  });

  it('keeps the order it was handed, which is the order they were kept', () => {
    const out = built([highlight('First.'), highlight('Second.')]);
    expect(out.indexOf('First.')).toBeLessThan(out.indexOf('Second.'));
  });

  it('puts the locator on its own line, so it does not run into the passage', () => {
    expect(built([highlight('The passage.', 'Location 412')])).toBe('Location 412\nThe passage.');
  });

  it('separates passages by a blank line rather than a glyph', () => {
    expect(built([highlight('One.'), highlight('Two.')])).toBe('One.\n\nTwo.');
  });

  it('drops an empty highlight rather than emitting a gap', () => {
    expect(built([highlight('One.'), highlight('   '), highlight('Two.')])).toBe('One.\n\nTwo.');
  });

  // The locator survived the empty body, because `"Location 412\n"` is not the empty
  // string — so a citation with no passage under it was sent to the model and hashed
  // into `works.content_hash`.
  it('drops an empty highlight that still has a locator', () => {
    expect(built([highlight('One.'), highlight('  ', 'Location 412'), highlight('Two.')])).toBe(
      'One.\n\nTwo.',
    );
  });
});

describe('fitImportSource', () => {
  const long = (n: number) => 'x'.repeat(n);

  it('sends the whole book when it fits', () => {
    const items = [highlight('One.'), highlight('Two.')];
    const fitted = fitImportSource(items, 1000);
    expect(fitted.used).toBe(2);
    expect(fitted.total).toBe(2);
    expect(fitted.complete).toBe(true);
    expect(fitted.text).toBe('One.\n\nTwo.');
  });

  /*
   * The dead end this replaced: `checkSubmission` answered a four-thousand-highlight
   * book with "Send it in parts", and the picker has no parts — the only granularity it
   * offers is a whole book, so the reader its own copy describes could not use Studio.
   */
  it('cuts to a whole number of highlights rather than refusing the book', () => {
    const items = [highlight(long(50)), highlight(long(50)), highlight(long(50))];
    const fitted = fitImportSource(items, 110);
    expect(fitted.used).toBe(2);
    expect(fitted.total).toBe(3);
    expect(fitted.text.length).toBeLessThanOrEqual(110);
    // Whole passages, never half of one: a passage cut mid-sentence says something its
    // author did not.
    expect(fitted.text).toBe(`${long(50)}\n\n${long(50)}`);
  });

  it('is deterministic when it cuts, so a second press does not pay again', () => {
    const items = [highlight(long(50)), highlight(long(50)), highlight(long(50))];
    expect(fitImportSource(items, 110).text).toBe(fitImportSource(items, 110).text);
  });

  /*
   * A cut book is a PREFIX of the whole one, byte for byte — the pipeline hashes what it
   * is given, so text assembled one way when it fits and another way when it does not
   * would be two documents wearing one hash.
   */
  it('cuts to a prefix of the text it would have sent whole', () => {
    const items = [
      highlight(long(50), 'Location 1'),
      highlight(long(50), 'Location 3'),
      highlight(long(50)),
    ];
    const fitted = fitImportSource(items, 140);
    expect(fitted.used).toBe(2);
    expect(fitted.text).toBe(fitImportSource(items.slice(0, 2)).text);
    expect(fitImportSource(items).text.startsWith(fitted.text)).toBe(true);
  });

  /*
   * An empty row contributed nothing, so it is not one of the highlights the reader is
   * told was sent. Counting them both inflated "the first N of M" and defeated the
   * caller's "not one of them fits" guard — a book whose first row was blank and whose
   * second was over the bound came back claiming one highlight and no text.
   */
  it('does not count the empty highlights it skipped', () => {
    const items = [highlight('One.'), highlight('   '), highlight('Two.')];
    const fitted = fitImportSource(items, 1000);
    expect(fitted.used).toBe(2);
    // Nothing was dropped for LENGTH, so the screen says nothing about shortening.
    expect(fitted.complete).toBe(true);
    expect(truncationNote(fitted)).toBeNull();
    expect(fitted.text).toBe('One.\n\nTwo.');
  });

  it('reports nothing usable when the only real highlight is over the bound', () => {
    const fitted = fitImportSource([highlight('   '), highlight(long(400))], 100);
    expect(fitted.used).toBe(0);
    expect(fitted.text).toBe('');
  });

  it('reports nothing usable when the first highlight alone is over the bound', () => {
    const fitted = fitImportSource([highlight(long(400))], 100);
    expect(fitted.used).toBe(0);
    expect(fitted.text).toBe('');
  });
});

describe('truncationNote', () => {
  it('says nothing when the whole book went in', () => {
    expect(truncationNote({ used: 12, total: 12, complete: true })).toBeNull();
  });

  it('names both numbers, because the reader is about to pay for one of them', () => {
    expect(truncationNote({ used: 1842, total: 4000, complete: false })).toBe(
      'This book is longer than one summary can take. The first 1,842 of 4,000 highlights will be sent.',
    );
  });

  it('says what is wrong when not one highlight fits', () => {
    expect(truncationNote({ used: 0, total: 3, complete: false })).toContain('on its own longer');
  });
});

describe('waitMinutes', () => {
  /*
   * The replay branch returns the stagger LESS the wait already served, so a replay near
   * the end of one comes back with seconds — and `Math.round(seconds / 60)` printed
   * "starting in about 0 minutes" on the arm whose whole purpose is saying it has not
   * started.
   */
  it('never says nought minutes', () => {
    expect(waitMinutes(12)).toBe('a minute');
    expect(waitMinutes(89)).toBe('a minute');
  });

  it('rounds to whole minutes above that', () => {
    expect(waitMinutes(5400)).toBe('90 minutes');
  });
});

describe('describeJob', () => {
  it('says waiting for a queued job, which is what a budget wait looks like', () => {
    // A job waiting on the day's cap stays `queued` while the worker re-sends its
    // step. It is early, not broken, and must not read as a failure.
    expect(describeJob(job(), NOW)).toBe('Waiting its turn.');
  });

  // A status `generation_jobs` really has, and one that used to fall through to the
  // running branches: a job cancelled half an hour ago was told it would finish on its
  // own, on a screen that argues at length against saying what it cannot know.
  it('says a cancelled job was cancelled rather than that it is still working', () => {
    expect(
      describeJob(job({ status: 'cancelled', currentStep: 'synthesize' }), NOW + 60 * 60 * 1000),
    ).toBe('That was cancelled.');
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
  /*
   * And it is measured from `updatedAt`, not from creation: the stagger delays the Nth
   * job of a day by `(N - 3 + 1) * 300` seconds, so a job created 25 minutes before it
   * was dispatched arrived at this branch having "run" for the whole wait and told the
   * reader it was taking longer than usual at the moment it started.
   */
  it('counts from when the job last moved, not from when it was queued', () => {
    const staggered = job({
      status: 'running',
      currentStep: 'synthesize',
      createdAt: '2026-09-01T00:00:00Z',
      updatedAt: '2026-09-01T00:25:00Z',
    });
    expect(describeJob(staggered, Date.parse('2026-09-01T00:27:00Z'))).toBe('Writing the summary.');
  });

  it('stops claiming a summary is being written once that is implausible', () => {
    const stalled = job({ status: 'running', currentStep: 'synthesize' });
    const late = Date.parse(stalled.updatedAt) + STALLED_AFTER_MS + 1;
    expect(describeJob(stalled, late)).toContain('Taking longer');
    expect(describeJob(stalled, late)).not.toContain('Writing');
    // And it does not guess WHY. Naming the budget mislabels a genuinely slow source.
    expect(describeJob(stalled, late)).not.toContain('budget');
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
  it('keeps asking about a queued job for the length of the stagger, and no longer', () => {
    // The per-requester stagger delays the 50th job of the day by nearly four hours,
    // and it is `queued` for all of it — but exempting `queued` outright left the same
    // unbounded poll the bound exists to remove, pointed at the other status.
    const queued = job({ status: 'queued' });
    const at = (ms: number) => Date.parse(queued.createdAt) + ms;
    expect(isWorthPolling(queued, at(3 * 60 * 60 * 1000))).toBe(true);
    expect(isWorthPolling(queued, at(POLL_FOR_MS + 1))).toBe(false);

    // The stagger's own worst case, and the reason the window is not four hours flat:
    // `enqueue_generation_job` delays the 50th job of the day by `(50 - 3 + 1) * 300`
    // seconds, which is four hours exactly. A window of four hours stopped watching on
    // the tick the job was due to start.
    expect(isWorthPolling(queued, at(48 * 300 * 1000))).toBe(true);
  });

  it('stops asking long before a budget wait could run out', () => {
    // Not the same question as `isRunning`, and conflating them had the screen polling
    // every ten seconds for up to twenty-four hours against a job parked on the budget.
    // Nor the same question as `describeJob`'s threshold: twenty minutes is when
    // "Writing the summary" stops being honest, four hours is when asking again stops
    // being worth a request.
    const stalled = job({ status: 'running', currentStep: 'synthesize' });
    const at = (ms: number) => Date.parse(stalled.createdAt) + ms;
    expect(isWorthPolling(stalled, at(STALLED_AFTER_MS + 1))).toBe(true);
    expect(isWorthPolling(stalled, at(POLL_FOR_MS + 1))).toBe(false);
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
  /*
   * Coarse on purpose. It used to print `cap - spent`, which is a live countdown to
   * closing the day for everybody handed to the one account that might want to — the
   * disclosure the migration that added the cap argues against and then granted.
   */
  it('says the day is spent rather than showing a button that does nothing', () => {
    expect(budgetLine('spent')).toContain('spent');
  });

  it('warns before it is gone, so "spent" does not arrive as a fault', () => {
    expect(budgetLine('low')).toContain('nearly');
  });

  it('never quotes a figure a reader could aim at', () => {
    for (const state of ['open', 'low', 'spent'] as const) {
      expect(budgetLine(state)).not.toMatch(/\d/);
    }
  });
});
