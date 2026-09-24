import { describe, expect, it } from 'vitest';
import {
  goalSearchQueries,
  isPreviewableStudyUrl,
  shapeStudySuggestions,
} from './study-source-entry-shape.js';

describe('goal-first study suggestions', () => {
  it('only offers inspectable public-domain source URLs', () => {
    const suggestions = shapeStudySuggestions(
      ['a', 'b', 'c', 'd'],
      [
        {
          id: 'a',
          title: 'A',
          description: null,
          source_url: 'https://en.wikisource.org/wiki/A',
          rights_status: 'public_domain',
        },
        {
          id: 'b',
          title: 'B',
          description: null,
          source_url: 'https://en.wikisource.org/wiki/B',
          rights_status: 'licensed',
        },
        {
          id: 'c',
          title: 'C',
          description: null,
          source_url: 'https://evilwikisource.org/C',
          rights_status: 'public_domain',
        },
        {
          id: 'd',
          title: 'D',
          description: null,
          source_url: null,
          rights_status: 'public_domain',
        },
      ],
    );
    expect(suggestions.map((item) => item.id)).toEqual(['a']);
  });

  it('extracts a topic phrase from a sentence-style goal', () => {
    expect(goalSearchQueries('I want to understand natural selection')).toEqual([
      'I want to understand natural selection',
      'natural selection',
    ]);
  });

  it('rejects misleading hosts, non-HTTPS and links too long for provenance', () => {
    expect(isPreviewableStudyUrl('https://www.gutenberg.org/ebooks/123')).toBe(true);
    for (const url of [
      'http://www.gutenberg.org/ebooks/123',
      'https://www.gutenberg.org.evil.test/ebooks/123',
      'https://www.gutenberg.org:8443/ebooks/123',
      'https://www.gutenberg.org/' + 'a'.repeat(240),
    ])
      expect(isPreviewableStudyUrl(url)).toBe(false);
  });
});
