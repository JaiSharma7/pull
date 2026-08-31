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

describe('the model chain under an exhausted quota', () => {
  /**
   * A 429 is what a spent daily quota looks like, and Gemini meters per model — so
   * it is precisely the condition a fallback chain exists to survive. It was also
   * the one status that did not trigger one.
   *
   * On 2026-08-31 the head of the chain ran out mid-run and ten queued sources
   * failed at `synthesize` in a row, each burning its attempts against a model that
   * could not answer, while a configured fallback was never tried. These pin both
   * halves of the fix: fall through on 429, and do not retry it in place.
   */
  function fetchReturning(statusByModel: Record<string, number>, seen: string[]): typeof fetch {
    return ((url: string) => {
      const model = Object.keys(statusByModel).find((m) => String(url).includes(m)) ?? '?';
      seen.push(model);
      const status = statusByModel[model] ?? 500;
      if (status !== 200) {
        return Promise.resolve(
          new Response(JSON.stringify({ error: { code: status } }), { status }),
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        title: 'T',
                        elevatorPitch: 'E',
                        whyItMatters: 'W',
                        pulls: [{ headline: 'h', body: 'b', whyItMatters: 'w' }],
                        topics: ['philosophy'],
                      }),
                    },
                  ],
                },
              },
            ],
            usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
          }),
          { status: 200 },
        ),
      );
    }) as unknown as typeof fetch;
  }

  it('falls through to the next model when the first is out of quota', async () => {
    const seen: string[] = [];
    const provider = createGeminiSummaryProvider(
      configWith({ fetchImpl: fetchReturning({ 'model-a': 429, 'model-b': 200 }, seen) }),
    );

    const result = await provider.generateSummary({
      workTitle: 'W',
      kind: 'essay',
      context: 'text',
    });

    // The model that actually answered is the one recorded, or provenance is fiction.
    expect(result.model).toBe('model-b');
    expect(seen).toContain('model-b');
  });

  it('does not retry a 429 against the same model', async () => {
    // The retry is immediate — there is no backoff — so a spent quota is still spent
    // milliseconds later. All a second call buys is another rejection and less budget
    // for the model that might have answered.
    const seen: string[] = [];
    const provider = createGeminiSummaryProvider(
      configWith({ fetchImpl: fetchReturning({ 'model-a': 429, 'model-b': 200 }, seen) }),
    );

    await provider.generateSummary({ workTitle: 'W', kind: 'essay', context: 'text' });

    expect(seen.filter((m) => m === 'model-a')).toHaveLength(1);
  });
});
