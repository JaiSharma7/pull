import { describe, expect, it } from 'vitest';
import {
  clampDepth,
  clock,
  countWords,
  defaultDepth,
  depthLevels,
  HEADLINE_SCALE,
  readingSeconds,
  textAtDepth,
  WORDS_PER_MINUTE,
} from './depth.js';

/**
 * The Depth Dial's arithmetic, over the inputs the corpus actually contains.
 *
 * The interesting cases are all absences: most Pulls have `why_it_matters`, only
 * some have `explanation`, and a card must never offer a stop that leads to an
 * empty panel — the failure the old two-sided card had in miniature, where "Why"
 * was always there and sometimes turned over to nothing.
 */

const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');

const full = {
  headline: words(10),
  body: words(60),
  whyItMatters: words(80),
  explanation: words(500),
  hasSource: true,
};

describe('countWords', () => {
  it('counts words, not characters', () => {
    expect(countWords('one two three')).toBe(3);
  });

  it('treats absent, empty and whitespace-only text as nothing to read', () => {
    // All three arrive from the database: a null column, an empty string a
    // generation wrote, and a field someone left as a newline.
    expect(countWords(null)).toBe(0);
    expect(countWords(undefined)).toBe(0);
    expect(countWords('')).toBe(0);
    expect(countWords('   \n  ')).toBe(0);
  });

  it('does not count runs of whitespace as extra words', () => {
    expect(countWords('one   two\n\nthree')).toBe(3);
  });
});

describe('readingSeconds', () => {
  it('converts at the rate the design session made a law', () => {
    expect(WORDS_PER_MINUTE).toBe(210);
    expect(readingSeconds(WORDS_PER_MINUTE)).toBe(60);
    expect(readingSeconds(WORDS_PER_MINUTE * 3)).toBe(180);
  });
});

describe('clock', () => {
  it('rounds to five seconds, rather than implying it knows a reader to the second', () => {
    // 105 words at 210wpm is exactly 30 seconds.
    expect(clock(105)).toBe('30 sec');
    expect(clock(110)).toBe('30 sec');
  });

  it('never goes below ten seconds, however short the card', () => {
    // The floor is the design's. "0 sec" or "5 sec" on a headline reads as a
    // glitch rather than as an estimate.
    expect(clock(0)).toBe('10 sec');
    expect(clock(3)).toBe('10 sec');
  });

  it('switches to whole minutes past the minute, never "1 min 20 sec"', () => {
    expect(clock(420)).toBe('2 min');
    expect(clock(1050)).toBe('5 min');
  });
});

describe('depthLevels', () => {
  it('offers all five stops when the content supports them', () => {
    expect(depthLevels(full).map((l) => l.key)).toEqual([
      'headline',
      'claim',
      'why',
      'full',
      'source',
    ]);
  });

  it('offers one stop when a Pull is only a headline and a claim with nowhere to go', () => {
    // The dial hides itself below two stops; this is the input that gets closest.
    const levels = depthLevels({ headline: words(8), body: '' });
    expect(levels.map((l) => l.key)).toEqual(['headline']);
  });

  it('drops the stops whose text is missing, rather than drawing an empty panel', () => {
    const levels = depthLevels({ headline: words(8), body: words(40), explanation: words(200) });
    expect(levels.map((l) => l.key)).toEqual(['headline', 'claim', 'full']);
  });

  it('counts an example as reason enough for the why stop', () => {
    // `why_it_matters` is null far more often than `example` is, and a card with
    // only an example still has something to reveal.
    const levels = depthLevels({ headline: words(8), body: words(40), example: words(20) });
    expect(levels.map((l) => l.key)).toEqual(['headline', 'claim', 'why']);
  });

  it('treats an empty string as an absent field, not as a stop', () => {
    const levels = depthLevels({
      headline: words(8),
      body: words(40),
      whyItMatters: '   ',
      explanation: '',
    });
    expect(levels.map((l) => l.key)).toEqual(['headline', 'claim']);
  });

  it('draws the source stop only where there is a source to open', () => {
    // A card whose work is not resolvable — the specimen, an offline row — must
    // not offer a terminus that goes nowhere.
    const shape = { headline: words(8), body: words(40) };
    expect(depthLevels({ ...shape, hasSource: true }).at(-1)!.key).toBe('source');
    expect(depthLevels(shape).at(-1)!.key).toBe('claim');
  });

  it('counts the headline from the first stop, since the reader can already see it', () => {
    const levels = depthLevels({ headline: words(10), body: words(50) });
    expect(levels[0]!.words).toBe(10);
    expect(levels[1]!.words).toBe(60);
  });

  it('reports cumulative words, so a stop says how long the WHOLE card is', () => {
    const levels = depthLevels(full);
    expect(levels.map((l) => l.words)).toEqual([10, 70, 150, 650, 650]);
  });

  it('never lets a deeper stop claim to be quicker than a shallower one', () => {
    // Monotonic by construction, since the words accumulate. Asserted anyway
    // because a dial reading "2 min · 30 sec" would invite the reader to go
    // deeper to save time, and nothing else in the file would catch it.
    const seconds = depthLevels(full).map((l) => l.seconds);
    for (let i = 1; i < seconds.length; i++) {
      expect(seconds[i]!).toBeGreaterThanOrEqual(seconds[i - 1]!);
    }
  });

  it('labels the terminus Source rather than a duration', () => {
    // The last stop is not a longer read of this card; it is leaving it.
    expect(depthLevels(full).at(-1)!.label).toBe('Source');
  });

  it('grows the tick with the stop, so the dial reads without colour', () => {
    const ticks = depthLevels(full).map((l) => parseInt(l.tick, 10));
    expect(ticks).toEqual([6, 10, 14, 18, 22]);
  });

  it('gives a short card a short dial, with ticks by position not by name', () => {
    /*
     * The design session took this cost explicitly: "a short card gets a short
     * dial, so the control is not identical everywhere. Honest, but it gives up
     * the reassurance of a fixed scale." A three-stop dial must still start at
     * the shortest tick, or it reads as though its first stop were already deep.
     */
    const levels = depthLevels({ headline: words(8), body: words(40), explanation: words(90) });
    expect(levels.map((l) => l.tick)).toEqual(['6px', '10px', '14px']);
  });

  it('has a headline scale for every stop it can draw', () => {
    expect(HEADLINE_SCALE).toHaveLength(5);
    // Strictly shrinking: each turn of the dial trades display size for prose.
    for (let i = 1; i < HEADLINE_SCALE.length; i++) {
      expect(HEADLINE_SCALE[i]!).toBeLessThan(HEADLINE_SCALE[i - 1]!);
    }
  });
});

