import { describe, expect, it } from 'vitest';
import { parseCsvHighlights, parseKindleClippings, summarizeIngestion } from './ingestion.js';

describe('Universal Ingestion Bridge', () => {
  const sampleClippings = `Thinking, Fast and Slow (Daniel Kahneman)
- Your Highlight on page 42 | location 642-643 | Added on Monday, October 14, 2024 8:20:15 PM

System 1 operates automatically and quickly, with little or no effort and no sense of voluntary control.
==========
Antifragile (Nassim Nicholas Taleb)
- Your Highlight on page 19 | location 280-281 | Added on Tuesday, October 15, 2024 10:14:02 AM

Antifragility is beyond resilience or robustness. The resilient resists shocks and stays the same; the antifragile gets better.
==========
`;

  it('parses Kindle clippings with author, title, and quote', () => {
    const highlights = parseKindleClippings(sampleClippings);
    expect(highlights.length).toBe(2);

    expect(highlights[0]?.bookTitle).toBe('Thinking, Fast and Slow');
    expect(highlights[0]?.bookAuthor).toBe('Daniel Kahneman');
    expect(highlights[0]?.text).toContain('System 1 operates automatically');

    expect(highlights[1]?.bookTitle).toBe('Antifragile');
    expect(highlights[1]?.bookAuthor).toBe('Nassim Nicholas Taleb');
  });

  it('parses CSV highlights cleanly', () => {
    const csv = `Highlight,Book Title,Book Author
"Man is condemned to be free; because once thrown into the world, he is responsible for everything he does.",Being and Nothingness,Jean-Paul Sartre
"We suffer more often in imagination than in reality.",Letters from a Stoic,Seneca
`;
    const highlights = parseCsvHighlights(csv);
    expect(highlights.length).toBe(2);
    expect(highlights[0]?.bookTitle).toBe('Being and Nothingness');
    expect(highlights[1]?.bookTitle).toBe('Letters from a Stoic');
  });

  it('summarizes ingestion with distinct books and hours saved', () => {
    const highlights = parseKindleClippings(sampleClippings);
    const summary = summarizeIngestion(highlights);
    expect(summary.totalHighlights).toBe(2);
    expect(summary.distinctBooks.length).toBe(2);
    expect(summary.estimatedHoursSaved).toBeGreaterThan(0);
  });
});
