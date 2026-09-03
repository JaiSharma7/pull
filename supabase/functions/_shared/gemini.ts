/**
 * Gemini implementations of the provider interfaces.
 *
 * Deliberately free of top-level `Deno.env`: everything comes in through
 * `GeminiConfig`, so this module can be imported and exercised outside the Edge
 * runtime. That is the only way any of it gets tested — `supabase/functions/` has no
 * Deno test harness, and a provider that is only ever exercised in production is a
 * provider whose first bug is a bad summary nobody can explain.
 *
 * See docs/generation.md. Nothing here runs in the read path (law 2); every call is
 * made by the worker, once per canonical summary, and lands in `cost_ledger`.
 */

import { PROMPTS, toGeminiSchema } from './prompts.ts';
import { BilledProviderError, buildSummaryPrompt, ProviderUnavailableError } from './providers.ts';
import type {
  CanonicalSummary,
  EmbeddingProvider,
  SummaryInput,
  SummaryProvider,
  Usage,
} from './providers.ts';

const API_ROOT = 'https://generativelanguage.googleapis.com/v1beta';

/**
 * Summary models in preference order.
 *
 * Not "the newest one in /v1beta/models". That list is not a list of models you can
 * call: measured against this key, `gemini-2.5-flash` and `gemini-2.5-flash-lite`
 * return 404 despite being listed, and `gemini-3.7-flash` and `gemini-flash-latest`
 * both returned 503 UNAVAILABLE under load while 3.6 answered normally. A generation
 * pipeline that stalls whenever the newest model is busy is worse than one a version
 * behind, so the default leads with what actually answers and falls forward only if it
 * is configured to.
 */
export const DEFAULT_SUMMARY_MODELS = ['gemini-3.6-flash', 'gemini-3.7-flash'] as const;

export interface GeminiConfig {
  apiKey: string;
  /** Tried in order; the first that is reachable wins. */
  summaryModels: readonly string[];
  embeddingModel: string;
  /**
   * Prices move, so they are configuration rather than constants. USD per million
   * tokens, matching how every provider publishes them.
   */
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
  embeddingUsdPerMTok: number;
  /** Injectable so a test can drive the module without reaching the network. */
  fetchImpl?: typeof fetch;
  /** Below the platform's 150s wall clock, so a hung call fails the step rather than the worker. */
  timeoutMs?: number;
  /**
   * Ceiling on everything one provider call may spend, across retries and the
   * whole model chain.
   *
   * `timeoutMs` bounds a single HTTP attempt and is not sufficient on its own:
   * two attempts per model over a two-model chain is 4 × 60s = 240s, against a
   * platform that kills the invocation at 150s. Bounding the attempt while
   * leaving the total unbounded means the worst case is decided by how many
   * models happen to be configured — so adding a fallback model, which reads
   * like making the pipeline more robust, silently makes the step less able to
   * finish at all.
   *
   * The invocation dies with nothing recorded when that happens: no step row, no
   * ledger row, and a delivery charged against `read_ct`. Three of those and the
   * job is failed for a step that was only ever slow.
   */
  budgetMs?: number;
}

/** The dimensionality `pulls.embedding` is declared with, and its HNSW index built for. */
export const EMBEDDING_DIMENSIONS = 1536;

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * The total a step may spend inside a provider, chain and retries included.
 *
 * Sized so a step that uses all of it still leaves room for the worker to record
 * the outcome and advance the job before the platform's 150s cap. A step that
 * finishes is worth more than one that was allowed to keep trying.
 */
const DEFAULT_BUDGET_MS = 100_000;

/**
 * Scale a vector to unit length.
 *
 * Required, not defensive. Gemini only returns normalised vectors at a model's native
 * dimensionality; ask for a truncated 1536 and it returns something shorter — measured
 * at 0.689 for a typical Pull. Every comparison downstream (`get_feed`,
 * `get_source_delta`, the Delta's `covered` check) is a cosine distance against an HNSW
 * index built with `vector_cosine_ops`. Un-normalised vectors do not error there; they
 * quietly rank wrongly, which is far worse.
 *
 * A zero vector has no direction to preserve, so it is returned untouched rather than
 * divided by zero.
 */
export function l2Normalise(vector: number[]): number[] {
  let sumSquares = 0;
  for (const v of vector) sumSquares += v * v;
  const norm = Math.sqrt(sumSquares);
  if (norm === 0 || !Number.isFinite(norm)) return vector;
  return vector.map((v) => v / norm);
}

/** Cents, at the precision `cost_ledger.cost_cents` stores (numeric(12,4)). */
export function usdToCents(usd: number): number {
  return Math.round(usd * 100 * 10_000) / 10_000;
}

