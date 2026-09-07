import { describe, expect, it } from 'vitest';
import { draftQuestion, kindFor, MAX_ANSWER, MAX_PROMPT, WRITABLE_KINDS } from './questions.js';

/**
 * The form's half of `remember_pull`.
 *
 * Everything here is about the two ways a reader loses what they typed: a bound the
 * client measures differently from the database, and a kind the client can name but the
 * RPC cannot write.
 */

describe('kindFor', () => {
  it('is short_answer when the reader supplied something to check against', () => {
    expect(kindFor('the obstacle is the way')).toBe('short_answer');
  });

  it('is recall when they did not', () => {
    expect(kindFor('')).toBe('recall');
    // Whitespace is not an answer. A `short_answer` whose answer is three spaces is a
    // card that reveals nothing, and the reader graded themselves against a blank.
    expect(kindFor('   ')).toBe('recall');
    expect(kindFor('\t\n')).toBe('recall');
  });
});

describe('WRITABLE_KINDS', () => {
  it('offers only the kinds remember_pull can actually write', () => {
    expect([...WRITABLE_KINDS]).toEqual(['recall', 'short_answer']);
  });

  it('offers neither mcq nor cloze', () => {
    // Not a style rule. `remember_pull` has no parameter for `options` or for `cloze`,
    // so an `mcq` written through it is a multiple choice whose only button is the
    // right one — `mcqOptions` builds the choices from the answer plus the options, and
    // with none it renders a single correct button that grades as a pass. Adding either
    // kind here without a screen that can supply the column puts that card in front of
    // a reader, and this is the assertion that makes someone go and look.
    expect(WRITABLE_KINDS).not.toContain('mcq');
    expect(WRITABLE_KINDS).not.toContain('cloze');
  });
});

describe('draftQuestion', () => {
  it('trims both fields', () => {
    const result = draftQuestion({ prompt: '  What follows?  ', answer: '  it does  ' });
    expect(result).toEqual({
      ok: true,
      prompt: 'What follows?',
      answer: 'it does',
      kind: 'short_answer',
    });
  });

  it('sends null rather than an empty string for an answer', () => {
    // `remember_pull` does `nullif(btrim(...), '')`, so this only makes the two agree
    // about what was sent. A `''` answer would round-trip as null anyway; the point is
    // that the client and the server describe the same row.
    const result = draftQuestion({ prompt: 'What follows?', answer: '   ' });
    expect(result).toEqual({ ok: true, prompt: 'What follows?', answer: null, kind: 'recall' });
  });

  it('refuses a prompt that is empty or only whitespace', () => {
    for (const prompt of ['', '   ', '\t', '\n\n']) {
      const result = draftQuestion({ prompt, answer: 'an answer' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('A question needs something to ask.');
    }
  });

  /**
   * THE BOUND IS MEASURED ON THE TRIMMED STRING, WHICH IS WHAT THE SERVER MEASURES.
   *
   * `user_questions_prompt_length` is `length(prompt) between 1 and 2000` and
   * `remember_pull` writes `btrim(p_prompt)`. A client that measured the raw string
   * would refuse a prompt the database would have accepted — the reader is told their
   * question is too long because of spaces they cannot see.
   */
  it('accepts a prompt that is at the bound once trimmed, however much space follows it', () => {
    const result = draftQuestion({ prompt: 'x'.repeat(MAX_PROMPT) + '          ', answer: '' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.prompt).toHaveLength(MAX_PROMPT);
  });

  it('refuses a prompt one character over the bound', () => {
    const result = draftQuestion({ prompt: 'x'.repeat(MAX_PROMPT + 1), answer: '' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(String(MAX_PROMPT));
  });

  it('applies the same rule to the answer', () => {
    const atBound = draftQuestion({ prompt: 'q', answer: 'y'.repeat(MAX_ANSWER) + '   ' });
    expect(atBound.ok).toBe(true);
    if (atBound.ok) expect(atBound.answer).toHaveLength(MAX_ANSWER);

    const over = draftQuestion({ prompt: 'q', answer: 'y'.repeat(MAX_ANSWER + 1) });
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.error).toContain(String(MAX_ANSWER));
  });

  it('reports the prompt before the answer when both are wrong', () => {
    // One message at a time, and the first field is the one the reader is looking at.
    const result = draftQuestion({
      prompt: 'x'.repeat(MAX_PROMPT + 1),
      answer: 'y'.repeat(MAX_ANSWER + 1),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('question');
  });

  /**
   * CHARACTERS, NOT UTF-16 CODE UNITS — the same count-versus-unit split as the jsonb
   * clamp, one layer up and pointing the other way.
   *
   * `length(prompt)` in Postgres counts codepoints; `String.prototype.length` counts
   * UTF-16 code units, and every character outside the basic plane is two of those and
   * one of the former. So a form measuring `.length` refuses at half the bound for a
   * reader writing emoji, and tells them the limit is 2000 characters while holding
   * them to 1000.
   *
   * The astral half is what makes this a test rather than a restatement: the BMP case
   * passes either way.
   */
  it('counts an astral character once, as the database does', () => {
    const emoji = '\u{1F600}';
    expect(emoji.length).toBe(2);
    expect([...emoji]).toHaveLength(1);

    const atBound = draftQuestion({ prompt: emoji.repeat(MAX_PROMPT), answer: '' });
    expect(atBound.ok).toBe(true);

    const over = draftQuestion({ prompt: emoji.repeat(MAX_PROMPT + 1), answer: '' });
    expect(over.ok).toBe(false);
  });

  it('counts an astral answer the same way', () => {
    const emoji = '\u{1F600}';
    expect(draftQuestion({ prompt: 'q', answer: emoji.repeat(MAX_ANSWER) }).ok).toBe(true);
    expect(draftQuestion({ prompt: 'q', answer: emoji.repeat(MAX_ANSWER + 1) }).ok).toBe(false);
  });

  it('names the kind from the answer it is about to send, not from the raw field', () => {
    // The pair that would disagree if `kind` were read off the untrimmed input: a
    // whitespace answer becomes null, so the row must be a `recall`. A `short_answer`
    // with a null answer is a card that reveals nothing.
    const result = draftQuestion({ prompt: 'What follows?', answer: '\t \n' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.answer).toBeNull();
      expect(result.kind).toBe('recall');
    }
  });
});