describe('defaultDepth', () => {
  it('opens on the claim, not on a bare headline', () => {
    // A feed of headlines is a table of contents. The shortest stop is an option
    // the reader chooses, not the state they are dropped into.
    expect(defaultDepth(depthLevels(full))).toBe(1);
  });

  it('falls back to what a one-stop card can show', () => {
    expect(defaultDepth(depthLevels({ headline: words(8), body: '' }))).toBe(0);
  });
});

describe('clampDepth', () => {
  it('holds a remembered depth that the card can honour', () => {
    expect(clampDepth(3, depthLevels(full))).toBe(3);
  });

  it('pulls a remembered depth back to the deepest stop this card has', () => {
    // The reason this exists: the feed keeps one depth across cards, and the next
    // card may have no explanation. Unclamped, this indexes past the end and the
    // dial marks a stop that is not rendered.
    const levels = depthLevels({ headline: words(8), body: words(40) });
    expect(clampDepth(3, levels)).toBe(1);
  });

  it('refuses a negative or fractional depth', () => {
    const levels = depthLevels(full);
    expect(clampDepth(-3, levels)).toBe(0);
    expect(clampDepth(2.9, levels)).toBe(2);
  });

  it('survives an empty level list rather than returning -1', () => {
    expect(clampDepth(2, [])).toBe(0);
  });
});

describe('textAtDepth', () => {
  const content = {
    headline: 'A claim',
    body: 'The body',
    whyItMatters: 'Why it matters',
    explanation: 'The full argument',
  };

  it('speaks only the headline at the shortest stop', () => {
    expect(textAtDepth(content, 0)).toBe('A claim.');
  });

  it('speaks what the card is showing once the reader has opened it', () => {
    // Law 3 makes audio free forever. A Listen pinned to one stop makes it free
    // only at the depth the reader did not choose.
    const said = textAtDepth(content, 3);
    expect(said).toContain('The full argument');
    expect(said).toContain('Why it matters');
  });

  it('terminates each part, so a synthesiser pauses between them', () => {
    expect(textAtDepth({ headline: 'No stop here', body: 'Nor here' }, 1)).toBe(
      'No stop here. Nor here.',
    );
  });

  it('does not double a terminator the text already has', () => {
    expect(textAtDepth({ headline: 'Ends in a question?', body: 'Done.' }, 1)).toBe(
      'Ends in a question? Done.',
    );
  });

  it('clamps like the dial does, rather than reading a stop the card lacks', () => {
    expect(textAtDepth({ headline: 'A claim', body: 'The body' }, 4)).toBe('A claim. The body.');
  });

  it('skips an absent field instead of leaving a gap in the speech', () => {
    const said = textAtDepth({ ...content, whyItMatters: null, example: null }, 3);
    expect(said).toBe('A claim. The body. The full argument.');
  });

  it('does not read the source stop aloud as though it were text', () => {
    // The terminus adds no words to the card; it is where the card stops being
    // the thing you are reading.
    const said = textAtDepth({ ...content, hasSource: true }, 4);
    expect(said).toBe('A claim. The body. Why it matters. The full argument.');
  });
});
