import { describe, expect, it } from 'vitest';
import { appendPage, lastPlacedAbsolute, rebaseSlots, weave } from './feed-items.js';
import type { FeedResponse, FeedRow, InterleaveSlot } from './types.js';

/**
 * `weave` was pure, untested, and on the core screen the whole product is read
 * through. These are written to fail against the bugs they describe — each one was
 * checked by reintroducing the fault and confirming the test goes red, because a
 * test that passes against the broken version is not a test.
 */

function row(id: string): FeedRow {
  // Only the fields these functions actually touch. `weave` moves rows around and
  // never reads into them, so a fuller fixture would assert nothing extra.
  return { id, headline: id, body: id } as unknown as FeedRow;
}

const slot = (slotIndex: number, kind = 'recall'): InterleaveSlot =>
  ({ slotIndex, kind }) as unknown as InterleaveSlot;

const rows = (n: number) => Array.from({ length: n }, (_, i) => row(`p${i}`));

describe('weave', () => {
  it('returns the rows untouched when nothing is planned', () => {
    const out = weave(rows(3), []);
    expect(out).toHaveLength(3);
    expect(out.every((i) => i.type === 'pull')).toBe(true);
    expect(out.map((i) => i.index)).toEqual([0, 1, 2]);
  });

  it('puts the question before the card at its index, not instead of it', () => {
    // The slot marks where the reader is interrupted; the card at that index still
    // has to be read. An earlier version that replaced the row silently dropped one
    // Pull per question from the session.
    const out = weave(rows(6), [slot(4)]);
    expect(out).toHaveLength(7);
    expect(out[4]).toMatchObject({ type: 'interrupt', index: 4 });
    expect(out[5]).toMatchObject({ type: 'pull', index: 4 });
  });

  it('asks about a card three back, never the one on screen', () => {
    // The whole point of the mechanic: recall, not recognition. If the question
    // named the card it interrupts, the answer would be visible while answering.
    const out = weave(rows(6), [slot(4)]);
    const interrupt = out.find((i) => i.type === 'interrupt');
    expect(interrupt?.row.id).toBe('p1');
  });

  it('reaches back only as far as the list allows', () => {
    // At index 2 there is no card three back, so it takes the earliest one rather
    // than reading off the front of the array.
    const out = weave(rows(4), [slot(2)]);
    const interrupt = out.find((i) => i.type === 'interrupt');
    expect(interrupt?.row.id).toBe('p0');
  });

  it('drops a slot at index 0, where there is nothing earlier to ask about', () => {
    // `Math.max(0, 0 - 3)` is 0 — the slot's own card. Honouring it would ask the
    // reader to recall something they are looking at.
    const out = weave(rows(3), [slot(0)]);
    expect(out).toHaveLength(3);
    expect(out.some((i) => i.type === 'interrupt')).toBe(false);
  });

  it('ignores a slot pointing past the end of the page', () => {
    // `get_feed` plans against the page size it was asked for; a short final page
    // must not produce a question with no card to attach to.
    const out = weave(rows(3), [slot(9)]);
    expect(out).toHaveLength(3);
    expect(out.some((i) => i.type === 'interrupt')).toBe(false);
  });

  it('places several questions independently', () => {
    const out = weave(rows(12), [slot(4), slot(9)]);
    expect(out.filter((i) => i.type === 'interrupt').map((i) => i.index)).toEqual([4, 9]);
  });

  it('keeps every row exactly once, whatever is woven in', () => {
    // The invariant that matters most: a question must never cost the reader a Pull.
    const out = weave(rows(12), [slot(0), slot(4), slot(9), slot(40)]);
    expect(out.filter((i) => i.type === 'pull').map((i) => i.row.id)).toEqual(
      rows(12).map((r) => r.id),
    );
  });
});

describe('rebaseSlots', () => {
  it('shifts page-relative indices into the accumulated list', () => {
    // Without this, page two's questions file against page one's cards.
    expect(rebaseSlots([slot(0), slot(5)], 20).map((s) => s.slotIndex)).toEqual([20, 25]);
  });

  it('leaves the first page alone', () => {
    const first = [slot(3)];
    expect(rebaseSlots(first, 0)).toBe(first);
  });

  it('does not mutate the slots it was given', () => {
    const original = [slot(3)];
    rebaseSlots(original, 10);
    expect(original[0]!.slotIndex).toBe(3);
  });

  it('carries the kind across, so the question stays the one that was planned', () => {
    expect(rebaseSlots([slot(1, 'say_it_back')], 20)[0]).toMatchObject({
      slotIndex: 21,
      kind: 'say_it_back',
    });
  });
});