interface GeminiUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  /** Thinking models report reasoning separately — and bill it as output. */
  thoughtsTokenCount?: number;
}

/**
 * Turn Gemini's usage block into a ledger row.
 *
 * `thoughtsTokenCount` is added to output because that is how it is billed. Counting
 * only `candidatesTokenCount` would under-report spend on exactly the models most worth
 * watching, and an accounting system that is wrong in the cheap direction is the kind
 * nobody notices until the bill arrives.
 */
export function computeUsage(
  meta: GeminiUsageMetadata | undefined,
  config: Pick<GeminiConfig, 'inputUsdPerMTok' | 'outputUsdPerMTok'>,
): Usage {
  const inputTokens = meta?.promptTokenCount ?? 0;
  const outputTokens = (meta?.candidatesTokenCount ?? 0) + (meta?.thoughtsTokenCount ?? 0);
  const usd =
    (inputTokens / 1_000_000) * config.inputUsdPerMTok +
    (outputTokens / 1_000_000) * config.outputUsdPerMTok;
  return { inputTokens, outputTokens, costCents: usdToCents(usd) };
}

/**
 * Embedding cost has to be estimated: `embedContent` returns no usage metadata, and
 * asking `countTokens` first would double the request count to meter a fraction of a
 * cent. Four characters per token is the usual rough ratio.
 *
 * Named `estimate` so no caller mistakes it for a metered figure.
 */
export function estimateEmbeddingTokens(texts: string[]): number {
  return texts.reduce((total, text) => total + Math.ceil(text.length / 4), 0);
}

/**
 * The shape the summary model must return. Enforced by the API, not by parsing hope.
 *
 * Exported from `packages/prompts/baml_src` by `pnpm baml:export` and converted to
 * Gemini's dialect at module load. Until now this was a hand-written copy of the
 * same shape, one of four -- and `topics` and `question` were both added under the
 * hazard that copies drift silently. The enum on topic slugs comes through from the
 * BAML `@alias`es; the bounds on `topics` and `distractors` do NOT come from
 * `@assert` -- BAML v1 has no constraint syntax, and it parses v0's `@assert` and
 * then ignores it. They are layered on from `BOUNDS` in `packages/prompts/scripts/
 * export.mjs` after the schema is lowered, and `packages/prompts/src/schema.test.ts`
 * pins that each one landed on the node it was meant for. Either way they reach the
 * API, so a plausible slug the database would refuse, or an empty topic list that
 * would file the work under nothing, is rejected before synthesis is paid for --
 * but change a bound in `BOUNDS`, not in `baml_src`.
 * `narrowTopics` still runs on the way to the database, because a schema the
 * provider enforces is not the same as one this code enforces, and the stub
 * provider does not go through Gemini at all.
 */
const SUMMARY_SCHEMA = toGeminiSchema(PROMPTS.WriteCanonicalSummary.schema);

class GeminiError extends Error {
  // Assigned explicitly rather than declared as a constructor parameter property:
  // parameter properties need a real TypeScript transform, and this module is meant to
  // run under anything that can merely strip types — which is what makes it testable
  // outside the Edge runtime at all.
  status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'GeminiError';
    this.status = status;
  }
}

/**
 * Thrown when a step's total provider budget is gone.
 *
 * Declared after `GeminiError` because `extends` is evaluated where the class is
 * defined, not hoisted — putting this above would be a ReferenceError at module
 * load, which in an Edge Function means every invocation 500s.
 */
class GeminiBudgetExhausted extends GeminiError {
  constructor(spentMs: number, budgetMs: number) {
    super(`Gemini budget exhausted after ${spentMs}ms of ${budgetMs}ms`);
    this.name = 'GeminiBudgetExhausted';
  }
}

/**
 * A wall-clock budget shared by every attempt and every model in one step.
 *
 * Created once per provider call so the chain cannot outlive the invocation
 * running it. Each attempt gets whatever is left, never more than `timeoutMs`.
 */
function budgetFrom(config: GeminiConfig) {
  const budgetMs = config.budgetMs ?? DEFAULT_BUDGET_MS;
  const startedAt = Date.now();
  return {
    /** Remaining budget, or a throw when there is none left to spend. */
    nextTimeout(perAttemptMs: number): number {
      const spent = Date.now() - startedAt;
      const left = budgetMs - spent;
      if (left <= 0) throw new GeminiBudgetExhausted(spent, budgetMs);
      return Math.min(perAttemptMs, left);
    },
  };
}

