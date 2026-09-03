import { describe, expect, it } from 'vitest';
import { CALIBRATION_ITEMS } from './KnowledgeCensus.js';

describe('KnowledgeCensus', () => {
  it('provides rich set of multidisciplinary calibration items', () => {
    expect(CALIBRATION_ITEMS.length).toBeGreaterThanOrEqual(6);
    for (const item of CALIBRATION_ITEMS) {
      expect(item.id).toBeDefined();
      expect(item.concept).toBeDefined();
      expect(item.hoursSavedEstimated).toBeGreaterThan(0);
    }
  });

  it('calculates aggregate hours saved potential', () => {
    const totalPotentialHours = CALIBRATION_ITEMS.reduce(
      (acc, curr) => acc + curr.hoursSavedEstimated,
      0,
    );
    expect(totalPotentialHours).toBeGreaterThan(10);
  });
});
