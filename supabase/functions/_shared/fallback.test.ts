import { describe, expect, it, vi } from 'vitest';
import {
  BilledProviderError,
  createFallbackSummaryProvider,
  ProviderUnavailableError,
  stubSummaryProvider,
  worstCaseCentsFor,
  type SummaryProvider,
  type Usage,
} from './providers.ts';
import { computeAnthropicUsage } from './anthropic.ts';

/*
 * The chain exists because Gemini's free tier is metered per model per day. When it
 * ran out on 2026-08-31 every queued source failed at `synthesize` until the window
 * rolled over — a stalled queue with a perfectly healthy pipeline behind it.
 *
 * What is actually being pinned here is not "the fallback works". It is **which
 * failures are safe to recover from**. Recovering from a billed failure would leave a
 * real charge with no row in `cost_ledger`, and law 2 counts every model call rather
 * than every successful one. That is a silent accounting hole, so it is the assertion
 * that matters most in this file.
 */

const USAGE: Usage = { inputTokens: 10, outputTokens: 20, costCents: 3 };

/** A provider that fails exactly once, in exactly one way. */
function failsWith(error: unknown): SummaryProvider {
  return {
    name: 'primary',
    worstCaseCents: 6,
    generateSummary: vi.fn(() => Promise.reject(error)),
  };
}

const input = { workTitle: 'Meditations', kind: 'book', context: 'x' };

describe('worstCaseCentsFor', () => {
  /*
   * The number `reserve_budget` holds before a call, and the reason it is computed
   * rather than pinned: it was 6 — the expected cost of a Gemini summary — while the
   * Anthropic fallback at its own configured ceiling and prices can charge nearly three
   * times that for one accepted source. A day at 194 cents then admitted a call that
   * took the ledger past 200, which is the overshoot the reservation exists to close.
   */
  it('covers the Anthropic fallback at its configured ceiling and prices', () => {
    // 64,000 input tokens at $1.00/MTok is 6.4c; 24,576 output at $5.00/MTok is 12.29c.
    expect(
      worstCaseCentsFor({ inputUsdPerMTok: 1.0, outputUsdPerMTok: 5.0, maxOutputTokens: 24_576 }),
    ).toBe(19);
  });

  it('covers Gemini at its defaults', () => {
    // 64,000 at $0.75/MTok is 4.8c; 24,576 at $3.00/MTok is 7.37c.
    expect(
      worstCaseCentsFor({ inputUsdPerMTok: 0.75, outputUsdPerMTok: 3.0, maxOutputTokens: 24_576 }),
    ).toBe(13);
  });

  // Rounded UP, always: a hold that rounds down is a hold the charge can exceed, which
  // is the whole failure in miniature.
  it('never rounds a fraction of a cent away', () => {
    expect(
      worstCaseCentsFor({ inputUsdPerMTok: 0, outputUsdPerMTok: 0.01, maxOutputTokens: 1_000 }),
    ).toBe(1);
  });

  it('is the more expensive of the two when a chain may use either', () => {
    const chain = createFallbackSummaryProvider(
      { name: 'cheap', worstCaseCents: 6, generateSummary: vi.fn() },
      { name: 'dear', worstCaseCents: 19, generateSummary: vi.fn() },
    );
    expect(chain.worstCaseCents).toBe(19);
  });
});

describe('createFallbackSummaryProvider', () => {
  it('never asks the fallback when the primary answers', async () => {
    const fallback = { name: 'fallback', worstCaseCents: 19, generateSummary: vi.fn() };
    const chain = createFallbackSummaryProvider(stubSummaryProvider, fallback);

    const got = await chain.generateSummary(input);

    expect(got.model).toBe('stub');
    // The expensive one is the fallback. A chain that consults it on the happy path
    // would double the bill for every source and nothing would look wrong.
    expect(fallback.generateSummary).not.toHaveBeenCalled();
  });

  it('falls back when the primary was out of quota', async () => {
    const primary = failsWith(new ProviderUnavailableError('all models 429', 'gemini'));
    const chain = createFallbackSummaryProvider(primary, stubSummaryProvider);

    await expect(chain.generateSummary(input)).resolves.toMatchObject({ model: 'stub' });
  });

  it('rethrows a billed failure instead of paying twice for it', async () => {
    /*
     * The load-bearing one. A `BilledProviderError` means the primary metered a call
     * and returned something unusable — MAX_TOKENS with no parts is the common case.
     * Swallowing it to retry elsewhere would hide a real charge behind an apparent
     * success, and the ledger would under-report spend by exactly the amount nobody
     * went looking for.
     */
    const billed = new BilledProviderError('MAX_TOKENS, no parts', {
      usage: USAGE,
      model: 'gemini-3.6-flash',
    });
    const fallback = { name: 'fallback', worstCaseCents: 19, generateSummary: vi.fn() };
    const chain = createFallbackSummaryProvider(failsWith(billed), fallback);

    await expect(chain.generateSummary(input)).rejects.toThrow(BilledProviderError);
    expect(fallback.generateSummary).not.toHaveBeenCalled();
  });

  it('rethrows an ordinary failure rather than paying a second vendor to rediscover it', async () => {
    // A malformed request, a bug, a socket closing mid-stream: none of them are
    // evidence the primary is out of quota, and none get better for money.
    const fallback = { name: 'fallback', worstCaseCents: 19, generateSummary: vi.fn() };
    const chain = createFallbackSummaryProvider(failsWith(new Error('boom')), fallback);

    await expect(chain.generateSummary(input)).rejects.toThrow('boom');
    expect(fallback.generateSummary).not.toHaveBeenCalled();
  });

  it('names both ends, so job_steps records which chain ran', async () => {
    expect(createFallbackSummaryProvider(stubSummaryProvider, stubSummaryProvider).name).toBe(
      'stub->stub',
    );
  });
});

describe('computeAnthropicUsage', () => {
  const prices = { inputUsdPerMTok: 1.0, outputUsdPerMTok: 5.0 };

  it('prices input and output separately', () => {
    // 1M in at $1 plus 200k out at $5 = $2.00 = 200 cents.
    expect(
      computeAnthropicUsage({ input_tokens: 1_000_000, output_tokens: 200_000 }, prices),
    ).toEqual({ inputTokens: 1_000_000, outputTokens: 200_000, costCents: 200 });
  });

  it('treats a missing usage block as zero rather than NaN', () => {
    // A NaN cost propagates through `sum(cost_cents)` and makes the whole ledger NaN —
    // one unreported call would take the budget check down with it.
    expect(computeAnthropicUsage(undefined, prices)).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      costCents: 0,
    });
  });

  it('rounds to the nearest cent, as the Gemini path does', () => {
    // Two providers rounding differently would make a summed ledger quietly wrong.
    expect(computeAnthropicUsage({ input_tokens: 6000, output_tokens: 0 }, prices).costCents).toBe(
      1,
    );
    expect(computeAnthropicUsage({ input_tokens: 4000, output_tokens: 0 }, prices).costCents).toBe(
      0,
    );
  });
});
