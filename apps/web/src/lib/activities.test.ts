import { describe, expect, it } from 'vitest';
import {
  answerSimilarity,
  CLOZE_ACCEPT,
  FAST_ANSWER_MS,
  gradeCloze,
  gradeMcq,
  gradeOrdering,
  mcqOptions,
  normaliseAnswer,
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

  it('accepts a typo within the threshold', () => {
    // One letter wrong in twelve is a slip of the hand, not of memory.
    const result = gradeCloze('mitochondrea', answer);
    expect(result.similarity).toBeGreaterThanOrEqual(CLOZE_ACCEPT);
    expect(result.correct).toBe(true);
  });

  it('charges a swapped pair as one slip, not two', () => {
    // The commonest typing error. Plain Levenshtein would score it 10/12 and
    // fail it; the distance here counts an adjacent transposition once.
    const result = gradeCloze('mitochondira', answer);
    expect(result.similarity).toBeCloseTo(11 / 12);
    expect(result.correct).toBe(true);
  });

  it('rejects a different word, and says how close it came', () => {
    const result = gradeCloze('chloroplast', answer);
    expect(result.correct).toBe(false);
    expect(result.grade).toBe('forgot');
    expect(result.similarity).toBeLessThan(CLOZE_ACCEPT);
    expect(result.similarity).toBeGreaterThanOrEqual(0);
  });

  it('rejects a short word with one letter wrong', () => {
    // 0.85 on four letters allows no slip at all; "mass" is not "mast".
    expect(gradeCloze('mast', 'mass').correct).toBe(false);
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
      misplaced: 0,
    });
  });

  it('rejects one swapped pair, and counts both positions', () => {
    const result = gradeOrdering(['Observe', 'Test', 'Hypothesise', 'Revise'], q);
    expect(result.correct).toBe(false);
    expect(result.grade).toBe('forgot');
    expect(result.misplaced).toBe(2);
  });

  it('rejects a missing step', () => {
    const result = gradeOrdering(['Observe', 'Hypothesise', 'Revise'], q);
    expect(result.correct).toBe(false);
    expect(result.misplaced).toBe(2);
  });

  it('rejects an extra step', () => {
    const result = gradeOrdering(['Observe', 'Hypothesise', 'Test', 'Revise', 'Publish'], q);
    expect(result.correct).toBe(false);
    expect(result.misplaced).toBe(1);
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
    expect(whyWrong(q, 'A reason to stop')).toBe(
      'Stopping is the one response the passage rules out.',
    );
  });

  it('matches a distractor loosely when the verbatim one is not there', () => {
    expect(whyWrong(q, 'a sign of bad luck!')).toBe('Luck is not a category the Stoics grant.');
  });

  it('falls back to the explanation for a distractor with no rationale', () => {
    expect(whyWrong(q, 'Someone else’s fault')).toBe(q.explanation);
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
    expect(whyWrong(blank, 'A reason to stop')).toBe(blank.explanation);
  });
});
