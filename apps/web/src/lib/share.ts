/**
 * Sharing one idea.
 *
 * The `og` Edge Function has been redirecting browsers to `/pull/:id` since
 * round 2, so the destination has existed the whole time — and until guest
 * reading landed it put a stranger on a sign-in form, which is why a share
 * button would have been worse than none. Now the link opens on the idea.
 *
 * Pure, so the URL construction and the capability decision can be tested in
 * `environment: 'node'` where `navigator` does not exist.
 */

/**
 * The canonical address for one Pull.
 *
 * Built from an explicit origin rather than read from `window` so the same
 * function answers in a test, and so a share never carries a preview host into
 * somebody else's inbox — `og` has been defaulting `APP_ORIGIN` to a Vercel
 * preview URL, which is exactly that failure from the other end.
 */
export function pullUrl(origin: string, pullId: string): string {
  const clean = origin.replace(/\/+$/, '');
  return `${clean}/pull/${encodeURIComponent(pullId)}`;
}

export type ShareOutcome = 'shared' | 'copied' | 'failed';

export interface ShareTarget {
  title: string;
  text: string;
  url: string;
}

/**
 * What a Pull looks like when it is handed to somebody else.
 *
 * The headline and the source, and nothing about the reader. A share is about
 * the idea; carrying "read by" into it would make the reader's history
 * something the recipient learns, which `docs/privacy.md` is explicit about not
 * doing anywhere else either.
 */
export function shareTarget(args: {
  origin: string;
  pullId: string;
  headline: string;
  workTitle: string | null;
}): ShareTarget {
  return {
    title: args.headline,
    text: args.workTitle ? `${args.headline} — ${args.workTitle}` : args.headline,
    url: pullUrl(args.origin, args.pullId),
  };
}

/** A description of what this browser can do, so the caller does not sniff twice. */
export interface ShareCapability {
  canShare: boolean;
  canCopy: boolean;
}

/**
 * Whether the operating system's share sheet is the right thing to open here.
 *
 * `navigator.share` exists on the desktop and should almost never be used there.
 * On Windows it hands the page to the system Share flyout, which takes focus,
 * enumerates the machine's contact list and installed apps, and — reported on
 * this app on 2026-09-06 — can wedge the whole desktop rather than only the tab.
 * The page cannot close it, cannot time it out, and cannot tell that it opened:
 * `share()` simply never settles. Nothing in this repository can make that sheet
 * behave, so the only fix available is not to ask for it.
 *
 * A pointer query rather than a user-agent string, because the question is not
 * which operating system this is — it is whether a share sheet is how this
 * device hands things to people. `(pointer: coarse)` describes the *primary*
 * pointer, so a phone and a tablet answer yes, and a laptop with a touchscreen
 * and a trackpad answers no, which is the answer that was wanted.
 *
 * Where the query cannot be asked at all, the answer is no. That is the safe
 * direction: the worst a copied link does is ask the reader to paste it.
 */
export function sheetIsNative(view: {
  matchMedia?: (query: string) => { matches: boolean };
}): boolean {
  if (typeof view.matchMedia !== 'function') return false;
  return view.matchMedia('(pointer: coarse)').matches === true;
}

export function shareCapability(
  nav: {
    share?: unknown;
    clipboard?: { writeText?: unknown };
  },
  /**
   * Passed in rather than sniffed, so this stays pure and the decision above is
   * stated by the caller — including in `environment: 'node'`, where neither
   * `matchMedia` nor a share sheet exists.
   */
  env: { sheetIsNative: boolean },
): ShareCapability {
  return {
    canShare: env.sheetIsNative && typeof nav.share === 'function',
    canCopy: typeof nav.clipboard?.writeText === 'function',
  };
}

/**
 * What this browser will actually do, read from the live globals.
 *
 * One reader for both the label and the act, because a control that says
 * "Share" and copies — or says "Copy link" and opens a sheet — is the same
 * small lie `shareLabel` exists to avoid, and two separate sniffs are how the
 * two answers drift apart.
 */
export function liveShareCapability(): ShareCapability {
  return shareCapability(navigator, { sheetIsNative: sheetIsNative(globalThis) });
}

/**
 * The label the control should carry.
 *
 * A button that says "Share" and silently copies a link is a small lie, and the
 * two do different things: one opens the operating system's sheet, the other
 * puts text on a clipboard the reader then has to paste. Naming which one is
 * about to happen costs nothing.
 */
export function shareLabel(capability: ShareCapability): string {
  if (capability.canShare) return 'Share';
  if (capability.canCopy) return 'Copy link';
  return 'Link';
}

/**
 * Do the share, whichever way this browser can.
 *
 * Lives beside the pure helpers rather than in an api module because it touches
 * no network and imports nothing: `navigator` is read at call time, so this file
 * still imports cleanly in `environment: 'node'` and its neighbours above stay
 * unit-tested.
 *
 * An abort is not a failure. `navigator.share` rejects with an `AbortError` when
 * the reader closes the sheet, and reporting "could not share" to somebody who
 * simply changed their mind is a worse outcome than saying nothing.
 *
 * There is deliberately no fall back to the sheet when the clipboard is missing.
 * Both APIs need a secure context, so a browser that has one and not the other is
 * a rounding error — and the one case where the clipboard is refused on a desktop
 * is exactly the case where opening the sheet is the thing `sheetIsNative`
 * exists to prevent.
 */
export async function shareOrCopy(target: ShareTarget): Promise<ShareOutcome> {
  const capability = liveShareCapability();

  if (capability.canShare) {
    try {
      await navigator.share(target);
      return 'shared';
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') return 'shared';
      // Fall through: some browsers advertise `share` and refuse this payload.
    }
  }

  if (capability.canCopy) {
    try {
      await navigator.clipboard.writeText(target.url);
      return 'copied';
    } catch {
      return 'failed';
    }
  }

  return 'failed';
}

/**
 * What to say once it is done, or null when the browser already said it.
 *
 * The outcome above was returned and discarded by every caller, which made the
 * two silent paths indistinguishable from each other and from nothing having
 * happened: a button reading "Copy link" copied and gave no sign, and a refused
 * clipboard — the permission a reader is most likely to have denied — did
 * nothing at all. A share sheet is its own confirmation, so only the paths the
 * reader cannot see get a sentence.
 */
export function shareNote(outcome: ShareOutcome): string | null {
  if (outcome === 'copied') return 'Link copied.';
  if (outcome === 'failed') return 'Could not copy the link. This browser did not allow it.';
  return null;
}
