import { useEffect, useId, useRef, useState } from 'react';
import { overflowIsCurrent, splitNav, type NavItem } from '../lib/tab-bar.js';

/**
 * The navigation a phone gets, and the reason the masthead no longer carries one.
 *
 * Below the rail's breakpoint every destination used to sit in one wrapping row under
 * the wordmark — thirteen of them, four rows deep, about a fifth of a 393px screen
 * spent before the first sentence of the thing the reader came for. It was also the
 * furthest place on a phone from the thumb holding it.
 *
 * So it moves to the bottom, where both platforms put it, and it keeps four items and a
 * disclosure. That is the same list the rail renders, in the same order, split by
 * `splitNav` — not a second list that can drift from it. The rail and this are two
 * presentations of one array, which is the property the masthead and the rail kept
 * losing when each filtered `DESTINATIONS` for itself.
 *
 * ── what makes it not a video feed's chrome ──────────────────────────────────────────
 *
 * Design law 7 asks a session to show its bounds, and a bar pinned to the bottom of the
 * viewport is exactly the shape a feed uses to hide them. The difference is what is in
 * it: named places with a marked current one, on an opaque ground with a hairline above
 * it — not a floating control that dissolves into the content behind it. It is drawn
 * with the same rule, the same mono chip type and the same single accent as everything
 * else; there is no shadow, no gradient and no rounding on it at all.
 *
 * ── the disclosure ───────────────────────────────────────────────────────────────────
 *
 * A disclosure rather than a modal dialog, deliberately. Nothing here needs a focus
 * trap, a backdrop or an inert page behind it: it is a list of links that replaces
 * itself when one is chosen. `aria-expanded` and `aria-controls` are the whole contract,
 * Escape closes it, and pressing "More" again closes it. A dialog would owe the reader
 * a returned focus and a trap, and would be a heavier promise than the thing keeps.
 */
export function TabBar({ items }: { items: NavItem[] }) {
  const [open, setOpen] = useState(false);
  const sheetId = useId();
  const { primary, overflow } = splitNav(items);
  const moreIsCurrent = overflowIsCurrent(overflow);

  /*
   * The sheet closes when the reader leaves the screen it was opened from.
   *
   * Selecting inside it closes it directly, but the tabs beside it, the Back button and
   * an in-page link all change where the reader is without touching this state — and a
   * list of somewhere-else hanging over the new screen is the kind of leftover chrome
   * that makes an app feel unmaintained. Keyed on the current item rather than on a
   * navigation event, because that is the thing that is actually stale.
   */
  const currentKey = items.find((i) => i.current)?.key ?? null;
  const openedAt = useRef<string | null>(null);
  useEffect(() => {
    if (!open) {
      openedAt.current = null;
      return;
    }
    if (openedAt.current === null) {
      openedAt.current = currentKey;
      return;
    }
    if (openedAt.current !== currentKey) setOpen(false);
  }, [open, currentKey]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  if (items.length === 0) return null;

  return (
    <div className="tabbar">
      {open && overflow.length > 0 && (
        <div className="tabbar__sheet" id={sheetId}>
          <nav aria-label="More places" className="tabbar__sheet-nav">
            {overflow.map((item) => (
              <button
                key={item.key}
                type="button"
                className="btn btn--plain tabbar__sheet-item"
                aria-current={item.current ? 'page' : undefined}
                onClick={() => {
                  setOpen(false);
                  item.select();
                }}
              >
                {item.label}
              </button>
            ))}
          </nav>
        </div>
      )}

      <nav aria-label="Sections" className="tabbar__row">
        {primary.map((item) => (
          <button
            key={item.key}
            type="button"
            className="btn btn--plain tabbar__item"
            aria-current={item.current ? 'page' : undefined}
            /*
             * The visible text shortens; the accessible name does not.
             *
             * WCAG 2.5.3 asks that the name contain the visible label, which "Daily
             * Pull" does for "Daily" — so this is the sanctioned shape rather than a
             * workaround. It also keeps one name for one destination across the rail,
             * the bar and the sheet, which is what a reader using voice control says
             * out loud and what a screen reader announces in both navigations.
             */
            aria-label={item.short ? item.label : undefined}
            onClick={() => {
              setOpen(false);
              item.select();
            }}
          >
            {item.short ?? item.label}
          </button>
        ))}

        {overflow.length > 0 && (
          <button
            type="button"
            className="btn btn--plain tabbar__item"
            aria-expanded={open}
            aria-controls={open ? sheetId : undefined}
            /*
             * Marked current when the screen the reader is on lives behind it. Without
             * this the one screen with nothing marked in the bar is the screen they are
             * looking at, which reads as the bar being broken rather than as the item
             * being elsewhere.
             */
            aria-current={moreIsCurrent && !open ? 'page' : undefined}
            onClick={() => setOpen((v) => !v)}
          >
            More
          </button>
        )}
      </nav>
    </div>
  );
}
