/**
 * Structured generation for the study stages, one record per provider attempt.
 *
 * `SummaryProvider` returns one usage for one summary, which is the right shape for a
 * step that the ledger records once. The study stages are held to a stricter account
 * (docs/eval/study-quality.md): EVERY HTTP attempt -- the 503 retried on the same model,
 * the 429 that moved the chain to the next one, the request aborted at its timeout --
 * gets its own ledger row, keyed to the journal row the transport wrote before sending
 * it. So `generate` never throws for a provider failure; it returns the outcome AND the
 * attempts, and the step records the attempts before it decides anything else.
 *
 * The retry policy is the summary provider's for answers of known cost -- two attempts
 * per model on a 5xx, the next model on 404/429/503, stop on anything else, all inside
 * one wall-clock budget -- and stricter for the rest: after an attempt that was sent and
 * may have been billed without saying so, it stops, so one hold never covers two.
 *
 * Law 2: called only by the worker's study steps, at generation time.
 */

import {
  API_ROOT,
  computeUsage,
  DEFAULT_BUDGET_MS,
  DEFAULT_TIMEOUT_MS,
  isRetryable,
  isUnavailable,
  type GeminiConfig,
} from './gemini.ts';
import { PROMPTS, toGeminiSchema, type GeminiSchema } from './prompts.ts';
import { assertPricing, worstCaseCentsForPrompt } from './providers.ts';
import {
  JournalledRequestError,
  JournalUnavailableError,
  type ProviderName,
  type ProviderTransport,
} from './provider-journal.ts';
import { renderStudyPrompt, type StudyPromptName } from './study.ts';

export interface ProviderCallRecord {
  providerCallId: string;
  provider: ProviderName;
  model: string;
  httpStatus: number | null;
  outcome: 'responded' | 'network_error' | 'aborted';
  inputTokens: number;
  outputTokens: number;
  costCents: number;
  /**
   * False when the provider may have charged without saying what: a request that was
   * sent and then aborted or dropped, or a 200 whose body could not be read. The step
   * charges it at the ceiling its hold was sized to, and the row says the figure is a
   * ceiling rather than a measurement.
   */
  usageKnown: boolean;
}

export type StructuredOutcome =
  | { ok: true; value: unknown; model: string; calls: ProviderCallRecord[] }
  | {
      ok: false;
      error: string;
      /** Every configured model said it could not answer, and none charged for it. */
      unavailable: boolean;
      model: string | null;
      calls: ProviderCallRecord[];
    };

export interface StructuredProvider {
  readonly name: string;
  /** Provider and models, in the cache key: a different model is a different output. */
  readonly signature: string;
  /** The most one `generate` can charge, in cents, for these arguments. */
  worstCaseCentsFor(name: StudyPromptName, args: Record<string, string>): number;
  generate(
    name: StudyPromptName,
    args: Record<string, string>,
    transport: ProviderTransport,
  ): Promise<StructuredOutcome>;
}

const geminiSchemas = new Map<StudyPromptName, GeminiSchema>();
function geminiSchemaFor(name: StudyPromptName): GeminiSchema {
  let schema = geminiSchemas.get(name);
  if (!schema) {
    schema = toGeminiSchema(PROMPTS[name].schema);
    geminiSchemas.set(name, schema);
  }
  return schema;
}

/** Defensive about every level: a malformed 200 must be recorded, never thrown past. */
function textOf(payload: Record<string, unknown>): { text: string; finishReason?: string } {
  const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
  const candidate = (candidates[0] ?? {}) as { content?: unknown; finishReason?: unknown };
  const parts = (candidate.content as { parts?: unknown } | null | undefined)?.parts;
  const text = Array.isArray(parts)
    ? parts.map((p) => (typeof p?.text === 'string' ? (p.text as string) : '')).join('')
    : '';
  return {
    text,
    finishReason: typeof candidate.finishReason === 'string' ? candidate.finishReason : undefined,
  };
}

/**
 * Replace lone surrogates with U+FFFD, through the whole parsed value.
 *
 * `JSON.parse` accepts a `\\ud800` escape the model wrote and `JSON.stringify` writes it
 * back out, and jsonb refuses it -- which failed the cache insert and, with it, the
 * ledger rows recorded in the same call.
 */
