import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('./supabase.js', async () => {
  const { createClient } = await import('@supabase/supabase-js');
  return {
    supabase: createClient('https://example.supabase.co', 'test-publishable', {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    }),
  };
});
const { fetchDailyCuration } = await import('./daily-api.js');
afterEach(() => vi.unstubAllGlobals());
function server(rpcStatus: number, rpcBody: unknown, rows: unknown[] = []) {
  const urls: string[] = [];
  vi.stubGlobal('fetch', async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    if (url.includes('/rpc/')) return new Response(JSON.stringify(rpcBody), { status: rpcStatus });
    return new Response(JSON.stringify(rows), { status: 200 });
  });
  return urls;
}
const row = {
  day: '2026-09-01',
  ordinal: 1,
  blurb: 'An editorial choice.',
  pulls: {
    id: 'pull-1',
    headline: 'Some things are up to you. Most are not.',
    body: 'Your judgements, intentions and effort are yours.',
    why_it_matters: null,
    summaries: {
      title: 'The Enchiridion',
      works: { id: 'work-1', title: 'The Enchiridion', kind: 'book', year: 125 },
    },
  },
};
describe('Daily Pull across database versions', () => {
  it('uses personal selections when the RPC is available', async () => {
    const data = { day: '2026-09-09', pulls: [] };
    const urls = server(200, data);
    expect(await fetchDailyCuration(data.day)).toEqual(data);
    expect(urls).toHaveLength(1);
  });
  it('falls back to visibly labelled editorial picks only for a missing RPC', async () => {
    const urls = server(404, { code: 'PGRST202', message: 'Missing RPC' }, [row]);
    const result = await fetchDailyCuration('2026-09-09');
    expect(result.day).toBe('2026-09-09');
    expect(result.editorialDay).toBe('2026-09-01');
    expect(result.pulls[0]).toMatchObject({
      pullId: 'pull-1',
      reason: 'editorial',
      workTitle: 'The Enchiridion',
    });
    expect(decodeURIComponent(urls[1]!)).toContain('summaries.status=eq.published');
    expect(decodeURIComponent(urls[1]!)).toContain('summaries.visibility=eq.public');
  });
  it('does not disguise permission failures as an editorial selection', async () => {
    const urls = server(403, { code: '42501', message: 'Permission denied' });
    await expect(fetchDailyCuration('2026-09-09')).rejects.toThrow('Permission denied');
    expect(urls).toHaveLength(1);
  });
  it('reports an empty editorial archive without pretending it is a personal result', async () => {
    server(404, { code: 'PGRST202', message: 'Missing RPC' });
    expect(await fetchDailyCuration('2026-09-09')).toMatchObject({ editorialDay: null, pulls: [] });
  });
});
