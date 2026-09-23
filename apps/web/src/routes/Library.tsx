import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PullCard, SynapseMap, type SynapseNode, textAtDepth } from '@wap/ui';
import * as api from '../lib/api.js';

import { groupByWork, type WorkGroup } from '../lib/library.js';
import { downloadText } from '../lib/download.js';
import { flattenHighlights, toCsvHighlights, toStashMarkdown } from '../lib/export-formats.js';
import { fetchHighlightsByPull } from '../lib/export-api.js';
import {
  exportFilename,
  exportSlug,
  stashExportItems,
  stashExportSources,
} from '../lib/export-rows.js';
import { toMarkdown } from '../lib/highlights.js';
import { countHighlights, fetchExportData } from '../lib/highlights-api.js';
import { graphAbsence, personalGraph, undirectedEdges } from '../lib/graph.js';
import { fetchKnowledgeGraph } from '../lib/graph-api.js';
import { queueIfOffline } from '../lib/offline.js';
import {
  isPlaying,
  isQueued,
  usePlayerActions,
  usePlayerSelection,
} from '../components/PlayerProvider.js';
import { RememberThis } from '../components/RememberThis.js';
import {
  countImportedItems,
  fetchImportedItems,
  fetchImportedWorks,
  fetchImports,
  importBatchLabel,
  importedSummary,
  isUndoable,
  undoImport,
  type ImportBatch,
  type ImportedItem,
} from '../lib/import-api.js';
import type { Track } from '../lib/player.js';
import { shareCapability, shareLabel, shareNote, shareOrCopy, shareTarget } from '../lib/share.js';
import { speechSupported } from '../lib/speech.js';
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
import type { KnowledgeGraphData, LibraryItem, SourceDelta } from '../lib/types.js';

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

/**
 * Whether this browser can speak at all, decided once — the same reasoning
 * `Feed` gives: a capability cannot change between renders, and a control that
 * cannot work is withheld rather than drawn dead.
 */
