export interface PathStep {
  id: string;
  order: number;
  headline: string;
  workTitle: string;
  rationale: string;
  estimatedMinutes: number;
}

export interface LearningPath {
  slug: string;
  title: string;
  subtitle: string;
  category: string;
  estimatedMinutes: number;
  steps: PathStep[];
}

export const CURATED_PATHS: readonly LearningPath[] = [
  {
    slug: 'rationality-crucible',
    title: 'The Rationality Crucible',
    subtitle: 'Move from reflexive cognitive heuristic traps to calibrated probabilistic judgment.',
    category: 'Epistemology',
    estimatedMinutes: 8,
    steps: [
      {
        id: 'sample-1',
        order: 1,
        headline: 'System 1 is fast and heuristic; System 2 is slow and deliberate',
        workTitle: 'Thinking, Fast and Slow',
        rationale:
          'Establish the dual-process architecture of human judgment before analyzing specific biases.',
        estimatedMinutes: 2,
      },
      {
        id: 'sample-3',
        order: 2,
        headline: 'Outlier events dominate history yet are retrospectively rationalized',
        workTitle: 'The Black Swan',
        rationale:
          'Understand how heuristic pattern-matching fails catastrophically in non-linear fat-tailed domains.',
        estimatedMinutes: 3,
      },
      {
        id: 'sample-5',
        order: 3,
        headline: 'Science progresses by paradigm shifts, not steady accumulation',
        workTitle: 'The Structure of Scientific Revolutions',
        rationale:
          'Recognize that entire theoretical structures blind observers to conflicting anomalies.',
        estimatedMinutes: 3,
      },
    ],
  },
  {
    slug: 'antifragile-systems',
    title: 'Antifragile Systems & Extreme Risk',
    subtitle:
      'Design decisions and architectures that thrive under volatility rather than merely surviving shocks.',
    category: 'Systems Thinking',
    estimatedMinutes: 7,
    steps: [
      {
        id: 'sample-3',
        order: 1,
        headline: 'Outlier events dominate history yet are retrospectively rationalized',
        workTitle: 'The Black Swan',
        rationale:
          'Define the vulnerability of Gaussian bell-curve models in real-world socioeconomic extremes.',
        estimatedMinutes: 2,
      },
      {
        id: 'sample-2',
        order: 2,
        headline: 'Antifragility gains from disorder, volatility, and stressors',
        workTitle: 'Antifragile',
        rationale:
          'Learn the operational antidote: asymmetric payoffs where upside exceeds downside under stressors.',
        estimatedMinutes: 3,
      },
      {
        id: 'sample-4',
        order: 3,
        headline: 'You have power over your mind, not outside events',
        workTitle: 'Meditations',
        rationale:
          'Internalize personal antifragility through voluntary hardship and cognitive detachment.',
        estimatedMinutes: 2,
      },
    ],
  },
  {
    slug: 'stoic-agency',
    title: 'Stoic Agency & Emotional Sovereignty',
    subtitle:
      'Transform external adversity into internal agency through classical Stoicism and existential logotherapy.',
    category: 'Philosophy & Psychology',
    estimatedMinutes: 6,
    steps: [
      {
        id: 'sample-4',
        order: 1,
        headline: 'You have power over your mind, not outside events',
        workTitle: 'Meditations',
        rationale:
          'Establish the fundamental dichotomy of control: divide reality into what is up to you and what is not.',
        estimatedMinutes: 3,
      },
      {
        id: 'sample-6',
        order: 2,
        headline: 'Between stimulus and response there is a space: our choice',
        workTitle: 'Man’s Search for Meaning',
        rationale:
          'Apply the dichotomy of control to extreme suffering: freedom is the intentional choice of attitude.',
        estimatedMinutes: 3,
      },
    ],
  },
] as const;

/**
 * Retrieve a learning path by its URL slug.
 */
export function getPathBySlug(slug: string): LearningPath | undefined {
  return CURATED_PATHS.find((p) => p.slug === slug);
}

/**
 * Calculate completion percentage for a path given completed Pull IDs.
 */
export function computePathProgress(path: LearningPath, completedPullIds: Set<string>): number {
  if (path.steps.length === 0) return 0;
  const done = path.steps.filter((s) => completedPullIds.has(s.id)).length;
  return Math.round((done / path.steps.length) * 100);
}
