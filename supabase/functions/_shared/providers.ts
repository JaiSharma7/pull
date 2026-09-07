/**
 * Provider interfaces.
 *
 * Selected by environment so a self-hosted instance is never forced to
 * reproduce our vendors. Round 1 ships only the stub implementations: the
 * step-machine is wired and testable end to end without any API key, and
 * round 2 swaps in real providers without touching the pipeline.
 */

import { promptFor } from './prompts.ts';

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
  'mathematics',
  'computation',
  'architecture',
  'world-philosophy',
  'strategy',
  'ecology',
] as const;
export type TopicSlug = (typeof TOPIC_SLUGS)[number];

export interface CanonicalSummary {
  title: string;
  elevatorPitch: string;
  whyItMatters: string;
  pulls: {
    headline: string;
    body: string;
    whyItMatters: string;
    /** Concrete grounding: case study, demonstration, or thought experiment. */
    example?: string;
    /** The deep-dive breakdown for readers choosing the full/long depth stop. */
    explanation?: string;
    /**
     * The questions about this idea, produced by the same call.
     *
     * `quiz_questions` has been read by `get_due_reviews` since round 1 and
     * written by nothing: six rows, all seeded, against 156 pulls. `recall` is
     * 45% of the interrupt distribution, so Interleaved Recall — the mechanic
     * this product is built on — had nothing to ask about 96% of the library.
     *
     * AN ARRAY NOW, and `question` stays beside it. A provider that predates this
     * field is still a valid provider — the singular is read when the plural is
     * absent, and `questionsToWrite` normalises the two into one list — so the
     * widening costs no provider anything. An idea with nothing worth asking has
     * an empty array, and the interrupt falls back to the self-graded reveal
     * rather than failing.
     *
     * At most one of each kind reaches Postgres: `quiz_questions_pull_kind_key` is
     * unique on `(pull_id, kind)`. See `questionsToWrite`.
     *
     * They ride on the synthesis call rather than becoming a step of their own, so
     * they cost no extra request and only a few output tokens — the same trade
     * `topics` already made, and the reason both are affordable at all.
     */
    questions?: {
      kind?: string;
      prompt: string;
      answer: string;
      distractors?: string[];
      cloze?: string | null;
      explanation?: string | null;
      rationale?: { distractor: string; why: string }[];
    }[];
    /** @deprecated The one-question shape. Read only when `questions` is absent. */
    question?: { prompt: string; answer: string; distractors?: string[] };
  }[];
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
            // One question of each generated kind, so the no-key path exercises
            // the write rather than the skip — and exercises it for every kind,
            // since a kind that only appears in a real generation is a kind whose
            // insert is first tried in production. Same reasoning as the real
            // topic slug below.
            questions: [
              {
                kind: 'recall',
                prompt: `What does ${input.workTitle} claim?`,
                answer: 'That the stub provider produced this idea.',
                distractors: [],
                explanation: 'The stub says so in its own body.',
                rationale: [],
              },
              {
                kind: 'mcq',
                prompt: `Which of these does ${input.workTitle} claim?`,
                answer: 'That the stub provider produced this idea.',
                distractors: ['Nothing at all.', 'Something a model wrote.'],
                explanation: 'Only the first is what the stub body says.',
                rationale: [
                  { distractor: 'Nothing at all.', why: 'The stub does produce one idea.' },
                  { distractor: 'Something a model wrote.', why: 'No model ran on this path.' },
                ],
              },
              {
                kind: 'cloze',
                prompt: 'Fill the blank.',
                answer: 'stub provider',
                distractors: [],
                cloze: 'This idea was produced by the ____ , without a model.',
                explanation: 'The no-key path is the stub provider.',
                rationale: [],
              },
            ],
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

/**
 * A provider that could not answer, and did not charge for failing to.
 *
 * The distinction from `BilledProviderError` is the whole reason this exists. That one
 * says "you have been charged and got nothing usable"; this one says "nothing happened".
 * Only the second is safe to recover from by asking somebody else, because recovering
 * from the first would leave a real charge with no row in `cost_ledger` — law 2 counts
 * every model call, not every successful one.
 *
 * Thrown when an entire vendor is unreachable for the request: an exhausted daily quota,
 * a model that does not exist, a service returning 503 across every configured model.
 */
export class ProviderUnavailableError extends Error {
  readonly provider: string | undefined;

  constructor(message: string, provider?: string) {
    super(message);
    this.name = 'ProviderUnavailableError';
    this.provider = provider;
  }
}

/**
 * Ask the second provider only when the first one could not be asked at all.
 *
 * Gemini's free tier meters **per model per day**. When it is spent, `gemini.ts` walks
 * its whole model chain, gets 429 from each, and throws — and every queued source then
 * fails at `synthesize` until the quota window rolls over. On 2026-08-31 that stalled a
 * night's generation with a perfectly healthy pipeline behind it.
 *
 * The fall-through condition is deliberately the narrowest one that fixes that:
 *
 * - `ProviderUnavailableError` → try the fallback. Nothing was charged, so nothing is
 *   lost by asking elsewhere.
 * - `BilledProviderError` → **rethrow**. The primary metered a call; that charge has to
 *   reach `cost_ledger`, and swallowing it to retry elsewhere would hide real spend
 *   behind an apparent success. The step retries and reaches here again.
 * - anything else → rethrow. A malformed request, a bug, a network failure mid-stream:
 *   none of them are evidence the primary is out of quota, and paying a second vendor to
 *   rediscover a local bug is the expensive way to find out.
 *
 * A second provider is a second bill, so it is only ever constructed when one is
 * explicitly configured — see `resolveProviders`.
 */
export function createFallbackSummaryProvider(
  primary: SummaryProvider,
  fallback: SummaryProvider,
): SummaryProvider {
  return {
    // Both names, because `job_steps.provider` should say which chain ran, and the
    // model returned per call already says which one actually answered.
    name: `${primary.name}->${fallback.name}`,

    async generateSummary(input) {
      try {
        return await primary.generateSummary(input);
      } catch (e) {
        if (!(e instanceof ProviderUnavailableError)) throw e;
        // Logged rather than silent: a deployment quietly running on its more expensive
        // fallback for a week is exactly the kind of spend nobody notices until the bill.
        console.warn(
          `[providers] ${primary.name} unavailable (${e.message}); falling back to ${fallback.name}`,
        );
        return await fallback.generateSummary(input);
      }
    },
  };
}

/**
 * The prompt is analysis, not reproduction (law 4).
 *
 * It lives in `packages/prompts/baml_src/canonical_summary.baml` and arrives here
 * through `pnpm baml:export` as a template; this renders it. The one thing the
 * template cannot carry is a conditional on an argument's value -- the exporter
 * refuses a transformed argument, because a placeholder has to be the argument
 * verbatim -- so the fallback for an empty context is applied here rather than in
 * the prompt. See docs/baml.md and docs/content-policy.md.
 */
export function buildSummaryPrompt(input: SummaryInput): string {
  return promptFor('WriteCanonicalSummary', {
    workTitle: input.workTitle,
    kind: input.kind,
    context: input.context || '(no additional context supplied)',
  });
}
