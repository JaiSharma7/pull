import {
  type ExportSource,
  type Highlight,
  type HighlightField,
  shapeHighlights,
} from './highlights.js';
import { pageAfter, pageAll } from './paging.js';
import { rpcError } from './rpc-error.js';
import { supabase } from './supabase.js';

/**
 * Highlights, over a table that existed since round 1 with nothing writing it until
 * `Source.tsx` did. Nothing here adds a read path, so CI check 4's fifth invariant — no two
 * permissive SELECT policies for one role on one table — is untouched:
 * `highlights_select_own` is the table's only one.
 *
 * The write policies are NOT simply "the owner". 20260910010000 split the old
 * `highlights_own` (a single `for all` owner policy) into four, and the insert
 * half also requires the caller to be able to READ `pull_id` — so `createHighlight`
 * below can be refused with 42501 for a Pull whose summary has been withdrawn,
 * where before it could not. Moving an existing highlight onto a Pull the reader
 * cannot read is refused by a trigger; editing one in place, and deleting it, are
 * untouched, so a highlight outlives the readability of what it marks.
 */

export async function fetchHighlights(userId: string, pullIds: string[]): Promise<Highlight[]> {
  if (pullIds.length === 0) return [];
  /*
   * Paged: `max_rows` is 100, and a source page's worth of pull ids can easily carry
   * more highlights than that between them. Unpaged, a heavily-marked source rendered
   * with some of its own highlights missing and nothing said so.
   *
   * Ordered by `id` rather than `start_offset` for the walk. The order has to
   * partition the set, and `start_offset` is neither unique nor monotonic across
   * pulls — two highlights at offset 0 on different pulls make the page boundary
   * ambiguous, which repeats or drops rows. `shapeHighlights` sorts what it is given,
   * so the display order is unaffected.
   *
   * KEYSET, NOT OFFSET, and the `id` order above is exactly what makes that available.
   * `.range()` is `LIMIT/OFFSET`, so a row inserted before the current offset shifts
   * every later page: one row comes back twice and another never comes back at all.
   * Review measured both against this walk — a concurrent insert duplicated a row, a
   * concurrent delete silently dropped one — and it is reachable rather than theoretical,
   * because `createHighlight` mints its `id` on the client, so a highlight the offline
   * queue drains mid-walk can sort anywhere.
   *
   * `paging.ts` already argued all of this for the export and then this function, which
   * the stash CSV reaches through `fetchHighlightsByPull`, kept the offset walk -- so one
   * PR shipped two exports that disagreed about it. Changed here rather than duplicated
   * in the export, because `Source.tsx` reads through the same function and has the same
   * problem, quietly, on any source a reader is actively marking up.
   */
  const data = await pageAfter<{
    id: string;
    pull_id: string;
    field: string;
    start_offset: number;
    end_offset: number;
    text: string;
    created_at: string;
  }>((after, limit) => {
    let q = supabase
      .from('highlights')
      .select('id, pull_id, field, start_offset, end_offset, text, created_at')
      .eq('user_id', userId)
      .in('pull_id', pullIds)
      .order('id', { ascending: true })
      .limit(limit);
    if (after !== null) q = q.gt('id', after);
    return q;
  }, 'id').catch((e: unknown) => {
    throw rpcError(e);
  });

  return shapeHighlights(
    data.map((r) => ({
      id: r.id,
      pullId: r.pull_id,
      field: r.field,
      start: r.start_offset,
      end: r.end_offset,
      text: r.text,
      createdAt: r.created_at,
    })),
  );
}

