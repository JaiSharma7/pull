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
}

/** The dimensionality `pulls.embedding` is declared with, and its HNSW index built for. */
export const EMBEDDING_DIMENSIONS = 1536;

const DEFAULT_TIMEOUT_MS = 60_000;

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

/** The shape the summary model must return. Enforced by the API, not by parsing hope. */
const SUMMARY_SCHEMA = {
  type: 'OBJECT',
  properties: {
    title: { type: 'STRING' },
    elevatorPitch: { type: 'STRING' },
    whyItMatters: { type: 'STRING' },
    pulls: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          headline: { type: 'STRING' },
          body: { type: 'STRING' },
          whyItMatters: { type: 'STRING' },
        },
        required: ['headline', 'body', 'whyItMatters'],
      },
    },
  },
  required: ['title', 'elevatorPitch', 'whyItMatters', 'pulls'],
} as const;

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

/** 429 and 5xx are worth one more try; a 400 means the request itself is wrong. */
const isRetryable = (status: number) => status === 429 || status >= 500;

async function callGemini(
  path: string,
  body: unknown,
  config: GeminiConfig,
): Promise<Record<string, unknown>> {
  const doFetch = config.fetchImpl ?? fetch;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let lastError: GeminiError | undefined;
  // Two attempts, not a loop with backoff: the worker already retries the whole step up
  // to MAX_ATTEMPTS, and a step that sleeps through a rate limit burns the wall clock
  // the step-machine exists to protect.
  for (let attempt = 1; attempt <= 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
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
const isUnavailable = (status: number | undefined) => status === 404 || status === 503;

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

      for (const candidate of config.summaryModels) {
        try {
          payload = await callGemini(`models/${candidate}:generateContent`, body, config);
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

      if (!payload) {
        throw lastError instanceof Error
          ? lastError
          : new GeminiError(
              `No summary model available (tried ${config.summaryModels.join(', ')})`,
            );
      }

      const raw = firstTextPart(payload);
      let summary: CanonicalSummary;
      try {
        summary = JSON.parse(raw) as CanonicalSummary;
      } catch {
        throw new GeminiError(`Gemini returned unparseable JSON: ${raw.slice(0, 200)}`);
      }

      if (!Array.isArray(summary.pulls)) {
        throw new GeminiError('Gemini summary has no pulls array');
      }

      return {
        summary,
        usage: computeUsage(payload.usageMetadata as GeminiUsageMetadata | undefined, config),
        model,
      };
    },
  };
}

/**
 * The prompt is analysis, not reproduction (law 4). It asks for claims, arguments and
 * consequences the reader can act on — never a condensed retelling that could stand in
 * for the original. See docs/content-policy.md.
 */
function buildSummaryPrompt(input: SummaryInput): string {
  return [
    `You are writing for What a Pull, a knowledge feed whose unit is one idea worth keeping.`,
    ``,
    `Source: ${input.workTitle}`,
    `Medium: ${input.kind}`,
    ``,
    `Write an original analysis of the ideas in this work: its claims, the arguments`,
    `behind them, and what follows from them. Do not retell the work section by section,`,
    `and do not produce anything that could substitute for reading it. Quote only where a`,
    `phrase itself is the point, and keep quotations short.`,
    ``,
    `Each pull must be one atomic idea that stands on its own out of context, in plain`,
    `language, with a headline that states the idea rather than teasing it. "whyItMatters"`,
    `should say what changes if the reader believes it — not restate the body.`,
    ``,
    `Context:`,
    input.context || '(no additional context supplied)',
  ].join('\n');
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
