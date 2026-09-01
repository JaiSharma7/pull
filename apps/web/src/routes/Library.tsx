import { useCallback, useEffect, useMemo, useState } from 'react';
import { PullCard } from '@wap/ui';
import * as api from '../lib/api.js';
import { groupByWork, type WorkGroup } from '../lib/library.js';
import { toMarkdown } from '../lib/highlights.js';
import { fetchExportData } from '../lib/highlights-api.js';
import { shareCapability, shareLabel, shareOrCopy, shareTarget } from '../lib/share.js';
import { speak } from '../lib/speech.js';
import * as stashApi from '../lib/stash-api.js';
import {
  type LibraryFilter,
  type Stash,
  type StashNode,
  applyFilter,
  buildStashTree,
  flattenTree,
  newStashId,
} from '../lib/stashes.js';
import type { LibraryItem, SourceDelta } from '../lib/types.js';

/**
 * Everything the reader has kept, and — finally — somewhere to put it.
 *
 * `stashes` and four columns on `saved_items` have existed since round 1 with
 * nothing writing them: a reader could keep an unlimited number of things and
 * organise none of them. Deepstash named its product after this feature; we
 * named the table after it and never built the screen.
 *
 * Still grouped by source underneath, because that is what makes the Delta
 * meaningful — "3 of 21 still new to you" is a reason to open something again,
 * where a chronological dump is not. Collections sit above that grouping rather
 * than replacing it.
 */

const FILTERS: { id: LibraryFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'read-later', label: 'Read later' },
  { id: 'archived', label: 'Archived' },
];

