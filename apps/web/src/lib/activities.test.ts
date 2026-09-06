import { describe, expect, it } from 'vitest';
import {
  answerSimilarity,
  FAST_ANSWER_MS,
  gradeCloze,
  gradeMcq,
  gradeOrdering,
  mcqOptions,
  normaliseAnswer,
  semanticMarks,
  orderingSteps,
  type Question,
  seededShuffle,
  selfReportedHard,
  whyWrong,
} from './activities.js';

/**
 * A question that can be wrong, and the graders that say so without a model.
 * Every assertion here is about a decision the memory model will act on, so the
 * cases are the ones where a wrong grade does lasting damage: an `easy` handed
 * out for a slow answer, a `forgot` softened into `hard`, a typo marked as a
 * different idea.
 */

const mcq = (over: Partial<Question> = {}): Question => ({
  id: 'q1',
  kind: 'mcq',
  prompt: 'What does an obstacle become, on the Stoic account?',
  answer: 'The material of the work',
  distractors: ['A reason to stop', 'A sign of bad luck', 'Someone else’s fault'],
  cloze: null,
  explanation: 'The impediment to action advances action; what stands in the way becomes the way.',
  rationale: [
    { distractor: 'A reason to stop', why: 'Stopping is the one response the passage rules out.' },
    { distractor: 'A sign of bad luck', why: 'Luck is not a category the Stoics grant.' },
  ],
  ...over,
});

describe('seededShuffle', () => {
  const items = ['a', 'b', 'c', 'd', 'e', 'f'];

  it('gives the same order for the same seed, every time', () => {
    // A re-render must not move the option the reader is about to click.
    expect(seededShuffle(items, 'q1')).toEqual(seededShuffle(items, 'q1'));
    expect(seededShuffle(items, 42)).toEqual(seededShuffle(items, 42));
  });

  it('keeps every item exactly once', () => {
    expect([...seededShuffle(items, 'anything')].sort()).toEqual(items);
  });

  it('does not touch the input', () => {
    const copy = [...items];
    seededShuffle(items, 'x');
    expect(items).toEqual(copy);
  });

  it('actually shuffles: two seeds disagree', () => {
    const a = seededShuffle(items, 'first');
    const b = seededShuffle(items, 'second');
    expect(a).not.toEqual(b);
    expect(a).not.toEqual(items);
  });

  it('treats a number and its string as the same seed', () => {
    expect(seededShuffle(items, 7)).toEqual(seededShuffle(items, '7'));
  });

  it('copes with nothing and with one thing', () => {
    expect(seededShuffle([], 's')).toEqual([]);
    expect(seededShuffle(['only'], 's')).toEqual(['only']);
  });
});

describe('mcqOptions', () => {
  it('always includes the answer', () => {
    const options = mcqOptions(mcq(), 'seed');
    expect(options).toContain('The material of the work');
    expect(options).toHaveLength(4);
  });

  it('is stable for one question id across calls and sessions', () => {
    const q = mcq();
    expect(mcqOptions(q, q.id)).toEqual(mcqOptions(q, q.id));
  });

  it('never shows two right answers', () => {
    const q = mcq({ distractors: ['The material of the work', 'A reason to stop'] });
    const options = mcqOptions(q, 's');
    expect(options.filter((o) => o === 'The material of the work')).toHaveLength(1);
    expect(options).toHaveLength(2);
  });

  it('drops duplicate and blank distractors', () => {
    const q = mcq({ distractors: ['A reason to stop', ' A reason to stop ', '', '  '] });
    expect(mcqOptions(q, 's').sort()).toEqual(['A reason to stop', 'The material of the work']);
  });
});

describe('gradeMcq', () => {
  const q = mcq();
  const right = q.answer;
  const wrong = 'A reason to stop';

  it('right, sure and fast is easy', () => {
    expect(gradeMcq(right, q, 'sure', 2_000)).toEqual({
      grade: 'easy',
      correct: true,
      confidentlyWrong: false,
    });
  });

  it('right but slow is good, however sure', () => {
    expect(gradeMcq(right, q, 'sure', FAST_ANSWER_MS.mcq + 1).grade).toBe('good');
  });

  it('right at exactly the threshold is still fast', () => {
    expect(gradeMcq(right, q, 'sure', FAST_ANSWER_MS.mcq).grade).toBe('easy');
  });

  it('right but unsure is good, however fast', () => {
    // A hesitant hit is a hit, but it is not the effortless recall `easy` claims.
    expect(gradeMcq(right, q, 'unsure', 500).grade).toBe('good');
  });

  it('an unmeasured latency never promotes to easy', () => {
    expect(gradeMcq(right, q, 'sure', null).grade).toBe('good');
    expect(gradeMcq(right, q, 'sure', undefined).grade).toBe('good');
    expect(gradeMcq(right, q, 'sure', Number.NaN).grade).toBe('good');
    expect(gradeMcq(right, q, 'sure', -1).grade).toBe('good');
    expect(gradeMcq(right, q, 'sure', Number.POSITIVE_INFINITY).grade).toBe('good');
  });

  it('wrong and sure is forgot, and flagged as confidently wrong', () => {
    expect(gradeMcq(wrong, q, 'sure', 1_000)).toEqual({
      grade: 'forgot',
      correct: false,
      confidentlyWrong: true,
    });
  });

  it('wrong and unsure is forgot, and not flagged', () => {
    expect(gradeMcq(wrong, q, 'unsure', 1_000)).toEqual({
      grade: 'forgot',
      correct: false,
      confidentlyWrong: false,
    });
  });

  it('compares the option verbatim, trimmed, not normalised', () => {
    expect(gradeMcq('  The material of the work ', q, 'unsure', null).correct).toBe(true);
    // Options were handed out verbatim, so a looser match could only ever make
    // a near-identical distractor count as right.
    expect(gradeMcq('the material of the work', q, 'unsure', null).correct).toBe(false);
  });
});

