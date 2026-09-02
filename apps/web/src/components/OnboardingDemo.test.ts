import { describe, expect, it } from 'vitest';
import { SAMPLE_GRAPH } from '../lib/graph.js';

describe('OnboardingDemo', () => {
  it('has valid seed graph for the 3rd step interactive visualization', () => {
    expect(SAMPLE_GRAPH.nodes.length).toBeGreaterThanOrEqual(4);
    expect(SAMPLE_GRAPH.edges.length).toBeGreaterThanOrEqual(2);
  });
});
