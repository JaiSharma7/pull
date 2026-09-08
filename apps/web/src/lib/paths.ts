import { int, isRecord, nonNull, nullableStr, rows, str } from './shape.js';

export type PathStepKind = 'read' | 'predict' | 'compare' | 'say_it_back' | 'apply';

export interface PathPullWork {
  id: string;
  title: string;
  slug: string;
}

export interface PathPullSummary {
  id: string;
  headline: string;
  body: string | null;
  whyItMatters: string | null;
  example: string | null;
  explanation: string | null;
  work: PathPullWork;
}

export interface PathStep {
  ordinal: number;
  kind: PathStepKind;
  prompt: string;
  comparePullId: string | null;
  done: boolean;
  testedOut: boolean;
  doneAt: string | null;
  pull: PathPullSummary;
  comparePull: PathPullSummary | null;
}

export interface PathItem {
  id: string;
  slug: string;
  title: string;
  question: string;
  description: string;
  topicSlug: string | null;
  stepCount: number;
  startedAt: string | null;
  pausedAt: string | null;
  completedAt: string | null;
  completedSteps: number;
}

export interface PathDetail {
  id: string;
  slug: string;
  title: string;
  question: string;
  description: string;
  topicSlug: string | null;
  startedAt: string | null;
  pausedAt: string | null;
  completedAt: string | null;
  steps: PathStep[];
}

/* --------------------------------------------------------------------------
 * Pure Helpers
 * -------------------------------------------------------------------------- */

/**
 * Returns the first step that has not been marked done, or null if all are done.
 */
export function nextUndone(steps: PathStep[]): PathStep | null {
  for (const step of steps) {
    if (!step.done) return step;
  }
  return null;
}

/**
 * The concise status label for a path in a list or header.
 */
export function progressLabel(
  completed: number,
  total: number,
  completedAt?: string | null,
): string {
  if (completedAt || (total > 0 && completed >= total)) {
    return 'Completed';
  }
  if (completed <= 0) {
    return `${total} ${total === 1 ? 'step' : 'steps'}`;
  }
  return `${completed} of ${total} done`;
}

/**
 * Action verb and explanatory phrase for each of the 5 learning path step kinds.
 */
export function stepCopy(kind: PathStepKind): { action: string; description: string } {
  switch (kind) {
    case 'read':
      return {
        action: 'Read',
        description: 'Understand the core claim and its reasoning',
      };
    case 'predict':
      return {
        action: 'Predict',
        description: 'Anticipate the mechanism before reading further',
      };
    case 'compare':
      return {
        action: 'Compare',
        description: 'Contrast this idea with an opposing or adjacent view',
      };
    case 'say_it_back':
      return {
        action: 'Say it back',
        description: 'State the idea in your own words to verify comprehension',
      };
    case 'apply':
      return {
        action: 'Apply',
        description: 'Ground this principle in your own observation or practice',
      };
    default:
      return {
        action: 'Reflect',
        description: 'Engage with this idea',
      };
  }
}

/* --------------------------------------------------------------------------
 * Shaping
 * -------------------------------------------------------------------------- */

function shapePullSummary(raw: unknown): PathPullSummary | null {
  if (!isRecord(raw)) return null;
  const id = str(raw.id);
  const headline = str(raw.headline);
  if (!id || !headline) return null;

  const workRaw = isRecord(raw.work) ? raw.work : {};
  const work: PathPullWork = {
    id: str(workRaw.id),
    title: str(workRaw.title),
    slug: str(workRaw.slug),
  };

  return {
    id,
    headline,
    body: nullableStr(raw.body),
    whyItMatters: nullableStr(raw.whyItMatters),
    example: nullableStr(raw.example),
    explanation: nullableStr(raw.explanation),
    work,
  };
}

const STEP_KINDS = new Set<PathStepKind>(['read', 'predict', 'compare', 'say_it_back', 'apply']);

function shapeStep(raw: unknown): PathStep | null {
  if (!isRecord(raw)) return null;
  const ordinal = int(raw.ordinal);
  const kindRaw = str(raw.kind) as PathStepKind;
  if (ordinal <= 0 || !STEP_KINDS.has(kindRaw)) return null;

  const pull = shapePullSummary(raw.pull);
  if (!pull) return null;

  const comparePull = raw.comparePull ? shapePullSummary(raw.comparePull) : null;

  return {
    ordinal,
    kind: kindRaw,
    prompt: str(raw.prompt),
    comparePullId: nullableStr(raw.comparePullId),
    done: Boolean(raw.done),
    testedOut: Boolean(raw.testedOut),
    doneAt: nullableStr(raw.doneAt),
    pull,
    comparePull,
  };
}

function shapePathItem(raw: unknown): PathItem | null {
  if (!isRecord(raw)) return null;
  const id = str(raw.id);
  const slug = str(raw.slug);
  const title = str(raw.title);
  if (!id || !slug || !title) return null;

  return {
    id,
    slug,
    title,
    question: str(raw.question),
    description: str(raw.description),
    topicSlug: nullableStr(raw.topicSlug),
    stepCount: int(raw.stepCount),
    startedAt: nullableStr(raw.startedAt),
    pausedAt: nullableStr(raw.pausedAt),
    completedAt: nullableStr(raw.completedAt),
    completedSteps: int(raw.completedSteps),
  };
}

export function shapePaths(raw: unknown): PathItem[] {
  return rows(raw).map(shapePathItem).filter(nonNull);
}

export function shapePathDetail(raw: unknown): PathDetail | null {
  if (!isRecord(raw)) return null;
  const id = str(raw.id);
  const slug = str(raw.slug);
  const title = str(raw.title);
  if (!id || !slug || !title) return null;

  const steps = rows(raw.steps).map(shapeStep).filter(nonNull);

  return {
    id,
    slug,
    title,
    question: str(raw.question),
    description: str(raw.description),
    topicSlug: nullableStr(raw.topicSlug),
    startedAt: nullableStr(raw.startedAt),
    pausedAt: nullableStr(raw.pausedAt),
    completedAt: nullableStr(raw.completedAt),
    steps,
  };
}