describe('selfReportedHard', () => {
  it('lets the reader lower a right answer to hard', () => {
    const result = gradeMcq(mcq().answer, mcq(), 'sure', 1_000);
    expect(selfReportedHard(result)).toEqual({ ...result, grade: 'hard' });
  });

  it('cannot soften a wrong answer', () => {
    // A false belief on a normal schedule is the one outcome this must not allow.
    const result = gradeMcq('A reason to stop', mcq(), 'sure', 1_000);
    expect(selfReportedHard(result)).toEqual(result);
    expect(selfReportedHard(result).grade).toBe('forgot');
  });
});

describe('normaliseAnswer', () => {
  it('drops case, punctuation and extra spacing', () => {
    expect(normaliseAnswer('  The   Mitochondria!  ')).toBe('mitochondria');
    expect(normaliseAnswer('Self-reliance.')).toBe('self reliance');
  });

  it('drops diacritics', () => {
    expect(normaliseAnswer('Café')).toBe('cafe');
    expect(normaliseAnswer('naïve')).toBe('naive');
  });

  it('drops one leading article and nothing more', () => {
    expect(normaliseAnswer('a river')).toBe('river');
    expect(normaliseAnswer('an ending')).toBe('ending');
    expect(normaliseAnswer('the the end')).toBe('the end');
    // Not a word that merely starts with one.
    expect(normaliseAnswer('theory')).toBe('theory');
    expect(normaliseAnswer('another')).toBe('another');
  });
});