const CAN_SPEAK = speechSupported();

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
  /*
   * The same flag, readable IN THE SAME TICK.
   *
   * Three of the writers below guard on `busy` to stop a second invocation, and the
   * guard could not work: `busy` is the value this render captured, and `setBusy(true)`
   * does not change it — two `keydown` events dispatched before React commits both read
   * `false` and both proceed. That is precisely the case the guards were written for,
   * since the Enter path has no `disabled` to engage and key repeat fires once per
   * repeat. A ref is set synchronously, so the second call sees it, which is the same
   * answer `RememberThis` already uses for its own double-submit.
   */
  const busyRef = useRef(false);

  /** Take the flag if it is free. `false` means somebody else has it. */
  function claimBusy(): boolean {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    return true;
  }

  function releaseBusy() {
    busyRef.current = false;
    setBusy(false);
  }
  /*
   * The two native dialogs this screen used to open, as screen state.
   *
   * `naming` is the name field standing in for `window.prompt`; `armedStash` is
   * the collection whose delete has been pressed once, standing in for
   * `window.confirm`. Both follow `Account.tsx`, which does its confirmations
   * inline for reasons its header sets out at length, and closing the last of the
   * five native dialogs is the `docs/contributing-map.md` item this carries out.
   */
  const [naming, setNaming] = useState(false);
  const [newStashName, setNewStashName] = useState('');
  const [armedStash, setArmedStash] = useState<string | null>(null);
  /**
   * The save whose note is being written, and what has been typed into it.
   *
   * One at a time: two open notes would be two drafts to keep straight, and a
   * note is a thing a reader writes and then closes rather than a field they
   * leave open across a list.
   */
  const [noting, setNoting] = useState<{ saveId: string; text: string } | null>(null);

  /*
   * Focus a field when it appears, exactly once.
   *
   * An inline `ref={(el) => el?.focus()}` is a new function identity on every render,
   * so React detaches and reattaches it every time — and both fields are controlled,
   * so that is once per keystroke. `focus()` scrolls its element into view, so on a
   * phone the viewport was yanked back to the field on every character typed. Held in
   * a `useCallback` with no dependencies, the ref is the same function across renders
   * and React calls it only on mount and unmount, which is what the comments at the
   * call sites actually describe.
   */
  const focusOnMount = useCallback((el: HTMLInputElement | HTMLTextAreaElement | null) => {
    el?.focus();
  }, []);
  const [exportNote, setExportNote] = useState<string | null>(null);
  /*
   * Whether this screen is still on screen.
   *
   * An export is the longest read in the app and the reader is free to leave while it
   * runs. Without this, a failure after they navigate away either popped a modal over
   * another screen or set state on an unmounted component — which React 19 makes a silent
   * no-op, so the reader was told nothing at all and would press it again.
   */
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
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
   * The queue lives above the shell, so the Library hands it tracks rather than
   * speaking anything itself. This screen is where listening to a whole source
   * becomes worth having: a reader with fourteen kept ideas from one book has a
   * walk's worth of material and, until now, fourteen presses to hear it.
   */
  const player = usePlayerActions();
  const listening = usePlayerSelection();
  const trackFor = (item: LibraryItem, title: string): Track => ({
    id: item.id,
    title,
    text: textAtDepth(item, depth),
  });
  /*
   * The graph view's numbers come from `get_user_knowledge_graph` — the same RPC the
   * `/graph` destination reads — and not from anything derivable here.
   *
   * They were derived here, and that is what this replaces: `retrievability` was
   * `known / total` from the source Delta, which is a source-wide coverage ratio and
   * not this Pull's retrievability, falling back to a literal `0.9` whenever the Delta
   * had not been loaded — which is always, until the reader expands a group, because
   * `delta` is populated by `toggle()`. `stability` was the constant 14 and `status`
   * the constant 'solid'. So the Solid/Fading lattice, which is the whole point of the
   * view, was solid for everyone, always, on invented numbers.
   *
   * Loaded only when the reader actually opens the graph: it is one RPC, and the list
   * view has no use for it.
   */
  const [graph, setGraph] = useState<KnowledgeGraphData | null>(null);
  const [graphFilter, setGraphFilter] = useState<'all' | 'solid' | 'fading'>('all');
  const [selectedPullId, setSelectedPullId] = useState<string | null>(null);

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
    if (!claimBusy()) return;
    // Cleared on the way in, as `exportStash` does: a failure message from an earlier
    // attempt was left standing over a file that had just landed, and the comment below
    // claims a status line is spoken either way.
    setExportNote(null);
    try {
      const sources = await fetchExportData(userId);
      const now = new Date();
      downloadText(
        exportFilename(['highlights'], 'md', now),
        'text/markdown',
        toMarkdown(sources, now),
      );
      // Said on success too, which is what makes the claim below true: the line was
      // written only on failure, so a blind reader pressing Export still got silence
      // when it worked.
      if (mounted.current) {
        setExportNote(`Exported ${sources.length} ${sources.length === 1 ? 'source' : 'sources'}.`);
      }
    } catch (e) {
      console.error('Could not export highlights', e);
      // The same live region the collection export writes to, and for the reason
      // stated there: `window.alert` blocks, cannot be read in the app's voice,
      // and on a phone is a system sheet that looks like it came from somewhere
      // else. A blind reader pressing Export got silence on success and a modal
      // on failure; a `role="status"` line is spoken either way.
      if (mounted.current) setExportNote('Could not build the export just now.');
    } finally {
      if (mounted.current) releaseBusy();
      else busyRef.current = false;
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

  useEffect(() => {
    if (viewMode !== 'graph' || graph !== null) return;
    let cancelled = false;
    void fetchKnowledgeGraph(userId).then((g) => {
      if (!cancelled) setGraph(g);
    });
    return () => {
      cancelled = true;
    };
  }, [viewMode, graph, userId]);

  /* Derived rather than a second piece of state: the effect above starts the moment the
     reader opens the graph, and `fetchKnowledgeGraph` resolves either way — it answers a
     failed RPC with `SAMPLE_GRAPH` rather than rejecting — so "graph mode with nothing
     loaded" is exactly "in flight". Holding it in state meant a `setState` in the body of
     an effect, which is a cascading render and a lint error. */
  const graphLoading = viewMode === 'graph' && graph === null;

  /*
   * The saved ideas the reader has actually read, with the retrievability the database
   * computed for them.
   *
   * Intersected rather than mapped over `visible`, because the two sets are not the
   * same: the Library is what was *saved*, the graph is what has a `knowledge_states`
   * row — what was *read*. A saved Pull that has never been read has no retrievability,
   * and the honest thing to do with it is leave it out of a retrievability lattice
   * rather than assign it a number. `graphMissing` below says so in words.
   *
   * A `seed` or `sample` graph is nobody's history, so it is not shown here at all —
   * see `GraphSource`. The `/graph` destination may present the seed corpus as a
   * demonstration; a view labelled "your library" may not.
   */
  const graphNodes: SynapseNode[] = useMemo(() => {
    const measured = personalGraph(graph);
    if (!measured) return [];
    const savedPullIds = new Set((visible ?? []).map((item) => item.id));
    return measured.nodes
      .filter((n) => savedPullIds.has(n.pullId))
      .map((n) => ({
        pullId: n.pullId,
        workId: n.workId,
        workTitle: n.workTitle,
        workKind: n.workKind,
        headline: n.headline,
        body: n.body,
        retrievability: n.retrievability,
        stability: n.stability,
        difficulty: n.difficulty,
        status: n.status,
      }));
  }, [graph, visible]);

  const graphEdges = useMemo(() => {
    if (!graph) return [];
    const ids = new Set(graphNodes.map((n) => n.pullId));
    return undirectedEdges(graph.edges.filter((e) => ids.has(e.fromPullId) && ids.has(e.toPullId)));
  }, [graph, graphNodes]);

  /** Saved ideas with no knowledge state yet — read nothing into their absence. */
  const graphMissing = (visible ?? []).length - graphNodes.length;

  const selectedNode = useMemo(
    () => graphNodes.find((n) => n.pullId === selectedPullId) ?? null,
    [graphNodes, selectedPullId],
  );

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

  /** How many collections go with the one whose delete is armed; -1 for the node itself. */
  const armedCount = armedStash === null ? 0 : descendantIds(tree, armedStash).size - 1;

  /*
   * What is filed in the selected collection — all of it, not what is on screen.
   *
   * `visible` is `applyFilter`, which hides archived saves, so exporting it would
   * produce a file named after a collection that is missing part of that
   * collection — and worse, one whose contents change with a filter the reader
   * set for reading rather than for exporting. Archiving is "out of the way", not
   * "gone": the row still carries `stash_id`. (An earlier version of this sentence added
   * "and the strip still counts it" -- the collections strip renders a name and a delete
   * button and counts nothing; the only count on screen excludes archived saves, which is
   * the argument for exporting the collection rather than against it.) So
   * the export is the collection, and the screen says so beside the button rather
   * than leaving the reader to discover the difference from the file.
   */
  const stashItems = useMemo(
    () => (stashId === null ? [] : (items ?? []).filter((i) => i.stashId === stashId)),
    [items, stashId],
  );

  /*
   * One collection, as a file the reader keeps.
   *
   * Two formats because they answer different questions and neither substitutes
   * for the other: the Markdown is the collection as prose — every Pull's summary,
   * why it matters, and the reader's note, marked as theirs — and the CSV is the
   * passages they marked, one row each, for somebody who wants to count or sort
   * or paste them somewhere. `toStashMarkdown` and `toCsvHighlights` write both.
   *
   * The Markdown needs nothing the screen has not already loaded, so it is built and
   * handed over without a second request. NOT "it works on a plane", which an earlier
   * version of this sentence claimed: `fetchLibrary` has no cached fallback, so a Library
   * opened offline renders the error branch and these buttons are never drawn at all. The
   * property is real and smaller than it was stated -- once the screen is up, this export
   * costs nothing. The CSV is about highlights, and a highlight is not part of a save, so
   * that one asks for them.
   */
  async function exportStash(format: 'markdown' | 'csv') {
    if (!activeStash) return;
    /*
     * GUARDED HERE AS WELL AS BY `disabled`, because the Markdown path never awaits.
     * A flag set and cleared inside one synchronous run batches into a single render, so
     * `disabled` never engages between two clicks and the reader gets the same file
     * twice, the second named "… (1).md".
     *
     * `claimBusy` alone does not fix that, and saying it did was the mistake: a ref
     * beats a second call in the SAME turn, and two clicks are two turns — the first
     * handler had already reached its `finally` and given the flag back. So the work is
     * yielded to a macrotask, which lets React commit the render that disables the
     * button before the download starts. The CSV path was safe by accident, its own
     * `await` doing the same thing; now neither depends on the accident.
     */
    if (!claimBusy()) return;
    setExportNote(null);
    await new Promise((resolve) => setTimeout(resolve, 0));
    try {
      const now = new Date();
      const slug = exportSlug(activeStash.name);
      if (format === 'markdown') {
        downloadText(
          exportFilename([slug], 'md', now),
          'text/markdown',
          toStashMarkdown(activeStash, stashExportItems(stashItems), now),
        );
      } else {
        const highlights = await fetchHighlightsByPull(
          userId,
          stashItems.map((i) => i.id),
        );
        downloadText(
          exportFilename([slug], 'csv', now),
          'text/csv',
          toCsvHighlights(flattenHighlights(stashExportSources(stashItems, highlights))),
        );
      }
    } catch (e) {
      console.error('Could not export the collection', e);
      /*
       * ON THE SCREEN, not in a modal. `window.alert` blocks, and an export that fails
       * after the reader has moved on put a dialog naming nothing over whatever they
       * navigated to. The note below the buttons is also a live region, so the outcome is
       * spoken -- a blind reader pressing Export got silence on success and a modal on
       * failure, and the convention for this exists twice already in this file.
       */
      if (mounted.current) setExportNote('Could not build the export just now.');
    } finally {
      if (mounted.current) releaseBusy();
      else busyRef.current = false;
    }
  }

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

  async function addStash(typed: string) {
    /*
     * Guarded here as well as by the button's `disabled`, for the reason `exportStash`
     * gives about its own guard: the Enter path has no disabled state to engage, and
     * key repeat fires it once per repeat before React can re-render the field away.
     * Each call mints its own `crypto.randomUUID()`, so the collide-on-retry protection
     * does not apply and the reader ends up deleting two identically named collections.
     * Through `claimBusy` rather than a bare `if (busy)`, which is what made the guard
     * real: the second keystroke arrives before the render that would have set it.
     */
    // Bounded to `stashes_name_length`: an over-long name queued offline would be
    // refused for good on drain, not shown back.
    //
    // BEFORE the latch, and that ordering is the whole of it: an empty name returns
    // here, and a return between claiming the latch and the `finally` that releases it
    // never gives it back. Pressing Enter on the empty field — which is where the
    // cursor already is, since the field mounts focused — wedged every guarded control
    // on the screen until the Library remounted.
    const name = typed.slice(0, 200);
    if (!name.trim()) return;
    if (!claimBusy()) return;
    setNaming(false);
    setNewStashName('');
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
      releaseBusy();
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

    /*
     * Armed, then done — the shape every destructive action in `Account.tsx`
     * takes, and for the reasons its header gives: a `window.confirm` cannot be
     * styled, cannot be read in the app's voice, and on a phone is a system sheet
     * that looks like it came from somewhere else. The first press states the
     * consequence beside the control and the second one carries it out, so the
     * warning is on screen where the reader is looking rather than over the top
     * of it.
     */
    if (armedStash !== node.id) {
      setArmedStash(node.id);
      return;
    }
    // The latch before the disarm, for the same reason in reverse: taking the
    // confirmation down and then bailing because another write is in flight tells the
    // reader their delete was cancelled when nothing was even attempted. Either this
    // deletes, or the × stays armed and they can press it again.
    if (!claimBusy()) return;
    setArmedStash(null);

    // Every collection in `doomed` goes, not only the one named — so a selection
    // pointing at any of them would survive the row it names and leave the
    // screen filtering by a collection that no longer exists.
    const clearSelection = () => {
      if (stashId !== null && doomed.has(stashId)) setStashId(null);
    };

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
      releaseBusy();
    }
  }

  /*
   * Fetch a source's Delta unless it is already held.
   *
   * Extracted because there are two ways into an open group now, and only one of them
   * used to do this: "Open in list" from the graph set `openWork` directly, so the group
   * expanded with no Delta and its "N of M still new to you" line — the reason the
   * Library groups by source at all — was simply missing until the reader collapsed it
   * and opened it again.
   */
  function ensureDelta(workId: string | null | undefined) {
    if (!workId || delta[workId]) return;
    api
      .fetchSourceDelta(workId)
      .then((d) => setDelta((prev) => ({ ...prev, [workId]: d })))
      .catch((e: unknown) => console.error('Could not load the source Delta', e));
  }

  function toggle(group: WorkGroup) {
    const next = openWork === group.key ? null : group.key;
    setOpenWork(next);
    if (next) ensureDelta(group.workId);
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
  /*
   * The empty screen is a BRANCH, not a second return, so that `<Imported />` below
   * keeps its place in the tree.
   *
   * It used to be rendered from both returns, which is two positions as far as React is
   * concerned: a reader on the empty screen who opened Imported (three requests), opened
   * a book (a fourth), then saved their first Pull had the component unmounted and
   * mounted again — disclosure closed, every fetch to pay for a second time. One mount,
   * below whichever body is drawn.
   */
  const empty = items.length === 0 ? emptyLibraryScreen(highlightCount) : null;
  const emptyBody = empty && (
    <>
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
    </>
  );

  return (
    <div className={empty ? 'stack measure' : 'stack'}>
      {emptyBody ?? (
        <>
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
                    aria-label={
                      armedStash === node.id
                        ? `Confirm deleting the collection ${node.name}`
                        : `Delete the collection ${node.name}`
                    }
                    disabled={busy}
                  >
                    {armedStash === node.id ? 'Delete' : '×'}
                  </button>
                  {/*
                The consequence, beside the control, only once it has been asked
                for. Said in what it costs the reader rather than in what it does
                to the database: `stashes.parent_id` is `on delete cascade` while
                `saved_items.stash_id` is `on delete set null` — one word apart in
                the same migration, opposite consequences — so the children go and
                the saves stay.
              */}
                  {armedStash === node.id ? (
                    <span className="meta" role="status">
                      {/*
                    One walk, hoisted. It was called twice here — once for the test and
                    once for the number — and a third time in `removeStash`, so the
                    count the sentence quotes and the set the delete acts on were
                    computed separately from the same tree.
                  */}
                      {armedCount > 0
                        ? `Deletes “${node.name}” and ${armedCount} inside it. Nothing you have kept is deleted.`
                        : `Deletes “${node.name}”. Nothing you have kept is deleted.`}{' '}
                      <button
                        type="button"
                        className="btn btn--plain"
                        onClick={() => setArmedStash(null)}
                      >
                        Never mind
                      </button>
                    </span>
                  ) : null}
                </span>
              ))}
              {naming ? (
                <span className="library__collection">
                  <label className="meta" htmlFor="new-stash-name">
                    Name it
                  </label>{' '}
                  <input
                    id="new-stash-name"
                    className="field__input library__name"
                    value={newStashName}
                    maxLength={200}
                    /*
                  Focused when it appears, through a ref rather than `autoFocus`.
                  The rule that forbids the prop is about a control that steals
                  focus on page load; this one exists because the reader has just
                  pressed a button asking for it, and leaving focus behind on a
                  button that is no longer there is the worse outcome — it is the
                  one thing `window.prompt` did right, and losing it would make
                  this replacement worse for exactly the keyboard readers the
                  replacement is for.
                */
                    ref={focusOnMount}
                    onChange={(e) => setNewStashName(e.target.value)}
                    onKeyDown={(e) => {
                      // Enter keeps it and Escape abandons it, because a field that can
                      // only be committed with the pointer is worse than the prompt it
                      // replaced for exactly the readers the prompt was worst for.
                      if (e.key === 'Enter') void addStash(newStashName);
                      if (e.key === 'Escape') {
                        setNaming(false);
                        setNewStashName('');
                      }
                    }}
                  />{' '}
                  <button
                    type="button"
                    className="btn"
                    disabled={busy || !newStashName.trim()}
                    onClick={() => void addStash(newStashName)}
                  >
                    Keep it
                  </button>{' '}
                  <button
                    type="button"
                    className="btn btn--plain"
                    onClick={() => {
                      setNaming(false);
                      setNewStashName('');
                    }}
                  >
                    Never mind
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  className="btn btn--plain"
                  onClick={() => setNaming(true)}
                  disabled={busy}
                >
                  New collection{nestTarget ? ` inside ${nestTarget.name}` : ''}
                </button>
              )}
              {/*
            Told, not silently corrected. The alternative was to disable this
            button, which would mean a reader who has selected their deepest
            collection cannot create any collection at all — so it stays live and
            names where the new one will land.
          */}
              {activeStash && !nestTarget ? (
                <span className="meta">
                  Collections go {MAX_DEPTH} deep. A new one inside “{activeStash.name}” would start
                  at the top instead.
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
              {/*
            Offered only with a collection selected, because that is the only
            state in which "this collection" names anything. Nothing here is
            gated: every reader who can make a collection can take it away
            again, on every plan, which is the whole of law 3's "unlimited
            history" being a fact rather than a claim.
          */}
              {activeStash ? (
                <span className="library__collection">
                  {/*
                `aria-disabled` rather than `disabled`, on both. A disabled element is not
                focusable, so the browser blurs it the moment `busy` flips — a keyboard
                reader who just pressed Export is returned to the top of the document and
                has to tab the whole page back to find out what happened. The handler's
                own `if (busy) return` is what actually refuses the second press.
              */}
                  <button
                    type="button"
                    className="btn btn--plain"
                    onClick={() => void exportStash('markdown')}
                    aria-disabled={busy}
                  >
                    Export “{activeStash.name}”
                  </button>
                  {/*
                An accessible name that says what it exports and from where. "as CSV" is
                the whole of it by rotor or tab otherwise, which passes `jsx-a11y` because
                it is *a* name — the delete button forty lines up already solves this.
              */}
                  <button
                    type="button"
                    className="btn btn--plain"
                    onClick={() => void exportStash('csv')}
                    aria-disabled={busy}
                    aria-label={`Export “${activeStash.name}” as CSV`}
                  >
                    as CSV
                  </button>
                </span>
              ) : null}
              <p className="meta" role="status">
                {exportNote ?? ''}
              </p>
              {/*
            Said before the download rather than discovered from the file. The
            count is the collection's, not the list's, and the two differ the
            moment a filter is on — which is precisely when a reader would
            otherwise assume the file matches what they are looking at.
          */}
              {activeStash ? (
                <span className="meta">
                  Markdown carries all {stashItems.length}{' '}
                  {stashItems.length === 1 ? 'save' : 'saves'} filed here, archived included. CSV
                  carries one row per passage you marked, so an idea you never highlighted or noted
                  is not in it.
                </span>
              ) : null}
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
            graphLoading ? (
              <p className="measure">Reading your knowledge graph…</p>
            ) : graphAbsence(graph) === 'unreachable' ? (
              <p className="measure">
                Could not reach your reading history just now, so there is nothing to plot. This
                view is built from it.
              </p>
            ) : graphNodes.length === 0 ? (
              <p className="measure">
                Nothing to plot yet. This view maps saved ideas you have read against how well you
                are holding on to them, so an idea appears here once you have read it at least once.
              </p>
            ) : (
              <>
                <SynapseMap
                  nodes={graphNodes}
                  edges={graphEdges}
                  height="540px"
                  filter={graphFilter}
                  onFilterChange={setGraphFilter}
                  selectedNodeId={selectedPullId}
                  onSelectNode={(n) => setSelectedPullId(n ? n.pullId : null)}
                />
                {/* A click on a node used to set `openWork`, which is only read inside the
                list branch — so in graph mode it produced nothing visible at all. The
                selection is shown here, next to the graph the reader clicked in. */}
                {selectedNode ? (
                  <div className="measure" style={{ marginTop: 'var(--space-3)' }}>
                    <p className="meta">
                      {selectedNode.workTitle} · {selectedNode.status} ·{' '}
                      {Math.round(selectedNode.retrievability * 100)}% retrievable
                    </p>
                    <p>{selectedNode.headline}</p>
                    <button
                      type="button"
                      className="btn btn--plain"
                      onClick={() => {
                        // A graph node always carries a real `workId` — `get_user_knowledge_graph`
                        // inner-joins `works` — and `groupByWork` keys a group by that id when
                        // it has one, falling back to `orphan:<pull id>` when it does not. So
                        // this opens the right group. Opening it is only half of it, though:
                        // the Delta has to be asked for too, which `toggle` does and this
                        // used not to.
                        setOpenWork(selectedNode.workId);
                        ensureDelta(selectedNode.workId);
                        setViewMode('list');
                      }}
                    >
                      Open in list
                    </button>
                  </div>
                ) : null}
                {graphMissing > 0 ? (
                  <p className="measure meta">
                    {graphMissing} more saved {graphMissing === 1 ? 'idea is' : 'ideas are'} not
                    plotted — either not read yet, or beyond the most recent ideas this map covers.
                  </p>
                ) : null}
              </>
            )
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
                          {d.new} of {d.total} published source ideas unverified
                        </span>
                      </>
                    )}
                  </p>

                  {/*
                A source is a listening session.
                `enqueue` de-duplicates on the Pull's id, so pressing this twice adds
                nothing the second time and pressing it after queueing two cards by hand
                adds only the twelve that were not already there. Withheld when the
                browser cannot speak, like every other Listen control.

                "This source", not "this collection". `groups` comes from `groupByWork`,
                so what this queues is every idea kept from one book — and a collection
                on this screen is a `stashes` row, the thing the New collection button
                above makes and the filter row selects. A reader who has filed their
                saves into collections read that label as the one they had picked.
              */}
                  {CAN_SPEAK && group.items.length > 0 && (
                    <button
                      type="button"
                      className="btn"
                      onClick={() =>
                        player.enqueue(group.items.map((item) => trackFor(item, group.title)))
                      }
                    >
                      Listen to this source
                    </button>
                  )}

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
                          listening={isPlaying(listening, item.id)}
                          onListen={
                            CAN_SPEAK
                              ? () => {
                                  if (isPlaying(listening, item.id)) player.stop();
                                  else player.playNow(trackFor(item, group.title));
                                }
                              : undefined
                          }
                          queued={isQueued(listening, item.id)}
                          onQueue={
                            CAN_SPEAK
                              ? () => {
                                  if (isQueued(listening, item.id)) player.remove(item.id);
                                  else player.enqueue([trackFor(item, group.title)]);
                                }
                              : undefined
                          }
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

                          {/*
                        The last of the five, and the worst of them: a note is up to
                        20,000 characters and `window.prompt` offered a single-line box
                        with no wrapping, no newlines and no way to see what was already
                        there. A textarea is what the field always needed.
                      */}
                          <button
                            type="button"
                            className="btn btn--plain"
                            aria-expanded={noting?.saveId === item.saveId}
                            onClick={() =>
                              setNoting(
                                noting?.saveId === item.saveId
                                  ? null
                                  : { saveId: item.saveId, text: item.note ?? '' },
                              )
                            }
                          >
                            {item.note ? 'Edit note' : 'Add note'}
                          </button>
                        </div>

                        {noting?.saveId === item.saveId ? (
                          <div className="stack">
                            <label className="field__label" htmlFor={`note-${item.saveId}`}>
                              A note on this idea
                            </label>
                            <textarea
                              id={`note-${item.saveId}`}
                              className="field__textarea"
                              rows={3}
                              maxLength={20000}
                              value={noting.text}
                              ref={focusOnMount}
                              onChange={(e) =>
                                setNoting({ saveId: item.saveId, text: e.target.value })
                              }
                            />
                            <p>
                              <button
                                type="button"
                                className="btn"
                                disabled={busy}
                                onClick={() => {
                                  const text = noting.text.trim();
                                  setNoting(null);
                                  // An emptied note is a removed note, which is what the
                                  // prompt did when the reader cleared it and pressed OK.
                                  patchSave(item, { note: text || null });
                                }}
                              >
                                Keep the note
                              </button>{' '}
                              <button
                                type="button"
                                className="btn btn--plain"
                                onClick={() => setNoting(null)}
                              >
                                Never mind
                              </button>
                            </p>
                          </div>
                        ) : item.note ? (
                          <p className="library__note">{item.note}</p>
                        ) : null}
                      </div>
                    ))}
                </section>
              );
            })
          )}
        </>
      )}

      {/*
        Reachable from the empty screen too, which it was not.
        `commit_import` saves each highlight, so the usual importer never sees that
        branch — but a reader who unsaves their imported highlights, or who undoes a
        batch (`undo_import` deletes the pulls, cascading `saved_items` while the
        `import_items` tombstones survive), lands there with their whole import history
        and its Undo controls behind it. `emptyLibraryScreen` counts the `highlights`
        table and cannot see imports.
      */}
      <Imported userId={userId} />
    </div>
  );
}

