/**
 * The generation pipeline, as an ordered list of steps.
 *
 * Edge Functions cap at 150s wall clock and 2s CPU per request, so the pipeline
 * cannot run in one invocation and must never be written as though it can. Each
 * invocation executes exactly ONE step and enqueues the next; pg_cron ticks the
 * dispatcher. See docs/architecture.md.
 */
export const STEPS = [
  'resolve_identity',
  'acquire',
  'chunk',
  'extract_evidence',
  'synthesize',
  'template',
  'critic',
  'cards',
  'artwork',
  'embed',
  'moderate',
  'publish',
] as const;

export type Step = (typeof STEPS)[number];

export function nextStep(current: Step): Step | null {
  const i = STEPS.indexOf(current);
  if (i < 0 || i === STEPS.length - 1) return null;
  return STEPS[i + 1] ?? null;
}

/** A step that has failed this many times is not going to succeed. */
export const MAX_ATTEMPTS = 3;