describe('gradeCloze', () => {
  const answer = 'mitochondria';

  it('accepts the exact answer', () => {
    expect(gradeCloze('mitochondria', answer).correct).toBe(true);
  });

  it('accepts differences in case, punctuation, whitespace and articles', () => {
    expect(gradeCloze('The Mitochondria.', answer).correct).toBe(true);
    expect(gradeCloze('  mitochondria  ', answer).correct).toBe(true);
    expect(gradeCloze('MITOCHONDRIA', answer).correct).toBe(true);
  });

  it('accepts a dropped letter, which is a hand and not a memory', () => {
    expect(gradeCloze('mitochondia', answer).correct).toBe(true);
    expect(gradeCloze('color', 'colour').correct).toBe(true);
    expect(gradeCloze('ocurrence', 'occurrence').correct).toBe(true);
  });

  it('charges a swapped pair as one slip, not two', () => {
    // The commonest typing error.
    const result = gradeCloze('mitochondira', answer);
    expect(result.correct).toBe(true);
  });

  it('refuses a substituted letter, however near the ratio says it is', () => {
    // The four the review reproduced grading `easy` at 0.875-0.900. A hand
    // slipping off a key drops, doubles or swaps a letter; it does not put a
    // different letter in and land on the opposite structure of the nervous
    // system.
    for (const [typed, correctAnswer] of [
      ['efferent', 'afferent'],
      ['absorption', 'adsorption'],
      ['intension', 'intention'],
      ['inductive', 'deductive'],
    ] as const) {
      const result = gradeCloze(typed, correctAnswer, 'sure', 1000);
      expect(result.correct).toBe(false);
      expect(result.grade).toBe('forgot');
    }
  });

  it('holds a number to the letter', () => {
    // 0.875 similar and an order of magnitude apart.
    expect(gradeCloze('10000000', '1000000').correct).toBe(false);
    expect(gradeCloze('1000000', '1000000').correct).toBe(true);
  });

  it('rejects a different word, and says how close it came', () => {
    const result = gradeCloze('chloroplast', answer);
    expect(result.correct).toBe(false);
    expect(result.grade).toBe('forgot');
    expect(result.similarity).toBeLessThan(1);
    expect(result.similarity).toBeGreaterThanOrEqual(0);
  });

  it('rejects a short word with one letter wrong', () => {
    // A substitution: "mass" is not "mast".
    expect(gradeCloze('mast', 'mass').correct).toBe(false);
  });

  it('never reports a wrong answer as identical', () => {
    // `normaliseAnswer` strips both symbols, so this used to score 1 while
    // grading wrong -- a screen saying "close" would show "100%" over "no".
    const result = gradeCloze('Na-', 'Na+');
    expect(result.correct).toBe(false);
    expect(result.similarity).toBeLessThan(1);
  });

  it('refuses a short word that a slip turns into a different word', () => {
    // The kind-of-difference rule alone moved the boundary rather than removing
    // the class: in a short word an inserted, dropped or swapped letter lands on
    // another real word about as often as on a typo. All of these graded `easy`
    // — stability multiplied, out of review for a fortnight, and
    // `confidentlyWrong` false so nothing downstream looked again.
    for (const [typed, correctAnswer] of [
      ['casual', 'causal'],
      ['trail', 'trial'],
      ['ion', 'iron'],
      ['aid', 'acid'],
      ['cost', 'coast'],
      ['sale', 'scale'],
      ['form', 'from'],
      ['untied', 'united'],
      ['hat', 'heat'],
      ['at', 'art'],
      ['rat', 'rate'],
    ] as const) {
      const result = gradeCloze(typed, correctAnswer, 'sure', 1000);
      expect(result.correct, `${typed} for ${correctAnswer}`).toBe(false);
      expect(result.grade).toBe('forgot');
    }

    // And the floor does not cost the cases worth forgiving.
    expect(gradeCloze('color', 'colour').correct).toBe(true);
    expect(gradeCloze('ocurrence', 'occurrence').correct).toBe(true);
    expect(gradeCloze('mitochondira', 'mitochondria').correct).toBe(true);
  });

  it('does not tell a British reader they hold a false belief', () => {
    // `-ise`/`-ize` and `-yse`/`-yze` are substitutions, so the slip rule refused
    // them: `organisation` for `organization` graded `forgot` AND
    // `confidentlyWrong`, which routes a correct speller into the misconception
    // loop. Folding `z` to `s` makes that family exact instead. It is only that
    // family: `sceptic`/`skeptic`, `grey`/`gray` and `catalogue`/`catalog` are
    // different axes and are still refused, which the module says plainly rather
    // than pretending the split is closed.
    for (const [typed, correctAnswer] of [
      ['organisation', 'organization'],
      ['analyse', 'analyze'],
      ['emphasise', 'emphasize'],
      ['ionised', 'ionized'],
      ['organise', 'organize'],
    ] as const) {
      const result = gradeCloze(typed, correctAnswer, 'sure', 1000);
      expect(result.correct, `${typed} for ${correctAnswer}`).toBe(true);
      expect(result.confidentlyWrong).toBe(false);
    }
  });

  it('never grades a slip as easy, however fast it came', () => {
    // `easy` multiplies stability by more than three. An accepted one-character
    // difference is not evidence of easy retrieval — it is evidence the rule
    // could not tell a typo from a different word.
    const slip = gradeCloze('mitochondia', 'mitochondria', 'sure', 100);
    expect(slip.correct).toBe(true);
    expect(slip.grade).toBe('good');

    // Typed exactly, fast and sure, is still easy.
    const exact = gradeCloze('mitochondria', 'mitochondria', 'sure', 100);
    expect(exact.grade).toBe('easy');
  });

  it('does not let two absences agree', () => {
    // The branch protecting an answer that IS a mark reintroduced, in this
    // function, the defect fixed one function above in `gradeMcq`: an empty box
    // against an empty or punctuation-only answer graded `easy`.
    for (const [typed, correctAnswer] of [
      ['', ''],
      ['   ', ''],
      ['!', '.'],
    ] as const) {
      const result = gradeCloze(typed, correctAnswer, 'sure', 500);
      expect(result.correct, `"${typed}" for "${correctAnswer}"`).toBe(false);
      expect(result.grade).toBe('forgot');
    }
  });

  it('accepts an answer that is only a mark', () => {
    // `normaliseAnswer` reduces these to nothing, which used to fail them.
    for (const mark of ['+', '=', '<', '^']) {
      expect(gradeCloze(mark, mark).correct).toBe(true);
    }
  });

  it('reads a hyphen the same way however the reader spaced it', () => {
    expect(gradeCloze('well - known', 'well-known').correct).toBe(
      gradeCloze('well known', 'well-known').correct,
    );
    expect(gradeCloze('cost - benefit', 'cost-benefit').correct).toBe(true);
  });

  it('does not send a typo to the misconception loop, by grading it right', () => {
    // The review asked that a reader who mistypes a word they know is not
    // recorded as confidently wrong. Suppressing the flag on a similarity band
    // would have re-admitted `increase`/`decrease` (0.92 across the string), so
    // the answer is that a slip is simply correct and never gets there.
    const slip = gradeCloze('colour', 'color', 'sure', 1000);
    expect(slip.correct).toBe(true);
    expect(slip.confidentlyWrong).toBe(false);

    // And a reader who wrote the ampersand out is not answering a different
    // question.
    expect(gradeCloze('supply and demand', 'supply & demand').correct).toBe(true);
  });

  it('rejects nothing typed', () => {
    expect(gradeCloze('', answer).correct).toBe(false);
    expect(gradeCloze('   ', answer).similarity).toBe(0);
  });

  it('never marks anything right against an empty answer', () => {
    expect(gradeCloze('anything', '').correct).toBe(false);
  });

  it('is good, never easy, when confidence and latency are not given', () => {
    expect(gradeCloze('mitochondria', answer)).toMatchObject({
      grade: 'good',
      correct: true,
      confidentlyWrong: false,
    });
  });

  it('uses the cloze threshold for easy, which is slower than the MCQ one', () => {
    expect(FAST_ANSWER_MS.cloze).toBeGreaterThan(FAST_ANSWER_MS.mcq);
    expect(gradeCloze('mitochondria', answer, 'sure', FAST_ANSWER_MS.cloze).grade).toBe('easy');
    expect(gradeCloze('mitochondria', answer, 'sure', FAST_ANSWER_MS.cloze + 1).grade).toBe('good');
  });

  it('flags a confident miss', () => {
    expect(gradeCloze('chloroplast', answer, 'sure', 1_000).confidentlyWrong).toBe(true);
    expect(gradeCloze('chloroplast', answer, 'unsure', 1_000).confidentlyWrong).toBe(false);
  });
});

