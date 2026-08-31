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
