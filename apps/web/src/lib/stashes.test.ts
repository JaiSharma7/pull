import { describe, expect, it } from 'vitest';
import {
  MAX_DEPTH,
  applyFilter,
  buildStashTree,
  canNest,
  canNestNew,
  descendantIds,
  detachSaves,
  emptyLibraryMessage,
  emptyLibraryScreen,
  findNode,
  flattenTree,
  shapeStashes,
  withoutStashes,
  type Stash,
} from './stashes.js';

/**
 * The stash tree, and the two states the database permits that a renderer must
 * survive: a parent that no longer exists, and a cycle.
 *
 * `stashes.parent_id` references `stashes.id` and nothing forbids `A → B → A`.
 * A component that walks that while rendering does not draw a wrong tree — it
 * hangs the tab, and no error reaches anyone. So it is tested here, where the
 * failure is a red test rather than a frozen browser.
 */

const stash = (id: string, parentId: string | null = null, over: Partial<Stash> = {}): Stash => ({
  id,
  name: id.toUpperCase(),
  description: null,
  parentId,
  position: 0,
  ...over,
});

describe('buildStashTree', () => {
  it('nests children under their parent', () => {
    const tree = buildStashTree([stash('a'), stash('b', 'a'), stash('c', 'a')]);
    expect(tree).toHaveLength(1);
    expect(tree[0]?.children.map((c) => c.id)).toEqual(['b', 'c']);
    expect(tree[0]?.children[0]?.depth).toBe(1);
  });

  it('orders by position, then by name, so loads do not shuffle', () => {
    const tree = buildStashTree([
      stash('c', null, { position: 1, name: 'Zeta' }),
      stash('a', null, { position: 0, name: 'Beta' }),
      stash('b', null, { position: 0, name: 'Alpha' }),
    ]);
    expect(tree.map((n) => n.id)).toEqual(['b', 'a', 'c']);
  });

  it('treats a stash whose parent is gone as a root rather than losing it', () => {
    const tree = buildStashTree([stash('orphan', 'deleted-parent')]);
    expect(tree.map((n) => n.id)).toEqual(['orphan']);
    expect(tree[0]?.depth).toBe(0);
  });

  it('terminates on a two-node cycle instead of hanging', () => {
    // The whole reason this function exists. Nothing in the schema stops this
    // row pair being written.
    const tree = buildStashTree([stash('a', 'b'), stash('b', 'a')]);
    expect(flattenTree(tree)).toHaveLength(2);
  });

  it('terminates on a longer cycle too', () => {
    const tree = buildStashTree([stash('a', 'c'), stash('b', 'a'), stash('c', 'b')]);
    expect(flattenTree(tree)).toHaveLength(3);
  });

  it('flattens anything deeper than the product allows, rather than hiding it', () => {
    // a → b → c is the deepest permitted chain at MAX_DEPTH 3; d is one too far.
    const tree = buildStashTree([stash('a'), stash('b', 'a'), stash('c', 'b'), stash('d', 'c')]);
    const all = flattenTree(tree);
    expect(all).toHaveLength(4);
    expect(all.find((n) => n.id === 'd')?.depth).toBe(0);
    expect(all.find((n) => n.id === 'c')?.depth).toBe(MAX_DEPTH - 1);
  });

  it('never loses a row, whatever the shape', () => {
    const input = [stash('a'), stash('b', 'a'), stash('x', 'y'), stash('p', 'q'), stash('q', 'p')];
    expect(flattenTree(buildStashTree(input))).toHaveLength(input.length);
  });
});

describe('canNest', () => {
  const tree = buildStashTree([stash('a'), stash('b', 'a'), stash('c', 'b'), stash('other')]);

  it('refuses a stash onto itself', () => {
    expect(canNest(tree, 'a', 'a')).toBe(false);
  });

  it('refuses a stash onto its own descendant, which is how a cycle is written', () => {
    expect(canNest(tree, 'a', 'b')).toBe(false);
    expect(canNest(tree, 'a', 'c')).toBe(false);
  });

  it('refuses a move that would exceed the depth cap', () => {
    // `c` is already at the deepest level, so nothing may go beneath it.
    expect(canNest(tree, 'other', 'c')).toBe(false);
  });

  it('allows a legitimate move', () => {
    expect(canNest(tree, 'other', 'a')).toBe(true);
    expect(canNest(tree, 'other', 'b')).toBe(true);
  });

  it('refuses a move that fits the node but not the subtree hanging off it', () => {
    // The move takes the children along. Measuring only where `sub` lands says
    // yes, and then `buildStashTree` re-roots `leaf` — the flattening this cap
    // exists to prevent, performed silently by the guard meant to prevent it.
    const withSubtree = buildStashTree([
      stash('root'),
      stash('mid', 'root'),
      stash('sub'),
      stash('leaf', 'sub'),
    ]);
    expect(canNest(withSubtree, 'sub', 'mid')).toBe(false);
    // The leaf alone still fits there, and the subtree still fits one level up.
    expect(canNest(withSubtree, 'leaf', 'mid')).toBe(true);
    expect(canNest(withSubtree, 'sub', 'root')).toBe(true);
  });

  it('answers for a stash that does not exist yet, which is how a create is checked', () => {
    // A new collection has no children, so it is a leaf and only the parent's
    // depth decides. `Library` asks this before it writes the row.
    expect(canNest(tree, 'not-created-yet', 'b')).toBe(true);
    expect(canNest(tree, 'not-created-yet', 'c')).toBe(false);
  });
});