describe('gradeCloze: the two ways a wrong answer used to pass', () => {
  // A proportional threshold spread over a phrase let every edit pile into the
  // one word carrying the meaning: 0.92 across the string, and `easy` for the
  // opposite answer, so the confidently-wrong repair loop never saw it.
  it('refuses a phrase whose meaning-bearing word is different', () => {
    const result = gradeCloze(
      'increase marginal utility',
      'decrease marginal utility',
      'sure',
      1000,
    );
    expect(result.correct).toBe(false);
    expect(result.confidentlyWrong).toBe(true);
  });

  it('still forgives a transposition inside a long word', () => {
    expect(gradeCloze('mitochondira', 'mitochondria').correct).toBe(true);
  });

  it('refuses a missing or extra word', () => {
    expect(gradeCloze('marginal utility', 'decreasing marginal utility').correct).toBe(false);
    expect(gradeCloze('the marginal utility curve', 'marginal utility').correct).toBe(false);
  });

  // Stripping every symbol made `Na+` and `Na-` the same string, and accepted
  // `C` for `C++`. Chemistry and computation answers must not do that.
  it('keeps punctuation that is part of the answer', () => {
    expect(gradeCloze('Na-', 'Na+').correct).toBe(false);
    expect(gradeCloze('C', 'C++').correct).toBe(false);
    expect(gradeCloze('C++', 'C++').correct).toBe(true);
    expect(gradeCloze('na+', 'Na+').correct).toBe(true);
  });

  it('still treats a hyphen between words as spacing', () => {
    expect(semanticMarks('well-known')).toBe('');
    expect(semanticMarks('Na+')).toBe('+');
    expect(semanticMarks('C++')).toBe('++');
    expect(gradeCloze('well known', 'well-known').correct).toBe(true);
  });
});

describe('answerSimilarity', () => {
  it('is 1 for the same answer and 0 for nothing', () => {
    expect(answerSimilarity('Walden', 'walden')).toBe(1);
    expect(answerSimilarity('', 'walden')).toBe(0);
  });

  it('is symmetric', () => {
    expect(answerSimilarity('kitten', 'sitting')).toBeCloseTo(
      answerSimilarity('sitting', 'kitten'),
    );
  });
});

describe('orderingSteps', () => {
  it('reads one step per line and ignores blank lines', () => {
    expect(orderingSteps({ answer: 'Observe\nHypothesise\n\nTest\nRevise\n' })).toEqual([
      'Observe',
      'Hypothesise',
      'Test',
      'Revise',
    ]);
  });

  it('accepts Windows line endings', () => {
    expect(orderingSteps({ answer: 'One\r\nTwo' })).toEqual(['One', 'Two']);
  });
});

