import { describe, expect, it } from 'vitest';
import { summarizeIngestion } from '../lib/ingestion.js';

describe('Ingestion route logic', () => {
  it('summarizes empty highlights gracefully', () => {
    const summary = summarizeIngestion([]);
    expect(summary.totalHighlights).toBe(0);
    expect(summary.distinctBooks).toEqual([]);
    expect(summary.distinctAuthors).toEqual([]);
  });
});
