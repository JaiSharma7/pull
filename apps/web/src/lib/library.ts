import type { LibraryItem } from './types.js';

/**
 * A source, and the Pulls the reader has kept from it.
 *
 * `workId` is carried separately from `key` on purpose, and that separation is the
 * whole reason this module exists.
 */
export interface WorkGroup {
  /** Identity for React and for the open/closed map. Never sent to the database. */
  key: string;
  /** The real `works.id`, or `''` when the work is gone. Only this may reach an RPC. */
  workId: string;
  title: string;
  kind: string | null;
  items: LibraryItem[];
}

/**
 * Group kept Pulls by the source they came from.
 *
 *   item.work.id present  ──→ key = the uuid,      workId = the uuid
 *   item.work.id missing  ──→ key = "orphan:<id>", workId = ''
 *
 * The second row is the fix. Grouping used to key on `item.work.id || item.work.title`,
 * and `fetchLibrary` substitutes `{ id: '', title: 'Unknown source' }` when a Pull's
 * work has been deleted — so the key became the literal string `Unknown source`, and
 * the Library then handed that to `get_source_delta(p_work_id uuid)`. Postgres raised
 * `22P02 invalid input syntax for type uuid`, and the caller's `.catch(() => undefined)`
 * swallowed it, so the Delta silently never loaded and nothing said why.
 *
 * Worse, every orphaned Pull from every different source collapsed into one group
 * titled "Unknown source", because they all produced the same key.
 *
 * Keying orphans on the Pull's own id fixes both: each keeps its own row, and an
 * empty `workId` is a value the caller can test before spending a request.
 *
 * Grouping is a pure function of the rows, so it is here rather than inline in the
 * component — the failure above was ordinary logic, and ordinary logic should be
 * testable without rendering anything.
 */
export function groupByWork(items: readonly LibraryItem[]): WorkGroup[] {
  const byKey = new Map<string, WorkGroup>();

  for (const item of items) {
    const workId = item.work.id;
    // Prefixed so a work whose uuid somehow equalled another Pull's id cannot collide.
    const key = workId || `orphan:${item.id}`;

    const existing = byKey.get(key);
    if (existing) existing.items.push(item);
    else {
      byKey.set(key, {
        key,
        workId,
        title: item.work.title,
        kind: item.work.kind,
        items: [item],
      });
    }
  }

  return [...byKey.values()];
}