export function Library({ userId }: { userId: string }) {
  const [items, setItems] = useState<LibraryItem[] | null>(null);
  const [stashes, setStashes] = useState<Stash[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [openWork, setOpenWork] = useState<string | null>(null);
  const [delta, setDelta] = useState<Record<string, SourceDelta>>({});
  const [filter, setFilter] = useState<LibraryFilter>('all');
  const [stashId, setStashId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /*
   * Everything the reader has marked or written, as a file they keep.
   *
   * Readwise's business is getting highlights back out into Obsidian, Notion and
   * the rest. Rather than build an integration per destination, this writes
   * plain Markdown: it opens in all of them, needs an account nowhere, and
   * cannot rot when somebody's API changes. It is also the only posture
   * consistent with the pitch — a product whose claim is that nothing worth
   * having sits behind a wall should not put the reader's own words behind one.
   */
  async function exportHighlights() {
    setBusy(true);
    try {
      const sources = await fetchExportData(userId);
      const markdown = toMarkdown(sources, new Date());
      const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `what-a-pull-highlights-${new Date().toISOString().slice(0, 10)}.md`;
      a.click();
      // Revoked on a later tick rather than immediately: the browser has not
      // necessarily started reading the blob by the time click() returns.
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      console.error('Could not export highlights', e);
      window.alert('Could not build the export just now.');
    } finally {
      setBusy(false);
    }
  }

  const load = useCallback(() => {
    let cancelled = false;
    Promise.all([api.fetchLibrary(userId), stashApi.fetchStashes(userId)])
      .then(([rows, s]) => {
        if (cancelled) return;
        setItems(rows);
        setStashes(s);
      })
      .catch((e: unknown) => {
        console.error('Library request failed', e);
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  useEffect(load, [load]);

  const tree = useMemo(() => buildStashTree(stashes), [stashes]);
  const flat = useMemo(() => flattenTree(tree), [tree]);

  const visible = useMemo(
    () => applyFilter(items ?? [], filter, stashId),
    [items, filter, stashId],
  );
  const groups = useMemo(() => groupByWork(visible), [visible]);

  /*
   * Applied to local state first, then sent.
   *
   * Every one of these is a last-write-wins update on one `saved_items` row, so
   * a failure is recoverable by doing it again — and waiting for a round trip
   * before moving a card into a folder makes organising a library feel like
   * filing a form. On failure the row is reloaded rather than rolled back
   * locally, because the server is the thing that knows what actually landed.
   */
  function patchSave(item: LibraryItem, patch: stashApi.SavePatch) {
    setItems((prev) =>
      (prev ?? []).map((i) =>
        i.saveId === item.saveId
          ? {
              ...i,
              stashId: patch.stashId !== undefined ? patch.stashId : i.stashId,
              note: patch.note !== undefined ? patch.note : i.note,
              archived: patch.archived !== undefined ? patch.archived : i.archived,
              readLater: patch.readLater !== undefined ? patch.readLater : i.readLater,
            }
          : i,
      ),
    );
    stashApi.updateSavedItem(item.saveId, patch).catch((e: unknown) => {
      console.error('Could not update the save', e);
      load();
    });
  }

  async function addStash() {
    const name = window.prompt('Name this collection');
    if (!name?.trim()) return;
    setBusy(true);
    // The id is minted here rather than by the database, so a retry after a lost
    // response collides on the primary key instead of creating a second folder
    // with the same name. See `createStash`.
    const stash: Stash = {
      id: newStashId(),
      name: name.trim(),
      description: null,
      parentId: stashId,
      position: stashes.length,
    };
    setStashes((prev) => [...prev, stash]);
    try {
      await stashApi.createStash(userId, stash);
    } catch (e) {
      console.error('Could not create the collection', e);
      load();
    } finally {
      setBusy(false);
    }
  }

  async function removeStash(node: StashNode) {
    /*
     * `stashes.parent_id` is `on delete cascade` while `saved_items.stash_id` is
     * `on delete set null` — one word apart in the same migration, opposite
     * consequences. So the children go and the saves stay, and the reader is
     * told which before they agree to it rather than after.
     */
    const childCount = flattenTree(node.children).length;
    const warning = childCount
      ? `Delete “${node.name}” and ${childCount} collection${childCount === 1 ? '' : 's'} inside it? Nothing you have kept is deleted.`
      : `Delete “${node.name}”? Nothing you have kept is deleted.`;
    if (!window.confirm(warning)) return;

    setBusy(true);
    try {
      await stashApi.deleteStash(node.id);
      if (stashId === node.id) setStashId(null);
    } catch (e) {
      console.error('Could not delete the collection', e);
    } finally {
      setBusy(false);
      load();
    }
  }

  function toggle(group: WorkGroup) {
    const next = openWork === group.key ? null : group.key;
    setOpenWork(next);
    if (next && group.workId && !delta[group.workId]) {
      api
        .fetchSourceDelta(group.workId)
        .then((d) => setDelta((prev) => ({ ...prev, [group.workId]: d })))
        .catch((e: unknown) => console.error('Could not load the source Delta', e));
    }
  }

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

  const activeStash = stashId ? flat.find((n) => n.id === stashId) : null;

  return (
    <div className="stack">
      <p className="meta">
        Library · {items.length} kept
        {visible.length !== items.length ? ` · ${visible.length} shown` : ''}
      </p>

      <div className="library__controls">
        {/*
          Filters as text, not as colour. Design law 5, and it is also the only
          way "Archived" reads as a place rather than as a state of the button.
        */}
        <div className="library__filters" role="group" aria-label="Filter">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              className="btn btn--plain library__filter"
              aria-pressed={filter === f.id}
              onClick={() => setFilter(f.id)}
            >
              {f.label}
            </button>
          ))}
        </div>

        <div className="library__collections">
          <span className="meta">Collections</span>
          <button
            type="button"
            className="btn btn--plain library__filter"
            aria-pressed={stashId === null}
            onClick={() => setStashId(null)}
          >
            Everything
          </button>
          {flat.map((node) => (
            <span key={node.id} className="library__collection">
              <button
                type="button"
                className="btn btn--plain library__filter"
                aria-pressed={stashId === node.id}
                style={{ marginLeft: `calc(${node.depth} * var(--space-3))` }}
                onClick={() => setStashId(node.id)}
              >
                {node.name}
              </button>
              <button
                type="button"
                className="btn btn--plain library__remove"
                onClick={() => void removeStash(node)}
                aria-label={`Delete the collection ${node.name}`}
                disabled={busy}
              >
                ×
              </button>
            </span>
          ))}
          <button
            type="button"
            className="btn btn--plain"
            onClick={() => void addStash()}
            disabled={busy}
          >
            New collection{activeStash ? ` inside ${activeStash.name}` : ''}
          </button>
          <button
            type="button"
            className="btn btn--plain"
            onClick={() => void exportHighlights()}
            disabled={busy}
          >
            Export highlights
          </button>
        </div>
      </div>

      {visible.length === 0 && (
        <p className="measure">
          {filter === 'archived'
            ? 'Nothing archived. Archiving keeps something without keeping it in front of you.'
            : filter === 'read-later'
              ? 'Nothing marked for later.'
              : 'Nothing in this collection yet. Move a save into it from below.'}
        </p>
      )}

      {groups.map((group) => {
        const open = openWork === group.key;
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
                <div key={item.id} className="library__item">
                  <PullCard
                    source={{ title: group.title, kind: group.kind }}
                    headline={item.headline}
                    body={item.body}
                    whyItMatters={item.whyItMatters}
                    sourceTrail={group.title}
                    saved
                    onListen={() => speak(`${item.headline}. ${item.body}`)}
                    onShare={() =>
                      void shareOrCopy(
                        shareTarget({
                          origin: window.location.origin,
                          pullId: item.id,
                          headline: item.headline,
                          workTitle: group.title,
                        }),
                      )
                    }
                    shareLabel={shareLabel(shareCapability(navigator))}
                  />

                  <div className="library__actions">
                    <label className="library__assign">
                      <span className="meta">Collection</span>{' '}
                      <select
                        className="field__input library__select"
                        value={item.stashId ?? ''}
                        onChange={(e) => patchSave(item, { stashId: e.target.value || null })}
                      >
                        <option value="">None</option>
                        {flat.map((n) => (
                          <option key={n.id} value={n.id}>
                            {'— '.repeat(n.depth)}
                            {n.name}
                          </option>
                        ))}
                      </select>
                    </label>

                    <button
                      type="button"
                      className="btn btn--plain library__filter"
                      aria-pressed={item.readLater}
                      onClick={() => patchSave(item, { readLater: !item.readLater })}
                    >
                      {item.readLater ? 'For later ✓' : 'Read later'}
                    </button>

                    <button
                      type="button"
                      className="btn btn--plain library__filter"
                      aria-pressed={item.archived}
                      onClick={() => patchSave(item, { archived: !item.archived })}
                    >
                      {item.archived ? 'Archived ✓' : 'Archive'}
                    </button>

                    <button
                      type="button"
                      className="btn btn--plain"
                      onClick={() => {
                        const next = window.prompt('A note on this idea', item.note ?? '');
                        if (next === null) return;
                        patchSave(item, { note: next.trim() || null });
                      }}
                    >
                      {item.note ? 'Edit note' : 'Add note'}
                    </button>
                  </div>

                  {item.note ? <p className="library__note">{item.note}</p> : null}
                </div>
              ))}
          </section>
        );
      })}
    </div>
  );
}