/**
 * A 5xx is worth one more try on the same model; a 400 means the request itself is
 * wrong and a 429 means this model has no quota left.
 *
 * 429 was retried here and it never helped. The retry is immediate — there is no
 * backoff, because the worker already retries the whole step — so a quota that is
 * exhausted is still exhausted a few milliseconds later. All it bought was a second
 * wasted call against the same limit, and a step budget spent before the chain could
 * try a model that might answer. Measured on 2026-08-31: 27 failed synthesize steps,
 * every one of them two 429s against the same model.
 */
const isRetryable = (status: number) => status >= 500;

async function callGemini(
  path: string,
  body: unknown,
  config: GeminiConfig,
  budget: ReturnType<typeof budgetFrom>,
): Promise<Record<string, unknown>> {
  const doFetch = config.fetchImpl ?? fetch;
  const perAttemptMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let lastError: GeminiError | undefined;
  // Two attempts, not a loop with backoff: the worker already retries the whole step up
  // to MAX_ATTEMPTS, and a step that sleeps through a rate limit burns the wall clock
  // the step-machine exists to protect.
  for (let attempt = 1; attempt <= 2; attempt++) {
    const controller = new AbortController();
    // Throws rather than starting an attempt there is no time to finish. A
    // request the invocation cannot outlive still costs money if it reaches the
    // provider, and produces nothing anyone can read.
    const timer = setTimeout(() => controller.abort(), budget.nextTimeout(perAttemptMs));
    try {
      const response = await doFetch(`${API_ROOT}/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.apiKey },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        const error = new GeminiError(
          `Gemini ${path} failed: ${response.status} ${detail.slice(0, 300)}`,
          response.status,
        );
        if (attempt === 1 && isRetryable(response.status)) {
          lastError = error;
          continue;
        }
        throw error;
      }

      return (await response.json()) as Record<string, unknown>;
    } catch (e) {
      // An abort or a socket failure is worth the same single retry as a 503.
      if (attempt === 1 && !(e instanceof GeminiError)) {
        lastError = new GeminiError(e instanceof Error ? e.message : String(e));
        continue;
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError ?? new GeminiError(`Gemini ${path} failed`);
}

function firstTextPart(payload: Record<string, unknown>): string {
  const candidates = payload.candidates as
    { content?: { parts?: { text?: string }[] }; finishReason?: string }[] | undefined;
  const candidate = candidates?.[0];
  const text = candidate?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
  if (!text) {
    // MAX_TOKENS and SAFETY both arrive as a 200 with no usable text. Saying which one
    // turns "the summary step failed" into something actionable.
    throw new GeminiError(`Gemini returned no text (finishReason: ${candidate?.finishReason})`);
  }
  return text;
}

/** Availability problems, as opposed to "this request is wrong". Only these fall over. */
/**
 * Statuses that mean "try the next model", rather than "this request is wrong".
 *
 * 429 belongs here and its absence cost a night's generation. Gemini meters quota
 * **per model**, so an exhausted daily limit on the head of the chain is exactly the
 * condition a fallback exists for — and it was the one condition that did not trigger
 * one. On 2026-08-31 `gemini-3.6-flash` ran out mid-run and the chain never tried
 * `gemini-3.7-flash`: ten queued sources failed at `synthesize` in a row, each burning
 * three attempts against a model that could not answer, while a configured fallback
 * sat unused.
 *
 * Falling through on a quota error costs one call against the next model's own limit.
 * If that is exhausted too the job fails as it would have anyway, so the downside is
 * bounded and the upside is the chain doing the job it was written for.
 */
const isUnavailable = (status: number | undefined) =>
  status === 404 || status === 429 || status === 503;

export function createGeminiSummaryProvider(config: GeminiConfig): SummaryProvider {
  return {
    // Not the first configured model: a fallback makes that a lie, and the run above
    // proved it — the chain led with 3.7, answered on 3.6, and a name pinned to the
    // head would have labelled it wrongly. The model that ran is returned per call.
    name: 'gemini',

    async generateSummary(input: SummaryInput) {
      const body = {
        contents: [{ role: 'user', parts: [{ text: buildSummaryPrompt(input) }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: SUMMARY_SCHEMA,
        },
      };

      let payload: Record<string, unknown> | undefined;
      let model = '';
      let lastError: unknown;

      // One budget for the whole chain, not one per model. Two attempts across
      // two models is 4 × 60s = 240s against a platform that kills the
      // invocation at 150s, so bounding the attempt while leaving the total
      // open made the worst case a function of how many fallbacks were
      // configured — adding one to be safer made the step less likely to finish.
      const budget = budgetFrom(config);

      for (const candidate of config.summaryModels) {
        try {
          payload = await callGemini(`models/${candidate}:generateContent`, body, config, budget);
          model = candidate;
          break;
        } catch (e) {
          // Only move on when the model itself is the problem. A 400 means the request
          // is malformed and the next model would reject it identically — retrying it
          // down the whole chain just multiplies the same failure.
          if (e instanceof GeminiError && isUnavailable(e.status)) {
            lastError = e;
            continue;
          }
          throw e;
        }
      }

      /*
       * The whole chain is out, and none of it was charged for.
       *
       * `ProviderUnavailableError` rather than the raw `GeminiError`, because this is
       * exactly the condition a second vendor can answer: every model returned 404,
       * 429 or 503, so nothing metered and nothing is lost by asking elsewhere. See
       * `createFallbackSummaryProvider`.
       *
       * A budget exhaustion does *not* arrive here — it carries no status, so the loop
       * above rethrows it rather than moving on. That is deliberate: running out of
       * wall clock is not something another vendor fixes, and starting a fresh call
       * inside an invocation the platform kills at 150s would only lose the step later.
       */
      if (!payload) {
        const tried = config.summaryModels.join(', ') || '(none configured)';
        const because = lastError instanceof Error ? `: ${lastError.message}` : '';
        throw new ProviderUnavailableError(
          `No Gemini summary model available (tried ${tried})${because}`,
          'gemini',
        );
      }

      /*
       * Everything below this line has already been paid for.
       *
       * `payload` exists, so the model answered and metered the call. The three ways
       * the answer can still be unusable — no text part, unparseable JSON, no pulls
       * array — were previously plain `GeminiError`s, which the worker's failure path
       * records in `job_steps` and NOT in `cost_ledger`. Each retry then bought
       * another unrecorded charge.
       *
       * The likeliest of the three is not a malformed model: it is `MAX_TOKENS`. A
       * thinking Flash model given up to MAX_SOURCE_CHARS of context can spend its
       * entire output budget on `thoughtsTokenCount` and return HTTP 200 with a full
       * `usageMetadata` and no parts at all — an expensive call, billed for tens of
       * thousands of input tokens, that produces nothing.
       *
       * Law 2 counts every model call, not every successful one.
       */
      const usage = computeUsage(payload.usageMetadata as GeminiUsageMetadata | undefined, config);
      const billed = (message: string) => new BilledProviderError(message, { usage, model });

      let raw: string;
      try {
        raw = firstTextPart(payload);
      } catch (e) {
        throw billed(e instanceof Error ? e.message : String(e));
      }

      let summary: CanonicalSummary;
      try {
        summary = JSON.parse(raw) as CanonicalSummary;
      } catch {
        throw billed(`Gemini returned unparseable JSON: ${raw.slice(0, 200)}`);
      }

      if (!Array.isArray(summary.pulls)) {
        throw billed('Gemini summary has no pulls array');
      }

      return { summary, usage, model };
    },
  };
}

export function createGeminiEmbeddingProvider(config: GeminiConfig): EmbeddingProvider {
  return {
    name: `gemini:${config.embeddingModel}`,

    async embed(texts: string[]) {
      if (texts.length === 0) {
        return { vectors: [], usage: { inputTokens: 0, outputTokens: 0, costCents: 0 } };
      }

      const payload = await callGemini(
        `models/${config.embeddingModel}:batchEmbedContents`,
        {
          requests: texts.map((text) => ({
            model: `models/${config.embeddingModel}`,
            content: { parts: [{ text }] },
            // Pulls are the corpus being searched, not the query searching it.
            taskType: 'RETRIEVAL_DOCUMENT',
            outputDimensionality: EMBEDDING_DIMENSIONS,
          })),
        },
        config,
        // Embedding has no model chain, but it has the same two retries and the
        // same platform ceiling, so it gets the same bound.
        budgetFrom(config),
      );

      const embeddings = payload.embeddings as { values?: number[] }[] | undefined;
      if (!embeddings || embeddings.length !== texts.length) {
        throw new GeminiError(
          `Gemini returned ${embeddings?.length ?? 0} embeddings for ${texts.length} texts`,
        );
      }

      const vectors = embeddings.map((embedding, i) => {
        const values = embedding.values ?? [];
        if (values.length !== EMBEDDING_DIMENSIONS) {
          throw new GeminiError(
            `Embedding ${i} has ${values.length} dimensions, expected ${EMBEDDING_DIMENSIONS}`,
          );
        }
        return l2Normalise(values);
      });

      const inputTokens = estimateEmbeddingTokens(texts);
      return {
        vectors,
        usage: {
          inputTokens,
          outputTokens: 0,
          costCents: usdToCents((inputTokens / 1_000_000) * config.embeddingUsdPerMTok),
        },
      };
    },
  };
}
