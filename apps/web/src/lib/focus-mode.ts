/**
 * Focus mode — bigger reading on a screen that has room for it.
 *
 * The type scale is fluid but its ceilings are low: body copy tops out around 17px,
 * so a 2560px display renders the same 17px line as a phone inside a 544px column.
 * All that extra screen buys peripheral furniture and margin, and none of it reaches
 * the words. On a laptop that reads as a phone app someone stretched.
 *
 * The measure is not the thing to relax — a 1400px line is still unreadable. What is
 * wrong is the *physical size* of the type, so focus mode scales the type up and
 * scales the measure with it. Characters per line stay where they were; everything
 * just gets bigger. It also drops the rails, because a reader who has asked to focus
 * has said what they want the width for.
 *
 * A root attribute rather than React state, for the same reason `data-theme` is one:
 * the CSS owns the consequences, and a class threaded through the tree would put half
 * the rule in a stylesheet and half in a component.
 */

const KEY = 'wap:focus-mode';
const ATTR = 'data-focus';

/**
 * Read the stored preference.
 *
 * Every access is guarded. `localStorage` throws outright — not returns null — in a
 * browser set to block site data, and in that browser this would otherwise be the
 * exception that stops the app rendering at all. A reader who has blocked storage
 * still gets the app; they just get it with focus mode off.
 */
export function readStoredFocus(): boolean {
  try {
    return localStorage.getItem(KEY) === 'on';
  } catch {
    return false;
  }
}

export function storeFocus(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? 'on' : 'off');
  } catch {
    // A preference that cannot be remembered is still a preference that works now.
  }
}

/**
 * Reflect the state onto the document element.
 *
 * Removed rather than set to "off": `[data-focus]` with any value is a selector
 * somebody will eventually write, and an attribute that is present-but-off is the
 * kind of thing that makes a stylesheet true only by accident.
 */
export function applyFocus(
  on: boolean,
  root: { setAttribute(k: string, v: string): void; removeAttribute(k: string): void },
): void {
  if (on) root.setAttribute(ATTR, 'on');
  else root.removeAttribute(ATTR);
}

/*
 * The browser's own fullscreen, not only a CSS mode.
 *
 * Hiding the rails frees the app's chrome; it does nothing about the browser's. A
 * "full screen mode" that still shows tabs, an address bar and a bookmark strip has
 * not taken over the screen, and saying it has is the kind of claim this product is
 * supposed to be careful about.
 *
 * Everything here is best-effort by design. `requestFullscreen` rejects unless it is
 * called during a user gesture, iOS Safari does not implement it on iPhone at all, and
 * a kiosk or embedded context can forbid it outright. In every one of those cases the
 * CSS half still works and the reader still gets the larger type — so a rejection is
 * swallowed rather than surfaced. The one thing that must not happen is an unhandled
 * rejection taking down the click handler that also toggles the mode.
 */

/** Whether the browser will even entertain it. Used to decide, never to promise. */
export function fullscreenSupported(doc: Document): boolean {
  return typeof doc.documentElement.requestFullscreen === 'function';
}

export async function enterFullscreen(doc: Document): Promise<void> {
  if (!fullscreenSupported(doc) || doc.fullscreenElement) return;
  try {
    await doc.documentElement.requestFullscreen({ navigationUI: 'hide' });
  } catch {
    // Denied, unsupported, or not in a gesture. The CSS half carries the feature.
  }
}

export async function exitFullscreen(doc: Document): Promise<void> {
  if (!doc.fullscreenElement || typeof doc.exitFullscreen !== 'function') return;
  try {
    await doc.exitFullscreen();
  } catch {
    // Nothing to recover: the reader is already where they asked to be.
  }
}
