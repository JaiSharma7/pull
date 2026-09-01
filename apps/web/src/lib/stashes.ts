import { int, nonNull, nullableStr, rows, str } from './shape.js';

/**
 * Collections, minus the network.
 *
 * `stashes` and the four unused columns on `saved_items` have existed since
 * round 1 — `stash_id`, `note`, `archived`, `read_later`, all with RLS, all
 * always null or false. The Library grouped by source and offered nothing else,
 * so a reader could keep an unlimited number of things and organise none of them.
 *
 * The interesting logic is the tree, and it is all here rather than in the
 * screen: `parent_id` is self-referential, the database only forbids a stash
 * being its own parent, and nothing stops a longer cycle. A component that walks
 * that structure while rendering does not get a second chance.
 */

export const MAX_DEPTH = 3;

export interface Stash {
  id: string;
  name: string;
  description: string | null;
  parentId: string | null;
  position: number;
}

export interface StashNode extends Stash {
  depth: number;
  children: StashNode[];
}

export type LibraryFilter = 'all' | 'read-later' | 'archived';

/* --------------------------------------------------------------------------
 * Shaping
 * -------------------------------------------------------------------------- */

function shapeStash(r: Record<string, unknown>): Stash | null {
  const id = str(r.id);
  if (!id) return null;
  return {
    id,
    name: str(r.name),
    description: nullableStr(r.description),
    parentId: nullableStr(r.parentId) || null,
    position: int(r.position),
  };
}

export function shapeStashes(raw: unknown): Stash[] {
  return rows(raw).map(shapeStash).filter(nonNull);
}

/* --------------------------------------------------------------------------
 * The tree
 * -------------------------------------------------------------------------- */

/**
 * Flat rows to a tree, with two guards that are not optional.
 *
 * **Cycles.** `stashes.parent_id` references `stashes.id`, and the only thing
 * stopping `A → B → A` is that nobody has written it yet. A naive recursive
 * build on that data does not render a wrong tree, it hangs the tab. Any stash
 * that cannot reach a root within `MAX_DEPTH` hops is treated as a root instead,
 * so a cycle costs the reader a misplaced row rather than the screen.
 *
 * **Missing parents.** A stash whose parent was deleted is not corrupt — it is
 * what a `set null` or an unenforced delete leaves behind — and it becomes a
 * root for the same reason.
 *
 * Ordered by `position` then name, so two stashes created in the same second do
 * not swap places between loads.
 */