describe('lastPlacedAbsolute', () => {
  it('is null when the page placed nothing', () => {
    // Not 0 — that is a real position, and the planner reads null as "no previous
    // placement" through its own sentinel.
    expect(lastPlacedAbsolute([], 20)).toBeNull();
  });

  it('reports the furthest placement in planner space', () => {
    expect(lastPlacedAbsolute([slot(2), slot(11)], 20)).toBe(31);
  });

  it('takes the maximum rather than the last element', () => {
    // The contract is "the furthest placement". Reading `slots.at(-1)` happens to
    // agree while the array is sorted, and stops agreeing the moment it is not.
    expect(lastPlacedAbsolute([slot(11), slot(2)], 20)).toBe(31);
  });

  it('is a real answer at the very start of a session', () => {
    expect(lastPlacedAbsolute([slot(0)], 0)).toBe(0);
  });
});

const page = (over: Partial<FeedResponse> = {}): FeedResponse => ({
  rows: rows(20),
  skippedKnownCount: 3,
  minutesSaved: 6,
  interleaveSlots: [],
  page: 0,
  ...over,
});

describe('appendPage', () => {
  it('starts a fresh feed from page 0', () => {
    const out = appendPage(null, page({ interleaveSlots: [slot(7)] }), 0);
    expect(out.rows).toHaveLength(20);
    expect(out.slots.map((s) => s.slotIndex)).toEqual([7]);
    expect(out.nextPage).toBe(1);
    expect(out.exhausted).toBe(false);
  });

  it('appends rather than replaces, so the reader keeps their place', () => {
    const first = appendPage(null, page(), 0);
    const out = appendPage(first, page({ page: 1 }), 20);
    expect(out.rows).toHaveLength(40);
    expect(out.nextPage).toBe(2);
  });

  it('shifts the new page slots so its questions land on its own cards', () => {
    // The bug this guards: without the rebase, page two's slot 2 files against
    // page one's third card — a question about something read twenty cards ago,
    // rendered in the middle of the new page.
    const first = appendPage(null, page(), 0);
    const out = appendPage(first, page({ page: 1, interleaveSlots: [slot(2)] }), 20);
    expect(out.slots.map((s) => s.slotIndex)).toEqual([22]);
  });

  it('computes lastPlaced in planner space, not render space', () => {
    // The two disagree whenever the reader loads a page without finishing the last:
    // 5 cards read, 20 rendered. `lastPlaced` must follow the planner.
    const first = appendPage(null, page(), 0);
    const out = appendPage(first, page({ page: 1, interleaveSlots: [slot(6)] }), 5);
    expect(out.lastPlaced).toBe(11);
  });

  it('keeps the previous placement when a page places nothing', () => {
    // Clearing it would reset the minimum gap and let the very next page open with
    // a question one card after the last one.
    const first = appendPage(null, page({ interleaveSlots: [slot(9)] }), 0);
    const out = appendPage(first, page({ page: 1, interleaveSlots: [] }), 20);
    expect(out.lastPlaced).toBe(9);
  });

  it('adds each page Delta to the session total', () => {
    const first = appendPage(null, page(), 0);
    const out = appendPage(first, page({ page: 1 }), 20);
    expect(out.skippedKnownCount).toBe(6);
    expect(out.minutesSaved).toBe(12);
  });

  it('lets an unmeasured page contribute nothing rather than erase the total', () => {
    // Understating what the Delta saved is survivable; claiming a number the
    // product cannot stand behind is not.
    const first = appendPage(null, page(), 0);
    const out = appendPage(
      first,
      page({ page: 1, skippedKnownCount: null, minutesSaved: null }),
      20,
    );
    expect(out.skippedKnownCount).toBe(3);
    expect(out.minutesSaved).toBe(6);
  });

  it('stays null until something has actually been measured', () => {
    const out = appendPage(null, page({ skippedKnownCount: null, minutesSaved: null }), 0);
    expect(out.skippedKnownCount).toBeNull();
    expect(out.minutesSaved).toBeNull();
  });

  it('marks the feed exhausted when a page comes back empty', () => {
    const first = appendPage(null, page(), 0);
    const out = appendPage(first, page({ page: 1, rows: [] }), 20);
    expect(out.exhausted).toBe(true);
    // The rows already on screen survive it — an empty page must not blank the feed.
    expect(out.rows).toHaveLength(20);
  });

  it('does not mutate the feed it was given', () => {
    const first = appendPage(null, page(), 0);
    appendPage(first, page({ page: 1 }), 20);
    expect(first.rows).toHaveLength(20);
    expect(first.nextPage).toBe(1);
  });

  it('a later page question reaches back into an earlier page', () => {
    // The payoff of accumulating: `weave` could not honour a slot near the start of
    // a page while each page stood alone, because the earlier cards were gone.
    const first = appendPage(null, page({ rows: rows(4) }), 0);
    const out = appendPage(first, page({ page: 1, rows: rows(4), interleaveSlots: [slot(0)] }), 4);
    const woven = weave(out.rows, out.slots);
    const interrupt = woven.find((i) => i.type === 'interrupt');
    expect(interrupt?.index).toBe(4);
    expect(interrupt?.row).toBe(out.rows[1]);
  });
});
