import { useEffect, useMemo, useState } from 'react';
import { PullCard } from '@wap/ui';
import * as api from '../lib/api.js';
import type { LibraryItem, SourceDelta } from '../lib/types.js';

/**
 * Everything the reader has kept, grouped by the source it came from.
 *
 * Grouping rather than a flat list because a library is how someone finds their
 * way back into a work, not a chronological dump — and because grouping is what
 * makes the source Delta meaningful: "you have 3 of 21 ideas from this" is a
 * reason to open it again. Saving was previously write-only; nothing in the app
 * read it back.
 */
export function Library({ userId }: { userId: string }) {
  const [items, setItems] = useState<LibraryItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openWork, setOpenWork] = useState<string | null>(null);
  const [delta, setDelta] = useState<Record<string, SourceDelta>>({});

  useEffect(() => {
    let cancelled = false;
    api
      .fetchLibrary(userId)
      .then((rows) => {
        if (!cancelled) setItems(rows);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  const groups = useMemo(() => {
    const byWork = new Map<string, { title: string; kind: string | null; items: LibraryItem[] }>();
    for (const item of items ?? []) {
      const key = item.work.id || item.work.title;
      const group = byWork.get(key);
      if (group) group.items.push(item);
      else byWork.set(key, { title: item.work.title, kind: item.work.kind, items: [item] });
    }
    return [...byWork.entries()];
  }, [items]);

  /**
   * Fetched when a source is opened rather than for every group on mount: the
   * Delta scans the reader's known set per candidate, so N sources on screen
   * would be N of those scans to answer a question nobody has asked yet.
   */
  function toggle(workId: string) {
    const next = openWork === workId ? null : workId;
    setOpenWork(next);
    if (next && workId && !delta[workId]) {
      api
        .fetchSourceDelta(workId)
        .then((d) => setDelta((prev) => ({ ...prev, [workId]: d })))
        // A missing Delta costs the reader a line of context, not their library.
        .catch(() => undefined);
    }
  }

  if (error)
    return (
      <p role="alert" className="measure">
        Could not load your library: {error}
      </p>
    );

  if (!items) return <p className="meta">Loading…</p>;

  if (items.length === 0)
    return (
      <div className="stack measure">
        <p className="meta">Library</p>
        <h1>Nothing kept yet.</h1>
        <p>
          Save a Pull from the feed and it lands here, grouped by where it came from — with how much
          of that source you have left to meet.
        </p>
      </div>
    );

  return (
    <div className="stack">
      <p className="meta">Library · {items.length} kept</p>

      {groups.map(([key, group]) => {
        const open = openWork === key;
        const d = delta[key];
        return (
          <section key={key} className="stack">
            <h2 style={{ fontSize: 'var(--step-1)', margin: 0 }}>
              <button
                type="button"
                className="btn btn--plain"
                aria-expanded={open}
                onClick={() => toggle(key)}
                style={{ textAlign: 'left' }}
              >
                {group.title}
              </button>
            </h2>

            <p className="meta">
              {group.items.length} kept
              {d && (
                <>
                  {' · '}
                  <span style={{ color: 'var(--accent)' }}>
                    {d.new} of {d.total} still new to you
                  </span>
                </>
              )}
            </p>

            {open &&
              group.items.map((item) => (
                <PullCard
                  key={item.id}
                  source={{ title: group.title, kind: group.kind }}
                  headline={item.headline}
                  body={item.body}
                  whyItMatters={item.whyItMatters}
                  sourceTrail={group.title}
                  saved
                />
              ))}
          </section>
        );
      })}
    </div>
  );
}
