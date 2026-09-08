import { describe, expect, it } from 'vitest';
import {
  askReducer,
  type AskState,
  draftFor,
  draftQuestion,
  EMPTY_ASK,
  kindFor,
  MAX_ANSWER,
  MAX_PROMPT,
  WRITABLE_KINDS,
} from './questions.js';

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

  it('never pairs short_answer with the null it is about to send', () => {
    /*
     * THE INVARIANT, not the implementation detail this used to assert.
     *
     * It was titled "names the kind from the answer it is about to send, not from the
     * raw field" and could not fail: `kindFor` trims internally, so reading it off the
     * raw field and off the trimmed one are the same function of the same input for
     * every string. Review's mutation sweep swapped one for the other and the suite
     * stayed green — the test pinned nothing.
     *
     * What actually matters is that `answer` and `kind` agree once the row is built: a
     * `short_answer` whose answer is null is a card that reveals nothing.
     */
    for (const answer of ['\t \n', '', '   ', '\u00a0']) {
      const result = draftQuestion({ prompt: 'What follows?', answer });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.answer).toBeNull();
        expect(result.kind).toBe('recall');
      }
    }
    const withAnswer = draftQuestion({ prompt: 'What follows?', answer: '  the way  ' });
    expect(withAnswer.ok).toBe(true);
    if (withAnswer.ok) {
      expect(withAnswer.answer).toBe('the way');
      expect(withAnswer.kind).toBe('short_answer');
    }
  });

  it('pins the two bounds to the numbers the table enforces', () => {
    // The module exists to mirror the table, and every other test here is written in
    // terms of the constants — so the mirror could drift in either direction with the
    // suite green. Review's sweep changed `MAX_ANSWER` to 20000 and nothing failed;
    // that direction is the one that bites, because the form then accepts what
    // `user_questions_answer_length` refuses and the reader is shown the raw constraint.
    expect([MAX_PROMPT, MAX_ANSWER]).toEqual([2000, 2000]);
  });
});

/**
 * The three sequences review demonstrated against the old shared state.
 *
 * Each of them lost or misplaced something a reader had typed, and none of them was a
 * logic error in a tested function — they were races and shared-state mix-ups in a
 * component nothing can drive. That is why the machine is here now.
 */
describe('askReducer', () => {
  const open = (s: AskState, pullId: string) => askReducer(s, { type: 'toggle', pullId });
  const type = (s: AskState, pullId: string, prompt: string) =>
    askReducer(s, { type: 'edit', pullId, field: 'prompt', value: prompt });

  it('keeps one idea’s draft when the reader opens another', () => {
    // The P1. `askPrompt` was one value for the page, so this sequence emptied the box
    // under idea A with no confirmation and no undo.
    let s = type(open(EMPTY_ASK, 'a'), 'a', 'What does A ask?');
    s = open(s, 'b');
    expect(s.openFor).toBe('b');
    expect(draftFor(s, 'a').prompt).toBe('What does A ask?');
    expect(draftFor(s, 'b').prompt).toBe('');
  });

  it('does not close the form the reader is typing in when another idea’s save lands', () => {
    // A is in flight, the reader opens B and starts typing, A succeeds. The old code
    // ran `setAsking(null)` and cleared the boxes unconditionally, so B closed under
    // the reader and B's words went with it.
    let s = type(open(EMPTY_ASK, 'a'), 'a', 'A’s question');
    s = askReducer(s, { type: 'sending', pullId: 'a' });
    s = type(open(s, 'b'), 'b', 'B’s half-written question');
    s = askReducer(s, { type: 'kept', pullId: 'a' });

    expect(s.openFor).toBe('b');
    expect(draftFor(s, 'b').prompt).toBe('B’s half-written question');
    // A's own draft is gone, because A's row exists now.
    expect(draftFor(s, 'a').prompt).toBe('');
    expect(s.keptFor).toBe('a');
    expect(s.busyFor).toBeNull();
  });

  it('files a refusal against the idea it is about, not the one on screen', () => {
    // The old `askError` was shared and rendered inside the open form, so a failure on
    // A appeared under B — telling the reader B's question was lost when B's was never
    // sent — or, if the form had been closed, appeared nowhere at all.
    let s = type(open(EMPTY_ASK, 'a'), 'a', 'A’s question');
    s = askReducer(s, { type: 'sending', pullId: 'a' });
    s = open(s, 'b');
    s = askReducer(s, { type: 'failed', pullId: 'a', message: 'That did not reach your account.' });

    expect(s.errors.b).toBeUndefined();
    expect(s.errors.a).toBe('That did not reach your account.');
    // And the words are still there to try again with.
    expect(draftFor(s, 'a').prompt).toBe('A’s question');
    expect(s.busyFor).toBeNull();
  });

  it('gives a draft back when the reader returns to that idea', () => {
    /*
     * The round trip, which is where the keying actually earns its place — and which the
     * first version of these tests could not see. Mutating the toggle to drop the
     * toggled idea's draft unconditionally passed every other case here, because none of
     * them re-opened an idea that already had words in it. That mutant is the P1 wearing
     * different clothes: type into B, look at A, come back to B, and the sentence is gone.
     */
    let s = type(open(EMPTY_ASK, 'b'), 'b', 'B’s question');
    s = open(s, 'a');
    s = open(s, 'b');
    expect(s.openFor).toBe('b');
    expect(draftFor(s, 'b').prompt).toBe('B’s question');
  });

  it('leaves another idea’s request in flight when one save lands', () => {
    // `busyFor` is one value, so clearing it unconditionally on a save would unlock a
    // button whose own request is still out — the shared-flag bug one field over.
    let s = askReducer(open(EMPTY_ASK, 'a'), { type: 'sending', pullId: 'a' });
    s = askReducer(s, { type: 'kept', pullId: 'b' });
    expect(s.busyFor).toBe('a');
  });

  it('drops the draft when the reader dismisses that form, and only then', () => {
    let s = type(open(EMPTY_ASK, 'a'), 'a', 'A’s question');
    s = type(open(s, 'b'), 'b', 'B’s question');
    // Closing B is a dismissal of B.
    s = open(s, 'b');
    expect(s.openFor).toBeNull();
    expect(draftFor(s, 'b').prompt).toBe('');
    expect(draftFor(s, 'a').prompt).toBe('A’s question');
  });

  it('clears the refusal as soon as the reader edits the box it was about', () => {
    let s = askReducer(type(open(EMPTY_ASK, 'a'), 'a', 'x'.repeat(MAX_PROMPT + 1)), {
      type: 'failed',
      pullId: 'a',
      message: 'A question can be 2000 characters at most.',
    });
    expect(s.errors.a).toBeDefined();
    s = type(s, 'a', 'Something shorter.');
    expect(s.errors.a).toBeUndefined();
  });

  it('never labels one idea’s button with another idea’s request', () => {
    // `askBusy` was shared, so B's freshly opened form rendered "Keeping…" and refused
    // to save while A's request was in flight.
    let s = askReducer(open(EMPTY_ASK, 'a'), { type: 'sending', pullId: 'a' });
    s = open(s, 'b');
    expect(s.busyFor).toBe('a');
    expect(s.busyFor === 'b').toBe(false);
  });
});
