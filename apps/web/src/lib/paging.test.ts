import { describe, expect, it, vi } from 'vitest';
import { pageAfter, pageAll } from './paging.js';

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

  it("throws a real Error for PostgREST's plain error object, keeping its code", async () => {
    // supabase-js resolves with `{ error: { message, code, ... } }`; thrown as is, a
    // screen renders "[object Object]" where the message should be.
    const refused = { message: 'permission denied for table notes', code: '42501' };
    const fetchRange = vi.fn(async () => ({ data: null, error: refused }));
    await expect(pageAll(fetchRange)).rejects.toMatchObject({
      message: 'permission denied for table notes',
      name: 'PostgrestError 42501',
    });
    await expect(pageAll(fetchRange)).rejects.toBeInstanceOf(Error);
  });

  it('treats a null data with no error as the end', async () => {
    const fetchRange = vi.fn(async () => ({ data: null, error: null }));
    expect(await pageAll(fetchRange)).toEqual([]);
  });
});

/**
 * The keyset walk, which shipped with nothing at all.
 *
 * Two reviewers said so independently, and every row of the Anki deck goes through it.
 * The fake below is a table rather than a page oracle: it holds rows, and each call
 * applies `gt`, `order` and `limit` the way PostgREST does — so a test can INSERT or
 * DELETE between pages, which is the entire reason this walk exists instead of
 * `.range()`.
 */
function table(ids: readonly string[]) {
  const store = new Set(ids);
  return {
    insert: (id: string) => store.add(id),
    remove: (id: string) => store.delete(id),
    fetch: async (after: string | number | null, limit: number) => ({
      data: [...store]
        .sort()
        .filter((id) => after === null || id > String(after))
        .slice(0, limit)
        .map((id) => ({ id })),
      error: null,
    }),
  };
}

/** Ids that sort in insertion order, so a "row inserted early" is expressible. */
const id = (n: number) => `row-${String(n).padStart(4, '0')}`;

describe('pageAfter', () => {
  it('walks to the end and stops on the short page', async () => {
    const t = table(Array.from({ length: 250 }, (_, i) => id(i)));
    const fetchAfter = vi.fn(t.fetch);
    const all = await pageAfter(fetchAfter, 'id', 100);
    expect(all).toHaveLength(250);
    expect(fetchAfter).toHaveBeenCalledTimes(3);
    // The cursor, not an offset: every call after the first asks for what sorts after
    // the last row it was given.
    expect(fetchAfter.mock.calls.map((c) => c[0])).toEqual([null, id(99), id(199)]);
  });

  it('costs one extra request when the last page is exactly full', async () => {
    const t = table(Array.from({ length: 200 }, (_, i) => id(i)));
    const fetchAfter = vi.fn(t.fetch);
    expect(await pageAfter(fetchAfter, 'id', 100)).toHaveLength(200);
    expect(fetchAfter).toHaveBeenCalledTimes(3);
  });

  /*
   * THE WHOLE POINT, and what `pageAll` cannot do.
   *
   * An offset walk shifts every later page when a row lands before the cursor: one row
   * comes back twice and another never comes back at all. Measured on this same fixture
   * during review — `pageAll` returned 251 rows with one duplicated, and dropped one
   * under a concurrent delete.
   */
  it('neither duplicates nor drops a row when the table changes mid-walk', async () => {
    const t = table(Array.from({ length: 250 }, (_, i) => id(i)));
    let call = 0;
    const all = await pageAfter(
      (after, limit) => {
        // Between page one and page two, a row lands *before* the cursor and another
        // that has already been read is deleted.
        if (call++ === 1) {
          t.insert(id(50) + '-late');
          t.remove(id(10));
        }
        return t.fetch(after, limit);
      },
      'id',
      100,
    );

    const ids = all.map((r) => (r as { id: string }).id);
    expect(new Set(ids).size).toBe(ids.length);
    // Everything from page one is still present, including the row deleted after it was
    // read — a snapshot, not a re-count.
    expect(ids).toContain(id(10));
    expect(ids).toContain(id(249));
  });

  it('stops rather than looping when the cursor column is absent', async () => {
    // A silent infinite loop is the alternative: the same page, forever.
    const fetchAfter = async () => ({ data: [{ notId: 'x' }], error: null });
    await expect(pageAfter(fetchAfter, 'id', 1)).rejects.toThrow(/no usable id/);
  });

  it('throws the error rather than returning a short file', async () => {
    const boom = new Error('JWT expired');
    const t = table(Array.from({ length: 250 }, (_, i) => id(i)));
    let call = 0;
    await expect(
      pageAfter(
        async (after, limit) =>
          call++ === 1 ? { data: null, error: boom } : await t.fetch(after, limit),
        'id',
        100,
      ),
    ).rejects.toBe(boom);
  });

  it('refuses a page bigger than the server will send', async () => {
    // `max_rows` is 100, and a request for more comes back capped with no error — so the
    // walk would see a short page, stop, and report a truncated result as complete.
    // Measured during review: 100 of 250 rows, one request, no error.
    const t = table(Array.from({ length: 250 }, (_, i) => id(i)));
    await expect(pageAfter(t.fetch, 'id', 500)).rejects.toThrow(/max_rows/);
    await expect(pageAll(async () => ({ data: [], error: null }), 500)).rejects.toThrow(/max_rows/);
  });
});
