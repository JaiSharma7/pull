import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { accountFor, createSidecar, TOKEN_HEADER, type Handler } from './server.js';

/**
 * The sidecar's contract with the worker, exercised over a real socket.
 *
 * The provider itself is not called: handlers are injected. What is asserted is the
 * part law 7 and law 2 depend on -- the door is shut without a token, and a failure
 * after a billed attempt says so, with the usage attached.
 */

const TOKEN = 'a-test-token-long-enough-to-pass';

function fakeLog(
  calls: { inputTokens: number; outputTokens: number; client: string; selected: boolean }[],
) {
  return {
    calls: calls.map((c) => ({
      selected: c.selected,
      clientName: c.client,
      provider: 'google-ai',
      usage: { inputTokens: c.inputTokens, outputTokens: c.outputTokens, cachedInputTokens: 0 },
    })),
  } as never;
}

let server: ReturnType<typeof createSidecar> | undefined;
afterEach(() => server?.close());

async function serve(handlers: Record<string, Handler>) {
  server = createSidecar({ token: TOKEN, handlers });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
  const { port } = server.address() as AddressInfo;
  return {
    call: (fn: string, body: unknown, headers: Record<string, string> = {}) =>
      fetch(`http://127.0.0.1:${port}/call/${fn}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      }),
    get: (path: string, headers: Record<string, string> = {}) =>
      fetch(`http://127.0.0.1:${port}${path}`, { headers }),
  };
}

const auth = { [TOKEN_HEADER]: TOKEN };

describe('the door', () => {
  it('refuses to be built without a token', () => {
    expect(() => createSidecar({ token: '' })).toThrow(/will not run open/);
    expect(() => createSidecar({ token: 'short' })).toThrow(/will not run open/);
  });

  it('answers ping without a token, and nothing else', async () => {
    const s = await serve({ Echo: async (args) => args });
    expect((await s.get('/_debug/ping')).status).toBe(200);
    expect((await s.call('Echo', { a: 1 })).status).toBe(401);
    expect((await s.call('Echo', { a: 1 }, { [TOKEN_HEADER]: 'wrong' })).status).toBe(401);
    // Unknown function names are also behind the door: 401, not 404.
    expect((await s.call('Nope', {}, { [TOKEN_HEADER]: 'wrong' })).status).toBe(401);
  });

  it('serves only the allowlisted functions', async () => {
    const s = await serve({ Echo: async (args) => args });
    expect((await s.call('Nope', {}, auth)).status).toBe(404);
    expect((await s.get('/call/Echo', auth)).status).toBe(405);
    const ok = await s.call('Echo', { a: 1 }, auth);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ result: { a: 1 }, attempts: 0 });
  });

  it('rejects a body that is not an object', async () => {
    const s = await serve({ Echo: async (args) => args });
    expect((await s.call('Echo', [1, 2], auth)).status).toBe(400);
  });
});

describe('the ledger', () => {
  it('sums usage over every attempt and names the client that answered', () => {
    const account = accountFor(
      fakeLog([
        { inputTokens: 100, outputTokens: 0, client: 'GeminiFlash', selected: false },
        { inputTokens: 100, outputTokens: 40, client: 'GeminiFlash', selected: true },
      ]),
    );
    expect(account.usage).toEqual({ inputTokens: 200, outputTokens: 40, cachedInputTokens: 0 });
    expect(account.attempts).toBe(2);
    expect(account.client).toBe('GeminiFlash');
    expect(account.model).toBe('gemini-3.6-flash');
  });

  it('reports a failure after a billed attempt as billed, with the usage', async () => {
    // The load-bearing one. A handler that throws after the vendor answered must
    // not look like a free failure, or the worker retries and pays again.
    const s = await serve({
      Broken: async (_args, collector) => {
        // Simulate the collector having recorded a billed call before the throw.
        Object.defineProperty(collector, 'last', {
          value: fakeLog([
            { inputTokens: 500, outputTokens: 20, client: 'GeminiFlash', selected: true },
          ]),
        });
        throw new Error('assert failed: at_least_one');
      },
    });
    const res = await s.call('Broken', {}, auth);
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({
      billed: true,
      error: 'assert failed: at_least_one',
      usage: { inputTokens: 500, outputTokens: 20 },
      model: 'gemini-3.6-flash',
    });
  });

  it('reports a failure before any attempt as not billed', async () => {
    const s = await serve({
      Refused: async () => {
        throw new Error('connection refused');
      },
    });
    const res = await s.call('Refused', {}, auth);
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ billed: false, usage: { inputTokens: 0 } });
  });
});
