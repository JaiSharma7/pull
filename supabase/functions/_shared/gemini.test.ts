import { describe, expect, it } from 'vitest';
import { createGeminiSummaryProvider, type GeminiConfig } from './gemini.ts';
import { worstCaseCentsFor } from './providers.ts';

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
    maxOutputTokens: 24_576,
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

  it('sends the output ceiling the reservation is computed from', async () => {
    /*
     * The one behavioural half of the worst-case reservation, and it was unasserted:
     * `worstCaseCentsFor` derives a hold from `config.maxOutputTokens`, and a hold is a
     * ceiling only if the request carries the same number. Nothing compared them, so a
     * dropped field would have left the bill unbounded with every test still green.
     */
    const bodies: string[] = [];
    const provider = createGeminiSummaryProvider(
      configWith({
        maxOutputTokens: 4_096,
        fetchImpl: ((url: string, init?: RequestInit) => {
          bodies.push(String(init?.body ?? ''));
          return fetchReturning({ 'model-a': 200 }, [])(url, init);
        }) as unknown as typeof fetch,
      }),
    );

    await provider.generateSummary({ workTitle: 'W', kind: 'essay', context: 'text' });

    expect(bodies).toHaveLength(1);
    expect(JSON.parse(bodies[0] ?? '{}').generationConfig.maxOutputTokens).toBe(4_096);
  });

  it('prices a call from its own prompt, not from a constant', async () => {
    /*
     * Two things at once, because they are the same claim. The hold rises with the
     * input — a byte is the most a token can be worth, so a longer prompt can only
     * cost more — and it rises with the configured output ceiling. A per-provider
     * constant could do neither, which is why a 200,000-character source and a
     * two-line one used to reserve the same six cents.
     */
    const provider = createGeminiSummaryProvider(
      configWith({ inputUsdPerMTok: 1_000, outputUsdPerMTok: 1_000, maxOutputTokens: 1_000 }),
    );

    const short = provider.worstCaseCentsFor({ workTitle: 'W', kind: 'essay', context: 'a' });
    const long = provider.worstCaseCentsFor({
      workTitle: 'W',
      kind: 'essay',
      context: 'a'.repeat(50_000),
    });

    expect(long).toBeGreaterThan(short);
    // 50,000 ASCII bytes at $1,000/MTok is 5,000 cents of input on its own.
    expect(long - short).toBeGreaterThanOrEqual(5_000);

    // And a non-Latin script is not charged as though it were ASCII: the same
    // character count in three-byte code points bounds to three times the tokens,
    // which is the assumption the old 4-chars-to-a-token constant got wrong.
    const dense = provider.worstCaseCentsFor({
      workTitle: 'W',
      kind: 'essay',
      context: '\u6f22'.repeat(50_000),
    });
    expect(dense - short).toBeGreaterThanOrEqual(3 * (long - short) - 1);
  });

  it('refuses to be built at all on a price an operator mistyped', () => {
    /*
     * At construction, and this is the whole point of moving it there. The check used to
     * live in `worstCaseCentsFor`, which `synthesize` calls to size its hold -- and the
     * plain `Error` it threw is not a `BudgetExhaustedError`, so it went past the catch
     * that returns the source claim. One mistyped variable then failed every job in the
     * deployment, three attempts each, leaving a claim behind every time.
     */
    expect(() => createGeminiSummaryProvider(configWith({ outputUsdPerMTok: -1 }))).toThrow(
      /gemini: outputUsdPerMTok/,
    );
    expect(() => createGeminiSummaryProvider(configWith({ maxOutputTokens: 0 }))).toThrow(
      /gemini: maxOutputTokens/,
    );
    // But zero is a real price, not a mistake: free costs nothing and holds nothing.
    expect(() => createGeminiSummaryProvider(configWith({ inputUsdPerMTok: 0 }))).not.toThrow();
  });

  it('prices the response schema it sends, not only the prompt', () => {
    // `responseSchema` goes with every request and the API bills it as input. Omitting
    // it made the number the daily cap treats as a ceiling into one that is merely close.
    const dear = createGeminiSummaryProvider(
      configWith({ inputUsdPerMTok: 100_000, outputUsdPerMTok: 0.000001, maxOutputTokens: 1 }),
    );
    const input = { workTitle: 'W', kind: 'essay', context: 'x' };
    // The bare prompt alone; the provider's figure has to exceed it by the schema.
    expect(dear.worstCaseCentsFor(input)).toBeGreaterThan(
      worstCaseCentsFor(
        { inputUsdPerMTok: 100_000, outputUsdPerMTok: 0.000001, maxOutputTokens: 1 },
        input,
      ),
    );
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
