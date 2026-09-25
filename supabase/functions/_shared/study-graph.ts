/**
 * The study generation pipeline, as a graph.
 *
 * Separate from `graph.ts` rather than a branch inside it, because the two share
 * nothing but the machine: the canonical graph turns one source into a published
 * summary; this turns a reader's private versions into a draft course. Its steps are
 * named `study_*` so a queue message identifies its graph by itself, and the worker
 * asks `isStudyStep` which one to walk.
 *
 *     study_prepare      plan bounded windows over the chosen versions (no model)
 *           │
 *     study_extract      one ExtractStudyClaims call per window, cached, one window
 *           │            per invocation -- the step re-sends itself until every
 *           │            window has a cached claim map (see `continue` in pipeline.ts)
 *     study_assemble     one AssembleStudyCourse call over the grounded claims, cached
 *           │
 *     study_ground       resolve evidence, check the course, write the rows (no model)
 *
 * A line, so `after` and `needs` coincide except that the later steps read the plan.
 */

export const STUDY_STEPS = [
  'study_prepare',
  'study_extract',
  'study_assemble',
  'study_ground',
] as const;

export type StudyStep = (typeof STUDY_STEPS)[number];

export interface StudyNode {
  readonly needs: readonly StudyStep[];
  readonly after: readonly StudyStep[];
}

export const STUDY_NODES: Record<StudyStep, StudyNode> = {
  study_prepare: { needs: [], after: [] },
  study_extract: { needs: ['study_prepare'], after: ['study_prepare'] },
  study_assemble: { needs: ['study_prepare', 'study_extract'], after: ['study_extract'] },
  study_ground: {
    needs: ['study_prepare', 'study_extract', 'study_assemble'],
    after: ['study_assemble'],
  },
};

export const STUDY_ROOT: StudyStep = 'study_prepare';

/** The steps that call a provider, and so write ledger rows of their own. */
export const STUDY_PROVIDER_STEPS: ReadonlySet<StudyStep> = new Set([
  'study_extract',
  'study_assemble',
]);

export function isStudyStep(step: string): step is StudyStep {
  return (STUDY_STEPS as readonly string[]).includes(step);
}

export function studySuccessorsOf(step: StudyStep): StudyStep[] {
  return STUDY_STEPS.filter((s) => STUDY_NODES[s].after.includes(step));
}
