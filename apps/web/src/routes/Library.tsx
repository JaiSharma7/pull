import { useEffect, useMemo, useState } from 'react';
import { PullCard } from '@wap/ui';
import * as api from '../lib/api.js';
import { groupByWork, type WorkGroup } from '../lib/library.js';
import { speak } from '../lib/speech.js';
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
        console.error('Library request failed', e);
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  const groups = useMemo(() => groupByWork(items ?? []), [items]);

  /**
   * Fetched when a source is opened rather than for every group on mount: the
   * Delta scans the reader's known set per candidate, so N sources on screen
   * would be N of those scans to answer a question nobody has asked yet.
   *
   * `key` drives the open/closed state and `workId` is what may reach the database.
   * They are different values for an orphaned Pull, and conflating them is what sent
   * the string "Unknown source" into a `uuid` parameter — see `lib/library.ts`.
   */
  function toggle(group: WorkGroup) {
    const next = openWork === group.key ? null : group.key;
    setOpenWork(next);

    // A Pull whose work has been deleted has no Delta to ask for. Skipping is not a
    // silent failure: there is genuinely nothing to show, and asking anyway was the
    // request that raised 22P02 and got swallowed.
    if (next && group.workId && !delta[group.workId]) {
      api
        .fetchSourceDelta(group.workId)
        .then((d) => setDelta((prev) => ({ ...prev, [group.workId]: d })))
        // A missing Delta costs the reader a line of context, not their library.
        .catch((e: unknown) => console.error('Could not load the source Delta', e));
    }
  }

  // Same reasoning as the feed's error state: the detail goes to the console where
  // it helps whoever is debugging, and the reader gets a sentence rather than
  // `permission denied for function ...`. Rendering the raw message here while
  // arguing against it three files away would have been the inconsistency, not the
  // fix.
  if (error)
    return (
      <p role="alert" className="measure">
        Could not load your library just now.
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

      {groups.map((group) => {
        const open = openWork === group.key;
        // Keyed by workId, not by the group key: an orphan has no Delta and must not
        // read one belonging to whatever else shares its position.
        const d = group.workId ? delta[group.workId] : undefined;
        return (
          <section key={group.key} className="stack">
            <h2 style={{ fontSize: 'var(--step-1)', margin: 0 }}>
              <button
                type="button"
                className="btn btn--plain"
                aria-expanded={open}
                onClick={() => toggle(group)}
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
                  // Law 3: audio is free forever, and the Library is where a reader
                  // comes back to something they kept — so it is the screen where
                  // listening matters most. The Feed had this and the Library did
                  // not, which made the promise conditional on where you happened
                  // to be standing. `speak` is Web Speech, on-device and free.
                  onListen={() => speak(`${item.headline}. ${item.body}`)}
                />
              ))}
          </section>
        );
      })}
    </div>
  );
}
