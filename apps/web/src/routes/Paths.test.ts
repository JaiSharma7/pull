import { describe, expect, it } from 'vitest';
import { CURATED_PATHS } from '../lib/paths.js';

describe('Paths route logic', () => {
  it('has valid pathways configured for rendering', () => {
    expect(CURATED_PATHS.length).toBeGreaterThan(0);
    const first = CURATED_PATHS[0]!;
    expect(first.title).toBe('The Rationality Crucible');
    expect(first.steps.length).toBe(3);
  });
});