describe('canNestNew', () => {
  const tree = buildStashTree([stash('a'), stash('b', 'a'), stash('c', 'b')]);

  it('refuses a parent already at the deepest level', () => {
    // The bug this is the guard for: creating inside `c` wrote a row with `c` as
    // its parent that `buildStashTree` then rendered at the root, on every load,
    // permanently, with nothing said to the reader.
    expect(canNestNew(tree, 'c')).toBe(false);
    expect(canNestNew(tree, 'b')).toBe(true);
    expect(canNestNew(tree, 'a')).toBe(true);
  });

  it('always allows a collection at the top level', () => {
    expect(canNestNew(tree, null)).toBe(true);
  });

  it('always allows detaching to the root', () => {
    expect(canNest(tree, 'c', null)).toBe(true);
  });

  it('refuses a parent that does not exist', () => {
    expect(canNest(tree, 'a', 'nowhere')).toBe(false);
  });
});

describe('descendantIds and findNode', () => {
  const tree = buildStashTree([stash('a'), stash('b', 'a'), stash('c', 'b'), stash('other')]);

  it('includes the stash itself and everything beneath', () => {
    expect([...descendantIds(tree, 'a')].sort()).toEqual(['a', 'b', 'c']);
    expect([...descendantIds(tree, 'c')]).toEqual(['c']);
  });

  it('finds a node at any depth, and null for one that is absent', () => {
    expect(findNode(tree, 'c')?.id).toBe('c');
    expect(findNode(tree, 'nope')).toBeNull();
  });
});

describe('applyFilter', () => {
  const item = (
    id: string,
    over: Partial<{ archived: boolean; readLater: boolean; stashId: string | null }> = {},
  ) => ({
    id,
    archived: false,
    readLater: false,
    stashId: null,
    ...over,
  });

  const items = [
    item('plain'),
    item('later', { readLater: true }),
    item('gone', { archived: true }),
    item('later-and-gone', { readLater: true, archived: true }),
    item('in-stash', { stashId: 's1' }),
  ];

  it('hides archived items from every view except their own', () => {
    // The difference between archiving and deleting. If "archived" only hid
    // things from one list it would not be a promise anyone could rely on.
    expect(applyFilter(items, 'all').map((i) => i.id)).toEqual(['plain', 'later', 'in-stash']);
    expect(applyFilter(items, 'read-later').map((i) => i.id)).toEqual(['later']);
  });

  it('shows only archived items under the archived filter, read-later included', () => {
    expect(applyFilter(items, 'archived').map((i) => i.id)).toEqual(['gone', 'later-and-gone']);
  });

  it('narrows to one stash without losing the archive rule', () => {
    expect(applyFilter(items, 'all', 's1').map((i) => i.id)).toEqual(['in-stash']);
    expect(applyFilter(items, 'all', 'nope')).toEqual([]);
  });

  it('narrows the archived filter to the collection too, rather than ignoring it', () => {
    // Filter and collection are independent controls and neither resets the
    // other. With the archive test in front, choosing "Archived" inside a
    // collection showed every archived save in the library while the collection
    // button still reported itself pressed — a control with nothing behind it.
    const scoped = [
      item('gone-here', { archived: true, stashId: 's1' }),
      item('gone-elsewhere', { archived: true, stashId: 's2' }),
      item('gone-loose', { archived: true }),
      item('here', { stashId: 's1' }),
    ];
    expect(applyFilter(scoped, 'archived', 's1').map((i) => i.id)).toEqual(['gone-here']);
    expect(applyFilter(scoped, 'archived').map((i) => i.id)).toEqual([
      'gone-here',
      'gone-elsewhere',
      'gone-loose',
    ]);
  });
});

