/**
 * Claude implementations of the provider interfaces — the fallback when Gemini's
 * free tier is spent.
 *
 * Gemini meters its free allowance **per model per day**. When it runs out, every
 * queued source fails at `synthesize` until the window rolls over, and the queue
 * stops for reasons that have nothing to do with the pipeline. `gemini.ts` already
 * walks its own model chain; this is the next thing to try when that chain is done.
 *
 * Same shape as `gemini.ts` and for the same reason: no top-level `Deno.env`, so the
 * module is importable and testable outside the Edge runtime. Nothing here runs in
 * the read path (law 2) — the worker calls it once per canonical summary and the
 * result lands in `cost_ledger`.
 */

import { BilledProviderError, buildSummaryPrompt, ProviderUnavailableError } from './providers.ts';
import { PROMPTS } from './prompts.ts';
import type { CanonicalSummary, SummaryInput, SummaryProvider, Usage } from './providers.ts';

const API_URL = 'https://api.anthropic.com/v1/messages';

/** Pinned by the header the API requires; not a date this code cares about otherwise. */
const API_VERSION = '2023-06-01';

/**
 * The cheap model, deliberately.
 *
 * This provider exists to keep the queue moving when the free tier is gone, which is
 * a different job from producing the best possible summary. Every call it makes is
 * real money that the primary would have made for nothing, so the default is the
 * least expensive model that can follow a schema rather than the strongest one.
 */
export const DEFAULT_SUMMARY_MODEL = 'claude-haiku-4-5-20251001';

/**
 * Enough for a long summary and no more.
 *
 * `max_tokens` is required by the API, so there is no "unlimited" to default to. A
 * summary that hits this ceiling comes back `stop_reason: max_tokens` with a partial
 * tool input — billed and unusable, which is precisely what `BilledProviderError`
 * exists to report rather than silently retry.
 */
export const DEFAULT_MAX_TOKENS = 8192;

const DEFAULT_TIMEOUT_MS = 90_000;

/**
 * Published rates, as configuration rather than constants — same reasoning as
 * `gemini.ts`. These are Haiku 4.5's list prices and a starting point for the ledger
 * to be approximately right out of the box, not a quoted price.
 */
export const DEFAULT_INPUT_USD_PER_MTOK = 1.0;
export const DEFAULT_OUTPUT_USD_PER_MTOK = 5.0;

export interface AnthropicConfig {
  apiKey: string;
  summaryModel: string;
  maxTokens: number;
  timeoutMs?: number;
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
}

class AnthropicError extends Error {
  // Assigned in the body rather than as a parameter property, for the reason
  // `GeminiError` documents: parameter properties need a real TypeScript transform,
  // and this module must run anywhere types can merely be stripped.
  status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'AnthropicError';
    this.status = status;
  }
}

/**
 * The schema, as a tool.
 *
 * Anthropic has no `responseSchema`; the supported way to get a guaranteed shape is a
 * single tool with `tool_choice` forcing it, so the model's only legal move is to emit
 * arguments matching `input_schema`. JSON Schema here, not Gemini's uppercase dialect.
 *
 * `enum` on the topic slugs does the same work it does in `gemini.ts` — it makes the
 * usual failure impossible, where a plausible-looking slug passes the model and the
 * client and is refused only by Postgres, after synthesis has been paid for.
 */
function summaryTool() {
  return {
    name: 'emit_summary',
    description: 'Return the canonical summary of the source, and file it under topics.',
    // Plain JSON Schema, as exported from `packages/prompts/baml_src` -- the same
    // source `gemini.ts` converts to its own dialect. The topic enum and the array
    // bounds arrive from the BAML aliases and asserts, so this copy cannot drift.
    input_schema: PROMPTS.WriteCanonicalSummary.schema,
  };
}

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
}

/**
 * Cost in cents from the token counts the API reports.
 *
 * Rounded to the nearest cent at the last step and never below zero. Deliberately
 * mirrors `computeUsage` in `gemini.ts`: `cost_ledger` is summed across providers, so
 * two providers rounding differently would make the total quietly wrong.
 */
export function computeAnthropicUsage(
  raw: AnthropicUsage | undefined,
  config: Pick<AnthropicConfig, 'inputUsdPerMTok' | 'outputUsdPerMTok'>,
): Usage {
  const inputTokens = raw?.input_tokens ?? 0;
  const outputTokens = raw?.output_tokens ?? 0;
  const usd =
    (inputTokens / 1_000_000) * config.inputUsdPerMTok +
    (outputTokens / 1_000_000) * config.outputUsdPerMTok;
  return { inputTokens, outputTokens, costCents: Math.max(0, Math.round(usd * 100)) };
}

