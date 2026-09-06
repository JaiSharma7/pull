/**
 * Walk a PostgREST range until it runs out.
 *
 * `supabase/config.toml` sets `max_rows = 100`, so *every* unpaged select in this app
 * silently returns at most a hundred rows. Silently is the whole problem: there is no
 * error, no truncation flag, and no way for the caller to tell a reader with 100
 * highlights from a reader with 4,000. `api.ts` learned this the hard way and pages
 * carefully in two places; three others did not, and one of them was the export.
 *
 * Extracted here rather than copied a fourth time, because the loop has two details
 * that are easy to get wrong and invisible when they are:
 *
 *   * THE RANGE IS INCLUSIVE. `range(0, 100)` returns 101 rows, not 100, so the walk
 *     has to ask for `from + size - 1`. Off by one here silently re-reads a row per
 *     page, which looks like duplicated data much later and nowhere near the cause.
 *   * A SHORT PAGE ENDS IT. Asking again after a partial page costs a round trip to
 *     learn nothing. Asking `while (rows.length > 0)` instead makes the final,
 *     empty request on every single call.
 *
 * The caller supplies the query because the shape of a Supabase select is not worth
 * abstracting — the filters, the embed and the order differ every time, and a wrapper
 * general enough to express them would be harder to read than the query it replaced.
 */
export async function pageAll<T>(
  fetchRange: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
  pageSize = 100,
): Promise<T[]> {
  const all: T[] = [];

  for (let from = 0; ; from += pageSize) {
    const { data, error } = await fetchRange(from, from + pageSize - 1);
    if (error) throw error;

    const rows = data ?? [];
    all.push(...rows);
    if (rows.length < pageSize) return all;
  }
}

/**
 * The same walk, cursored on a key instead of counted from the start.
 *
 * `pageAll` is `LIMIT/OFFSET`, and an offset is unstable under concurrent writes however
 * well the rows are ordered: a row inserted before the current offset shifts every later
 * page by one, so the caller gets one row twice and misses another. `buildAccountExport`
 * measured exactly that on 250 rows — row 109 duplicated, the concurrently inserted row
 * absent — and moved to a keyset walk for it. An export is the place it matters most,
 * because it runs long enough for another tab to write underneath it.
 *
 * `key` must be a column unique WITHIN the rows this query returns, so that it is both a
 * total order and a usable cursor. The caller applies `.order(key)` itself, because the
 * order may need other terms in front of it.
 *
 * `buildAccountExport` has this walk inline and predates this helper. It should adopt it;
 * that is a change to a merged file and does not belong in the PR that noticed.
 */
export async function pageAfter<T extends Record<string, unknown>>(
  fetchAfter: (
    after: string | number | null,
    limit: number,
  ) => PromiseLike<{
    data: T[] | null;
    error: unknown;
  }>,
  key: string,
  pageSize = 100,
): Promise<T[]> {
  const all: T[] = [];
  let after: string | number | null = null;

  for (;;) {
    const { data, error } = await fetchAfter(after, pageSize);
    if (error) throw error;

    const rows = data ?? [];
    all.push(...rows);
    if (rows.length < pageSize) return all;

    const cursor = rows[rows.length - 1]?.[key];
    // A key that is absent, or of a type no cursor can be made from, would loop on the
    // same page forever. A number is a cursor too: `history_events.id` is a `bigint` and
    // PostgREST serialises it as a JSON number.
    if (typeof cursor !== 'string' && typeof cursor !== 'number') {
      throw new Error(`pageAfter: row has no usable ${key} to continue from`);
    }
    after = cursor;
  }
}
