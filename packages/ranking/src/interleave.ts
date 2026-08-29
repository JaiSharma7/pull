import type { InterruptKind } from '@wap/schemas';
import { seededUnit } from './prng.js';

/**
 * Mirror of `public.plan_interleave`.
 *
 * SQL is authoritative — this exists so the client can predict the next page's
 * interrupt slots for prefetch, and so the behaviour can be tested without a
 * database. `interleave.parity.test.ts` asserts the two agree exactly against
 * fixtures captured from the live database.
 */

export interface InterleaveConfig {
  maxPerSession: number;
  minGapCards: number;
  warmupCards: number;
  baseProbability: number;
  pressureMultiplier: number;
  maxProbability: number;
  weightRecall: number;
  weightSayItBack: number;
  weightConviction: number;
  weightCounterpull: number;
  weightDeltaProbe: number;
}

/** Matches the row inserted by migration 0007. */
export const DEFAULT_INTERLEAVE_CONFIG: InterleaveConfig = {
  maxPerSession: 3,
  minGapCards: 4,
  warmupCards: 2,
  baseProbability: 0.08,
  pressureMultiplier: 0.04,
  maxProbability: 0.35,
  weightRecall: 45,
  weightSayItBack: 20,
  weightConviction: 15,
  weightCounterpull: 12,
  weightDeltaProbe: 8,
};

export interface InterleaveInput {
  seed: bigint | number;
  page: number;
  pageSize: number;
  /** Cards already seen this session, so the gap holds across page boundaries. */
  cardsBefore?: number;
  /** Interrupts already shown this session. */
  usedBudget?: number;
  /** 0..1 — how much recall work is waiting. */
  duePressure?: number;
  /** 0.25..1 — lowered by repeated dismissals, so the system backs off. */
  dismissalDamping?: number;
  /** The user's own preference multiplier; 0 disables interrupts entirely. */
  preferenceRate?: number;
  config?: InterleaveConfig;
}

export interface InterleaveSlot {
  slotIndex: number;
  kind: InterruptKind;
}

/** Weighted choice from a draw already scaled to [0, 100). */
function pickKind(pick: number, c: InterleaveConfig): InterruptKind {
  let cum = c.weightRecall;
  if (pick < cum) return 'recall';
  cum += c.weightSayItBack;
  if (pick < cum) return 'say_it_back';
  cum += c.weightConviction;
  if (pick < cum) return 'conviction';
  cum += c.weightCounterpull;
  if (pick < cum) return 'counterpull';
  return 'delta_probe';
}

export function planInterleave(input: InterleaveInput): InterleaveSlot[] {
  const {
    seed,
    page,
    pageSize,
    cardsBefore = 0,
    usedBudget = 0,
    duePressure = 0,
    dismissalDamping = 1,
    preferenceRate = 1,
    config = DEFAULT_INTERLEAVE_CONFIG,
  } = input;

  let budgetLeft = Math.max(config.maxPerSession - usedBudget, 0);
  if (budgetLeft === 0 || preferenceRate === 0) return [];

  const probability = Math.min(
    config.maxProbability,
    (config.baseProbability + config.pressureMultiplier * duePressure * 10) *
      dismissalDamping *
      preferenceRate,
  );

  const slots: InterleaveSlot[] = [];
  // Sentinel far enough back that the first eligible card is never gap-blocked.
  let lastPlaced = -1000;

  for (let i = 0; i < pageSize; i++) {
    if (budgetLeft <= 0) break;

    const absolutePos = cardsBefore + i;
    if (absolutePos < config.warmupCards) continue;
    if (absolutePos - lastPlaced <= config.minGapCards) continue;

    if (seededUnit(seed, page, i, 'place') >= probability) continue;

    slots.push({
      slotIndex: i,
      kind: pickKind(seededUnit(seed, page, i, 'kind') * 100, config),
    });

    lastPlaced = absolutePos;
    budgetLeft -= 1;
  }

  return slots;
}