describe('emptyLibraryMessage', () => {
  const item = (
    id: string,
    over: Partial<{ archived: boolean; readLater: boolean; stashId: string | null }> = {},
  ) => ({ id, archived: false, readLater: false, stashId: null, ...over });

  it('says nothing while there is something to show', () => {
    expect(emptyLibraryMessage([item('plain')], 'all')).toBeNull();
  });

  it('tells a reader whose whole library is archived where it went', () => {
    // The reported lie: two saves, both archived, no collections at all, and a
    // screen that said "Nothing in this collection yet. Move a save into it
    // from below." — three claims, none of them true.
    const message = emptyLibraryMessage(
      [item('a', { archived: true }), item('b', { archived: true })],
      'all',
    );
    expect(message).toContain('Archived');
    expect(message).not.toContain('collection');
  });

  it('separates an empty collection from one whose saves are all archived', () => {
    const items = [item('a', { archived: true, stashId: 's1' })];
    expect(emptyLibraryMessage(items, 'all', 's1', 'Alpha')).toBe(
      'Everything in “Alpha” is archived. It is under Archived, not gone.',
    );
    expect(emptyLibraryMessage(items, 'all', 's2', 'Beta')).toBe(
      'Nothing in “Beta” yet. Move a save into it from below.',
    );
  });

  it('scopes the archived and read-later sentences to the collection in view', () => {
    const items = [item('a', { archived: true, stashId: 's2' }), item('b', { readLater: true })];
    expect(emptyLibraryMessage(items, 'archived', 's1', 'Alpha')).toBe(
      'Nothing in “Alpha” is archived.',
    );
    expect(emptyLibraryMessage(items, 'read-later', 's1', 'Alpha')).toBe(
      'Nothing in “Alpha” is marked for later.',
    );
    // Library-wide there is something archived, so there is nothing to say —
    // only the collection in view is empty of it.
    expect(emptyLibraryMessage(items, 'archived')).toBeNull();
    expect(emptyLibraryMessage([item('b')], 'archived')).toContain('Nothing archived.');
  });

  it('falls back to "this collection" when the name is not known', () => {
    expect(emptyLibraryMessage([item('a')], 'all', 'gone')).toBe(
      'Nothing in this collection yet. Move a save into it from below.',
    );
  });
});

describe('shapeStashes', () => {
  it('drops a row with no id and normalises an empty parent to null', () => {
    const out = shapeStashes([
      { name: 'no id' },
      { id: 's1', name: 'Kept', parentId: '', position: 2 },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.parentId).toBeNull();
    expect(out[0]?.position).toBe(2);
  });

  it('returns an empty list for anything that is not an array', () => {
    expect(shapeStashes(null)).toEqual([]);
    expect(shapeStashes({})).toEqual([]);
  });
});

/**
 * The screen a reader sees when they have kept nothing.
 *
 * "Nothing kept" and "nothing to take away" are different facts, and the Library
 * used to conflate them: it returned early with one sentence, and the export
 * control sat below that return in the branch a reader with no saves never
 * reaches. `fetchExportData` reads `highlights` and `saved_items` in separate
 * queries precisely because a highlight does not require a save — so that reader
 * is real, has a file waiting, and could not reach the button that builds it.
 */
describe('emptyLibraryScreen', () => {
  it('offers no export when there would be nothing in it', () => {
    // With no saves there are no notes either, so the highlights are the whole
    // of the export. None of them means the file would be empty, and a control
    // that writes an empty file is its own small lie.
    const screen = emptyLibraryScreen(0);
    expect(screen.exportable).toBe(false);
    expect(screen.body).not.toMatch(/highlight/);
  });

  it('offers the export to a reader who has highlights and has kept nothing', () => {
    const screen = emptyLibraryScreen(3);
    expect(screen.exportable).toBe(true);
    expect(screen.body).toContain('3 highlights already');
  });

  it('counts one highlight as one', () => {
    expect(emptyLibraryScreen(1).body).toContain('1 highlight already');
  });

  it('still invites the reader to save something either way', () => {
    // The offer is an addition to the empty state, not a replacement for it.
    for (const count of [0, 4]) {
      expect(emptyLibraryScreen(count).heading).toBe('Nothing kept yet.');
      expect(emptyLibraryScreen(count).body).toContain('Save a Pull from the feed');
    }
  });
});

/**
 * Deleting a collection, mirrored locally while offline.
 *
 * The two foreign keys are one word apart in the same migration and have
 * opposite consequences: `stashes.parent_id` is `on delete cascade`, so the
 * collections beneath go, while `saved_items.stash_id` is `on delete set null`,
 * so the saves stay and merely become unfiled. Offline the screen cannot reload
 * to find out which happened, so it has to know.
 */
describe('a deleted collection, mirrored locally', () => {
  it('takes every collection beneath it', () => {
    const doomed = new Set(['a', 'b']);
    const left = withoutStashes([stash('a'), stash('b', 'a'), stash('c')], doomed);
    expect(left.map((s) => s.id)).toEqual(['c']);
  });

  it('keeps every save and merely unfiles the ones that were inside', () => {
    // The single thing law 3 promises cannot happen: an unlimited library
    // destroyed by one click on a folder.
    const saves = [
      { id: 's1', stashId: 'b' },
      { id: 's2', stashId: 'c' },
      { id: 's3', stashId: null },
    ];
    expect(detachSaves(saves, new Set(['a', 'b']))).toEqual([
      { id: 's1', stashId: null },
      { id: 's2', stashId: 'c' },
      { id: 's3', stashId: null },
    ]);
  });

  it('returns untouched saves by identity, so nothing re-renders for nothing', () => {
    const saves = [{ id: 's2', stashId: 'c' }];
    expect(detachSaves(saves, new Set(['a']))[0]).toBe(saves[0]);
  });
});
