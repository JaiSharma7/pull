import { describe, expect, it } from 'vitest';
import { qualityFromDraft, questionsToWrite, trustFromProvenance } from './pipeline.ts';

/**
 * The two numbers that were never written.
 *
 * `works.quality_score` and `works.trust_score` are 0.24 of `get_feed`'s score
 * combined, and no pipeline step ever set either — so every generated work sat
 * at the 0.5 default while the six hand-seeded ones carried real values. A
 * quarter of the ranking was a constant.
 *
 * Both are deterministic on purpose. This runs at generation time, where law 2
 * would permit a model — but a provenance judgement that varies between two runs
 * over the same URL is not a judgement, it is noise with a decimal point. That
 * property is what these tests are really pinning down.
 */

describe('trustFromProvenance', () => {
  it('trusts a known public-domain archive most', () => {
    expect(trustFromProvenance('public_domain', 'https://www.gutenberg.org/files/1/1.txt')).toBe(
      0.9,
    );
    expect(trustFromProvenance('public_domain', 'https://en.wikisource.org/wiki/X')).toBe(0.9);
    expect(trustFromProvenance('public_domain', 'http://classics.mit.edu/Plato/x.html')).toBe(0.9);
  });

  it('trusts the same rights claim less from an arbitrary host', () => {
    expect(trustFromProvenance('public_domain', 'https://some-blog.example/x')).toBe(0.7);
  });

  it('matches a subdomain but not a lookalike', () => {
    expect(trustFromProvenance('public_domain', 'https://mirror.gutenberg.org/a')).toBe(0.9);
    // The check must not be a substring test: this host is not Gutenberg.
    expect(trustFromProvenance('public_domain', 'https://gutenberg.org.evil.test/a')).toBe(0.7);
  });

  it('does not extend archive.org trust to the Wayback Machine', () => {
    /*
     * `web.archive.org` serves an archived copy of *any* site under an
     * archive.org hostname, so the suffix rule handed the maximum score to a URL
     * whose host says nothing about the text behind it. archive.org's own
     * collections still earn it.
     */
    expect(trustFromProvenance('public_domain', 'https://archive.org/details/x')).toBe(0.9);
    expect(trustFromProvenance('public_domain', 'https://ia801504.us.archive.org/x.txt')).toBe(0.9);
    expect(
      trustFromProvenance('public_domain', 'https://web.archive.org/web/2020/https://any.example/'),
    ).toBe(0.7);
  });

  it('puts anything awaiting a rights decision at the bottom', () => {
    expect(trustFromProvenance('review_required', 'https://www.gutenberg.org/x')).toBe(0.3);
  });

  it('survives a missing or unparseable url instead of throwing', () => {
    expect(trustFromProvenance('public_domain', null)).toBe(0.7);
    expect(trustFromProvenance('public_domain', 'not a url')).toBe(0.7);
  });

  it('is a pure function of its inputs', () => {
    const a = trustFromProvenance('public_domain', 'https://www.gutenberg.org/x');
    const b = trustFromProvenance('public_domain', 'https://www.gutenberg.org/x');
    expect(a).toBe(b);
  });
});

