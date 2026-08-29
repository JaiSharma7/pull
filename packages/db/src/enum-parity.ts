/**
 * Compile-time guard: the hand-written enum mirrors in `@wap/schemas` must stay
 * exactly equal to the generated database enums.
 *
 * This is the single likeliest way for this repo to break. A migration adds an
 * enum member, `pnpm db:types` regenerates, and the TypeScript mirror silently
 * drifts — producing code that compiles but cannot represent a value the
 * database will happily return. These assertions turn that into a typecheck
 * failure (CI check 2) at the moment the two disagree.
 *
 * The file exports nothing at runtime; it exists to be type-checked.
 */
import type { RelationKind, RightsStatus, Stance, WorkKind, InterruptKind } from '@wap/schemas';
import type { Database } from './database.types.js';

type Enums = Database['public']['Enums'];

/** Exact bidirectional equality — `extends` alone would allow a subset to pass. */
type Equal<A, B> =
  (<G>() => G extends A ? 1 : 2) extends <G>() => G extends B ? 1 : 2 ? true : false;

type Assert<T extends true> = T;

export type EnumParityChecks = [
  Assert<Equal<WorkKind, Enums['work_kind']>>,
  Assert<Equal<RightsStatus, Enums['rights_status']>>,
  Assert<Equal<Stance, Enums['stance']>>,
  Assert<Equal<RelationKind, Enums['relation_kind']>>,
  Assert<Equal<InterruptKind, Enums['interrupt_kind']>>,
];
