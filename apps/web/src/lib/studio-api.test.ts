/**
 * The Studio's job list shows summaries, and only summaries.
 *
 * `generation_jobs` also holds study courses (20260925010000). The list describes every
 * row as a summary -- "Done." with nothing to read, a raw `study_extract` error -- so a
 * course job listed there would be a summary that never appears, for a feature the app
 * does not offer yet. The filter is asserted on the query the list actually sends.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls: { method: string; args: unknown[] }[] = [];

vi.mock('./supabase.js', () => {
  const builder = () => {
    const self: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'in', 'neq', 'order', 'limit']) {
      self[method] = (...args: unknown[]) => {
        calls.push({ method, args });
        return self;
      };
    }
    self.then = (resolve: (r: { data: unknown[]; error: null }) => unknown) =>
      resolve({ data: [], error: null });
    return self;
  };
  return { supabase: { from: () => builder() } };
});

const { fetchMyJobs } = await import('./studio-api.js');

beforeEach(() => {
  calls.length = 0;
});

describe('fetchMyJobs', () => {
  it('asks for this reader’s summary jobs and no study courses', async () => {
    await fetchMyJobs('u1');
    expect(calls).toContainEqual({ method: 'eq', args: ['requester_id', 'u1'] });
    expect(calls).toContainEqual({
      method: 'in',
      args: ['kind', ['canonical_summary', 'private_summary']],
    });
  });
});
