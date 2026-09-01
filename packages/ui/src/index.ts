export { PullCard } from './components/PullCard.js';
export type { PullCardProps, PullCardSource } from './components/PullCard.js';
export {
  HEADLINE_SCALE,
  WORDS_PER_MINUTE,
  clampDepth,
  clock,
  countWords,
  defaultDepth,
  depthLevels,
  readingSeconds,
  textAtDepth,
} from './depth.js';
export type { DepthContent, DepthKey, DepthLevel } from './depth.js';
export { Meter } from './components/Meter.js';
export type { MeterProps } from './components/Meter.js';
export { Enough } from './components/Enough.js';
export type { EnoughProps } from './components/Enough.js';
export { Mark, brimPath, hatGeometry } from './components/Mark.js';
export type { HatGeometry, MarkProps } from './components/Mark.js';

/** Identifier for the design system these components implement. */
export const DESIGN_SYSTEM = 'the-archive';
