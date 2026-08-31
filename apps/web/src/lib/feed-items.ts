/**
 * Turning a fetched page into the list the feed renders.
 *
 * Pure and free of React and of the Supabase client, so it can be tested at all —
 * `apps/web/vite.config.ts` runs vitest under `environment: 'node'`, and importing
 * `Feed.tsx` would drag in `api.ts`, which constructs the Supabase client and throws
 * without `VITE_*` env. `lib/routes.ts`, `lib/preferences.ts` and `lib/library.ts`
 * are split for exactly this reason.
 *
 * Together these are the whole of the pagination arithmetic, and they are worth
 * having in one file because they have to agree about which coordinate space they
 * are in. There are two, and confusing them is the bug this file exists to make
 * hard:
 *
 *   render space   an index into the accumulated `rows` array — what `weave` and the
 *                  DOM keys use. Grows by a page's length every time one is appended.
 *   planner space  `cardsBefore + slotIndex` — absolute *cards read this session*,
 *                  which is what `plan_interleave` measures its warm-up and its
 *                  minimum gap in. See `supabase/migrations/20260829135224_…sql`.
 *
 * They are not the same number. A reader who has read 5 of 20 rendered cards and
 * loads another page is at render index 20 and planner position 5.
 */
import type { FeedResponse, FeedRow, InterleaveSlot } from './types.js';

export type Item =
  | { type: 'pull'; row: FeedRow; index: number }
  | { type: 'interrupt'; slot: InterleaveSlot; row: FeedRow; index: number };

/**
 * How far back a question reaches for its subject.
 *
 * A slot replaces the card at its index with a question about an *earlier* card;
 * asking about something the reader has just this second read would be recognition,
 * not recall.
 */
const RECALL_LOOKBACK = 3;

/**
 * Weave the interrupt slots into the row list.
 *
 * `slots` must already be in render space — see `rebaseSlots`.
 *
 * The `i > 0` guard used to drop a slot at index 0 of every page, and the comment
 * defending it said the earlier pages' rows "are not in hand". That was true when
 * page 0 was the only page ever fetched and each page replaced the last. Now pages
 * accumulate, so at any index above the first the earlier cards genuinely are in
 * hand and the slot can be honoured.
 *
 * The guard stays, and now means only what it says: at the very first card of a
 * session there is nothing earlier to ask about, and `Math.max(0, i - 3)` would
 * resolve to the slot's own card — asking the reader to recall something still on
 * screen.
 */
export function weave(rows: FeedRow[], slots: InterleaveSlot[]): Item[] {
  const bySlot = new Map(slots.map((s) => [s.slotIndex, s]));
  const out: Item[] = [];
  rows.forEach((row, i) => {
    const slot = bySlot.get(i);
    if (slot && i > 0) {
      const earlier = rows[Math.max(0, i - RECALL_LOOKBACK)];
      if (earlier) out.push({ type: 'interrupt', slot, row: earlier, index: i });
    }
    out.push({ type: 'pull', row, index: i });
  });
  return out;
}

/**
 * Move a page's slots from page-relative indices into render space.
 *
 * `get_feed` returns `slotIndex` relative to the page it planned — slot 2 means the
 * third card *of that page*. Appending a page's rows to the ones already on screen
 * without shifting its slots would file every question against the first page's
 * cards, so page two's questions would land on page one's rows.
 */
export function rebaseSlots(slots: InterleaveSlot[], offset: number): InterleaveSlot[] {
  if (offset === 0) return slots;
  return slots.map((s) => ({ ...s, slotIndex: s.slotIndex + offset }));
}

/**
 * The planner-space position of the last question this page placed, for the next
 * page's `p_last_placed`.
 *
 * Without it the minimum gap resets at every page boundary: a question on the final
 * card of one page leaves slot 0 of the next immediately eligible, and the reader
 * gets two questions one card apart. `packages/ranking/src/interleave.test.ts` holds
 * a 3,000-seed regression test for exactly that.
 *
 * Takes the maximum rather than the last element — the contract is "the furthest
 * placement", and depending on the array already being sorted is the kind of
 * assumption that holds until it does not.
 *
 * Null when the page placed nothing, which is not the same as zero: zero is a real
 * position, and `plan_interleave` reads null as "no previous placement" via its
 * `coalesce(p_last_placed, -1000)` sentinel.
 *
 * Takes `slots` **as `get_feed` returned them** — page-relative, before `rebaseSlots`
 * — because the answer belongs in planner space. Passing already-rebased slots would
 * add the render offset on top of `cardsBefore` and push the gap far into the future,
 * silently suppressing every later question.
 */
export function lastPlacedAbsolute(slots: InterleaveSlot[], cardsBefore: number): number | null {
  if (slots.length === 0) return null;
  return cardsBefore + Math.max(...slots.map((s) => s.slotIndex));
}

/**
 * Every page the reader has loaded this sitting, as one list.
 *
 * Pages accumulate rather than replace. That is what makes a second page readable at
 * all — the previous page's cards stay on screen, so the reader keeps their place —
 * and it is also what lets a question at the start of a later page find a card to ask
 * about, which `weave` could not do while each page stood alone.
 */
export interface LoadedFeed {
  rows: FeedRow[];
  /** In render space: indices into `rows`, not into the page they came from. */
  slots: InterleaveSlot[];
  skippedKnownCount: number | null;
  minutesSaved: number | null;
  /** Planner space, for the next page's `p_last_placed`. */
  lastPlaced: number | null;
  nextPage: number;
  /** The last page came back empty — there is nothing further to load. */
  exhausted: boolean;
}

/**
 * Add a page's Delta to the running total.
 *
 * A null page contributes nothing rather than poisoning the total to null. That can
 * only understate what the Delta saved the reader, never overstate it, and this is
 * the one number in the product where the direction of the error matters: the rail
 * exists to say what a sitting was worth, and it must not claim more than it can
 * stand behind.
 */
function addDelta(prev: number | null, next: number | null): number | null {
  if (next === null) return prev;
  return (prev ?? 0) + next;
}

/**
 * Fold a freshly fetched page into what is already on screen.
 *
 * `cardsBefore` is the value that was sent as `p_cards_before` for *this* page — the
 * planner-space position its slots were planned against. It is not `rows.length`, and
 * the two drift apart as soon as a reader loads a page without having read all of the
 * previous one.
 */
export function appendPage(
  prev: LoadedFeed | null,
  page: FeedResponse,
  cardsBefore: number,
): LoadedFeed {
  const offset = prev?.rows.length ?? 0;
  return {
    rows: [...(prev?.rows ?? []), ...page.rows],
    slots: [...(prev?.slots ?? []), ...rebaseSlots(page.interleaveSlots, offset)],
    skippedKnownCount: addDelta(prev?.skippedKnownCount ?? null, page.skippedKnownCount),
    minutesSaved: addDelta(prev?.minutesSaved ?? null, page.minutesSaved),
    // Slots as the page returned them: `lastPlacedAbsolute` works in planner space,
    // so it must not see the render-space rebase. A page that placed nothing leaves
    // the previous page's placement standing rather than clearing the gap.
    lastPlaced: lastPlacedAbsolute(page.interleaveSlots, cardsBefore) ?? prev?.lastPlaced ?? null,
    nextPage: page.page + 1,
    exhausted: page.rows.length === 0,
  };
}