describe('gradeOrdering', () => {
  const q = { answer: 'Observe\nHypothesise\nTest\nRevise' };

  it('accepts the right order', () => {
    expect(gradeOrdering(['Observe', 'Hypothesise', 'Test', 'Revise'], q)).toMatchObject({
      correct: true,
      grade: 'good',
      positionsWrong: 0,
      inSequence: 4,
    });
  });

  it('rejects one swapped pair, and counts both positions', () => {
    const result = gradeOrdering(['Observe', 'Test', 'Hypothesise', 'Revise'], q);
    expect(result.correct).toBe(false);
    expect(result.grade).toBe('forgot');
    expect(result.positionsWrong).toBe(2);
    expect(result.inSequence).toBe(3);
  });

  it('says how much of the order survived a rotation', () => {
    // The commonest drag error, and the one `misplaced` misrepresented: every
    // position is wrong, and three of the four steps are still in the right
    // order relative to one another.
    const result = gradeOrdering(['Hypothesise', 'Test', 'Revise', 'Observe'], q);
    expect(result.positionsWrong).toBe(4);
    expect(result.inSequence).toBe(3);
  });

  it('rejects a missing step', () => {
    const result = gradeOrdering(['Observe', 'Hypothesise', 'Revise'], q);
    expect(result.correct).toBe(false);
    expect(result.positionsWrong).toBe(2);
  });

  it('rejects an extra step', () => {
    const result = gradeOrdering(['Observe', 'Hypothesise', 'Test', 'Revise', 'Publish'], q);
    expect(result.correct).toBe(false);
    expect(result.positionsWrong).toBe(1);
  });

  it('is never right against a question with no steps', () => {
    expect(gradeOrdering([], { answer: '' }).correct).toBe(false);
  });

  it('trims what the reader arranged', () => {
    expect(gradeOrdering([' Observe', 'Hypothesise ', 'Test', 'Revise'], q).correct).toBe(true);
  });

  it('is easy only when sure and within the ordering threshold', () => {
    const order = ['Observe', 'Hypothesise', 'Test', 'Revise'];
    expect(gradeOrdering(order, q, 'sure', FAST_ANSWER_MS.ordering).grade).toBe('easy');
    expect(gradeOrdering(order, q, 'sure', FAST_ANSWER_MS.ordering + 1).grade).toBe('good');
    expect(gradeOrdering(order, q, 'unsure', 1_000).grade).toBe('good');
  });
});

describe('whyWrong', () => {
  const q = mcq();

  it('answers with the rationale written for that distractor', () => {
    expect(whyWrong(q, 'A reason to stop')).toEqual({
      why: 'Stopping is the one response the passage rules out.',
      source: 'distractor',
    });
  });

  it('does not guess at a distractor it was not given verbatim', () => {
    // There was a loose pass here, matching on normalised text. It was narrowed
    // twice and removed: given the pick and the rationales but never the option
    // list, this function cannot tell a reader's near-miss from a sibling option
    // that happens to normalise the same way — so `the market` was answered with
    // the reason written for `market`. The options come from `mcqOptions`
    // verbatim, so an exact match after trimming covers every real pick, and a
    // wrong account of your own mistake is worse than none.
    expect(whyWrong(q, 'a sign of bad luck!')).toEqual({
      why: q.explanation,
      source: 'answer',
    });
  });

  it('never explains one wrong answer with another one’s reason', () => {
    // `normaliseAnswer` strips exactly the characters `semanticMarks` keeps, so
    // `C++` and `C` both reduced to `c`, and `the market` and `market` both to
    // `market`. Neither is answered with the other's reason now.
    const languages = mcq({
      answer: 'Rust',
      explanation: null,
      rationale: [{ distractor: 'C++', why: 'C++ has manual memory management.' }],
    });
    expect(whyWrong(languages, 'C')).toBeNull();
    expect(whyWrong(languages, 'C++')).toEqual({
      why: 'C++ has manual memory management.',
      source: 'distractor',
    });

    const markets = mcq({
      answer: 'The state',
      explanation: null,
      rationale: [{ distractor: 'the market', why: 'Markets clear; they do not decide.' }],
    });
    expect(whyWrong(markets, 'market')).toBeNull();
    expect(whyWrong(markets, 'the market')).toEqual({
      why: 'Markets clear; they do not decide.',
      source: 'distractor',
    });
  });

  it('survives a rationale element the column has no shape for', () => {
    // `rationale` is jsonb and not a column until 3a, so the elements are as
    // unvalidated as the array. Each of these used to throw inside the feedback
    // path after a reader answered, taking the render with it.
    for (const junk of [[null], [{ why: 'x' }], [{ distractor: 'B' }], ['B'], [42]]) {
      const broken = mcq({ rationale: junk as never, explanation: 'The answer stands.' });
      expect(() => whyWrong(broken, 'anything')).not.toThrow();
      expect(whyWrong(broken, 'anything')).toEqual({
        why: 'The answer stands.',
        source: 'answer',
      });
    }
  });

  it('labels the answer’s own explanation as what it is', () => {
    // It says why the ANSWER is the answer, whatever was picked. Under a heading
    // like "Why that's wrong" it reads as an account of the reader's error, and
    // a screen rendering `explanation` separately would print it twice.
    expect(whyWrong(q, 'Someone else’s fault')).toEqual({
      why: q.explanation,
      source: 'answer',
    });
  });

  it('survives a question whose rationale column does not exist yet', () => {
    // 3a adds `rationale`; a row read today arrives without it.
    const legacy = { answer: 'Rust', explanation: 'Because of ownership.' } as Parameters<
      typeof whyWrong
    >[0];
    expect(whyWrong(legacy, 'Go')).toEqual({ why: 'Because of ownership.', source: 'answer' });
  });

  it('has nothing to say about the right answer', () => {
    expect(whyWrong(q, q.answer)).toBeNull();
    expect(whyWrong(q, ` ${q.answer} `)).toBeNull();
  });

  it('is null when there is neither a rationale nor an explanation', () => {
    expect(whyWrong(mcq({ rationale: [], explanation: null }), 'A reason to stop')).toBeNull();
    expect(whyWrong(mcq({ rationale: [], explanation: '   ' }), 'A reason to stop')).toBeNull();
  });

  it('ignores a rationale whose reason is blank', () => {
    const blank = mcq({ rationale: [{ distractor: 'A reason to stop', why: '  ' }] });
    expect(whyWrong(blank, 'A reason to stop')).toEqual({
      why: blank.explanation,
      source: 'answer',
    });
  });
});

