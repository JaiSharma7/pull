import { describe, expect, it } from 'vitest';
import { asCanonicalSummary, createBamlSummaryProvider, TOKEN_HEADER, usageFrom } from './baml.ts';
import { BilledProviderError, ProviderUnavailableError } from './providers.ts';

/**
 * The classification, one case per row of the table in baml.ts.
 *
 * `fetchImpl` is a fake so the sidecar is never run; what is under test is the
 * decision the worker makes from each answer, which is what decides whether a
 * charge reaches `cost_ledger` and whether a second vendor is paid.
 */

const PRICES = { inputUsdPerMTok: 1, outputUsdPerMTok: 10 };
const input = { workTitle: 'Meditations', kind: 'book', context: 'x' };
const GOOD = {
  result: {
    title: 'Meditations',
    elevatorPitch: 'e',
    whyItMatters: 'w',
    pulls: [{ headline: 'h', body: 'b', whyItMatters: 'w' }],
    topics: ['stoicism'],
  },
  usage: { inputTokens: 1_000_000, outputTokens: 100_000 },
  model: 'gemini-3.6-flash',
  client: 'GeminiFlash',
};

function answering(status: number, body: unknown, capture?: { req?: Request }) {
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    if (capture) capture.req = new Request(url, init);
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return createBamlSummaryProvider({
    url: 'http://sidecar:2024/',
    token: 'tok',
    ...PRICES,
    fetchImpl,
  });
}

describe('createBamlSummaryProvider', () => {
  it('posts the function call with the token and returns the priced usage', async () => {
    const capture: { req?: Request } = {};
    const got = await answering(200, GOOD, capture).generateSummary(input);

    expect(capture.req?.url).toBe('http://sidecar:2024/call/WriteCanonicalSummary');
    expect(capture.req?.headers.get(TOKEN_HEADER)).toBe('tok');
    expect(got.model).toBe('gemini-3.6-flash');
    // 1M input at $1/MTok + 100k output at $10/MTok = $2.00 = 200 cents.
    expect(got.usage).toEqual({ inputTokens: 1_000_000, outputTokens: 100_000, costCents: 200 });
    // Topics arrive as slugs; the sidecar did the enum crossing.
    expect(got.summary.topics).toEqual(['stoicism']);
  });

  it('raises a billed error for a billed failure, carrying the usage', async () => {
    // The load-bearing one: this is what keeps a retry from paying twice unrecorded.
    const p = answering(502, {
      error: 'assert failed',
      billed: true,
      usage: { inputTokens: 500, outputTokens: 0 },
      model: 'gemini-3.6-flash',
    });
    const err = await p.generateSummary(input).catch((e) => e);
    expect(err).toBeInstanceOf(BilledProviderError);
    expect(err.usage.inputTokens).toBe(500);
    expect(err.model).toBe('gemini-3.6-flash');
  });

  it('treats an unbilled failure as unavailable, so the chain may ask elsewhere', async () => {
    const p = answering(502, { error: '429 from vendor', billed: false, usage: {} });
    await expect(p.generateSummary(input)).rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  it('treats a refused connection as unavailable', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('connection refused');
    }) as typeof fetch;
    const p = createBamlSummaryProvider({ url: 'http://x', token: 'tok', ...PRICES, fetchImpl });
    await expect(p.generateSummary(input)).rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  it('treats a wrong token as a local bug, not as the vendor being down', async () => {
    // Falling back here would spend on a second vendor because of a config typo.
    const err = await answering(401, { error: 'missing or wrong token' })
      .generateSummary(input)
      .catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ProviderUnavailableError);
    expect(err).not.toBeInstanceOf(BilledProviderError);
  });

  it('reports a 200 of the wrong shape as billed', async () => {
    const p = answering(200, {
      result: { title: 't' },
      usage: { inputTokens: 9, outputTokens: 1 },
    });
    const err = await p.generateSummary(input).catch((e) => e);
    expect(err).toBeInstanceOf(BilledProviderError);
    expect(err.usage.inputTokens).toBe(9);
  });

  it('does not claim to know the cost of a timeout', async () => {
    const fetchImpl = (async () => {
      const e = new Error('timed out');
      e.name = 'TimeoutError';
      throw e;
    }) as typeof fetch;
    const p = createBamlSummaryProvider({ url: 'http://x', token: 'tok', ...PRICES, fetchImpl });
    const err = await p.generateSummary(input).catch((e) => e);
    expect(err).not.toBeInstanceOf(ProviderUnavailableError);
    expect(err).not.toBeInstanceOf(BilledProviderError);
    expect(String(err.message)).toMatch(/usage unknown/);
  });
});

describe('usageFrom', () => {
  it('prices missing usage as zero rather than NaN', () => {
    expect(usageFrom(undefined, PRICES)).toEqual({ inputTokens: 0, outputTokens: 0, costCents: 0 });
  });
});

describe('asCanonicalSummary', () => {
  it('refuses a pull with no body', () => {
    expect(asCanonicalSummary({ title: 't', pulls: [{ headline: 'h' }] })).toBeNull();
  });
});