export function wellFormed(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
      '\uFFFD',
    );
  }
  if (Array.isArray(value)) return value.map(wellFormed);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [wellFormed(k) as string, wellFormed(v)]),
    );
  }
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function createGeminiStructuredProvider(config: GeminiConfig): StructuredProvider {
  assertPricing('gemini', config);
  const models = [...config.summaryModels];

  return {
    name: 'gemini',
    signature: `gemini:${models.join(',')}`,

    worstCaseCentsFor(name, args) {
      return worstCaseCentsForPrompt(
        config,
        renderStudyPrompt(name, args),
        JSON.stringify(geminiSchemaFor(name)),
      );
    },

    async generate(name, args, transport) {
      const calls: ProviderCallRecord[] = [];
      const body = JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: renderStudyPrompt(name, args) }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: geminiSchemaFor(name),
          maxOutputTokens: config.maxOutputTokens,
        },
      });
      const perAttemptMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const budgetMs = config.budgetMs ?? DEFAULT_BUDGET_MS;
      const startedAt = Date.now();
      const failed = (
        error: string,
        model: string | null,
        unavailable = false,
      ): StructuredOutcome => ({
        ok: false,
        error,
        unavailable,
        model,
        calls,
      });

      let lastError = '';
      for (const model of models) {
        for (let attempt = 1; attempt <= 2; attempt++) {
          const left = budgetMs - (Date.now() - startedAt);
          if (left <= 0) return failed(`Gemini budget exhausted after ${budgetMs}ms`, model);

          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), Math.min(perAttemptMs, left));
          /*
           * The timer runs until the BODY has been read, not only the headers: a response
           * that stalls mid-body would otherwise wait on no clock at all, until the
           * platform killed the invocation with its hold open and its attempt unledgered.
           * `callGemini` clears in `finally` for the same reason.
           */
          try {
            let response: Response;
            try {
              response = await transport.fetch(`${API_ROOT}/models/${model}:generateContent`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.apiKey },
                body,
                signal: controller.signal,
              });
            } catch (e) {
              if (e instanceof JournalUnavailableError) return failed(e.message, model);
              if (e instanceof JournalledRequestError) {
                calls.push({
                  providerCallId: e.callId,
                  provider: 'gemini',
                  model,
                  httpStatus: null,
                  outcome: e.aborted ? 'aborted' : 'network_error',
                  inputTokens: 0,
                  outputTokens: 0,
                  costCents: 0,
                  usageKnown: false,
                });
                /*
                 * NO RETRY, which is where this parts from `callGemini`. An attempt that
                 * was sent and then dropped may have been billed, and is charged at the
                 * ceiling of the ONE hold this call took; a retry, or the next model,
                 * would be a second possibly-billed attempt under the same hold, and the
                 * day could pass the cap by a ceiling per attempt while it was in flight.
                 * Answers of known cost (a 5xx, a 429) still retry and fall through: they
                 * cost nothing. The step's own retry takes a fresh hold.
                 */
                return failed(`Gemini ${model} request failed: ${e.message}`, model);
              }
              return failed(e instanceof Error ? e.message : String(e), model);
            }

            const callId = transport.callIdOf(response);
            if (!callId)
              return failed('provider transport returned an unjournalled response', model);

            if (!response.ok) {
              const detail = await response.text().catch(() => '');
              calls.push({
                providerCallId: callId,
                provider: 'gemini',
                model,
                httpStatus: response.status,
                outcome: 'responded',
                inputTokens: 0,
                outputTokens: 0,
                costCents: 0,
                usageKnown: true,
              });
              lastError = `Gemini ${model} failed: ${response.status} ${detail.slice(0, 200)}`;
              if (attempt === 1 && isRetryable(response.status)) continue;
              if (isUnavailable(response.status)) break;
              return failed(lastError, model);
            }

            // Past here the provider has answered, and has charged for it.
            let payload: unknown;
            try {
              payload = await response.json();
            } catch {
              payload = undefined;
            }
            if (!isObject(payload)) {
              calls.push({
                providerCallId: callId,
                provider: 'gemini',
                model,
                httpStatus: response.status,
                outcome: 'responded',
                inputTokens: 0,
                outputTokens: 0,
                costCents: 0,
                usageKnown: false,
              });
              return failed(`Gemini ${model} returned an unreadable body`, model);
            }

            const meta = isObject(payload.usageMetadata)
              ? (payload.usageMetadata as Parameters<typeof computeUsage>[0])
              : undefined;
            const usage = computeUsage(meta, config);
            calls.push({
              providerCallId: callId,
              provider: 'gemini',
              model,
              httpStatus: response.status,
              outcome: 'responded',
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              costCents: usage.costCents,
              usageKnown: meta !== undefined,
            });

            const { text, finishReason } = textOf(payload);
            if (!text) {
              return failed(`Gemini returned no text (finishReason: ${finishReason})`, model);
            }
            try {
              return { ok: true, value: wellFormed(JSON.parse(text)), model, calls };
            } catch {
              // No excerpt: this message lands in `job_steps.error`, and model output here is
              // derived from the reader's text, which must not outlive a deleted source.
              return failed(`Gemini returned unparseable JSON (${text.length} characters)`, model);
            }
          } finally {
            clearTimeout(timer);
          }
        }
      }
      return failed(
        `No Gemini model available (tried ${models.join(', ') || '(none configured)'}): ${lastError}`,
        null,
        true,
      );
    },
  };
}