describe('qualityFromDraft', () => {
  const pull = (body = 'x'.repeat(400), whyItMatters = 'because') => ({ body, whyItMatters });

  it('scores a full, well-formed draft high', () => {
    const score = qualityFromDraft({
      pulls: Array.from({ length: 10 }, () => pull()),
      topics: ['philosophy'],
    });
    expect(score).toBeGreaterThan(0.9);
  });

  it('ranks a thin draft below the 0.5 default it replaces', () => {
    // The whole point: writing these scores has to be able to rank a weak
    // generated work BELOW the seeded corpus, or it changes nothing.
    const score = qualityFromDraft({ pulls: [pull('short')], topics: [] });
    expect(score).toBeLessThan(0.5);
  });

  it('penalises a draft nothing classified, because preferences cannot reach it', () => {
    const withTopics = qualityFromDraft({
      pulls: Array.from({ length: 10 }, () => pull()),
      topics: ['philosophy'],
    });
    const without = qualityFromDraft({
      pulls: Array.from({ length: 10 }, () => pull()),
      topics: [],
    });
    expect(without).toBeLessThan(withTopics);
  });

  it('penalises padding, not only thinness', () => {
    // The comment always said "more is usually the model padding"; the term
    // saturated at eight and could not say it. Forty ideas must rank below
    // ten, and ten must not be punished for being more than eight.
    const ten = qualityFromDraft({
      pulls: Array.from({ length: 10 }, () => pull()),
      topics: ['a'],
    });
    const fourteen = qualityFromDraft({
      pulls: Array.from({ length: 14 }, () => pull()),
      topics: ['a'],
    });
    const forty = qualityFromDraft({
      pulls: Array.from({ length: 40 }, () => pull()),
      topics: ['a'],
    });
    expect(fourteen).toBe(ten);
    expect(forty).toBeLessThan(ten);
    // Not so steep that a slightly long draft ranks with a thin one.
    const twenty = qualityFromDraft({
      pulls: Array.from({ length: 20 }, () => pull()),
      topics: ['a'],
    });
    const three = qualityFromDraft({
      pulls: Array.from({ length: 3 }, () => pull()),
      topics: ['a'],
    });
    expect(twenty).toBeGreaterThan(three);
  });

  it('penalises bodies outside a readable band in either direction', () => {
    const good = qualityFromDraft({ pulls: [pull('x'.repeat(400))], topics: ['a'] });
    const tooShort = qualityFromDraft({ pulls: [pull('x'.repeat(50))], topics: ['a'] });
    const tooLong = qualityFromDraft({ pulls: [pull('x'.repeat(5000))], topics: ['a'] });
    expect(tooShort).toBeLessThan(good);
    expect(tooLong).toBeLessThan(good);
  });

  it('penalises ideas that never say why they matter', () => {
    const explained = qualityFromDraft({
      pulls: [pull('x'.repeat(400), 'because')],
      topics: ['a'],
    });
    const bare = qualityFromDraft({ pulls: [pull('x'.repeat(400), '')], topics: ['a'] });
    expect(bare).toBeLessThan(explained);
  });

  it('never leaves the range the column accepts', () => {
    // `quality_score` is a `real not null`; a value outside [0,1] would rank
    // wrongly rather than fail, which is the harder kind of bug to see.
    const cases = [
      { pulls: [], topics: [] },
      { pulls: Array.from({ length: 400 }, () => pull()), topics: ['a', 'b', 'c', 'd'] },
      { pulls: [pull('')], topics: undefined },
    ];
    for (const c of cases) {
      const score = qualityFromDraft(c);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }
  });

  it('tolerates `topics` arriving as something other than an array', () => {
    // It is read off a stored step output, so it has been through JSON and back.
    expect(() =>
      qualityFromDraft({ pulls: [pull()], topics: 'philosophy' as unknown as string[] }),
    ).not.toThrow();
  });
});

/**
 * The recall questions, and what is allowed to reach Postgres.
 *
 * `quiz_questions` has been read by `get_due_reviews` since round 1 and written
 * by nothing: six seeded rows against 156 pulls, while `recall` is 45% of the
 * interrupt distribution. So Interleaved Recall — the mechanic this product is
 * built on — had nothing to ask about 96% of the library.
 */
