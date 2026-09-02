/**
 * Where the auth token is kept, decided by whose token it is.
 *
 * A guest session is meant to behave like an incognito window: isolated, unlinked to any
 * identity, and gone when the browser is. The database half of that is
 * `sweep_guest_accounts`, which deletes the account a day after its last use
 * (20260901220000). This is the browser half, and without it the promise is only true of
 * the server: `localStorage` survives a browser restart, so on a shared or public machine
 * the next person to open the browser lands inside the previous guest's session — their
 * stashes, their notes, their history — with no sign-in wall in the way and nothing on
 * screen to suggest the account is not theirs. It does not need a bug to happen: it is
 * what "stay signed in" means, applied to an account nobody owns.
 *
 * It is NOT the only place one reader's material can reach another, and this comment said
 * it was until the review of #48. `lib/offline.ts` keeps the cached feed and any unsent
 * writes in IndexedDB, nothing in the app ever clears either store, and `readCachedPulls`
 * has no user filter -- so an offline load can render the previous person's cached feed to
 * whoever is at the machine. That is a real gap, it is filed separately, and closing this
 * one does not close it. `docs/privacy.md` says so rather than implying otherwise.
 *
 * So: a guest's token goes to `sessionStorage`, which the browser discards when the tab
 * is closed, and everybody else's stays in `localStorage`, where "stay signed in" is
 * exactly what a reader with an address wants.
 *
 * WHAT THIS COSTS, stated because it is user-visible and will look like a bug. A new tab
 * gets its own `sessionStorage`, so a guest who opens a link in one arrives as a signed-
 * out visitor rather than as themselves. Public routes (`/explore`, `/search`, a shared
 * source or Pull) still render, so the common case degrades to what a stranger sees
 * rather than to an error. A reader with an address is unaffected in every case.
 *
 * Two openings DO inherit a copy, and it is worth naming them precisely because the review
 * of #48 got this wrong in both directions before measuring it properly: duplicating the
 * tab, and `window.open`. Ordinary links do not — ctrl-click, middle-click and
 * `target="_blank"` are all noopener by default in current browsers, and were measured
 * returning an empty store in Chromium. This app calls `window.open` nowhere and sets
 * `rel="opener"` nowhere, so in practice a second tab is a signed-out visitor. Browser
 * session restore can also bring a tab's storage back. `docs/privacy.md` says all of this
 * to readers in one sentence rather than three.
 *
 * The decision reads the value being written rather than any state this module holds,
 * which is what makes it correct across a conversion. When a guest signs in with an
 * address the new token is not anonymous, so it is written to `localStorage` and the
 * `sessionStorage` copy is cleared in the same call — no stale guest token left behind to
 * be found by the fallback in `getItem`.
 */

/** The parts of `Storage` this needs. Narrowed so the tests can pass plain fakes. */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * Whether a stored auth token belongs to a guest.
 *
 * `=== true` for the same reason `isGuest` uses it: `is_anonymous` is absent from every
 * token minted before anonymous sign-ins were switched on, and absent means *not a
 * guest*.
 *
 * WHAT HAPPENS WHEN THE SHAPE IS NOT THE ONE WE EXPECT, which is the whole security
 * question here and which this function got wrong until the review of #48. The old rule
 * was "anything unreadable is not a guest", and not-a-guest is written to `localStorage` —
 * so a change in supabase-js's stored shape would silently put every guest token in
 * exactly the place the module exists to keep them out of, with no test failing.
 *
 * That is not hypothetical. The installed `@supabase/auth-js` ALREADY has a branch that
 * saves a session with the `user` key deleted (taken when `auth.userStorage` is
 * configured), and `@supabase/ssr` stores a base64 envelope. Either arriving through a
 * dependency bump would flip every guest to `localStorage`.
 *
 * So the answer now depends on whether the value looks like a session at all:
 *
 *   * not JSON, or not an object -> NOT a guest. This is the PKCE code verifier and the
 *     other non-session keys supabase-js keeps, and they must stay in `localStorage` or a
 *     sign-in link opened in a fresh tab has nothing to verify against.
 *   * an object with a readable `user` -> the claim decides. Absent `is_anonymous` means a
 *     token minted before anonymous sign-ins existed, which is a reader.
 *   * an object that carries an `access_token` but no readable `user` -> treated as a
 *     GUEST. This is the fail-closed case: a session we cannot classify is confined to the
 *     tab rather than persisted. The cost of being wrong is signing a reader out, which
 *     they can undo with an email; the cost of the other direction is handing the next
 *     person at a shared machine somebody's reading, which nobody can undo.
 */
