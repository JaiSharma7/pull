/**
 * Call back once, the first time an element is genuinely on screen.
 *
 * "Genuinely" has two halves, and the first version of the interrupt's clock had
 * neither. `IntersectionObserver`'s first notification after `observe()` reports the
 * current state whatever the threshold, and `isIntersecting` is true for any overlap
 * at all -- so a card with one line in view counted as seen. And a card taller than
 * twice the viewport can never reach a ratio of one half, because the ratio is bounded
 * by `viewport / card`; on a phone a long cloze card would never have counted at all,
 * and the latency graders would have had no measurement to award `easy` on.
 *
 * So an element is in view when EITHER half of it is visible OR it fills half the
 * viewport, whichever comes first. The thresholds are stepped so a tall card scrolling
 * in produces notifications on the way to filling the viewport rather than only at a
 * ratio it cannot reach.
 *
 * Where there is no `IntersectionObserver` -- the test environment, an old browser --
 * the element is taken to be in view at once, which is what the caller would have
 * assumed before this existed. Returns a teardown; after `onSeen` fires it is a no-op.
 *
 * `IN_VIEW_THRESHOLDS` is exported for the one observer that cannot use `onceInView`
 * -- the feed's dwell timer, which needs the leaving notifications too -- so the two
 * agree on what a notification schedule looks like.
 */
export const IN_VIEW_SHARE = 0.5;
export const IN_VIEW_THRESHOLDS: readonly number[] = Array.from({ length: 21 }, (_, i) => i / 20);

export interface InViewEntry {
  isIntersecting: boolean;
  intersectionRatio: number;
  intersectionRect: { height: number };
  rootBounds: { height: number } | null;
}

/** Pure: the decision, so it can be tested without a browser. */
export function isGenuinelyInView(entry: InViewEntry, share = IN_VIEW_SHARE): boolean {
  if (!entry.isIntersecting) return false;
  if (entry.intersectionRatio >= share) return true;
  const viewport = entry.rootBounds?.height ?? 0;
  return viewport > 0 && entry.intersectionRect.height >= viewport * share;
}

export function onceInView(el: Element, onSeen: () => void, share = IN_VIEW_SHARE): () => void {
  if (typeof IntersectionObserver === 'undefined') {
    onSeen();
    return () => {};
  }
  // Once means once. A notification already queued when `disconnect()` ran can still
  // be delivered, and the caller's clock must not be restarted by it.
  let seen = false;
  const observer = new IntersectionObserver(
    (entries) => {
      if (seen || !entries.some((entry) => isGenuinelyInView(entry, share))) return;
      seen = true;
      observer.disconnect();
      onSeen();
    },
    // Dense, not stepped at a few round numbers (review finding): the viewport half is
    // only evaluated at a threshold crossing, and a card between 1.3x and 2x the
    // viewport crossed 0.25 too early and 0.5 too late to be caught at half a screen.
    // Twenty steps put a crossing within five percent of wherever the rule is met.
    { threshold: [...IN_VIEW_THRESHOLDS] },
  );
  observer.observe(el);
  return () => observer.disconnect();
}