/**
 * "This vendor cannot answer", as opposed to "this request is wrong".
 *
 * 429 is rate limit or spent credit; 529 is Anthropic's overloaded status; 5xx is the
 * service. All three mean the request might succeed elsewhere or later, and none of
 * them were charged for. A 400 or a 401 is ours to fix and is not retried anywhere.
 */
const isUnavailable = (status: number | undefined) =>
  status === 429 || status === 529 || (status !== undefined && status >= 500);

async function callAnthropic(
  body: unknown,
  config: AnthropicConfig,
): Promise<Record<string, unknown>> {
  // An Edge invocation is killed at 150s. Without an abort the fetch outlives the
  // function that started it, and the step is recorded as failed for a call that may
  // yet have succeeded and been billed.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': config.apiKey,
        'anthropic-version': API_VERSION,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      // Read the body before throwing: Anthropic puts the actual reason in it, and a
      // bare status turns "your credit balance is too low" into an unexplained 400.
      const detail = await response.text().catch(() => '');
      throw new AnthropicError(
        `Anthropic ${response.status}: ${detail.slice(0, 300)}`,
        response.status,
      );
    }
    return (await response.json()) as Record<string, unknown>;
  } catch (e) {
    // An abort is not a vendor failure, but it is equally not something a different
    // vendor would fix — it means this step ran out of wall clock.
    if (e instanceof AnthropicError) throw e;
    throw new AnthropicError(e instanceof Error ? e.message : String(e));
  } finally {
    clearTimeout(timer);
  }
}

/** The forced tool's arguments, or a description of why there are none. */
function toolInput(payload: Record<string, unknown>): Record<string, unknown> {
  const content = payload.content;
  if (!Array.isArray(content)) throw new Error('Anthropic response had no content array');
  for (const block of content) {
    const b = block as Record<string, unknown>;
    if (b.type === 'tool_use' && b.input && typeof b.input === 'object') {
      return b.input as Record<string, unknown>;
    }
  }
  // The overwhelmingly likely cause, and worth naming: the model spent `max_tokens`
  // before closing the tool call. Billed in full, and useless.
  const stop = String(payload.stop_reason ?? 'unknown');
  throw new Error(`Anthropic returned no tool_use block (stop_reason: ${stop})`);
}

export function createAnthropicSummaryProvider(config: AnthropicConfig): SummaryProvider {
  return {
    name: 'anthropic',

    async generateSummary(input: SummaryInput) {
      const tool = summaryTool();
      const model = config.summaryModel;

      let payload: Record<string, unknown>;
      try {
        payload = await callAnthropic(
          {
            model,
            max_tokens: config.maxTokens,
            tools: [tool],
            // Forced, not suggested. Left to itself the model may answer in prose,
            // and prose is not a shape `JSON.parse` or the pipeline can use.
            tool_choice: { type: 'tool', name: tool.name },
            messages: [{ role: 'user', content: buildSummaryPrompt(input) }],
          },
          config,
        );
      } catch (e) {
        /*
         * Nothing was charged, so it is safe to say so.
         *
         * This is the class `createFallbackSummaryProvider` recovers from, and the
         * reason the distinction is drawn this precisely: a request that never
         * produced a response never metered one. Everything past this point has been
         * paid for and must reach `cost_ledger` instead.
         */
        if (e instanceof AnthropicError && isUnavailable(e.status)) {
          throw new ProviderUnavailableError(e.message, 'anthropic');
        }
        throw e;
      }

      // Below here the model answered and the call is billed, however unusable the
      // answer turns out to be. Law 2 counts every model call, not every good one.
      const usage = computeAnthropicUsage(payload.usage as AnthropicUsage | undefined, config);
      const billed = (message: string) => new BilledProviderError(message, { usage, model });

      let raw: Record<string, unknown>;
      try {
        raw = toolInput(payload);
      } catch (e) {
        throw billed(e instanceof Error ? e.message : String(e));
      }

      const summary = raw as unknown as CanonicalSummary;
      // The same guard `gemini.ts` applies. A forced tool call makes this unlikely
      // rather than impossible, and `synthesize` rejects a summary with no pulls
      // downstream anyway — failing here keeps the charge attached to the reason.
      if (!Array.isArray(summary.pulls)) {
        throw billed('Anthropic summary has no pulls array');
      }

      return { summary, usage, model };
    },
  };
}
