import { useEffect, useMemo, useState } from 'react';
import { PullCard, SynapseMap, type SynapseNode, textAtDepth } from '@wap/ui';
import * as api from '../lib/api.js';

import { groupByWork, type WorkGroup } from '../lib/library.js';
import { toMarkdown } from '../lib/highlights.js';
import { countHighlights, fetchExportData } from '../lib/highlights-api.js';
import { queueIfOffline } from '../lib/offline.js';
import { shareCapability, shareLabel, shareNote, shareOrCopy, shareTarget } from '../lib/share.js';
import { speak } from '../lib/speech.js';
import * as stashApi from '../lib/stash-api.js';
import {
  MAX_DEPTH,
  type LibraryFilter,
  type Stash,
  type StashNode,
  applyFilter,
  buildStashTree,
  canNestNew,
  descendantIds,
  detachSaves,
  emptyLibraryMessage,
  emptyLibraryScreen,
  flattenTree,
  newStashId,
  withoutStashes,
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
  /*
   * Highlights the reader has, whether or not they kept the Pull they are on.
   *
   * Only a count, and only so the empty state can tell "nothing here" apart from
   * "nothing kept, but your highlights are still yours". `fetchExportData` reads
   * highlights in a query of its own for the same reason.
   */
  const [highlightCount, setHighlightCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [openWork, setOpenWork] = useState<string | null>(null);
  const [delta, setDelta] = useState<Record<string, SourceDelta>>({});
  const [filter, setFilter] = useState<LibraryFilter>('all');
  const [stashId, setStashId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Bumped to ask for the library again — see the load effect. */
  const [attempt, setAttempt] = useState(0);
  /*
   * What the last share actually did, and which save it was for.
   *
   * `shareOrCopy` answers with one of three outcomes and every caller used to
   * throw it away: a button reading "Copy link" copied and gave no sign, and a
   * clipboard the browser refused did nothing at all — the same silence as
   * success. Kept per save so the answer appears beside the button pressed.
   */
  const [shareStatus, setShareStatus] = useState<{ saveId: string; note: string } | null>(null);
  /* One depth for the screen, for the reason the Feed keeps one: it is a reading
     preference, not a property of any single saved idea. */
  const [depth, setDepth] = useState(1);
  const [viewMode, setViewMode] = useState<'list' | 'graph'>('list');

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

  /*
   * One place that loads, and one way to ask for it again.
   *
   * The three write handlers below all reload after a failed write, and they
   * used to call the loader as a function — which discards the destructor it
   * returns, so its `cancelled` flag protected nothing and a reload outliving
   * the screen could still set state on it. Bumping `attempt` re-runs this
   * effect instead, and React holds the cleanup for every run of it.
   */
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api.fetchLibrary(userId),
      stashApi.fetchStashes(userId),
      // Caught here rather than at the end: a count that fails costs the reader
      // the export control, not their library.
      countHighlights(userId).catch(() => 0),
    ])
      .then(([rows, s, highlights]) => {
        if (cancelled) return;
        setItems(rows);
        setStashes(s);
        setHighlightCount(highlights);
        // A load that worked ends the failure before it. Without this the error
        // screen outlives its own cause: `error` was set in exactly one place
        // and cleared in none, so one flaky request replaced a working library
        // with a dead end until the reader thought to reload the page.
        setError(null);
      })
      .catch((e: unknown) => {
        console.error('Library request failed', e);
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [userId, attempt]);

  function reload() {
    setAttempt((n) => n + 1);
  }

  const tree = useMemo(() => buildStashTree(stashes), [stashes]);
  const flat = useMemo(() => flattenTree(tree), [tree]);

  const visible = useMemo(
    () => applyFilter(items ?? [], filter, stashId),
    [items, filter, stashId],
  );
  const groups = useMemo(() => groupByWork(visible), [visible]);

  const graphNodes: SynapseNode[] = useMemo(() => {
    return (visible ?? []).map((item) => {
      const d = item.work.id ? delta[item.work.id] : undefined;
      return {
        pullId: item.id,
        workId: item.work.id,
        workTitle: item.work.title,
        workKind: item.work.kind ?? 'book',
        headline: item.headline,
        body: item.body,
        retrievability: d ? d.known / Math.max(1, d.total) : 0.9,
        stability: 14,
        status: 'solid' as const,
      };
    });
  }, [visible, delta]);

  const activeStash = useMemo(
    () => (stashId === null ? null : (flat.find((n) => n.id === stashId) ?? null)),
    [flat, stashId],
  );

  /*
   * The collection a new one would actually be created inside.
   *
   * Null when the selected collection is already at the deepest level, because
   * `buildStashTree` re-roots anything past `MAX_DEPTH` — so a row written with
   * that parent renders at the top level on every load, permanently, and the
   * reader is never told which of the two things they are looking at. The
   * control names its destination instead, and `addStash` asks the same
   * question again at the moment it writes.
   */
  const nestTarget = activeStash && canNestNew(tree, activeStash.id) ? activeStash : null;

  /*
   * Why the list is empty, in words that are true of this library.
   *
   * The screen used to assume one cause — a collection the reader picked — and
   * said so to a reader with no collections at all, whose every save was
   * archived. `emptyLibraryMessage` decides from the same rows the list is drawn
   * from, so the sentence and the list cannot disagree.
   */
  const emptyMessage = useMemo(
    () => emptyLibraryMessage(items ?? [], filter, stashId, activeStash?.name ?? null),
    [items, filter, stashId, activeStash],
  );

  /*
   * Applied to local state first, then sent.
   *
   * Every one of these is a last-write-wins update on one `saved_items` row, so
   * a failure is recoverable by doing it again — and waiting for a round trip
   * before moving a card into a folder makes organising a library feel like
   * filing a form. On a failure the server actually answered, the row is
   * reloaded rather than rolled back locally, because the server is the thing
   * that knows what actually landed.
   *
   * A failure the network swallowed is the opposite case and used to be handled
   * as if it were the same one. Nothing knew anything, the write was dropped, and
   * `reload()` then asked a connection that had just failed for the whole library
   * — turning a working screen into the error state and losing the reader's
   * change in the same motion. Law 3 promises unlimited stashing; a promise that
   * only holds on wifi is a smaller promise. So it is queued and the optimistic
   * state stands, which is what the reader already sees.
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
    stashApi.updateSavedItem(item.saveId, patch).catch(async (e: unknown) => {
      if (await queueIfOffline(userId, e, { kind: 'organise', saveId: item.saveId, patch })) return;
      console.error('Could not update the save', e);
      reload();
    });
  }

  /*
   * The outcome of a share, said out loud.
   *
   * Cleared first rather than left standing: a second share that fails silently
   * beneath the previous "Link copied." would be worse than no message at all.
   */
  async function share(item: LibraryItem, workTitle: string) {
    setShareStatus(null);
    const outcome = await shareOrCopy(
      shareTarget({
        origin: window.location.origin,
        pullId: item.id,
        headline: item.headline,
        workTitle,
      }),
    );
    const note = shareNote(outcome);
    setShareStatus(note ? { saveId: item.saveId, note } : null);
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
      // `nestTarget`, not `stashId`: a parent past the depth cap is a parent the
      // tree ignores, and writing one produces a row whose stored `parent_id`
      // disagrees with every render of it. The button has already said where
      // this is going; this is that decision made once more against the same
      // predicate, at the only moment that writes anything.
      parentId: nestTarget?.id ?? null,
      position: stashes.length,
    };
    setStashes((prev) => [...prev, stash]);
    try {
      await stashApi.createStash(userId, stash);
    } catch (e) {
      // The id above is already minted, so the queued replay collides on the
      // primary key rather than creating a second folder with the same name.
      const queued = await queueIfOffline(userId, e, {
        kind: 'stash-create',
        stashId: stash.id,
        name: stash.name,
        parentId: stash.parentId,
      });
      if (!queued) {
        console.error('Could not create the collection', e);
        reload();
      }
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
    const doomed = descendantIds(tree, node.id);
    const childCount = doomed.size - 1;
    const warning = childCount
      ? `Delete “${node.name}” and ${childCount} collection${childCount === 1 ? '' : 's'} inside it? Nothing you have kept is deleted.`
      : `Delete “${node.name}”? Nothing you have kept is deleted.`;
    if (!window.confirm(warning)) return;

    // Every collection in `doomed` goes, not only the one named — so a selection
    // pointing at any of them would survive the row it names and leave the
    // screen filtering by a collection that no longer exists.
    const clearSelection = () => {
      if (stashId !== null && doomed.has(stashId)) setStashId(null);
    };

    setBusy(true);
    try {
      await stashApi.deleteStash(node.id);
      clearSelection();
      reload();
    } catch (e) {
      if (await queueIfOffline(userId, e, { kind: 'stash-delete', stashId: node.id })) {
        /*
         * Reloading is the one thing that must not happen here: the request that
         * just failed is the same one a reload would make. So the two foreign
         * keys are mirrored locally instead — `parent_id` cascades, `stash_id`
         * sets null — which is exactly what the reader was warned about and
         * exactly what the queued delete will do when it lands.
         */
        setStashes((prev) => withoutStashes(prev, doomed));
        setItems((prev) => (prev === null ? null : detachSaves(prev, doomed)));
        clearSelection();
      } else {
        console.error('Could not delete the collection', e);
        reload();
      }
    } finally {
      setBusy(false);
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

  /*
   * A failure with a way out of it, like every other screen in the app.
   *
   * The reachable path here is recovery rather than a cold load: a failed patch
   * asks for a reload, and if that reload also fails the reader lost a working
   * library to two unlucky requests. Search, Explore and Topic all offer this
   * button; the Library was the one that did not.
   */
  if (error)
    return (
      <section className="stack measure" role="alert">
        <p className="meta">Library</p>
        <h1>Could not load your library.</h1>
        <p>Something went wrong reaching the library. Nothing you have kept is affected.</p>
        <p className="meta">{error}</p>
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => {
            setError(null);
            setAttempt((n) => n + 1);
          }}
        >
          Try again
        </button>
      </section>
    );

  if (!items)
    return (
      <p className="meta" role="status">
        Loading…
      </p>
    );

  /*
   * Nothing kept is not the same as nothing to take away.
   *
   * This branch returns before the controls below it, and the export button was
   * one of them — so a reader with highlights and no saves could not reach the
   * one control that would have given them their own words back. `fetchExportData`
   * reads `highlights` and `saved_items` in separate queries precisely because a
   * highlight does not require a save, which is what makes that reader real.
   *
   * The offer is made only when there is something in it: with no saves there
   * are no notes either, so the highlight count is the whole of the export.
   */
  if (items.length === 0) {
    const empty = emptyLibraryScreen(highlightCount);
    return (
      <div className="stack measure">
        <p className="meta">Library</p>
        <h1>{empty.heading}</h1>
        <p>{empty.body}</p>
        {empty.exportable ? (
          <p>
            <button
              type="button"
              className="btn btn--plain"
              onClick={() => void exportHighlights()}
              disabled={busy}
            >
              Export highlights
            </button>
          </p>
        ) : null}
      </div>
    );
  }

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
            New collection{nestTarget ? ` inside ${nestTarget.name}` : ''}
          </button>
          {/*
            Told, not silently corrected. The alternative was to disable this
            button, which would mean a reader who has selected their deepest
            collection cannot create any collection at all — so it stays live and
            names where the new one will land.
          */}
          {activeStash && !nestTarget ? (
            <span className="meta">
              Collections go {MAX_DEPTH} deep. A new one inside “{activeStash.name}” would start at
              the top instead.
            </span>
          ) : null}
          <button
            type="button"
            className="btn btn--plain"
            onClick={() => void exportHighlights()}
            disabled={busy}
          >
            Export highlights
          </button>
        </div>

        <div className="library__filters" role="group" aria-label="View mode">
          <button
            type="button"
            className="btn btn--plain library__filter"
            aria-pressed={viewMode === 'list'}
            onClick={() => setViewMode('list')}
          >
            List
          </button>
          <button
            type="button"
            className="btn btn--plain library__filter"
            aria-pressed={viewMode === 'graph'}
            onClick={() => setViewMode('graph')}
          >
            Graph
          </button>
        </div>
      </div>

      {emptyMessage ? <p className="measure">{emptyMessage}</p> : null}

      {viewMode === 'graph' ? (
        <SynapseMap
          nodes={graphNodes}
          edges={[]}
          height="540px"
          onSelectNode={(n) => n && setOpenWork(n.workId)}
        />
      ) : (
        groups.map((group) => {
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
                      example={item.example}
                      explanation={item.explanation}
                      sourceTrail={group.title}
                      saved
                      depth={depth}
                      onDepthChange={setDepth}
                      onListen={() => speak(textAtDepth(item, depth))}
                      onShare={() => void share(item, group.title)}
                      shareLabel={shareLabel(shareCapability(navigator))}
                    />

                    {shareStatus?.saveId === item.saveId ? (
                      <p className="meta" role="status">
                        {shareStatus.note}
                      </p>
                    ) : null}

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
        })
      )}
    </div>
  );
}