/*
 * INSERTS GO OUT ONE AT A TIME, and the reason is `created_at`.
 *
 * `Source.tsx` calls this fire-and-forget: the mark is drawn optimistically and the
 * write is left to settle on its own, which is right for a highlight -- a reader who
 * has just underlined something should not wait on a round trip to see it. But two
 * marks made in quick succession then become two independent requests, and nothing
 * makes the database see them in the order the reader made them.
 *
 * `created_at` is `default now()`, stamped when each INSERT commits rather than when
 * the reader acted. So the second mark can commit first, take the earlier timestamp,
 * and sort ahead of the first -- and `shapeHighlights` sorting by `(createdAt, id)` is
 * then faithfully reporting an order that never happened. On the next reload "Remove
 * the last one" deletes the passage the reader underlined FIRST, which is the exact
 * bug that sort was added to fix, just moved into a narrower window.
 *
 * Chaining the writes closes it at the only place all of them pass through: each
 * insert starts after the previous one has settled, so commit order is click order and
 * the server's clock becomes a faithful proxy for the reader's. The alternative --
 * sending the client's own timestamp -- was rejected because `created_at` is also what
 * `highlights_user_idx` orders the Library by and what the data export reports, and a
 * reader with a skewed clock would have their marks dated wrongly in both.
 *
 * `.catch` on the QUEUE and not on the returned promise: a failed write must not stop
 * the next one from going out, while its own caller still sees its own rejection.
 *
 * What this does not order: two tabs, or two devices. Each has its own queue, so marks
 * made in the same round trip from both can still invert. That needs a client-supplied
 * action time and the trade above, and it is a great deal rarer than the double-click
 * this fixes.
 */
let writes: Promise<unknown> = Promise.resolve();

export async function createHighlight(
  userId: string,
  h: {
    id: string;
    pullId: string;
    field: HighlightField;
    start: number;
    end: number;
    text: string;
  },
): Promise<void> {
  const write = writes.then(() => insertHighlight(userId, h));
  writes = write.catch(() => undefined);
  return write;
}

async function insertHighlight(
  userId: string,
  h: {
    id: string;
    pullId: string;
    field: HighlightField;
    start: number;
    end: number;
    text: string;
  },
): Promise<void> {
  const { error } = await supabase.from('highlights').insert({
    id: h.id,
    user_id: userId,
    pull_id: h.pullId,
    field: h.field,
    start_offset: h.start,
    end_offset: h.end,
    text: h.text,
  });
  // Client-minted id, so a replay after a lost response collides rather than
  // underlining the same words twice.
  if (error && error.code !== '23505') throw rpcError(error);
}

export async function deleteHighlight(id: string): Promise<void> {
  const { error } = await supabase.from('highlights').delete().eq('id', id);
  if (error) throw rpcError(error);
}

/**
 * How many passages the reader has marked, without fetching one of them.
 *
 * The Library's empty state has to know whether an export would contain
 * anything: a highlight does not require a save, so a reader can have kept
 * nothing and still have something to take out. `head: true` asks PostgREST for
 * the count alone, so answering that question costs no rows.
 */
export async function countHighlights(userId: string): Promise<number> {
  const { count, error } = await supabase
    .from('highlights')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId);
  if (error) throw rpcError(error);
  return count ?? 0;
}

/**
 * Everything a reader has marked or written, shaped for the Markdown export.
 *
 * Two queries rather than a join through `saved_items`, because a highlight does
 * not require a save: a reader can mark a passage on a source page without
 * keeping it, and an export that silently dropped those would be the kind of
 * quiet incompleteness that makes an export untrustworthy.
 */
