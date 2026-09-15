import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./supabase.js', async () => {
  const { createClient } = await import('@supabase/supabase-js');
  return {
    supabase: createClient('https://example.supabase.co', 'test-publishable', {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    }),
  };
});

const { createHighlight } = await import('./highlights-api.js');

afterEach(() => vi.unstubAllGlobals());

const mark = (id: string) => ({
  id,
  pullId: 'pull-1',
  field: 'body' as const,
  start: 0,
  end: 4,
  text: 'test',
});

/**
 * A server that records when each insert STARTS and when it FINISHES, and lets the
 * test decide when each one finishes.
 *
 * The start/finish distinction is the whole point. Two inserts that overlap are two
 * requests the database may commit in either order, and `highlights.created_at` is
 * `default now()` — stamped at commit, not at the click. So overlap is exactly the
 * condition under which the stored order can disagree with the order the reader
 * marked things in, which is what `shapeHighlights` then faithfully reports.
 */
function recordingServer() {
  const events: string[] = [];
  const release = new Map<string, () => void>();
  const status = new Map<string, number>();

  vi.stubGlobal('fetch', async (_input: string | URL | Request, init?: RequestInit) => {
    // `.insert({...})` sends a bare object; `.insert([...])` an array. Accept both
    // rather than assuming, which is what made the first run of this file hang.
    const parsed = JSON.parse(String(init?.body ?? '{}')) as { id?: string } | { id?: string }[];
    const id = (Array.isArray(parsed) ? parsed[0]?.id : parsed.id) ?? 'unknown';

    events.push(`start:${id}`);
    await new Promise<void>((resolve) => release.set(id, resolve));
    events.push(`end:${id}`);

    const code = status.get(id) ?? 201;
    return code === 201
      ? new Response(null, { status: 201 })
      : new Response(JSON.stringify({ code: '42501', message: 'refused' }), {
          status: code,
          headers: { 'content-type': 'application/json' },
        });
  });

  return {
    events,
    fails: (id: string) => status.set(id, 403),
    /** Let one in-flight insert finish. Waits for it to have started. */
    finish: async (id: string) => {
      while (!release.has(id)) await new Promise((r) => setTimeout(r, 0));
      release.get(id)!();
      release.delete(id);
      await new Promise((r) => setTimeout(r, 0));
    },
    started: (id: string) => events.includes(`start:${id}`),
  };
}

describe('createHighlight orders its writes', () => {
  it('does not begin the second insert until the first has finished', async () => {
    const server = recordingServer();

    // Fire-and-forget, exactly as `Source.tsx` does: the marks are drawn
    // optimistically and neither call is awaited at the call site.
    const first = createHighlight('reader-1', mark('h-first'));
    const second = createHighlight('reader-1', mark('h-second'));

    // The second must not have reached the network while the first is in flight.
    // Without the queue both fetches start here, and the database is free to commit
    // them in either order.
    await new Promise((r) => setTimeout(r, 0));
    expect(server.started('h-second')).toBe(false);

    await server.finish('h-first');
    await first;
    await server.finish('h-second');
    await second;

    expect(server.events).toEqual([
      'start:h-first',
      'end:h-first',
      'start:h-second',
      'end:h-second',
    ]);
  });

  it('lets the next write through after one fails, and still rejects that one', async () => {
    const server = recordingServer();
    server.fails('h-bad');

    // Handlers attached SYNCHRONOUSLY, which is both what `Source.tsx` does
    // (`createHighlight(...).catch(...)` at the call site) and what keeps this from
    // tripping Node's unhandled-rejection warning in the tick before an `await`.
    const bad = createHighlight('reader-1', mark('h-bad')).then(
      () => 'resolved',
      () => 'rejected',
    );
    const good = createHighlight('reader-1', mark('h-good')).then(
      () => 'resolved',
      () => 'rejected',
    );

    // The caller of the failed write sees its own rejection...
    await server.finish('h-bad');
    expect(await bad).toBe('rejected');

    // ...and the queue is not poisoned by it. A highlight that cannot be saved must
    // not silently stop every later one from being saved either.
    await server.finish('h-good');
    expect(await good).toBe('resolved');

    expect(server.events).toEqual(['start:h-bad', 'end:h-bad', 'start:h-good', 'end:h-good']);
  });
});
