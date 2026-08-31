/**
 * Provider interfaces.
 *
 * Selected by environment so a self-hosted instance is never forced to
 * reproduce our vendors. Round 1 ships only the stub implementations: the
 * step-machine is wired and testable end to end without any API key, and
 * round 2 swaps in real providers without touching the pipeline.
 */

export interface SummaryInput {
  workTitle: string;
  kind: string;
  context: string;
}

/**
 * Every `topics.slug` a generated work may be filed under.
 *
 * Mirrors the taxonomy seeded by `20260831025500_topics_with_something_behind_them`
 * and the four parents that predate it, for the same reason `WORK_KINDS` is mirrored
 * in `pipeline.ts`: the model is told what the allowed values are, and the boundary
 * narrows anything else away before Postgres is asked.
 *
 * It lives here rather than beside the other enum mirrors because both the provider
 * that emits these and the pipeline that narrows them already import this module,
 * and a provider reaching into the orchestrator for a constant would be the wrong
 * direction to depend in.
 *
 * Parents are includable on purpose. A work about ethics generally, with no narrower
 * home, is better filed under `philosophy` than under a child that misdescribes it.
 *
 * If the taxonomy migration changes, this changes in the same commit.
 */
export const TOPIC_SLUGS = [
  'philosophy',
  'ethics',
  'stoicism',
  'logic',
  'metaphysics',
  'aesthetics',
  'psychology',
  'attention',
  'habits',
  'learning',
  'emotion',
  'science',
  'evolution',
  'physics',
  'chemistry',
  'astronomy',
  'medicine',
  'society',
  'economics',
  'liberty',
  'government',
  'justice',
  'education',
  'arts-and-letters',
  'literature',
  'rhetoric',
  'criticism',
  'history',
  'biography',
  'revolutions',
] as const;
export type TopicSlug = (typeof TOPIC_SLUGS)[number];

export interface CanonicalSummary {
  title: string;
  elevatorPitch: string;
  whyItMatters: string;
  pulls: { headline: string; body: string; whyItMatters: string }[];
  /**
   * Topic slugs this work belongs under, from the fixed taxonomy in `pipeline.ts`.
   *
   * Optional because a provider that predates this field is still a valid provider —
   * an absent list means "unclassified", which is what every generated work was until
   * now. It is not optional in effect: `topic_affinity` returns 0.0 for a work with no
   * `work_topics` rows, and that term is 28% of the score in `get_feed`, so an
   * unclassified work is one a reader's stated preferences can never reach.
   *
   * Produced by the same call that produces the summary, which is the whole point —
   * law 2 permits a model at generation time and forbids one in the read path, so the
   * classification is paid for once here and then stored.
   */
  topics?: string[];
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  costCents: number;
}

/**
 * A provider call that was metered and then turned out to be unusable.
 *
 * Lives here rather than beside a vendor because the pipeline must be able to
 * recognise it without importing one: `pipeline.ts` depends on these interfaces and
 * on no concrete provider, which is what lets the steps be tested against fakes.
 *
 * The distinction that matters is metered-vs-not, not failed-vs-succeeded. A model
 * that returns HTTP 200 with `finishReason: MAX_TOKENS` and empty parts has charged
 * for every input and thinking token it consumed; throwing a bare Error there loses
 * the only record of a real charge, and the step then retries and charges again.
 * A connection refused, by contrast, costs nothing and is correctly a plain Error.
 */
export class BilledProviderError extends Error {
  readonly usage: Usage;
  readonly model: string | undefined;

  constructor(message: string, billed: { usage: Usage; model?: string }) {
    super(message);
    this.name = 'BilledProviderError';
    this.usage = billed.usage;
    this.model = billed.model;
  }
}

export interface SummaryProvider {
  readonly name: string;
  /**
   * `model` is returned rather than read off the provider because a provider may fall
   * back between models mid-run — the newest Flash returns 503 under load often enough
   * that a pipeline pinned to it stalls. `job_steps.model` has to name the model that
   * actually produced this summary, or provenance is fiction.
   */
  generateSummary(
    input: SummaryInput,
  ): Promise<{ summary: CanonicalSummary; usage: Usage; model: string }>;
}

export interface EmbeddingProvider {
  readonly name: string;
  embed(texts: string[]): Promise<{ vectors: number[][]; usage: Usage }>;
}

export interface ImageProvider {
  readonly name: string;
  generateArtwork(prompt: string): Promise<{ path: string; usage: Usage } | null>;
}

/**
 * Deterministic, free, and offline. Enough to exercise every step.
 *
 * It has to emit at least one Pull. `synthesize` rejects a summary with none —
 * correctly, since a summary with no ideas in it is not a summary — so a stub
 * returning an empty array made the documented no-key path fail every job at the
 * one step it was supposed to prove. "Runs without an API key" is a promise to
 * every contributor cloning this repo and to anyone self-hosting; a stub that
 * cannot reach `publish` does not keep it.
 *
 * The Pull is derived from the input rather than hardcoded, so a test can tell
 * which source produced it and the pipeline's wiring — title in, content
 * through, rows out — is genuinely exercised rather than simulated.
 */
export const stubSummaryProvider: SummaryProvider = {
  name: 'stub',
  async generateSummary(input) {
    const opening = input.context.trim().slice(0, 240);
    return {
      summary: {
        title: input.workTitle,
        elevatorPitch: `A stub summary of ${input.workTitle}.`,
        whyItMatters: 'Generated by the stub provider; a real provider replaces this.',
        pulls: [
          {
            headline: `An idea from ${input.workTitle}`,
            body:
              opening.length > 0
                ? opening
                : `Placeholder body for ${input.workTitle}, produced without a model.`,
            whyItMatters:
              'The stub provider produces one Pull so the pipeline can be exercised end to end without an API key.',
          },
        ],
        // A real slug, not a placeholder: `upsertWork` looks these up against
        // `public.topics` and silently drops what it cannot find, so an invented
        // one would make the stub exercise the drop path instead of the write
        // path — and the write path is the one worth exercising without a key.
        topics: ['philosophy'],
      },
      usage: { inputTokens: 0, outputTokens: 0, costCents: 0 },
      model: 'stub',
    };
  },
};

export const stubEmbeddingProvider: EmbeddingProvider = {
  name: 'stub',
  async embed(texts) {
    return {
      vectors: texts.map(() => new Array(1536).fill(0)),
      usage: { inputTokens: 0, outputTokens: 0, costCents: 0 },
    };
  },
};

/**
 * Artwork is the first thing to switch off under cost pressure: an illustration
 * can cost several times the text generation it accompanies. Returning null is
 * a supported outcome, not a failure — the product degrades to typography.
 */
export const disabledImageProvider: ImageProvider = {
  name: 'disabled',
  async generateArtwork() {
    return null;
  },
};