/**
 * The highlights a reader brought with them.
 *
 * Kept apart from the saved list above, and not merged into it, because they are a
 * different kind of thing: a save is an idea from the catalogue the reader chose to
 * keep, and an import is their own text, private, readable by nobody else, and
 * arriving four hundred at a time. Filing four hundred Kindle highlights into the
 * same list as eleven saved Pulls would bury the second under the first.
 *
 * Its own fetch, for the reason the Delta and the graph have theirs: two requests
 * that each render when they land beat one that makes the whole screen wait.
 */
function Imported({ userId }: { userId: string }) {
  const [open, setOpen] = useState(false);
  /*
   * The SHELF, not the books.
   *
   * `fetchImportedWorks` is one row per book and `countImportedItems` is one count
   * header with no rows at all, so opening this section costs two bounded requests
   * whatever the reader has. It used to walk `fetchImportedItems(userId)` — every
   * highlight they own, a hundred at a time, each carrying its pull's body — and then
   * group the result in memory purely to print a list of titles and a count. For the
   * reader this section describes, the one arriving with four hundred highlights (and
   * law 3 promises no ceiling above that), that is forty sequential round trips and
   * several megabytes before a single heading is drawn. `fetchImportedWorks`'s own
   * docstring names that pattern as the thing it was written to remove, and it was
   * written for Studio while this screen was left still doing it.
   *
   * Ordered by title rather than by most recent, which is the one thing the walk gave
   * that this does not: the newest highlight in a book is not something a query bounded
   * by books can see. The batches above are already in import order and say what
   * arrived last, so the recency question still has an answer on the screen; a shelf is
   * alphabetical.
   */
  const [state, setState] = useState<
    | { batches: ImportBatch[]; books: { workId: string; title: string }[]; total: number }
    | 'failed'
    | null
  >(null);
  const [undoing, setUndoing] = useState<string | null>(null);
  const undoingRef = useRef(false);
  /*
   * One book open at a time, and its highlights fetched when it opens.
   *
   * Rendering every group's items mounts one `<li>` and one `RememberThis` — with its
   * own reducer — per highlight, and this section's own copy describes a reader
   * arriving with four hundred of them. Four hundred reducers in one commit is a
   * visible stall on a phone, and it grows with what law 3 promises is unlimited. Now
   * the rows for the other books are not merely unrendered, they are never fetched.
   */
  const [openWork, setOpenWork] = useState<string | null>(null);
  const [items, setItems] = useState<{ workId: string; rows: ImportedItem[] } | null>(null);
  /*
   * Which ATTEMPT failed, for the reason `Studio.tsx` gives at its own two: a flag
   * would have to be cleared synchronously inside the effect that starts the next
   * fetch, and a key lets the render derive the stale message away instead.
   */
  const [itemsFailed, setItemsFailed] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  /*
   * Two counters, for the reason `Studio.tsx` gives at its own two: one drove both
   * effects, so Try again under a failed book re-ran the batch list, the shelf and the
   * count — three requests that had just succeeded — to retry a fourth.
   */
  const [reloads, setReloads] = useState(0);
  const [itemReloads, setItemReloads] = useState(0);

  /*
   * Loaded when the section is opened, not with the screen.
   *
   * It is three more round trips and a reader with no imports has no use for any of
   * them. The disclosure is what asks, which also means the cost is paid by the reader
   * who is about to look at the answer.
   */
  useEffect(() => {
    if (!open) return;
    let live = true;
    Promise.all([fetchImports(userId), fetchImportedWorks(userId), countImportedItems(userId)])
      .then(([batches, works, total]) => {
        if (live) {
          setState({
            batches,
            books: works.map((w) => ({ workId: w.workId, title: w.title })),
            total,
          });
        }
      })
      .catch((e: unknown) => {
        console.error('Could not load your imports', e);
        if (live) setState('failed');
      });
    return () => {
      live = false;
    };
  }, [open, userId, reloads]);

  /** The highlight fetch currently in flight, or the one that would be. */
  const itemsAttempt = openWork === null ? null : `${openWork}#${itemReloads}`;

  useEffect(() => {
    if (openWork === null || items?.workId === openWork) return;
    let live = true;
    const attempt = `${openWork}#${itemReloads}`;
    fetchImportedItems(userId, openWork)
      .then((rows) => {
        if (!live) return;
        setItems({ workId: openWork, rows });
        // Cleared on success, for the reason `Studio.tsx` gives at its own: the attempt
        // key records which fetch failed and nothing retires it, so re-opening a book
        // that failed once drew the alert over rows the refetch had just loaded.
        setItemsFailed(null);
      })
      .catch((e: unknown) => {
        console.error('Could not read that book’s highlights', e);
        if (live) setItemsFailed(attempt);
      });
    return () => {
      live = false;
    };
  }, [openWork, items?.workId, userId, itemReloads]);

  const loaded = state !== null && state !== 'failed' ? state : null;

  async function undo(batch: ImportBatch) {
    // A ref, for the reason the busy latch above is one: `disabled={undoing !== null}`
    // has not committed when a second click of a double-click runs, so both reached
    // `undoImport` — the second came back `alreadyUndone` and the reader was told their
    // batch had already been taken back, in a race over which answer landed last.
    if (undoingRef.current) return;
    undoingRef.current = true;
    setNote(null);
    setUndoing(batch.id);
    try {
      const result = await undoImport(batch.id);
      setNote(
        result.alreadyUndone
          ? 'That batch was already taken back.'
          : `Took back ${result.removed} ${result.removed === 1 ? 'highlight' : 'highlights'}.`,
      );
      /*
       * The open book closes, and its rows go with it. An undo can remove the very
       * highlights on screen and can empty a book off the shelf entirely, and the fetch
       * effect above skips a book whose rows it already holds — so keeping them would
       * leave deleted highlights rendered under a heading that no longer exists.
       */
      setOpenWork(null);
      setItems(null);
      // Back to `null` first, like the Try again path below and for the same reason: the
      // three counts on screen describe the library before this undo, so leaving them
      // standing kept "400 highlights from 6 books" and an Undo button for a batch that
      // is gone until the refetches landed.
      setState(null);
      setReloads((n) => n + 1);
    } catch (e: unknown) {
      console.error('Could not undo the import', e);
      setNote('Could not take that batch back just now. Nothing was removed.');
    } finally {
      undoingRef.current = false;
      setUndoing(null);
    }
  }

  return (
    <section className="stack">
      <h2 style={{ fontSize: 'var(--step-1)', margin: 0 }}>
        <button
          type="button"
          className="btn btn--plain"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          style={{ textAlign: 'left' }}
        >
          Imported highlights
        </button>
      </h2>

      {open && state === null && (
        <p className="meta" role="status">
          Loading…
        </p>
      )}

      {open && state === 'failed' && (
        <p className="meta" role="alert">
          Could not read your imports just now.{' '}
          <button
            type="button"
            className="btn btn--plain"
            onClick={() => {
              // Back to `null` first, so the retry has a loading state and a second
              // failure is something the reader can see. Bumping the counter alone left
              // `state` at `'failed'`: the same alert stayed on screen, and when the
              // retry failed too React bailed out of re-rendering an identical value —
              // so the button appeared to do nothing at all.
              setState(null);
              setReloads((n) => n + 1);
            }}
          >
            Try again
          </button>
        </p>
      )}

      {open && loaded && (
        <>
          <p className="meta">{importedSummary(loaded.total, loaded.books.length)}</p>

          {note && (
            <p className="meta" role="status">
              {note}
            </p>
          )}

          {/*
            The batches, with a way back out of each.
            An import is the one action in this app that writes hundreds of rows on
            one press, so it is the one that most needs an undo — and `undo_import`
            is idempotent and does not block re-importing the same file, so pressing
            it is recoverable in both directions.
          */}
          {loaded.batches.length > 0 && (
            <ul className="stack" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {loaded.batches.map((batch) => (
                <li key={batch.id} className="library__item">
                  <span className="meta">{importBatchLabel(batch)}</span>{' '}
                  {batch.undoneAt ? (
                    <span className="meta">· taken back</span>
                  ) : isUndoable(batch) ? (
                    <button
                      type="button"
                      className="btn btn--plain"
                      disabled={undoing !== null}
                      onClick={() => void undo(batch)}
                    >
                      {undoing === batch.id ? 'Taking it back…' : 'Undo this batch'}
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}

          {loaded.books.map((book) => {
            // `expanded`, not `open`: the section's own disclosure state is called
            // `open` in this component's scope, and a per-book binding of the same
            // name shadowed it — two booleans one letter apart, both true at once,
            // reading as the same thing.
            const expanded = openWork === book.workId;
            const rows = expanded && items?.workId === book.workId ? items.rows : null;
            return (
              <section key={book.workId} className="stack">
                <h3 style={{ fontSize: 'var(--step-0)', margin: 0 }}>
                  <button
                    type="button"
                    className="btn btn--plain"
                    aria-expanded={expanded}
                    style={{ textAlign: 'left' }}
                    onClick={() => {
                      // The failure key is `(book, retry counter)` and neither moves
                      // when a reader closes a book and opens it again — so a book that
                      // failed once drew its alert again over the refetch that was
                      // already in flight. Cleared in the event that causes the fetch.
                      setItemsFailed(null);
                      setOpenWork(expanded ? null : book.workId);
                    }}
                  >
                    {book.title}
                  </button>
                </h3>

                {expanded &&
                  (itemsFailed === itemsAttempt ? (
                    <p className="meta" role="alert">
                      Could not read that book’s highlights.{' '}
                      <button
                        type="button"
                        className="btn btn--plain"
                        onClick={() => setItemReloads((n) => n + 1)}
                      >
                        Try again
                      </button>
                    </p>
                  ) : rows === null ? (
                    <p className="meta" role="status">
                      Reading your highlights…
                    </p>
                  ) : (
                    <>
                      <p className="meta">
                        {rows.length} {rows.length === 1 ? 'highlight' : 'highlights'}
                      </p>
                      <ul className="stack" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                        {rows.map((item) => (
                          <li key={item.id} className="library__item">
                            <p style={{ margin: 0 }}>{item.body}</p>
                            {item.locator ? <p className="meta">{item.locator}</p> : null}
                            {/*
                              The same form the source page offers, not a second one. A
                              reader who has just kept four hundred highlights is precisely
                              the reader with something to practise, and `remember_pull`
                              makes the highlight due NOW rather than tomorrow — "Remember
                              this" is an explicit ask to practise.
                            */}
                            <RememberThis pullId={item.pullId} idPrefix="imported" />
                          </li>
                        ))}
                      </ul>
                    </>
                  ))}
              </section>
            );
          })}
        </>
      )}
    </section>
  );
}