export function tokenIsGuest(value: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return false;
  }
  if (typeof parsed !== 'object' || parsed === null) return false;
  const record = parsed as { user?: unknown; access_token?: unknown };
  const user = record.user;
  if (typeof user === 'object' && user !== null) {
    return (user as { is_anonymous?: unknown }).is_anonymous === true;
  }
  return typeof record.access_token === 'string';
}

/**
 * Every access is wrapped, because a storage accessor is not merely empty when a browser
 * has storage disabled — reading `window.sessionStorage` THROWS in that configuration,
 * and it throws at module scope here, before the app has rendered anything. A reader with
 * cookies blocked would get a blank page rather than a product that cannot remember them.
 */
function guard<T>(run: () => T, fallback: T): T {
  try {
    return run();
  } catch {
    return fallback;
  }
}

export function createSplitAuthStorage(
  session: KeyValueStore,
  local: KeyValueStore,
): KeyValueStore {
  /*
   * A per-tab record that THIS tab signed itself out.
   *
   * Needed because `removeItem` deliberately spares a reader's `localStorage` token when a
   * guest signs out, and `getItem` falls back to that store — so without a marker the tab
   * that just signed out immediately reads the reader back and is signed in as somebody
   * else. Round four of the review on #48 measured the consequence: the masthead went on
   * saying "READING AS A GUEST" while the next request left carrying the reader's JWT.
   *
   * It lives in `sessionStorage`, so it is scoped to the one tab that did the signing out
   * and dies with it — a reader in another tab is untouched, which is the whole point of
   * the exemption it complements. It survives a reload of this tab, which is correct: a
   * tab that signed out should still be signed out afterwards.
   *
   * Any `setItem` clears it, so signing in again in this tab works normally.
   */
  const signedOutKey = (key: string) => `${key}::tab-signed-out`;

  /** `true` only if the value actually landed. A store that refuses throws rather than no-ops. */
  const write = (store: KeyValueStore, key: string, value: string): boolean =>
    guard(() => {
      store.setItem(key, value);
      return true;
    }, false);

  return {
    /*
     * This tab's own storage first, always. No tie-break.
     *
     * It had one for a while, and reverting it is the most consequential line in this file.
     * Codex found that a stale guest tab could destroy a converted reader's session, which
     * was true and had two halves: the tab READ the guest token, and its next write then
     * REMOVED the reader's token from `localStorage`. The fix preferred the reader's token
     * here — and the security review of #48 showed what that costs:
     *
     *   A shared library machine. Bob is reading as a guest in tab A, so his token is in
     *   that tab's `sessionStorage`. Alice signs in with her email in tab B, so hers is in
     *   the shared `localStorage`. Bob reloads. Preferring the account with an address
     *   hands Bob Alice's session — her Library, her notes, her address on /account.
     *
     * There is no rule here that can tell "the same person converted in another tab" from
     * "a different person signed in on this machine", because at this layer the two are
     * the same two values. So the preference is resolved toward the SMALLER blast radius,
     * and cross-reader escalation is far larger than one tab of one person's own session
     * being out of date.
     *
     * Reverting it costs nothing that mattered, because the damaging half of Codex's
     * finding is fixed independently in `setItem`: a guest write never removes a non-guest
     * token. The converted reader's persistence survives either way. What changes is only
     * that a tab which never converted goes on being the guest it always was — which is
     * also the honest description of that tab.
     */
    getItem: (key) => {
      const fromSession = guard(() => session.getItem(key), null);
      if (fromSession !== null) return fromSession;

      // This tab signed out. It must not read a reader back out of the shared store and
      // silently become them; see `signedOutKey`.
      if (guard(() => session.getItem(signedOutKey(key)), null) !== null) return null;

      const fromLocal = guard(() => local.getItem(key), null);
      if (fromLocal === null) return null;

      /*
       * The upgrade path, and it MIGRATES rather than merely reading.
       *
       * A guest token written to `localStorage` before this module shipped is moved across
       * here, on the read, because waiting for a write does not work: auth-js's
       * `_recoverAndRefresh` deliberately does not re-persist a session it just loaded, and
       * it only refreshes inside a 90-second expiry margin. A guest who opens the app,
       * reads for ten minutes and closes the browser performs no `setItem` at all — so the
       * old comment here, which promised "the first setItem of the hour moves it across",
       * described a write that a short session never makes. Their token stayed in
       * `localStorage`, survived the restart, and greeted the next person at that machine.
       * Found live in the review of #48.
       *
       * The eviction is unconditional even when the `sessionStorage` write fails, because
       * `localStorage` is the one place this token must not be. The cost is that such a
       * guest is signed out at the next `getSession()` rather than at tab close: auth-js
       * keeps no in-memory session and re-reads storage every time. Losing a guest session
       * on a browser that refuses per-tab storage is the right side of that trade.
       */
      if (tokenIsGuest(fromLocal)) {
        write(session, key, fromLocal);
        guard(() => local.removeItem(key), undefined);
      }
      return fromLocal;
    },

    setItem: (key, value) => {
      // Any write supersedes a previous sign-out in this tab.
      guard(() => session.removeItem(signedOutKey(key)), undefined);
      const guest = tokenIsGuest(value);
      const [keep, clear] = guest ? [session, local] : [local, session];

      if (!write(keep, key, value)) {
        /*
         * The write did not land, so there is nothing yet to replace the old copy with.
         * Clearing here — which the first version did unconditionally — turns a full quota
         * into a silent sign-out: the call returns, supabase-js believes the session was
         * persisted, and the next reload finds nothing anywhere.
         *
         * A reader falls back to the other store: a session that lasts until the tab closes
         * is a poor second to a persisted one and a great deal better than none. A guest
         * does NOT, and that asymmetry is the feature rather than an oversight —
         * `localStorage` is the one place a guest token must never be, so the fallback that
         * would rescue this session is the fallback that breaks the promise the sign-in
         * screen makes. A guest whose browser refuses `sessionStorage` is signed out at the
         * next `getSession()` — auth-js keeps NO in-memory copy and re-reads storage on
         * every call, so "in memory until the page closes", which this comment used to
         * claim, describes a client that does not exist.
         */
        if (!guest) {
          write(clear, key, value);
          return;
        }
        /*
         * A guest gets no fallback, but an OLDER guest token in `localStorage` must still
         * go. That is the upgrade path: a token written there before this module shipped.
         * Returning without clearing it left the comment above telling a lie — the session
         * did not live "in memory for as long as the page lives", it went on being served
         * from `localStorage` by `getItem` on every load, surviving the browser restart
         * this module exists to end. Only a guest token is cleared here; a reader's is the
         * one thing this path must never touch.
         */
        const stranded = guard(() => clear.getItem(key), null);
        if (stranded !== null && tokenIsGuest(stranded)) {
          guard(() => clear.removeItem(key), undefined);
        }
        return;
      }

      /*
       * A guest write must never remove a reader's token, for the reason `getItem` gives:
       * the tab doing the writing may be a stale guest session that has no way of knowing
       * another tab converted. Removing here would undo the persistence of an account with
       * an address — the one kind that is supposed to survive — on a timer, whenever that
       * forgotten tab next refreshed.
       *
       * Every other combination still clears, which is what keeps exactly one copy: a
       * reader write always clears the guest copy, and a guest write clears an older guest
       * copy (the upgrade path above).
       */
      if (guest) {
        const displaced = guard(() => clear.getItem(key), null);
        if (displaced !== null && !tokenIsGuest(displaced)) return;
      }
      guard(() => clear.removeItem(key), undefined);
    },

    /*
     * Both, except that a guest signing out must not sign a READER out.
     *
     * This cleared both unconditionally, and the comment on `getItem` claimed the
     * converted reader's persistence was safe because `setItem` protects it. That was true
     * of `setItem` and false here — round two of the review on #48 measured it. Two ways in:
     * a guest presses "Yes — end it and sign in", or a guest tab left open past the sweep
     * gets a non-retryable refresh failure and auth-js calls `_removeSession()` itself.
     * Either way `localStorage` was wiped, so a reader signed in on that machine lost their
     * persisted session and got a `SIGNED_OUT` broadcast they never asked for. The one-day
     * sweep is what turns the second path from rare into routine.
     *
     * The guard is the mirror of the one in `setItem`: the two stores are only left
     * disagreeing when the tab doing the work is a guest and the shared store holds
     * somebody with an address. Every other combination still clears both, so an ordinary
     * sign-out still means signed out wherever the token happened to be.
     */
    removeItem: (key) => {
      const inSession = guard(() => session.getItem(key), null);
      const inLocal = guard(() => local.getItem(key), null);
      guard(() => session.removeItem(key), undefined);

      const guestLeaving = inSession !== null && tokenIsGuest(inSession);
      const readerStays = inLocal !== null && !tokenIsGuest(inLocal);
      if (guestLeaving && readerStays) {
        // Spare the reader's token, and record that THIS tab is nonetheless signed out --
        // otherwise `getItem`'s fallback hands this tab the very token it just spared.
        guard(() => session.setItem(signedOutKey(key), '1'), undefined);
        return;
      }

      guard(() => session.removeItem(signedOutKey(key)), undefined);
      guard(() => local.removeItem(key), undefined);
    },
  };
}