/*
 * Round 3 found the round-2 fixes doing harm of their own, which is why these are
 * pinned as cases rather than as properties: each row is a measurement somebody made
 * against the code, not a hypothesis about it.
 */
describe('the spelling fold is the rule it claims to be', () => {
  // The fold was `/z/g`. Two different answers normalised to one string, which made
  // them an exact match — so they skipped the inexact cap and graded `easy` at
  // similarity 1, the one outcome `semanticMarks` says a grader must never produce.
  it.each([
    ['Zn', 'Sn'],
    ['Hz', 'Hs'],
    ['zeal', 'seal'],
    ['fuzz', 'fuss'],
    ['zinc', 'sinc'],
    ['zap', 'sap'],
    ['zip', 'sip'],
    ['zero', 'sero'],
    ['zest', 'sest'],
    ['zone', 'sone'],
    ['prize', 'prise'],
  ])('does not accept %s answered as %s', (answer, typed) => {
    const r = gradeCloze(typed, answer, 'sure');
    expect(r.correct).toBe(false);
    expect(r.similarity).toBeLessThan(1);
  });

  // And still does the job it was added for.
  it.each([
    ['organise', 'organize'],
    ['organisation', 'organization'],
    ['organising', 'organizing'],
    ['analyse', 'analyze'],
    ['recognised', 'recognized'],
  ])('still folds %s and %s together', (answer, typed) => {
    expect(gradeCloze(typed, answer).correct).toBe(true);
    expect(gradeCloze(answer, typed).correct).toBe(true);
  });
});

