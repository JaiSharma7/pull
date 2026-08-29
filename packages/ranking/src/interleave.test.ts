import { describe, expect, it } from 'vitest';
import { DEFAULT_INTERLEAVE_CONFIG, planInterleave, type InterleaveSlot } from './interleave.js';
import { seededUnit } from './prng.js';
import fixtures from './__fixtures__/interleave-parity.json' with { type: 'json' };

const CFG = DEFAULT_INTERLEAVE_CONFIG;

describe('seededUnit', () => {
  // Reference values taken from public.seeded_unit on the live database.
  it('matches the SQL implementation exactly', () => {
    expect(seededUnit(42, 0, 0)).toBeCloseTo(0.675024127433265, 12);
    expect(seededUnit(42, 0, 1)).toBeCloseTo(0.908634324157327, 12);
    expect(seededUnit(43, 0, 0)).toBeCloseTo(0.667168132851404, 12);
  });

  it('is deterministic and salt-separated', () => {
    expect(seededUnit(7, 1, 2, 'place')).toBe(seededUnit(7, 1, 2, 'place'));
    expect(seededUnit(7, 1, 2, 'place')).not.toBe(seededUnit(7, 1, 2, 'kind'));
  });

  it('is uniform over [0,1)', () => {
    const n = 20_000;
    let sum = 0;
    let min = 1;
    let max = 0;
    for (let i = 0; i < n; i++) {
      const v = seededUnit(i, 0, 0);
      sum += v;
      min = Math.min(min, v);
      max = Math.max(max, v);
    }
    expect(sum / n).toBeGreaterThan(0.49);
    expect(sum / n).toBeLessThan(0.51);
    expect(min).toBeGreaterThanOrEqual(0);
    expect(max).toBeLessThan(1);
  });
});

describe('planInterleave — parity with SQL', () => {
  // SQL is authoritative. These fixtures came from the database itself, so a
  // divergence here means the mirror drifted, not that the fixtures are wrong.
  it.each(fixtures.cases)(
    'seed $seed page $page (before=$cardsBefore used=$usedBudget last=$lastPlaced)',
    ({ seed, page, pageSize, cardsBefore, usedBudget, lastPlaced, expected }) => {
      const actual = planInterleave({
        seed,
        page,
        pageSize,
        cardsBefore,
        usedBudget,
        lastPlaced,
      });
      expect(actual).toEqual(expected as InterleaveSlot[]);
    },
  );
});

describe('planInterleave — the guarantees that make randomness tolerable', () => {
  const SESSIONS = 10_000;
  const PAGE = 30;

  const plans = Array.from({ length: SESSIONS }, (_, seed) =>
    planInterleave({ seed, page: 0, pageSize: PAGE }),
  );

  it('never exceeds the per-session budget', () => {
    const worst = Math.max(...plans.map((p) => p.length));
    expect(worst).toBeLessThanOrEqual(CFG.maxPerSession);
  });

  it('never interrupts during the warm-up cards', () => {
    const earliest = Math.min(...plans.flat().map((s) => s.slotIndex));
    expect(earliest).toBeGreaterThanOrEqual(CFG.warmupCards);
  });

  it('always leaves more than the minimum gap between interrupts', () => {
    for (const plan of plans) {
      for (let i = 1; i < plan.length; i++) {
        const gap = plan[i]!.slotIndex - plan[i - 1]!.slotIndex;
        expect(gap).toBeGreaterThan(CFG.minGapCards);
      }
    }
  });

  it('keeps the interrupt rate inside a tolerable band', () => {
    const total = plans.reduce((n, p) => n + p.length, 0);
    const perSession = total / SESSIONS;
    // Roughly 1-3 questions per 30-card session: frequent enough to matter,
    // rare enough not to feel like being nagged.
    expect(perSession).toBeGreaterThan(1);
    expect(perSession).toBeLessThan(3);
  });

  it('samples kinds in the configured proportions', () => {
    const all = plans.flat();
    const share = (k: string) => all.filter((s) => s.kind === k).length / all.length;
    expect(share('recall')).toBeCloseTo(CFG.weightRecall / 100, 1);
    expect(share('say_it_back')).toBeCloseTo(CFG.weightSayItBack / 100, 1);
    expect(share('conviction')).toBeCloseTo(CFG.weightConviction / 100, 1);
    expect(share('delta_probe')).toBeCloseTo(CFG.weightDeltaProbe / 100, 1);
  });

  it('holds the minimum gap across a page boundary', () => {
    // Found by review: without carrying the previous placement, an interrupt on
    // the last card of one page left slot 0 of the next immediately eligible —
    // an observed gap of 1 against a configured minimum of 4. Single-page tests
    // could not see it.
    const PAGE = 20;
    let violations = 0;
    let checked = 0;

    for (let seed = 0; seed < 3000; seed++) {
      const first = planInterleave({ seed, page: 0, pageSize: PAGE });
      const lastOfFirst = first.at(-1)?.slotIndex;
      if (lastOfFirst === undefined) continue;

      const second = planInterleave({
        seed,
        page: 1,
        pageSize: PAGE,
        cardsBefore: PAGE,
        usedBudget: first.length,
        lastPlaced: lastOfFirst,
      });
      const firstOfSecond = second[0];
      if (!firstOfSecond) continue;

      checked += 1;
      const gap = PAGE + firstOfSecond.slotIndex - lastOfFirst;
      if (gap <= CFG.minGapCards) violations += 1;
    }

    expect(checked).toBeGreaterThan(0);
    expect(violations).toBe(0);
  });

  it('is reproducible: the same seed always yields the same plan', () => {
    expect(planInterleave({ seed: 4242, page: 0, pageSize: PAGE })).toEqual(
      planInterleave({ seed: 4242, page: 0, pageSize: PAGE }),
    );
  });

  it('is unpredictable: different seeds usually yield different plans', () => {
    const shapes = new Set(plans.slice(0, 500).map((p) => JSON.stringify(p)));
    expect(shapes.size).toBeGreaterThan(100);
  });
});

describe('planInterleave — backing off', () => {
  it('asks more often when recall work is piling up', () => {
    const idle = planInterleave({ seed: 5, page: 0, pageSize: 60, duePressure: 0 });
    const loaded = planInterleave({ seed: 5, page: 0, pageSize: 60, duePressure: 1 });
    expect(loaded.length).toBeGreaterThanOrEqual(idle.length);
  });

  it('asks less often when the user keeps dismissing', () => {
    const engaged = Array.from({ length: 400 }, (_, s) =>
      planInterleave({ seed: s, page: 0, pageSize: 30, dismissalDamping: 1 }),
    ).flat().length;
    const dismissive = Array.from({ length: 400 }, (_, s) =>
      planInterleave({ seed: s, page: 0, pageSize: 30, dismissalDamping: 0.25 }),
    ).flat().length;
    expect(dismissive).toBeLessThan(engaged);
  });

  it('stops entirely when the user turns interrupts off', () => {
    expect(planInterleave({ seed: 1, page: 0, pageSize: 100, preferenceRate: 0 })).toEqual([]);
  });

  it('respects a budget already spent earlier in the session', () => {
    expect(
      planInterleave({ seed: 1, page: 2, pageSize: 100, usedBudget: CFG.maxPerSession }),
    ).toEqual([]);
  });
});
