import { describe, expect, it } from 'vitest';
import {
  clockForWords,
  depthLabels,
  initialPreviewState,
  previewReducer,
  sittingWordCount,
  visibleWords,
  wordCount,
  type PreviewPull,
} from './design-preview.js';

const pull: PreviewPull = {
  headline: 'One two three four five six seven',
  source: {
    title: 'A public-domain source',
    creator: 'A writer',
    kind: 'essay',
    year: '1625',
    trail: 'section 1',
    url: 'https://example.test/source',
  },
  layers: [
    { text: 'eight nine ten eleven twelve thirteen fourteen' },
    { heading: 'Fifteen sixteen', text: 'seventeen eighteen nineteen twenty twenty-one' },
    {
      text: 'twenty-two twenty-three twenty-four twenty-five twenty-six twenty-seven twenty-eight',
    },
    { text: 'twenty-nine thirty thirty-one thirty-two thirty-three thirty-four thirty-five' },
  ],
};

describe('preview reading time', () => {
  it('counts visible words rather than authored duration labels', () => {
    expect(wordCount(' one\n two   three ', '', 'four')).toBe(4);
    expect(clockForWords(35)).toBe('10 sec');
    expect(clockForWords(105)).toBe('30 sec');
    expect(clockForWords(210)).toBe('1 min');
    expect(clockForWords(315)).toBe('2 min');
  });

  it('gives empty content an honest zero', () => {
    expect(clockForWords(0)).toBe('0 sec');
  });

  it('makes each depth cumulative and leaves the fifth stop for the source', () => {
    expect(visibleWords(pull, 0)).toBe(7);
    expect(visibleWords(pull, 2)).toBe(21);
    expect(visibleWords(pull, 4)).toBe(35);
    /*
     * This asserted ['10 sec', '10 sec', '10 sec', '10 sec', 'Source'] — the
     * duplication, pinned as correct. Four stops that read identically are not a
     * dial; the fixture is short, but the old ten-second floor made the same thing
     * happen on 27% of the real corpus.
     */
    expect(depthLabels(pull)).toEqual(['5 sec', '5 sec', '10 sec', '10 sec', 'Source']);
  });

  it('does not render every stop with the same label', () => {
    // The property behind the expectation above: a dial whose stops all read alike
    // tells the reader nothing about what the next turn costs.
    const durations = depthLabels(pull).filter((l) => l !== 'Source');
    expect(new Set(durations).size).toBeGreaterThan(1);
  });

  it('derives a sitting total from the default visible depth of every dealt Pull', () => {
    expect(sittingWordCount([pull, pull])).toBe(28);
  });
});

describe('bounded preview sitting', () => {
  it('moves from the gate to face-up contents before reading', () => {
    const contents = previewReducer(initialPreviewState, { type: 'choose', count: 2 });
    expect(contents).toEqual({ phase: 'contents', count: 2, depths: [1, 1] });
    expect(previewReducer(contents, { type: 'begin' }).phase).toBe('reading');
  });

  it('bounds the dial to five stops and the selected sitting', () => {
    const reading = previewReducer(
      previewReducer(initialPreviewState, { type: 'choose', count: 2 }),
      { type: 'begin' },
    );
    const deeper = previewReducer(reading, { type: 'depth', index: 1, depth: 99 });
    expect(deeper.depths).toEqual([1, 4]);
    expect(previewReducer(deeper, { type: 'depth', index: 2, depth: 3 })).toBe(deeper);
  });

  it('returns to a fresh gate instead of extending the finished sitting', () => {
    const contents = previewReducer(initialPreviewState, { type: 'choose', count: 3 });
    expect(previewReducer(contents, { type: 'restart' })).toEqual(initialPreviewState);
  });
});