// ------------------------------------------------------------------------- stub

function sentences(text: string): string[] {
  return (text.match(/[^.!?\n]+[.!?]/g) ?? [])
    .map((s) => s.trim())
    .filter((s) => s.length >= 20 && s.length <= 300);
}

function stubClaims(passage: string) {
  const picked = sentences(passage).slice(0, 5);
  return {
    claims: picked.map((sentence, i) => ({
      key: `c${i + 1}`,
      statement: sentence,
      kind: 'finding',
      qualifications: [],
      evidence: [sentence],
      attribution: null,
    })),
    gaps: picked.length > 0 ? ['Whether this holds beyond what the passage describes.'] : [],
  };
}

function stubCourse(digest: string) {
  const claims = [
    ...digest.matchAll(
      /^\[(s\d+c\d+)\] \(Source \d+: [^)]*\) (.+?)(?= Qualifications:| Attributed to:| Evidence:)/gm,
    ),
  ].map((m) => ({ key: m[1] as string, statement: (m[2] as string).trim() }));
  const lessons: { key: string; claims: typeof claims }[] = [];
  for (let i = 0; i < claims.length && lessons.length < 4; i += 3) {
    lessons.push({ key: `l${lessons.length + 1}`, claims: claims.slice(i, i + 3) });
  }
  const questions: unknown[] = [];
  lessons.forEach((lesson) => {
    const first = lesson.claims[0];
    if (!first) return;
    questions.push({
      key: `q${questions.length + 1}`,
      lessonKey: lesson.key,
      purpose: 'placement',
      kind: 'short_recall',
      claimKeys: [first.key],
      prompt: 'In your own words, what does this part of the material establish?',
      answer: first.statement,
      acceptedAnswers: [],
      distractors: [],
      cloze: null,
      sequence: [],
      pairs: [],
      explanation: 'The stub provider restates the first claim of the lesson.',
      difficulty: 2,
    });
    if (lesson.claims.length >= 3) {
      questions.push({
        key: `q${questions.length + 1}`,
        lessonKey: lesson.key,
        purpose: 'practice',
        kind: 'ordering',
        claimKeys: lesson.claims.map((c) => c.key),
        prompt: 'Put these statements in the order the material makes them.',
        answer: 'The material makes them in this order.',
        acceptedAnswers: [],
        distractors: [],
        cloze: null,
        sequence: lesson.claims.map((c) => c.statement),
        pairs: [],
        explanation: 'The stub provider keeps document order.',
        difficulty: 1,
      });
    }
  });
  return {
    title: 'Study course (stub)',
    overview: 'Generated by the stub provider so the pipeline runs without an API key.',
    objectives: ['Recall what the material establishes.'],
    units: lessons.length
      ? [
          {
            title: 'The material',
            lessons: lessons.map((lesson) => ({
              key: lesson.key,
              title: `Part ${lesson.key.slice(1)}`,
              objective: 'Recall these claims.',
              claimKeys: lesson.claims.map((c) => c.key),
              explanation: lesson.claims.map((c) => c.statement).join(' '),
              example: null,
              recap: lesson.claims[0]?.statement ?? 'See the claims above.',
              minutes: 2,
            })),
          },
        ]
      : [],
    questions,
    recap: 'The stub provider made this course from the claims it was given.',
    disagreements: [],
    withheld: [{ prompt: 'Does this hold for everyone?', reason: 'The material does not say.' }],
  };
}

/**
 * Deterministic, free and offline, so a fresh clone runs every study step with no key.
 *
 * Its claims are sentences copied from the passage, so their evidence resolves
 * exactly, and its course cites those claims -- enough to exercise extraction,
 * caching, grounding and persistence end to end. It makes no provider call, so it
 * writes no journal row and no ledger row.
 */
export const stubStructuredProvider: StructuredProvider = {
  name: 'stub',
  signature: 'stub',
  worstCaseCentsFor: () => 0,
  async generate(name, args) {
    const value =
      name === 'ExtractStudyClaims'
        ? stubClaims(args.passage ?? '')
        : stubCourse(args.claims ?? '');
    return { ok: true, value, model: 'stub', calls: [] };
  },
};
