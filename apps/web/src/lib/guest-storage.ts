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
 * screen to suggest the account is not theirs. That is the one way this product can leak
 * one reader's material to another, and it does not need a bug to happen: it is what
 * "stay signed in" means, applied to an account nobody owns.
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
 * guest*. Anything unparseable is treated as not-a-guest too, which is the safe
 * direction — the cost of being wrong is a session that outlives a browser restart, and
 * the cost of guessing the other way is signing a real reader out when the shape of
 * supabase-js's stored value changes.
 */
export function tokenIsGuest(value: string): boolean {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== 'object' || parsed === null) return false;
    const user = (parsed as { user?: unknown }).user;
    if (typeof user !== 'object' || user === null) return false;
    return (user as { is_anonymous?: unknown }).is_anonymous === true;
  } catch {
    return false;
  }
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
  /** `true` only if the value actually landed. A store that refuses throws rather than no-ops. */
  const write = (store: KeyValueStore, key: string, value: string): boolean =>
    guard(() => {
      store.setItem(key, value);
      return true;
    }, false);

  return {
    /*
     * `sessionStorage` first, EXCEPT that an account with an address outranks a guest.
     *
     * The ordinary case is one store holding one token, and then this is just "wherever it
     * is". The tie is the interesting part, and a plain `??` got it wrong: `sessionStorage`
     * is per-tab while `localStorage` is shared, so a guest reading in tab A cannot see
     * that tab B has since signed in with an email address. Tab A's own `sessionStorage`
     * still holds the guest token; `localStorage` now holds the reader's. Preferring the
     * session copy would sign the converted reader back into the throwaway account they
     * just left — in the tab they are most likely to still have open.
     *
     * Resolved toward the account that can be recovered. A guest session is unreachable by
     * design once it is gone, so mistakenly keeping the reader's costs a browser refresh
     * and mistakenly keeping the guest's costs an account nobody can get back into.
     *
     * The fallback to `localStorage` is also the upgrade path: a guest whose token was
     * written there before this module existed keeps their session, and the first
     * `setItem` of the hour — supabase-js refreshes well inside `jwt_expiry` — moves it
     * across. Nobody is signed out by the deploy that adds this.
     */
    getItem: (key) => {
      const fromSession = guard(() => session.getItem(key), null);
      const fromLocal = guard(() => local.getItem(key), null);
      if (fromSession === null) return fromLocal;
      if (fromLocal === null) return fromSession;
      return tokenIsGuest(fromSession) && !tokenIsGuest(fromLocal) ? fromLocal : fromSession;
    },

    setItem: (key, value) => {
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
         * screen makes. A guest whose browser refuses `sessionStorage` keeps the session
         * in memory for as long as the page lives, and no longer.
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

    // Both, always. Signing out has to mean signed out wherever the token happened to be.
    removeItem: (key) => {
      guard(() => session.removeItem(key), undefined);
      guard(() => local.removeItem(key), undefined);
    },
  };
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
