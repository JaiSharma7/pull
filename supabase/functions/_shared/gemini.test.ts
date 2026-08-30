import { describe, expect, it } from 'vitest';
import { createGeminiSummaryProvider, type GeminiConfig } from './gemini.ts';

/**
 * The provider's wall clock.
 *
 * `timeoutMs` bounds one HTTP attempt, which is not the same as bounding a
 * step. `callGemini` retries once, and `generateSummary` wraps that in a loop
 * over the model chain, so two models at two attempts of 60s is 240s — against
 * a platform that kills the invocation at 150s. The worst case was a function of
 * how many fallback models happened to be configured, which meant adding one to
 * make the pipeline more robust made the step less able to finish at all.
 *
 * These drive the real module through an injected `fetch`, so what is asserted
 * is the behaviour of the shipped code path rather than a re-implementation of
 * the arithmetic.
 */

function configWith(overrides: Partial<GeminiConfig>): GeminiConfig {
  return {
    apiKey: 'test-key',
    summaryModels: ['model-a', 'model-b'],
    embeddingModel: 'embed-1',
    inputUsdPerMTok: 1,
    outputUsdPerMTok: 1,
    embeddingUsdPerMTok: 1,
    ...overrides,
  };
}

/** A fetch that never resolves, so only the abort signal ends the attempt. */
function hangingFetch(onCall: () => void): typeof fetch {
  return ((_url: string, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      onCall();
      init?.signal?.addEventListener('abort', () =>
        reject(new DOMException('The operation was aborted.', 'AbortError')),
      );
    })) as unknown as typeof fetch;
}

describe('the provider budget', () => {
  it('stops the model chain once the budget is spent, rather than trying every model twice', async () => {
    let calls = 0;
    const provider = createGeminiSummaryProvider(
      configWith({
        // One attempt fits; the budget is gone before a second can start.
        timeoutMs: 30,
        budgetMs: 45,
        fetchImpl: hangingFetch(() => {
          calls++;
        }),
      }),
    );

    const started = Date.now();
    await expect(
      provider.generateSummary({ workTitle: 'W', kind: 'essay', context: 'text' }),
    ).rejects.toThrow();
    const elapsed = Date.now() - started;

    // Unbounded, this is 2 models × 2 attempts = 4 calls and ~120ms. The budget
    // has to cut it short well before the chain is exhausted.
    expect(calls).toBeLessThan(4);
    expect(elapsed).toBeLessThan(200);
  });

  it('names the budget in the error, so job_steps.error says what happened', async () => {
    const provider = createGeminiSummaryProvider(
      configWith({
        timeoutMs: 10,
        // Already spent: the very first attempt has nothing to run in.
        budgetMs: 0,
        fetchImpl: hangingFetch(() => {}),
      }),
    );

    await expect(
      provider.generateSummary({ workTitle: 'W', kind: 'essay', context: 'text' }),
    ).rejects.toThrow(/budget exhausted/i);
  });

  it('does not start a request it has no time to finish', async () => {
    let calls = 0;
    const provider = createGeminiSummaryProvider(
      configWith({
        timeoutMs: 10,
        budgetMs: 0,
        fetchImpl: hangingFetch(() => {
          calls++;
        }),
      }),
    );

    await expect(
      provider.generateSummary({ workTitle: 'W', kind: 'essay', context: 'text' }),
    ).rejects.toThrow();

    // A request the invocation cannot outlive still costs money if it reaches
    // the provider, and produces nothing anyone can read.
    expect(calls).toBe(0);
  });
});
