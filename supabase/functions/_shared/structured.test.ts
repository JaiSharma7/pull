import { describe, expect, it } from 'vitest';
import type { GeminiConfig } from './gemini.ts';
import {
  createJournalledTransport,
  isConnectPhase,
  JournalledRequestError,
  JournalUnavailableError,
  type JournalOpen,
  type JournalOutcome,
  type ProviderJournal,
} from './provider-journal.ts';
import { createGeminiStructuredProvider, stubStructuredProvider } from './structured.ts';

/** An in-memory journal that records what the transport told it, in order. */
function memoryJournal(opts: { failOpen?: boolean; failClose?: boolean } = {}) {
  const rows = new Map<
    string,
    JournalOpen & { outcome: JournalOutcome | 'open'; httpStatus: number | null }
  >();
  const journal: ProviderJournal = {
    async open(call) {
      if (opts.failOpen) throw new Error('journal down');
      rows.set(call.id, { ...call, outcome: 'open', httpStatus: null });
    },
    async close(id, outcome, httpStatus) {
      if (opts.failClose) throw new Error('journal down');
      const row = rows.get(id);
      if (row) Object.assign(row, { outcome, httpStatus });
    },
  };
  return { journal, rows };
}

let seq = 0;
const ids = () => `call-${++seq}`;
const scope = { jobId: 'job-1', step: 'study_extract' };

const ok = (
  value: unknown,
  usage = { promptTokenCount: 1000, candidatesTokenCount: 200, thoughtsTokenCount: 100 },
) =>
  new Response(
    JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify(value) }] }, finishReason: 'STOP' }],
      usageMetadata: usage,
    }),
    { status: 200 },
  );
const status = (code: number) => new Response('{"error":"x"}', { status: code });

/** A fake network: each call takes the next scripted answer, and remembers the URL. */
function script(...answers: (Response | Error)[]) {
  const urls: string[] = [];
  const impl = (async (input: RequestInfo | URL) => {
    urls.push(String(input));
    const next = answers.shift();
    if (!next) throw new Error('script exhausted');
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return { impl, urls };
}

const config = (over: Partial<GeminiConfig> = {}): GeminiConfig => ({
  apiKey: 'test-key',
  summaryModels: ['model-a', 'model-b'],
  embeddingModel: 'e',
  inputUsdPerMTok: 0.75,
  outputUsdPerMTok: 3,
  embeddingUsdPerMTok: 0.15,
  maxOutputTokens: 1000,
  ...over,
});

const args = { sourceTitle: 'Notes', passage: 'A passage long enough to be a passage.' };

describe('createJournalledTransport', () => {
  it('journals before sending, closes with the status, and tags the response', async () => {
    const { journal, rows } = memoryJournal();
    const order: string[] = [];
    const inner = (async () => {
      order.push(`sent with ${rows.size} journalled`);
      return status(200);
    }) as typeof fetch;
    const t = createJournalledTransport(journal, scope, inner, ids);
    const res = await t.fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/m:generateContent',
      {},
    );
    expect(order).toEqual(['sent with 1 journalled']);
    const id = t.callIdOf(res) as string;
    expect(rows.get(id)).toMatchObject({
      provider: 'gemini',
      endpoint: 'models/m:generateContent',
      outcome: 'responded',
      httpStatus: 200,
      jobId: 'job-1',
      step: 'study_extract',
    });
  });

  it('sends nothing when the journal cannot record the attempt', async () => {
    const { journal } = memoryJournal({ failOpen: true });
    const net = script(status(200));
    const t = createJournalledTransport(journal, scope, net.impl, ids);
    await expect(
      t.fetch('https://generativelanguage.googleapis.com/v1beta/models/m:generateContent'),
    ).rejects.toBeInstanceOf(JournalUnavailableError);
    expect(net.urls).toEqual([]);
  });

  it('refuses a host that is not a model provider, before journalling', async () => {
    const { journal, rows } = memoryJournal();
    const net = script(status(200));
    const t = createJournalledTransport(journal, scope, net.impl, ids);
    await expect(t.fetch('https://example.com/x')).rejects.toThrow(/not a model provider/);
    await expect(t.fetch('http://generativelanguage.googleapis.com/x')).rejects.toThrow(
      /not a model provider/,
    );
    expect(rows.size).toBe(0);
    expect(net.urls).toEqual([]);
  });

  it('closes a dropped request and hands its id to the caller', async () => {
    const { journal, rows } = memoryJournal();
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const t = createJournalledTransport(journal, scope, script(abort).impl, ids);
    const err = await t
      .fetch('https://generativelanguage.googleapis.com/v1beta/models/m:generateContent')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JournalledRequestError);
    expect(rows.get((err as JournalledRequestError).callId)?.outcome).toBe('aborted');
  });

  it('keeps the response when only the close fails, leaving the row open for the audit', async () => {
    const { journal, rows } = memoryJournal({ failClose: true });
    const t = createJournalledTransport(journal, scope, script(status(200)).impl, ids);
    const res = await t.fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/m:generateContent',
    );
    expect(res.status).toBe(200);
    expect([...rows.values()][0]?.outcome).toBe('open');
  });

  it('refuses to follow a redirect, which would re-send the text and the key elsewhere', async () => {
    const { journal } = memoryJournal();
    const seen: RequestInit[] = [];
    const inner = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(init ?? {});
      return status(200);
    }) as typeof fetch;
    const t = createJournalledTransport(journal, scope, inner, ids);
    await t.fetch('https://generativelanguage.googleapis.com/v1beta/models/m:generateContent', {
      method: 'POST',
      redirect: 'follow',
    });
    expect(seen[0]?.redirect).toBe('manual');
    expect(seen[0]?.method).toBe('POST');
  });

  it('never journals the API key or a query string', async () => {
    const { journal, rows } = memoryJournal();
    const t = createJournalledTransport(journal, scope, script(status(200)).impl, ids);
    await t.fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/m:generateContent?key=secret',
      {
        headers: { 'x-goog-api-key': 'secret' },
      },
    );
    expect(JSON.stringify([...rows.values()])).not.toContain('secret');
  });
});

