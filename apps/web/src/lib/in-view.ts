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
 */
export const IN_VIEW_SHARE = 0.5;

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

export function onceInView(el: Element, onSeen: () => void): () => void {
  if (typeof IntersectionObserver === 'undefined') {
    onSeen();
    return () => {};
  }
  const observer = new IntersectionObserver(
    (entries) => {
      if (!entries.some((entry) => isGenuinelyInView(entry))) return;
      observer.disconnect();
      onSeen();
    },
    { threshold: [0, 0.1, 0.25, IN_VIEW_SHARE] },
  );
  observer.observe(el);
  return () => observer.disconnect();
}
