/**
 * How thirteen destinations become five slots on a phone.
 *
 * The masthead used to render every navigation item in one wrapping row. On a 393px
 * viewport that is four rows and roughly 200px of chrome before a reader sees a word —
 * a fifth of the screen spent on a list nobody reads, above the fold, on every screen.
 *
 * Five is not arbitrary. It is what a thumb can hit across the bottom of a phone at the
 * 44px minimum, and it is the count both platforms' own tab bars settle on for the same
 * reason. So the first four items keep a slot each, "More" takes the fifth, and
 * everything else lives behind it.
 *
 * Pure, and here rather than in the component, because the interesting cases are the
 * counts rather than the markup: a signed-out visitor has three items and must not be
 * given a "More" that opens onto nothing, and a list of exactly five must not lose its
 * last item to a disclosure it does not need.
 */
export type NavItem = {
  /** Stable across renders — a section id or a path, both unique within one list. */
  key: string;
  label: string;
  /*
   * What the bottom bar uses when the full label will not fit a fifth of a phone.
   *
   * A fifth of 393px is 78px, and "Daily Pull" in the mono chip face is wider than
   * that — so the slot truncated to "DAILY P…", which reads as a bug rather than as a
   * name. Shortening beats shrinking the type: a smaller face would be under the
   * minimum this whole change exists to respect, and it would break again the moment a
   * reader turns large text on. The rail and the "More" sheet have the room, so they
   * keep the full name and only the bar spends it.
   */
  short?: string;
  /** Whether the reader is looking at this now. Drives `aria-current`. */
  current: boolean;
  select: () => void;
};

/** Slots across the bottom bar, "More" included when there is one. */
export const SLOTS = 5;

export type NavSplit = {
  /** Items with a slot of their own. */
  primary: NavItem[];
  /** Items behind "More". Empty when everything fits, and then no "More" is drawn. */
  overflow: NavItem[];
};

export function splitNav(items: NavItem[], slots: number = SLOTS): NavSplit {
  // Everything fits, so nothing is hidden. A "More" holding one item costs the reader a
  // press to reach something that had room on screen.
  if (items.length <= slots) return { primary: items, overflow: [] };

  // One slot goes to "More" itself, so only `slots - 1` items keep theirs.
  return { primary: items.slice(0, slots - 1), overflow: items.slice(slots - 1) };
}

/**
 * Whether "More" is where the reader currently is.
 *
 * The bar marks the current item so somebody arriving mid-session can see where they
 * are. When that item is behind the disclosure, the disclosure has to say so, or the
 * one screen with no marked tab is the screen you are looking at.
 */
export function overflowIsCurrent(overflow: NavItem[]): boolean {
  return overflow.some((item) => item.current);
}