export function buildStashTree(stashes: readonly Stash[]): StashNode[] {
  const byId = new Map(stashes.map((s) => [s.id, s]));

  // Resolve each stash's real depth first, treating anything unreachable as a
  // root. Done as a separate pass so the tree build itself cannot recurse into
  // a cycle at all, rather than recursing carefully.
  const depthOf = new Map<string, number>();
  // The parent a stash is actually attached to, which is its stored `parent_id`
  // only when the chain above it resolved. Anything unreachable becomes a root.
  const attachTo = new Map<string, string | null>();

  for (const s of stashes) {
    let depth = 0;
    let cursor: Stash | undefined = s;
    const seen = new Set<string>([s.id]);

    while (cursor?.parentId) {
      const next: Stash | undefined = byId.get(cursor.parentId);
      // Parent deleted, or a cycle closing back on something already walked.
      if (!next || seen.has(next.id)) {
        depth = 0;
        break;
      }
      seen.add(next.id);
      depth += 1;
      if (depth >= MAX_DEPTH) {
        // Deeper than the product allows. Flattened rather than hidden: a row
        // the reader created must remain reachable.
        depth = 0;
        break;
      }
      cursor = next;
    }

    depthOf.set(s.id, depth);
    attachTo.set(s.id, depth === 0 ? null : (s.parentId ?? null));
  }

  const nodes = new Map<string, StashNode>(
    stashes.map((s) => [s.id, { ...s, depth: depthOf.get(s.id) ?? 0, children: [] }]),
  );

  const roots: StashNode[] = [];
  for (const s of stashes) {
    const node = nodes.get(s.id)!;
    const parentId = attachTo.get(s.id);
    const parent = parentId ? nodes.get(parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  const sort = (list: StashNode[]): StashNode[] => {
    list.sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
    for (const n of list) sort(n.children);
    return list;
  };

  return sort(roots);
}

/** Every stash at or beneath one, including itself. */
export function descendantIds(tree: readonly StashNode[], id: string): Set<string> {
  const found = new Set<string>();
  const walk = (nodes: readonly StashNode[], collecting: boolean) => {
    for (const n of nodes) {
      const take = collecting || n.id === id;
      if (take) found.add(n.id);
      walk(n.children, take);
    }
  };
  walk(tree, false);
  return found;
}

/** How far a subtree reaches below its own root. Zero for a leaf. */
function subtreeHeight(node: StashNode): number {
  let height = 0;
  for (const child of node.children) height = Math.max(height, subtreeHeight(child) + 1);
  return height;
}

/**
 * May this stash be moved under that one?
 *
 * Three ways it may not, and each is a real state the UI can offer: onto itself,
 * onto one of its own descendants (which is how a cycle gets written in the
 * first place), or somewhere that would push it past `MAX_DEPTH`. Returning a
 * boolean rather than throwing, because this is asked to decide whether to show
 * a control, not to recover from one.
 *
 * The depth test measures the whole subtree, not the node named. A move takes
 * everything beneath it along, so checking only the moved node's new depth
 * answers yes to a move that then re-roots its own children — `buildStashTree`
 * flattens whatever lands past the cap, silently, and the reader is told
 * nothing. `canNest(tree, 'sub', 'mid')` with `mid` at depth 1 and `sub`
 * holding a child is exactly that case.
 *
 * A `childId` the tree does not hold is a stash about to be created: it has no
 * children, so a height of zero is the honest answer and the create path can
 * ask this question before it writes a row.
 */
export function canNest(
  tree: readonly StashNode[],
  childId: string,
  parentId: string | null,
): boolean {
  if (parentId === null) return true;
  if (childId === parentId) return false;
  if (descendantIds(tree, childId).has(parentId)) return false;

  const parent = findNode(tree, parentId);
  if (!parent) return false;
  const child = findNode(tree, childId);
  return parent.depth + 1 + (child ? subtreeHeight(child) : 0) < MAX_DEPTH;
}

/**
 * Has this stash room for a new one inside it?
 *
 * The create path's half of `canNest`. A collection that does not exist yet has
 * no subtree to carry, so only the parent's depth decides — and asking it by
 * name rather than as `canNest(tree, someIdNotInTheTree, parentId)` keeps the
 * screen's question legible where it is asked.
 */
export function canNestNew(tree: readonly StashNode[], parentId: string | null): boolean {
  return canNest(tree, '', parentId);
}

export function findNode(tree: readonly StashNode[], id: string): StashNode | null {
  for (const n of tree) {
    if (n.id === id) return n;
    const inChild = findNode(n.children, id);
    if (inChild) return inChild;
  }
  return null;
}

/** Flatten for rendering, keeping the visual order and the depth for indentation. */
export function flattenTree(tree: readonly StashNode[]): StashNode[] {
  const out: StashNode[] = [];
  const walk = (nodes: readonly StashNode[]) => {
    for (const n of nodes) {
      out.push(n);
      walk(n.children);
    }
  };
  walk(tree);
  return out;
}

/* --------------------------------------------------------------------------
 * Filtering
 * -------------------------------------------------------------------------- */

export interface Filterable {
  archived: boolean;
  readLater: boolean;
  stashId: string | null;
}

/**
 * Archived is hidden everywhere except its own filter.
 *
 * That is the difference between archiving and deleting, and it has to hold in
 * the stash views too — otherwise "archived" means "hidden from one list", which
 * is not a promise anyone would rely on.
 *
 * The collection is applied first, and that order is the whole point: the two
 * are independent controls in the Library and neither resets the other, so with
 * the archive test in front, choosing "Archived" while a collection was selected
 * returned every archived save in the library — from every collection — while
 * the collection button still read `aria-pressed="true"`. A filter that ignores
 * the other control the reader is looking at makes that control dead.
 */
export function applyFilter<T extends Filterable>(
  items: readonly T[],
  filter: LibraryFilter,
  stashId: string | null = null,
): T[] {
  return items.filter((i) => {
    if (stashId !== null && i.stashId !== stashId) return false;
    if (filter === 'archived') return i.archived;
    if (i.archived) return false;
    if (filter === 'read-later' && !i.readLater) return false;
    return true;
  });
}

/**
 * Why the list is empty — in the reader's words, or null when it is not.
 *
 * An empty list has several causes and the screen used to name only one of
 * them: it said "Nothing in this collection yet" to a reader with no
 * collections at all, whose every save was archived. Three claims in one
 * sentence, all false, and no hint that Archived was where their library went.
 *
 * `all` is the case that hides things, because it drops archived saves — so an
 * empty `all` means either there is nothing here or everything here is
 * archived, and those are opposite instructions. The distinction is drawn from
 * the same rows the list is drawn from, and emptiness is asked of `applyFilter`
 * rather than restated, so the sentence and the list cannot disagree.
 *
 * Here rather than in the screen for the reason `catalogueSummary` is: a
 * sentence that can be wrong about the reader's own library is worth a test.
 */
export function emptyLibraryMessage(
  items: readonly Filterable[],
  filter: LibraryFilter,
  stashId: string | null = null,
  stashName: string | null = null,
): string | null {
  if (applyFilter(items, filter, stashId).length > 0) return null;

  // Named where there is a name to use: a collection the strip cannot show has
  // still been chosen, and "this collection" is true either way.
  const here = stashId === null ? null : stashName ? `“${stashName}”` : 'this collection';
  const inScope = stashId === null ? items : items.filter((i) => i.stashId === stashId);

  if (filter === 'archived') {
    return here
      ? `Nothing in ${here} is archived.`
      : 'Nothing archived. Archiving keeps something without keeping it in front of you.';
  }

  if (filter === 'read-later') {
    return here ? `Nothing in ${here} is marked for later.` : 'Nothing marked for later.';
  }

  if (inScope.length > 0) {
    return here
      ? `Everything in ${here} is archived. It is under Archived, not gone.`
      : 'Everything you have kept is archived. It is under Archived, not gone.';
  }

  return here ? `Nothing in ${here} yet. Move a save into it from below.` : 'Nothing kept yet.';
}

/** A client-minted id, so creating a stash is replayable after a lost response. */
export function newStashId(): string {
  return globalThis.crypto.randomUUID();
}
