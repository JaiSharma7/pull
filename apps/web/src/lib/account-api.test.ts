/**
 * The export walk, which had no test at all until it lost somebody's history.
 *
 * `buildAccountExport` pages every table a reader owns and writes them into one file.
 * A round-3 change moved it from offset paging to keyset paging — correctly, because
 * an offset is unstable under concurrent writes — and guarded the cursor with
 * `typeof cursor !== 'string'`. `history_events.id` and `feed_impressions.id` are
 * `bigint`, which PostgREST serialises as a JSON number, so the guard threw on the
 * second page of either. `data[table] = rows` sits after the loop inside the same
 * `try`, so the table did not truncate: it vanished, including the rows already
 * fetched. Every reader with more than 100 history events lost all of it.
 *
 * The module builds a Supabase client at import, so the client is mocked rather than
 * the network. What is exercised is the walk itself: the cursor, the page boundary
 * and where rows end up.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Rows the fake serves, by table. Set per test. */
const TABLES = new Map<string, Record<string, unknown>[]>();

vi.mock('./supabase.js', () => {
  /** Enough of PostgREST's builder to run the walk: chainable, and awaitable. */
  const builder = (table: string) => {
    let key = 'id';
    let after: string | number | null = null;
    let limit = 100;
    const self = {
      select: () => self,
      eq: () => self,
      order: (column: string) => {
        key = column;
        return self;
      },
      limit: (n: number) => {
        limit = n;
        return self;
      },
      gt: (_column: string, value: string) => {
        after = value;
        return self;
      },
      then: (resolve: (r: { data: unknown[] | null; error: unknown }) => unknown): unknown => {
        const all = TABLES.get(table) ?? [];
        /*
         * Ordered and compared BY THE COLUMN'S OWN TYPE, which is the whole point.
         *
         * `.gt()` is evaluated server-side against a bigint column, so `101 > 100`.
         * The first version of this fake compared `String(id)`, where `"100" > "9"`
         * is false — the walk then re-served rows it had already yielded and the
         * assertion caught 1295 rows instead of 151. A fake that orders differently
         * from the database proves nothing about a cursor.
         */
        /*
         * The ROW's type decides, and the cursor is coerced into it — which is what
         * PostgREST does with a query-string value against a typed column, and the
         * only reason sending `String(bigint)` back as a cursor is correct at all.
         * Comparing the cursor as the string it arrives as put `"100" > "9"` at
         * false and made the walk re-serve pages it had already yielded.
         */
        const cmp = (a: unknown, b: unknown) => {
          if (typeof a === 'number') {
            const rhs = typeof b === 'number' ? b : Number(b);
            return Number.isNaN(rhs) ? 0 : a - rhs;
          }
          return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
        };
        const sorted = [...all].sort((x, y) => cmp(x[key], y[key]));
        const rest = after === null ? sorted : sorted.filter((r) => cmp(r[key], after) > 0);
        return resolve({ data: rest.slice(0, limit), error: null });
      },
    };
    return self;
  };
  return { supabase: { from: (table: string) => builder(table) } };
});

const { buildAccountExport } = await import('./account-api.js');

/** `n` rows whose `id` is a JSON number, as PostgREST renders a bigint. */
const bigintRows = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: i + 1, user_id: 'u1', kind: 'read' }));

/** `n` rows whose `id` is a uuid-shaped string, ordered. */
const uuidRows = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: `0000${String(i + 1).padStart(4, '0')}-0000-0000-0000-000000000000`,
    user_id: 'u1',
  }));

beforeEach(() => {
  TABLES.clear();
});

describe('buildAccountExport', () => {
  it('exports every page of a bigint-keyed table, not just the first', async () => {
    // 151 is the reviewer's measured case: two pages and a remainder, which is what
    // every reader with any history looks like.
    TABLES.set('history_events', bigintRows(151));

    const out = await buildAccountExport('u1', 'reader@example.com');

    expect(out.incomplete).toEqual([]);
    expect(out.data['history_events']).toHaveLength(151);
  });

  it('leaves nothing out of a table whose rows exactly fill a page', async () => {
    // The boundary: `got.length < PAGE` is false on the last full page, so the walk
    // asks once more and must terminate on the empty answer rather than loop.
    TABLES.set('history_events', bigintRows(200));

    const out = await buildAccountExport('u1', null);

    expect(out.data['history_events']).toHaveLength(200);
    expect(out.incomplete).toEqual([]);
  });

  it('still pages a uuid-keyed table', async () => {
    TABLES.set('notes', uuidRows(150));

    const out = await buildAccountExport('u1', null);

    expect(out.data['notes']).toHaveLength(150);
    expect(out.incomplete).toEqual([]);
  });

  it('records a table it cannot page rather than dropping it silently', async () => {
    // A key that is neither a string nor a number is a walk that cannot continue.
    // The table lands in `incomplete` with a reason, which is what the file promises
    // — the failure was doing that to a perfectly readable bigint.
    TABLES.set(
      'history_events',
      Array.from({ length: 150 }, () => ({ id: { nested: true }, user_id: 'u1' })),
    );

    const out = await buildAccountExport('u1', null);

    expect(out.incomplete.map((i) => i.table)).toContain('history_events');
  });

  it('names every table it walked, so a missing one is visible in the file', async () => {
    const out = await buildAccountExport('u1', null);
    // Empty tables still appear as empty arrays. A table that vanished from `data`
    // is the shape of the defect this file was written for.
    expect(Object.keys(out.data)).toContain('history_events');
    expect(Object.keys(out.data)).toContain('feed_impressions');
    expect(Object.keys(out.data)).toContain('recall_events');
  });
});