describe('a spelling is not a misconception, and a confusion is', () => {
  /*
   * The `-re`/`-er` family fell wholesale on the transposition floor: `theatre` was
   * accepted for being one letter longer than `centre`. The first fix withheld
   * `confidentlyWrong` from anything with the SHAPE of a typo, which is not
   * evidence — the confusions below have exactly that shape — so the axis is folded
   * in `normaliseAnswer` instead and the answer is simply right.
   */
  it.each([
    ['centre', 'center'],
    ['metre', 'meter'],
    ['litre', 'liter'],
    ['fibre', 'fiber'],
    ['theatre', 'theater'],
    ['odour', 'odor'],
    ['sceptical', 'skeptical'],
    ['catalogue', 'catalog'],
    ['grey', 'gray'],
    ['kilometre', 'kilometer'],
    ['colourful', 'colorful'],
    ['colour', 'color'],
    ['favourite', 'favorite'],
    ['neighbours', 'neighbors'],
  ])('marks %s answered as %s right, not merely unaccused', (answer, typed) => {
    for (const [a, b] of [
      [typed, answer],
      [answer, typed],
    ] as const) {
      const r = gradeCloze(a, b, 'sure');
      expect(r.correct, `${a} for ${b}`).toBe(true);
      expect(r.confidentlyWrong).toBe(false);
    }
  });

  /*
   * AND THE ELEVEN THE FLOOR EXISTS FOR REACH THE FLAG AGAIN.
   *
   * Each is a reader holding one word to be another, answered `sure`, which is what
   * `confidentlyWrong` is for. Every one of them has the shape of a typo —
   * `casual`/`causal` and `trail`/`trial` are transpositions, the rest single
   * indels — so the shape-based suppression silenced all eleven. That is the
   * measurement that sent this rule back.
   */
  it.each([
    ['casual', 'causal'],
    ['trail', 'trial'],
    ['ion', 'iron'],
    ['aid', 'acid'],
    ['cost', 'coast'],
    ['sale', 'scale'],
    ['form', 'from'],
    ['untied', 'united'],
    ['hat', 'heat'],
    ['at', 'art'],
    ['rat', 'rate'],
    ['timbre', 'timber'],
  ])('refuses %s answered as %s AND says the reader was confidently wrong', (answer, typed) => {
    const r = gradeCloze(typed, answer, 'sure', 1000);
    expect(r.correct, `${typed} for ${answer}`).toBe(false);
    expect(r.confidentlyWrong, `${typed} for ${answer}`).toBe(true);
    // Unsure is never an accusation, whatever the shape of the difference.
    expect(gradeCloze(typed, answer, 'unsure', 1000).confidentlyWrong).toBe(false);
  });

  it('grades a spelling variant as well as the reader who spells it the other way', () => {
    /*
     * This is what folding an axis BUYS, over merely not accusing anybody, and it is
     * the only observable difference for `-our`: every foldable `-our` word clears
     * the slip rule's floor on its own, so without the fold `colour` for `color` is
     * an accepted slip -- and an accepted slip is capped at `good`, because the rule
     * cannot promise it was the reader's word. A fold can promise exactly that, so
     * the answer is exact and a fast, sure reader gets the `easy` an American
     * speller gets for the same knowledge. `organisation`/`organization` has worked
     * this way since the `-ize` fold; this is the same fairness one axis along.
     */
    expect(gradeCloze('colour', 'color', 'sure', 100).grade).toBe('easy');
    expect(gradeCloze('color', 'colour', 'sure', 100).grade).toBe('easy');
    expect(gradeCloze('favourite', 'favorite', 'sure', 100).grade).toBe('easy');
    expect(gradeCloze('organisation', 'organization', 'sure', 100).grade).toBe('easy');
    // An ordinary typo is still capped, because nothing promises it was the word.
    expect(gradeCloze('mitochondia', 'mitochondria', 'sure', 100).grade).toBe('good');
  });

  /*
   * THE TEN PAIRS A SUFFIX RULE MERGED, which is why this is a list.
   *
   * Round 4 wrote the axis as `(?<=[a-z]{3})re(s?)(?![a-z])` -> `er$1`, which is not a
   * suffix rule: it rewrote the trailing `re` of every word with three stem letters.
   * A 370k-word sweep found 453 collisions, these ten between real English words. Each
   * became an EXACT match, so the "an accepted slip is never easy" cap was skipped and
   * a wrong answer graded `easy` at similarity 1 — the one outcome the module says a
   * grader must never produce, and the same failure the `/z/g` fold was reverted for.
   */
  it.each([
    ['timbre', 'timber'],
    ['shire', 'shier'],
    ['stere', 'steer'],
    ['spire', 'spier'],
    ['shore', 'shoer'],
    ['eagre', 'eager'],
    ['livre', 'liver'],
    ['spare', 'spaer'],
    ['outre', 'outer'],
  ])('keeps %s and %s two words', (a, b) => {
    for (const [typed, answer] of [
      [a, b],
      [b, a],
    ] as const) {
      const r = gradeCloze(typed, answer, 'sure', 100);
      expect(r.correct, `${typed} for ${answer}`).toBe(false);
      expect(r.similarity).toBeLessThan(1);
    }
  });

  it('does not turn every final transposition into a free exact match', () => {
    // A side effect of the same rule: `nature` folded to `natuer`, so `natuer` typed
    // for `nature` was exact and graded `easy` — straight past the seven-letter
    // transposition floor, for every word ending in a consonant plus `e`.
    const r = gradeCloze('natuer', 'nature', 'sure', 100);
    expect(r.grade).not.toBe('easy');
    expect(r.similarity).toBeLessThan(1);
    expect(gradeCloze('measuer', 'measure', 'sure', 100).similarity).toBeLessThan(1);
  });

  it('names the tenth pair, which the slip rule accepts on its own', () => {
    /*
     * The regex merged ten real pairs and this list keeps nine of them apart.
     * `compère`/`compeer` is the tenth and is still accepted — not by any fold, but by
     * the seven-letter transposition floor: the accent strip makes it `compere`, and
     * `compere`/`compeer` is one swap at exactly seven letters. So it is a residual of
     * the slip rule rather than of the variant list, which is a different claim from
     * "a list cannot merge a pair nobody put in it" and is worth not conflating.
     */
    expect(gradeCloze('compère', 'compeer').correct).toBe(true);
    expect(gradeCloze('compère', 'compeer').similarity).toBeLessThan(1);
  });

  it('keeps the pairs a wider fold would merge', () => {
    // A list cannot merge a pair nobody put in it, which is the whole argument for
    // one. These are the pairs the plausible generalisations of it would take.
    expect(gradeCloze('four', 'for').correct).toBe(false);
    expect(gradeCloze('shoe', 'she').correct).toBe(false);

    // And the `ae`/`oe` family needs no entry: it clears the slip rule's own floor.
    expect(gradeCloze('foetus', 'fetus').correct).toBe(true);
    expect(gradeCloze('anaemia', 'anemia').correct).toBe(true);
  });

  it('folds a variant however it is capitalised', () => {
    /*
     * The fold is a rule about lower-case words, so it has to run AFTER the lowercase.
     * The first version folded the raw text, and `SPELLING_VARIANTS` is all lower case
     * against a case-sensitive `split`/`join` — so one capital defeated it entirely.
     *
     * The AUTHORED side matters more than the typed one here: an authored answer is
     * routinely capitalised and no keyboard is involved, so `centre` typed against an
     * authored `Centre` — the identical word — was accepted only as a typing slip and
     * could never be `easy`, while `Centre` typed against `center` was `forgot` AND
     * `confidentlyWrong`. Round 4's regexes ran after the lowercase and did not have
     * this, so it was a regression produced by the fix for one.
     */
    for (const [typed, answer] of [
      ['Centre', 'center'],
      ['centre', 'Centre'],
      ['center', 'Centre'],
      ['Colour', 'color'],
      ['Fibre', 'fiber'],
      ['Manoeuvre', 'maneuver'],
      ['Skeptic', 'Sceptic'],
      ['THEATRE', 'theater'],
    ] as const) {
      const r = gradeCloze(typed, answer, 'sure', 100);
      expect(r.correct, `${typed} for ${answer}`).toBe(true);
      expect(r.similarity, `${typed} for ${answer}`).toBe(1);
      expect(r.confidentlyWrong).toBe(false);
    }
  });

  it('does not read a different word as a mistyped variant', () => {
    /*
     * `wordsAreClose` took a second look at the RAW forms so that `colur` for `colour`
     * stayed a slip — the fold rewrites one side and turns a dropped letter into a
     * substitution. An exhaustive sweep of a 370k-word list found 52 pairs that retry
     * newly accepted, where the folded comparison correctly refuses and the raw one
     * sees an ordinary indel. These are two common words each, and `fibre` is an
     * ordinary cloze answer.
     *
     * The retry is gone. What it cost is asserted below rather than left implied.
     */
    for (const [typed, answer] of [
      ['fires', 'fibres'],
      ['amour', 'armour'],
      ['tires', 'titres'],
      ['mires', 'mitres'],
    ] as const) {
      expect(gradeCloze(typed, answer).correct, `${typed} for ${answer}`).toBe(false);
    }
  });

  it('refuses a typo at or before the folded part of a variant word, whatever the fold', () => {
    /*
     * The named price of removing the raw retry — and the two cases this used to assert
     * were the two that made it look self-limiting.
     *
     * Its name and its comment said the cost bites "only where the fold is an INDEL", so
     * that the `-re` family, being transpositions, was safe. Both examples happen to
     * agree with that story and the story is false: an exhaustive sweep found 2,581 of
     * the 7,969 regressions on SAME-LENGTH folds. `theatr` survives because the dropped
     * letter falls past `-tre`, not because `theatre` -> `theater` keeps its length —
     * drop one before or inside the folded region and it is refused, with the fold's
     * shape unchanged. So the extra cases below are the ones that pin the real rule; the
     * two originals stay because they are still true, just no longer the whole story.
     */
    expect(gradeCloze('colur', 'colour').correct).toBe(false);
    expect(gradeCloze('theatr', 'theatre').correct).toBe(true);

    // Same word, same fold shape, slip moved earlier: refused.
    for (const [typed, answer] of [
      ['teatre', 'theatre'],
      ['thatre', 'theatre'],
      ['cntre', 'centre'],
      ['clibre', 'calibre'],
    ] as const) {
      expect(gradeCloze(typed, answer).correct, `${typed} for ${answer}`).toBe(false);
    }

    // And a substitution fold regresses too, which "only where the fold is an indel"
    // denied outright.
    expect(gradeCloze('sceptc', 'sceptic').correct).toBe(false);
  });

  it('discloses that a doubled keystroke in a variant word is called a misconception', () => {
    /*
     * Not an endorsement — a disclosure. `centtre` is one doubled letter from a word the
     * variant list exists to protect, and answered `sure` it grades `forgot` AND sets
     * `confidentlyWrong`, routing a British reader into the misconception loop for a
     * typing slip. Withholding the flag on the SHAPE of a typo was tried and `gradeCloze`
     * records why it was worse: eleven real confusions have that shape and all went
     * silent. So this is asserted rather than fixed, and a future change that quietly
     * alters it has to come through here.
     */
    const graded = gradeCloze('centtre', 'centre', 'sure');
    expect(graded.correct).toBe(false);
    expect(graded.confidentlyWrong).toBe(true);
  });

  it('still flags a confident answer that is simply a different idea', () => {
    expect(
      gradeCloze('the opposite of that', 'a considered judgement', 'sure').confidentlyWrong,
    ).toBe(true);
  });
});

describe('a question with no answer', () => {
  it('renders no options rather than a blank one a reader can pick', () => {
    expect(mcqOptions({ answer: '   ', distractors: ['a', 'b'] }, 'seed')).toEqual([]);
  });

  it('does not treat picking nothing as agreeing with nothing', () => {
    // Blank answer, blank pick: graded wrong and flagged, while `whyWrong` returned
    // null because the two empty strings matched — judged, then given no reason.
    expect(whyWrong({ answer: '', explanation: 'e', rationale: [] }, '')).toBeNull();
    expect(whyWrong({ answer: '  ', explanation: 'e', rationale: [] }, 'anything')).toBeNull();
  });
});
