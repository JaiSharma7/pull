import { describe, expect, it } from 'vitest';
import {
  budgetLine,
  buildImportSource,
  checkSubmission,
  describeJob,
  isRunning,
  MAX_TEXT_CHARS,
  MIN_TEXT_CHARS,
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
    expect(describeJob(job())).toBe('Waiting its turn.');
  });

  it('names the phase rather than the DAG node', () => {
    expect(describeJob(job({ status: 'running', currentStep: 'acquire' }))).toBe(
      'Reading the text.',
    );
    expect(describeJob(job({ status: 'running', currentStep: 'synthesize' }))).toBe(
      'Writing the summary.',
    );
    expect(describeJob(job({ status: 'running', currentStep: 'publish' }))).toBe('Finishing up.');
  });

  it('quotes the reason a failure gives, and copes when it gives none', () => {
    expect(describeJob(job({ status: 'failed', error: 'the source is held' }))).toContain(
      'the source is held',
    );
    expect(describeJob(job({ status: 'failed' }))).toBe('That did not finish.');
  });

  it('says done when it is done', () => {
    expect(describeJob(job({ status: 'succeeded' }))).toBe('Done.');
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
