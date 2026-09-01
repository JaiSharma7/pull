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
