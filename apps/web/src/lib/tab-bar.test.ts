import { describe, expect, it } from 'vitest';
import { overflowIsCurrent, splitNav, type NavItem } from './tab-bar.js';

const item = (key: string, current = false): NavItem => ({
  key,
  label: key,
  current,
  select: () => {},
});

const keys = (items: NavItem[]) => items.map((i) => i.key);

describe('splitNav', () => {
  it('gives every item a slot when they fit', () => {
    const items = [item('a'), item('b'), item('c')];
    const { primary, overflow } = splitNav(items);
    expect(keys(primary)).toEqual(['a', 'b', 'c']);
    expect(overflow).toEqual([]);
  });

  it('does not hide the fifth item behind a disclosure it does not need', () => {
    /*
     * The off-by-one worth having a test for. Reserving the "More" slot
     * unconditionally would push item five behind a press for no reason — a
     * disclosure holding exactly one thing that already had room on screen.
     */
    const items = ['a', 'b', 'c', 'd', 'e'].map((k) => item(k));
    const { primary, overflow } = splitNav(items);
    expect(keys(primary)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(overflow).toEqual([]);
  });

  it('spends the fifth slot on "More" as soon as there are six', () => {
    const items = ['a', 'b', 'c', 'd', 'e', 'f'].map((k) => item(k));
    const { primary, overflow } = splitNav(items);
    expect(keys(primary)).toEqual(['a', 'b', 'c', 'd']);
    expect(keys(overflow)).toEqual(['e', 'f']);
  });

  it('keeps the reader’s own sections in the bar, and the rest behind More', () => {
    // The real signed-in list: six sections then seven destinations.
    const items = [
      'For You',
      'Daily Pull',
      'Review',
      'Library',
      'History',
      'Preferences',
      'Explore',
      'Search',
      'Graph',
      'Import',
      'Progress',
      'Appearance',
      'Account',
    ].map((k) => item(k));
    const { primary, overflow } = splitNav(items);
    expect(keys(primary)).toEqual(['For You', 'Daily Pull', 'Review', 'Library']);
    expect(overflow).toHaveLength(9);
  });

  it('handles an empty list without inventing a disclosure', () => {
    expect(splitNav([])).toEqual({ primary: [], overflow: [] });
  });
});

describe('overflowIsCurrent', () => {
  it('reports the screen the reader is on when it is behind More', () => {
    expect(overflowIsCurrent([item('Graph'), item('Account', true)])).toBe(true);
  });

  it('is false when nothing hidden is current, empty included', () => {
    expect(overflowIsCurrent([item('Graph'), item('Account')])).toBe(false);
    expect(overflowIsCurrent([])).toBe(false);
  });
});