/**
 * Which account a stored token belongs to, or null if the value does not say.
 *
 * Exists because `sessionStorage` is per-tab and auth-js's cross-tab `BroadcastChannel`
 * is not: its broadcast handler calls `_notifyAllSubscribers` with a session it never
 * wrote to this tab's storage. With one shared `localStorage` that distinction never
 * mattered. With this module it does, so `App.tsx` needs to ask what THIS tab actually
 * holds rather than trusting the session it was handed.
 */
export function tokenUserId(value: string): string | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const user = (parsed as { user?: unknown }).user;
    if (typeof user !== 'object' || user === null) return null;
    const id = (user as { id?: unknown }).id;
    return typeof id === 'string' ? id : null;
  } catch {
    return null;
  }
}

/**
 * Whether a session handed to us by auth-js is one this tab actually holds.
 *
 * Pure, and separated from the storage read on purpose: this is the whole of the rule that
 * two listeners depend on, and round three of the review on #48 found it applied to only
 * one of them. A rule living in one `if` inside a React component is a rule the next
 * caller does not know exists.
 *
 * Null on both sides means "signed out, and this tab agrees" — a local sign-out clears
 * storage before it notifies, so that adopts. Null on one side only is a cross-tab
 * broadcast about somebody else, and is ignored.
 */
