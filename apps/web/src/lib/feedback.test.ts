import { describe, expect, it } from 'vitest';
import { FEEDBACK_SUBJECTS } from '@wap/schemas';
import {
  MAX_MESSAGE,
  MAX_PATH,
  SUBJECT_OPTIONS,
  draftFeedback,
  isSubject,
  shapePath,
} from './feedback.js';

describe('the subjects the form offers', () => {
  it('offers every subject the database accepts, and no others', () => {
    // If a migration adds a member, `enum-parity.ts` already fails typecheck. This is
    // the other half: the form has to actually render the new one rather than quietly
    // omitting an option the column will accept.
    expect(SUBJECT_OPTIONS.map((o) => o.value)).toEqual([...FEEDBACK_SUBJECTS]);
  });

  it('gives each one a label and a hint that are not the same sentence', () => {
    for (const option of SUBJECT_OPTIONS) {
      expect(option.label.length).toBeGreaterThan(0);
      expect(option.hint.length).toBeGreaterThan(0);
      expect(option.hint).not.toBe(option.label);
    }
  });

  it('recognises exactly the known subjects', () => {
    expect(isSubject('bug')).toBe(true);
    expect(isSubject('other')).toBe(true);
    expect(isSubject('Bug')).toBe(false);
    expect(isSubject('')).toBe(false);
    expect(isSubject('not_a_subject')).toBe(false);
  });
});

describe('draftFeedback', () => {
  it('accepts a real message, trimmed', () => {
    const out = draftFeedback({ subject: 'bug', message: '  The button does nothing.  ' });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.message).toBe('The button does nothing.');
      expect(out.subject).toBe('bug');
      expect(out.path).toBeNull();
    }
  });

  it('refuses an empty message, and whitespace is empty', () => {
    expect(draftFeedback({ subject: 'bug', message: '' }).ok).toBe(false);
    expect(draftFeedback({ subject: 'bug', message: '   \n  ' }).ok).toBe(false);
  });

  it('refuses a subject the enum has never heard of', () => {
    // The control only offers valid values; it is read back out of the DOM as a string,
    // and the database would answer 22P02, which is not a sentence anyone can act on.
    const out = draftFeedback({ subject: 'urgent', message: 'Hello.' });
    expect(out).toEqual({ ok: false, error: 'Choose what this is about.' });
  });

  it('refuses a message past the column bound', () => {
    expect(draftFeedback({ subject: 'bug', message: 'x'.repeat(MAX_MESSAGE) }).ok).toBe(true);
    expect(draftFeedback({ subject: 'bug', message: 'x'.repeat(MAX_MESSAGE + 1) }).ok).toBe(false);
  });

  it('counts an emoji as one character, not two', () => {
    // `length` on a surrogate pair is 2, so a message of exactly MAX_MESSAGE emoji
    // would be refused by a naive count while the database accepted it.
    const emoji = '😀'.repeat(MAX_MESSAGE);
    expect(emoji.length).toBe(MAX_MESSAGE * 2);
    expect(draftFeedback({ subject: 'bug', message: emoji }).ok).toBe(true);
  });

  it('carries the path through when there is one', () => {
    const out = draftFeedback({ subject: 'idea', message: 'Hello.', path: '/explore' });
    expect(out.ok && out.path).toBe('/explore');
  });
});

describe('shapePath', () => {
  it('keeps a plain path', () => {
    expect(shapePath('/explore')).toBe('/explore');
    expect(shapePath('/source/abc-123')).toBe('/source/abc-123');
  });

  it('drops the query string, so a search term is not collected with the report', () => {
    expect(shapePath('/search?q=how+to+leave+my+job')).toBe('/search');
  });

  it('drops the fragment, so an anchored pull id is not either', () => {
    expect(shapePath('/source/abc#p-secret-idea')).toBe('/source/abc');
  });

  it('drops both at once, whichever order they appear in', () => {
    expect(shapePath('/search?q=x#p-1')).toBe('/search');
  });

  it('returns null for anything that is not a path', () => {
    expect(shapePath(null)).toBeNull();
    expect(shapePath(undefined)).toBeNull();
    expect(shapePath('')).toBeNull();
    // A full URL is refused rather than parsed: it carries an origin, and the column
    // is documented as holding a path.
    expect(shapePath('https://whatapull.vercel.app/explore')).toBeNull();
    expect(shapePath('explore')).toBeNull();
  });

  it('truncates to the column bound rather than refusing', () => {
    const long = '/' + 'a'.repeat(400);
    const out = shapePath(long);
    expect(out).not.toBeNull();
    expect(out).toHaveLength(MAX_PATH);
  });
});