export async function fetchExportData(userId: string): Promise<ExportSource[]> {
  /*
   * Both halves paged, and this is the query where it mattered most.
   *
   * `max_rows` is 100. Unpaged, a reader with more than a hundred highlights got a
   * file containing a hundred of them, with no error and nothing in the document
   * saying it was partial — so the export looked complete and was not, and they would
   * only find out when they needed the part that was missing. This function's own
   * docstring already argued that "an export that silently dropped those would be the
   * kind of quiet incompleteness that makes an export untrustworthy", about a
   * different omission, while doing exactly that with the row limit.
   *
   * Ordered by `id`: the walk needs a key that partitions the set, and `start_offset`
   * is neither unique nor monotonic across pulls. `groupExport` builds its own order
   * from the shape, so nothing downstream depends on the order rows arrive in.
   */
  type ExportRow = {
    pull_id: string | null;
    pulls: {
      headline: string;
      summaries: { works: { id: string; title: string } | null } | null;
    } | null;
  };

  /*
   * The three walks run together. Nothing downstream depends on the order — `slot()`
   * is called on all three afterwards and `groupExport` builds its own — so awaiting
   * them in turn only made the reader wait three times: a library with 400 highlights,
   * 300 notes and 400 imported items paid eleven sequential round trips where four
   * wall-clock rounds would do.
   */
  const highlightWalk = pageAll<ExportRow & { text: string; start_offset: number }>((from, to) =>
    supabase
      .from('highlights')
      .select('text, start_offset, pull_id, pulls(headline, summaries(works(id, title)))')
      .eq('user_id', userId)
      .order('id', { ascending: true })
      .range(from, to),
  ).catch((e: unknown) => {
    throw rpcError(e);
  });

  const saveWalk = pageAll<ExportRow & { note: string | null }>((from, to) =>
    supabase
      .from('saved_items')
      .select('note, pull_id, pulls(headline, summaries(works(id, title)))')
      .eq('user_id', userId)
      .not('note', 'is', null)
      .order('id', { ascending: true })
      .range(from, to),
  ).catch((e: unknown) => {
    throw rpcError(e);
  });

  /*
   * The third source, and the reason it belongs here.
   *
   * An imported highlight is not a `highlights` row marking part of a Pull — it IS
   * the Pull, whose `body` is the text the reader marked in their own book. So an
   * export built from `highlights` alone silently omitted every Kindle and
   * Readwise highlight a reader had kept, which is the largest thing most readers
   * will have. This file's own docstring calls that "the kind of quiet
   * incompleteness that makes an export untrustworthy", about a smaller omission.
   *
   * `pull_id` is `on delete set null`, so an undone batch leaves rows with nothing
   * attached; those are history rather than library and are filtered out.
   */
  const importedWalk = pageAll<ExportRow & { pulls: { headline: string; body: string } | null }>(
    (from, to) =>
      supabase
        .from('import_items')
        .select('pull_id, pulls(headline, body, summaries(works(id, title)))')
        .eq('user_id', userId)
        .not('pull_id', 'is', null)
        .order('id', { ascending: true })
        .range(from, to),
  ).catch((e: unknown) => {
    throw rpcError(e);
  });

  const [hi, saves, imported] = await Promise.all([highlightWalk, saveWalk, importedWalk]);

  type Row = {
    pull_id: string | null;
    pulls: {
      headline: string;
      summaries: { works: { id: string; title: string } | null } | null;
    } | null;
  };

  // Keyed by work, then by pull, so one idea's highlights and its note arrive
  // together under the source they came from rather than as two flat lists.
  const byWork = new Map<
    string,
    { title: string; ideas: Map<string, ExportSource['ideas'][number]> }
  >();

  const slot = (row: Row) => {
    const work = row.pulls?.summaries?.works;
    const pullId = row.pull_id;
    if (!work || !pullId || !row.pulls) return null;
    let source = byWork.get(work.id);
    if (!source) {
      source = { title: work.title, ideas: new Map() };
      byWork.set(work.id, source);
    }
    let idea = source.ideas.get(pullId);
    if (!idea) {
      idea = { headline: row.pulls.headline, highlights: [], note: null };
      source.ideas.set(pullId, idea);
    }
    return idea;
  };

  for (const r of (hi ?? []) as unknown as (Row & { text: string })[]) {
    const idea = slot(r);
    if (idea) idea.highlights.push(r.text);
  }
  for (const r of (imported ?? []) as unknown as (Row & {
    pulls: { headline: string; body: string } | null;
  })[]) {
    const idea = slot(r);
    // The body IS the highlight. Pushed rather than assigned, so an imported Pull
    // the reader has also marked up inside the app keeps both.
    if (idea && r.pulls?.body) idea.highlights.push(r.pulls.body);
  }
  for (const r of (saves ?? []) as unknown as (Row & { note: string | null })[]) {
    const idea = slot(r);
    if (idea && r.note) idea.note = r.note;
  }

  return [...byWork.values()].map((s) => ({ title: s.title, ideas: [...s.ideas.values()] }));
}