export function shouldAdoptSession(
  storedToken: string | null,
  sessionUserId: string | null,
): boolean {
  return (storedToken === null ? null : tokenUserId(storedToken)) === sessionUserId;
}

/**
 * Lazily reached, because naming a storage accessor is itself the thing that throws.
 *
 * A browser configured to block site data does not hand back an empty `Storage` — reading
 * `window.localStorage` raises. `guard` above catches that, but only for accesses made
 * THROUGH this module: passing `globalThis.sessionStorage` as an argument evaluates it at
 * the call site, at module scope, before any guard exists. The first version of this did
 * exactly that and rendered a blank page with `Error: storage disabled` for anyone with
 * cookies off — caught in Chromium with both accessors redefined to throw, which is now
 * the last case in the test file.
 *
 * So the store is picked per call rather than per client, inside the try/catch.
 */
function lazyStore(pick: () => KeyValueStore): KeyValueStore {
  return {
    getItem: (key) => pick().getItem(key),
    setItem: (key, value) => pick().setItem(key, value),
    removeItem: (key) => pick().removeItem(key),
  };
}

/** The storage `apps/web` hands to `createBrowserClient`. Reads nothing until asked. */
export function browserAuthStorage(): KeyValueStore {
  return createSplitAuthStorage(
    lazyStore(() => globalThis.sessionStorage),
    lazyStore(() => globalThis.localStorage),
  );
}
