import { describe, expect, it } from 'vitest';
import { computePathProgress, CURATED_PATHS, getPathBySlug } from './paths.js';

describe('learning paths', () => {
  it('defines curated paths with valid non-empty steps', () => {
    expect(CURATED_PATHS.length).toBeGreaterThanOrEqual(3);
    for (const path of CURATED_PATHS) {
      expect(path.steps.length).toBeGreaterThanOrEqual(2);
      expect(path.estimatedMinutes).toBeGreaterThan(0);
      expect(path.title.length).toBeGreaterThan(5);
    }
  });

  it('retrieves path by slug accurately', () => {
    const p = getPathBySlug('rationality-crucible');
    expect(p).toBeDefined();
    expect(p?.category).toBe('Epistemology');
  });

  it('computes completion progress accurately', () => {
    const p = getPathBySlug('rationality-crucible')!;
    expect(computePathProgress(p, new Set())).toBe(0);
    expect(computePathProgress(p, new Set(['sample-1']))).toBe(33);
    expect(computePathProgress(p, new Set(['sample-1', 'sample-3', 'sample-5']))).toBe(100);
  });
});
