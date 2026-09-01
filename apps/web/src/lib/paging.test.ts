import { describe, expect, it, vi } from 'vitest';
import { pageAll } from './paging.js';

/**
 * The two mistakes this helper exists to stop being made a fourth time.
 *
 * Both are invisible in production: an off-by-one on the inclusive range duplicates a
 * row per page, and a missing short-page exit costs one wasted request per call. So
 * the assertions are on the *ranges asked for*, not only on the rows returned — a test
 * that checked the output alone would pass with either bug present.
 */
const rows = (n: number, offset = 0) => Array.from({ length: n }, (_, i) => offset + i);

describe('pageAll', () => {
  it('returns everything when it fits in one page', async () => {
    const fetchRange = vi.fn(async (from: number) => ({ data: rows(3, from), error: null }));
    expect(await pageAll(fetchRange, 100)).toEqual([0, 1, 2]);
    expect(fetchRange).toHaveBeenCalledTimes(1);
  });

  it('asks for an inclusive range, so a page of 100 is range(0, 99)', async () => {
    const fetchRange = vi.fn(async () => ({ data: rows(0), error: null }));
    await pageAll(fetchRange, 100);
    expect(fetchRange).toHaveBeenCalledWith(0, 99);
  });

  it('walks until a short page and then stops', async () => {
    const pages = [rows(100), rows(100, 100), rows(7, 200)];
    const fetchRange = vi.fn(async (from: number) => ({
      data: pages[from / 100] ?? [],
      error: null,
    }));

    const all = await pageAll(fetchRange, 100);
    expect(all).toHaveLength(207);
    // Three calls, not four: a short page is the end, and asking again to be told so
    // is a round trip that buys nothing.
    expect(fetchRange).toHaveBeenCalledTimes(3);
    expect(fetchRange.mock.calls).toEqual([
      [0, 99],
      [100, 199],
      [200, 299],
    ]);
  });

  it('makes one more request when the last full page is exactly the boundary', async () => {
    // 100 rows then nothing. The extra call is unavoidable — a full page is
    // indistinguishable from "there is more" — and asserting it keeps the previous
    // test honest about what "stops early" does and does not mean.
    const fetchRange = vi.fn(async (from: number) => ({
      data: from === 0 ? rows(100) : [],
      error: null,
    }));
    expect(await pageAll(fetchRange, 100)).toHaveLength(100);
    expect(fetchRange).toHaveBeenCalledTimes(2);
  });

  it('throws what the query returned rather than swallowing it', async () => {
    const boom = new Error('permission denied');
    const fetchRange = vi.fn(async () => ({ data: null, error: boom }));
    await expect(pageAll(fetchRange)).rejects.toBe(boom);
  });

  it('treats a null data with no error as the end', async () => {
    const fetchRange = vi.fn(async () => ({ data: null, error: null }));
    expect(await pageAll(fetchRange)).toEqual([]);
  });
});