describe('isConnectPhase', () => {
  it('knows a connection that never opened, from Node and from Deno', () => {
    for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT']) {
      expect(
        isConnectPhase(Object.assign(new TypeError('fetch failed'), { cause: { code } })),
      ).toBe(true);
    }
    const deno = new TypeError(
      'error sending request for url (https://generativelanguage.googleapis.com/): ' +
        'client error (Connect): tcp connect error: Connection refused (os error 111)',
    );
    expect(isConnectPhase(deno)).toBe(true);
  });

  it('treats everything else as possibly sent: a reset, an abort, an unknown shape', () => {
    const reset = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    expect(isConnectPhase(reset)).toBe(false);
    expect(isConnectPhase(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe(false);
    expect(isConnectPhase(new Error('socket hang up'))).toBe(false);
    expect(isConnectPhase('ECONNREFUSED')).toBe(false);
    expect(isConnectPhase(null)).toBe(false);
  });
});

describe('createGeminiStructuredProvider', () => {
  async function run(net: ReturnType<typeof script>, over: Partial<GeminiConfig> = {}) {
    const { journal, rows } = memoryJournal();
    const provider = createGeminiStructuredProvider(config(over));
    const transport = createJournalledTransport(journal, scope, net.impl, ids);
    const outcome = await provider.generate('ExtractStudyClaims', args, transport);
    return { outcome, rows };
  }

  /** The inventory property: every journalled attempt has exactly one record, and no more. */
  function reconciles(
    outcome: { calls: { providerCallId: string }[] },
    rows: Map<string, unknown>,
  ) {
    expect(outcome.calls.map((c) => c.providerCallId).sort()).toEqual([...rows.keys()].sort());
  }

  it('returns the parsed value and one priced record for a clean call', async () => {
    const { outcome, rows } = await run(script(ok({ claims: [], gaps: [] })));
    expect(outcome.ok).toBe(true);
    expect(outcome.calls).toHaveLength(1);
    expect(outcome.calls[0]).toMatchObject({
      model: 'model-a',
      httpStatus: 200,
      inputTokens: 1000,
      outputTokens: 300,
      usageKnown: true,
    });
    // 1000 × 0.75 + 300 × 3.00 per million tokens, in cents.
    expect(outcome.calls[0]?.costCents).toBeCloseTo(0.165, 6);
    reconciles(outcome, rows);
  });

  it('records the 503 it retried as well as the answer', async () => {
    const { outcome, rows } = await run(script(status(503), ok({ claims: [], gaps: [] })));
    expect(outcome.ok).toBe(true);
    expect(outcome.calls.map((c) => [c.model, c.httpStatus, c.costCents > 0])).toEqual([
      ['model-a', 503, false],
      ['model-a', 200, true],
    ]);
    reconciles(outcome, rows);
  });

  it('moves down the chain on a 429 and records both models', async () => {
    const net = script(status(429), ok({ claims: [], gaps: [] }));
    const { outcome, rows } = await run(net);
    expect(outcome.ok && outcome.model).toBe('model-b');
    expect(net.urls.map((u) => u.split('/models/')[1])).toEqual([
      'model-a:generateContent',
      'model-b:generateContent',
    ]);
    reconciles(outcome, rows);
  });

  it('stops on a 400 rather than paying the next model to rediscover it', async () => {
    const net = script(status(400), ok({}));
    const { outcome, rows } = await run(net);
    expect(outcome.ok).toBe(false);
    expect(net.urls).toHaveLength(1);
    reconciles(outcome, rows);
  });

  it('stops after a dropped connection: one possibly-billed attempt per hold, never two', async () => {
    const net = script(new Error('socket hang up'), ok({ claims: [], gaps: [] }));
    const { outcome, rows } = await run(net);
    expect(outcome.ok).toBe(false);
    expect(net.urls).toHaveLength(1);
    expect(outcome.calls.map((c) => [c.outcome, c.usageKnown, c.costCents])).toEqual([
      ['network_error', false, 0],
    ]);
    reconciles(outcome, rows);
  });

  it('retries a connection that never opened once, as known and free', async () => {
    const refused = () =>
      Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    const net = script(refused(), ok({ claims: [], gaps: [] }));
    const { outcome, rows } = await run(net);
    expect(outcome.ok).toBe(true);
    expect(net.urls).toHaveLength(2);
    expect(outcome.calls.map((c) => [c.outcome, c.usageKnown, c.costCents > 0])).toEqual([
      ['network_error', true, false],
      ['responded', true, true],
    ]);
    reconciles(outcome, rows);

    const twice = script(refused(), refused(), ok({ claims: [], gaps: [] }));
    const again = await run(twice);
    expect(again.outcome.ok).toBe(false);
    expect(twice.urls).toHaveLength(2);
    expect(again.outcome.calls.every((c) => c.usageKnown && c.costCents === 0)).toBe(true);
  });

  it('does not move to the next model after an abort either', async () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const net = script(abort, ok({ claims: [], gaps: [] }));
    const { outcome } = await run(net);
    expect(outcome.ok).toBe(false);
    expect(net.urls).toHaveLength(1);
    expect(outcome.calls[0]).toMatchObject({ outcome: 'aborted', usageKnown: false });
  });

  it('still retries and falls through on answers of known cost', async () => {
    const net = script(status(503), status(503), status(429), ok({ claims: [], gaps: [] }));
    const { outcome } = await run(net, { summaryModels: ['a', 'b', 'c'] });
    expect(outcome.ok).toBe(true);
    expect(net.urls).toHaveLength(4);
  });

  it('reports unavailable, with every attempt, when the whole chain is out', async () => {
    const { outcome, rows } = await run(script(status(503), status(503), status(429)));
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.unavailable).toBe(true);
    expect(outcome.calls).toHaveLength(3);
    reconciles(outcome, rows);
  });

  it('keeps the charge for an answer with no text, and for one that is not JSON', async () => {
    const empty = new Response(
      JSON.stringify({
        candidates: [{ finishReason: 'MAX_TOKENS' }],
        usageMetadata: { promptTokenCount: 5000, thoughtsTokenCount: 1000 },
      }),
      { status: 200 },
    );
    const a = await run(script(empty));
    expect(a.outcome.ok).toBe(false);
    expect(a.outcome.calls[0]?.costCents).toBeGreaterThan(0);
    reconciles(a.outcome, a.rows);

    const garbled = new Response(
      JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'not json' }] } }],
        usageMetadata: { promptTokenCount: 10 },
      }),
      { status: 200 },
    );
    const b = await run(script(garbled));
    expect(b.outcome.ok).toBe(false);
    expect(b.outcome.calls[0]?.inputTokens).toBe(10);
  });

  it.each([
    ['a null body', 'null'],
    [
      'parts that are not an array',
      JSON.stringify({
        candidates: [{ content: { parts: 'x' } }],
        usageMetadata: { promptTokenCount: 3 },
      }),
    ],
    ['candidates that are not an array', JSON.stringify({ candidates: 7 })],
  ])('records rather than throws on a malformed 200: %s', async (_label, raw) => {
    const { outcome, rows } = await run(script(new Response(raw, { status: 200 })));
    expect(outcome.ok).toBe(false);
    expect(outcome.calls).toHaveLength(1);
    reconciles(outcome, rows);
  });

  it('keeps the attempt on the clock while the body is still arriving', async () => {
    // Headers now, body never: the timer must still abort the read.
    const stalled = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal as AbortSignal;
      const body = new ReadableStream({
        start(controller) {
          signal.addEventListener('abort', () =>
            controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          );
        },
      });
      return new Response(body, { status: 200 });
    }) as typeof fetch;
    const { journal } = memoryJournal();
    const provider = createGeminiStructuredProvider(config({ timeoutMs: 50, budgetMs: 200 }));
    const started = Date.now();
    const outcome = await provider.generate(
      'ExtractStudyClaims',
      args,
      createJournalledTransport(journal, scope, stalled, ids),
    );
    expect(Date.now() - started).toBeLessThan(2000);
    expect(outcome.ok).toBe(false);
    expect(outcome.calls[0]).toMatchObject({ httpStatus: 200, usageKnown: false });
  });

  it('replaces a lone surrogate the model wrote, which jsonb would refuse', async () => {
    const raw = JSON.stringify({
      candidates: [
        { content: { parts: [{ text: '{"claims":[],"gaps":["bad \\ud800 escape"]}' }] } },
      ],
      usageMetadata: { promptTokenCount: 1 },
    });
    const { outcome } = await run(script(new Response(raw, { status: 200 })));
    expect(outcome.ok).toBe(true);
    const gaps = (outcome.ok ? (outcome.value as { gaps: string[] }).gaps : []) ?? [];
    expect(gaps[0]).toBe('bad \uFFFD escape');
  });

  it('replaces a NUL the model wrote, which jsonb text would refuse too', async () => {
    const raw = JSON.stringify({
      candidates: [{ content: { parts: [{ text: '{"claims":[],"gaps":["a\\u0000b"]}' }] } }],
      usageMetadata: { promptTokenCount: 1 },
    });
    const { outcome } = await run(script(new Response(raw, { status: 200 })));
    expect(outcome.ok).toBe(true);
    const gaps = (outcome.ok ? (outcome.value as { gaps: string[] }).gaps : []) ?? [];
    expect(gaps[0]).toBe('a\uFFFDb');
  });

  it('records a redirect as an answer of known cost, and does not follow it', async () => {
    const seen: RequestInit[] = [];
    const impl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(init ?? {});
      return new Response('', { status: 307, headers: { location: 'https://example.com/' } });
    }) as typeof fetch;
    const { journal, rows } = memoryJournal();
    const outcome = await createGeminiStructuredProvider(config()).generate(
      'ExtractStudyClaims',
      args,
      createJournalledTransport(journal, scope, impl, ids),
    );
    expect(seen[0]?.redirect).toBe('manual');
    expect(outcome.ok).toBe(false);
    expect(outcome.calls).toEqual([
      expect.objectContaining({ httpStatus: 307, usageKnown: true, costCents: 0 }),
    ]);
    expect([...rows.values()][0]?.outcome).toBe('responded');
  });

  it('records a 200 whose body cannot be read as usage unknown', async () => {
    const { outcome } = await run(script(new Response('{truncated', { status: 200 })));
    expect(outcome.ok).toBe(false);
    expect(outcome.calls[0]).toMatchObject({ httpStatus: 200, usageKnown: false, costCents: 0 });
  });

  it('refuses to start an attempt once the budget is spent, and says so', async () => {
    const { outcome } = await run(script(status(503)), { budgetMs: 0 });
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.error).toMatch(/budget exhausted/);
    expect(outcome.calls).toEqual([]);
  });

  it('fails without sending when the journal is down, keeping earlier attempts', async () => {
    let opens = 0;
    const journal: ProviderJournal = {
      async open() {
        opens += 1;
        if (opens > 1) throw new Error('journal down');
      },
      async close() {},
    };
    const net = script(status(503), ok({}));
    const provider = createGeminiStructuredProvider(config());
    const outcome = await provider.generate(
      'ExtractStudyClaims',
      args,
      createJournalledTransport(journal, scope, net.impl, ids),
    );
    expect(outcome.ok).toBe(false);
    expect(net.urls).toHaveLength(1);
    expect(outcome.calls).toHaveLength(1);
  });

  it('sends the exported schema and the rendered prompt, with the key in a header only', async () => {
    const seen: RequestInit[] = [];
    const impl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(init ?? {});
      return ok({ claims: [], gaps: [] });
    }) as typeof fetch;
    const { journal } = memoryJournal();
    await createGeminiStructuredProvider(config()).generate(
      'ExtractStudyClaims',
      args,
      createJournalledTransport(journal, scope, impl, ids),
    );
    const body = JSON.parse(String(seen[0]?.body));
    expect(body.contents[0].parts[0].text).toContain(args.passage);
    expect(body.generationConfig.responseSchema.properties.claims.maxItems).toBe(25);
    expect(body.generationConfig.maxOutputTokens).toBe(1000);
    expect(String(seen[0]?.body)).not.toContain('test-key');
  });

  it('prices its ceiling over the rendered prompt and the schema', () => {
    const provider = createGeminiStructuredProvider(
      config({ maxOutputTokens: 1_000_000, outputUsdPerMTok: 3 }),
    );
    expect(provider.worstCaseCentsFor('ExtractStudyClaims', args)).toBeGreaterThanOrEqual(300);
    const longer = provider.worstCaseCentsFor('ExtractStudyClaims', {
      ...args,
      passage: 'x'.repeat(2_000_000),
    });
    expect(longer).toBeGreaterThan(provider.worstCaseCentsFor('ExtractStudyClaims', args));
  });
});

describe('stubStructuredProvider', () => {
  it('extracts sentences it can quote exactly, and calls nothing', async () => {
    const passage =
      'The first claim is stated here plainly. And a second claim follows it closely.';
    const outcome = await stubStructuredProvider.generate(
      'ExtractStudyClaims',
      { sourceTitle: 't', passage },
      {
        fetch: (() => {
          throw new Error('no network');
        }) as unknown as typeof fetch,
        callIdOf: () => undefined,
      },
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.calls).toEqual([]);
    const claims = (outcome.ok ? outcome.value : null) as { claims: { evidence: string[] }[] };
    for (const c of claims.claims) expect(passage).toContain(c.evidence[0]);
  });
});
