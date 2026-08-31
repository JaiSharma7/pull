import { describe, expect, it } from 'vitest';
import {
  MAX_DEPTH,
  applyFilter,
  buildStashTree,
  canNest,
  descendantIds,
  findNode,
  flattenTree,
  shapeStashes,
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