describe('questionsToWrite', () => {
  const written = [
    { ordinal: 0, id: 'p0' },
    { ordinal: 1, id: 'p1' },
  ];

  const q = (over: Record<string, unknown> = {}) => ({
    question: { prompt: 'Why?', answer: 'Because.', distractors: ['a', 'b', 'c'], ...over },
  });

  it('pairs a question to the Pull that was actually written', () => {
    expect(questionsToWrite([q(), q()], written)).toEqual([
      { pullId: 'p0', prompt: 'Why?', answer: 'Because.', distractors: ['a', 'b', 'c'] },
      { pullId: 'p1', prompt: 'Why?', answer: 'Because.', distractors: ['a', 'b', 'c'] },
    ]);
  });

  it('pairs by ordinal, not by array position', () => {
    // `insertPulls` returns ordinals for exactly this reason. A question attached
    // to the wrong idea is invisible and permanent.
    const shuffled = [
      { ordinal: 1, id: 'second' },
      { ordinal: 0, id: 'first' },
    ];
    expect(questionsToWrite([q({ prompt: 'A' }), q({ prompt: 'B' })], shuffled)).toEqual([
      { pullId: 'first', prompt: 'A', answer: 'Because.', distractors: ['a', 'b', 'c'] },
      { pullId: 'second', prompt: 'B', answer: 'Because.', distractors: ['a', 'b', 'c'] },
    ]);
  });

  it('skips a Pull with no question rather than writing an empty one', () => {
    expect(questionsToWrite([{}, q()], written)).toEqual([
      { pullId: 'p1', prompt: 'Why?', answer: 'Because.', distractors: ['a', 'b', 'c'] },
    ]);
  });

  it('drops a question missing either half', () => {
    // The half-formed row is the dangerous one: `get_due_reviews` copes with a
    // Pull that has no question and cannot cope with one whose answer is "".
    expect(questionsToWrite([q({ prompt: '   ' })], written)).toEqual([]);
    expect(questionsToWrite([q({ answer: undefined })], written)).toEqual([]);
    expect(questionsToWrite([q({ prompt: 42 })], written)).toEqual([]);
  });

  it('trims, so whitespace never becomes a prompt', () => {
    expect(questionsToWrite([q({ prompt: '  Why?  ' })], written)[0]?.prompt).toBe('Why?');
  });

  it('keeps only string distractors, and tolerates a missing list', () => {
    expect(questionsToWrite([q({ distractors: ['a', 7, '', null, 'b'] })], written)[0]).toEqual({
      pullId: 'p0',
      prompt: 'Why?',
      answer: 'Because.',
      distractors: ['a', 'b'],
    });
    expect(questionsToWrite([q({ distractors: undefined })], written)[0]?.distractors).toEqual([]);
  });

  it('drops a question whose Pull was never written', () => {
    expect(questionsToWrite([q(), q(), q()], [{ ordinal: 0, id: 'p0' }])).toHaveLength(1);
  });

  /*
   * THE BOUNDS THE TABLE CARRIES, MET HERE RATHER THAN HIT.
   *
   * `20260905120001` adds `quiz_questions_prompt_length`, `_answer_length` and
   * `_distractors_shape`, and this function is the only writer. Before the clamp, a model
   * returning a 2,100-character prompt raised 23514 in the `cards` step -- after
   * `insertPulls` had committed and after the synthesis had been paid for -- and, because
   * `synthesize` replays from `job_step_outputs`, failed identically on every retry.
   * Nothing upstream clamps it: `BOUNDS` in `packages/prompts/scripts/export.mjs` bounds
   * the distractor count and no length at all.
   */
  it('drops a question whose prompt or answer is over the column bound', () => {
    expect(questionsToWrite([q({ prompt: 'x'.repeat(2001) })], written)).toEqual([]);
    expect(questionsToWrite([q({ answer: 'y'.repeat(2001) })], written)).toEqual([]);
    // Exactly at the bound is a question, not a casualty.
    expect(questionsToWrite([q({ prompt: 'x'.repeat(2000) })], written)).toHaveLength(1);
    expect(questionsToWrite([q({ answer: 'y'.repeat(2000) })], written)).toHaveLength(1);
    // The pull keeps its place either way -- dropping the question is not dropping the
    // idea, and a pull with no question is an outcome the schema already allows.
    expect(questionsToWrite([q({ prompt: 'x'.repeat(2001) }), q()], written)).toEqual([
      { pullId: 'p1', prompt: 'Why?', answer: 'Because.', distractors: ['a', 'b', 'c'] },
    ]);
  });

  it('clamps distractors by count AND by size', () => {
    // Both halves, because this stack has twice shipped the count half of a bound with
    // the size half missing -- `quiz_questions_distractors_shape` checks
    // `jsonb_array_length(...) <= 8` and `length(distractors::text) <= 20000`.
    const nine = Array.from({ length: 9 }, (_, i) => `d${i}`);
    expect(questionsToWrite([q({ distractors: nine })], written)[0]?.distractors).toHaveLength(8);

    const huge = Array.from({ length: 8 }, () => 'z'.repeat(5000));
    const kept = questionsToWrite([q({ distractors: huge })], written)[0]?.distractors ?? [];
    expect(JSON.stringify(kept).length).toBeLessThanOrEqual(20000);
    // Some survive: the size clamp drops from the end rather than emptying the list.
    expect(kept.length).toBeGreaterThan(0);
  });
});
