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

/**
 * What each step reads from the steps before it.
 *
 * The worker holds nothing between invocations, so a step's only inputs are what
 * earlier steps wrote to `job_steps.output` -- and until this existed the worker
 * fetched all of it, every time. `acquire` writes up to 200,000 characters of source
 * text and `chunk` writes the same text again as sections, so from the fourth step on
 * every invocation pulled ~400 kB through PostgREST to run a step that mostly reads
 * one field. This is the list the worker hands to `job_step_outputs(uuid, text[])`
 * instead.
 *
 * Derived by reading `runPipelineStep`, not by guessing, and asserted two ways:
 * `steps.test.ts` checks that no step names a later one, and `pipeline.test.ts`
 * walks the whole pipeline giving each step ONLY what it declares here. A step that
 * quietly reads something undeclared fails that walk rather than failing in
 * production with "missing acquire or synthesize output".
 *
 * `reuseOf()` in pipeline.ts reads both `acquire.reuse` and `synthesize.reuse`, which
 * is why `template`, `critic` and `publish` list both. That is also why those three
 * still receive the source text -- `acquire` carries the text and the reuse marker in
 * one object. Five fetches of the text instead of ten; the rest go when the marker
 * moves, which is the graph work in docs/plans/2026-09-02-fable-5.1.md.
 */
export const NEEDS: Record<Step, readonly Step[]> = {
  resolve_identity: [],
  acquire: ['resolve_identity'],
  chunk: ['acquire'],
  extract_evidence: ['chunk'],
  synthesize: ['acquire'],
  template: ['acquire', 'synthesize'],
  critic: ['acquire', 'synthesize'],
  cards: ['template', 'synthesize'],
  artwork: [],
  embed: ['cards', 'synthesize'],
  moderate: [],
  publish: ['acquire', 'synthesize', 'template'],
};
