import { describe, expect, it } from 'vitest';
import {
  browserAuthStorage,
  createSplitAuthStorage,
  tokenIsGuest,
  type KeyValueStore,
} from './guest-storage.js';

function fake(): KeyValueStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

function throwing(): KeyValueStore {
  return {
    getItem: () => {
      throw new Error('storage disabled');
    },
    setItem: () => {
      throw new Error('storage disabled');
    },
    removeItem: () => {
      throw new Error('storage disabled');
    },
  };
}

const KEY = 'sb-zjvfwhjwaytyogdxeddo-auth-token';
const guestToken = JSON.stringify({ access_token: 'a', user: { id: 'u', is_anonymous: true } });
const readerToken = JSON.stringify({ access_token: 'a', user: { id: 'u', is_anonymous: false } });
// Every token minted before anonymous sign-ins were switched on looks like this.
const legacyToken = JSON.stringify({ access_token: 'a', user: { id: 'u' } });

describe('tokenIsGuest', () => {
  it('is true only for an explicit is_anonymous: true', () => {
    expect(tokenIsGuest(guestToken)).toBe(true);
    expect(tokenIsGuest(readerToken)).toBe(false);
    expect(tokenIsGuest(legacyToken)).toBe(false);
  });

  it('treats anything it cannot read as not a guest', () => {
    // The safe direction: the cost of being wrong here is a session that outlives a
    // browser restart. Guessing the other way signs a real reader out.
    for (const value of ['', 'not json', 'null', '[]', '{}', '{"user":null}', '"a string"']) {
      expect(tokenIsGuest(value)).toBe(false);
    }
  });

  it('fails CLOSED for a session it cannot classify', () => {
    /*
     * The installed @supabase/auth-js already has a branch that saves a session with the
     * `user` key deleted (when `auth.userStorage` is configured). Under the old rule that
     * read as "not a guest", which meant `localStorage` -- every guest token in the one
     * place this module exists to keep them out of, with no test failing.
     */
    expect(tokenIsGuest(JSON.stringify({ access_token: 'a', expires_at: 1 }))).toBe(true);
    expect(tokenIsGuest(JSON.stringify({ access_token: 'a', user: null }))).toBe(true);
  });

  it('still treats a non-session value as not a guest', () => {
    // The PKCE code verifier and friends are not sessions and must stay in localStorage,
    // or a sign-in link opened in a fresh tab has nothing to verify against.
    expect(tokenIsGuest('"a-code-verifier-string"')).toBe(false);
    expect(tokenIsGuest(JSON.stringify({ expires_at: 1 }))).toBe(false);
  });

  it('does not accept a truthy non-boolean', () => {
    expect(tokenIsGuest(JSON.stringify({ user: { is_anonymous: 'true' } }))).toBe(false);
    expect(tokenIsGuest(JSON.stringify({ user: { is_anonymous: 1 } }))).toBe(false);
  });
});

describe('createSplitAuthStorage', () => {
  it('keeps a guest token out of localStorage entirely', () => {
    const session = fake();
    const local = fake();
    createSplitAuthStorage(session, local).setItem(KEY, guestToken);

    // The whole point: nothing survives the browser closing.
    expect(session.map.get(KEY)).toBe(guestToken);
    expect(local.map.has(KEY)).toBe(false);
  });

  it('keeps a reader signed in across a restart', () => {
    const session = fake();
    const local = fake();
    createSplitAuthStorage(session, local).setItem(KEY, readerToken);

    expect(local.map.get(KEY)).toBe(readerToken);
    expect(session.map.has(KEY)).toBe(false);
  });

  it('moves the token across when a guest converts, leaving nothing behind', () => {
    const session = fake();
    const local = fake();
    const store = createSplitAuthStorage(session, local);

    store.setItem(KEY, guestToken);
    store.setItem(KEY, readerToken);

    expect(local.map.get(KEY)).toBe(readerToken);
    // A stale guest token here would be found by getItem's fallback and would outrank
    // nothing -- but it would still be one reader's token sitting in another's storage.
    expect(session.map.has(KEY)).toBe(false);
    expect(store.getItem(KEY)).toBe(readerToken);
  });

  it('migrates a stranded guest token on the READ, not on the next write', () => {
    /*
     * Found live by the security review of #48. auth-js does not re-persist a session it
     * just recovered, and only refreshes inside a 90-second expiry margin -- so a guest who
     * opens the app, reads, and closes the browser performs no `setItem` at all. Waiting
     * for a write left their token in `localStorage` across the restart, which is the exact
     * leak this module exists to close.
     */
    const session = fake();
    const local = fake();
    local.map.set(KEY, guestToken);
    const store = createSplitAuthStorage(session, local);

    expect(store.getItem(KEY)).toBe(guestToken);

    // One read is enough. No write happens in this test at all.
    expect(session.map.get(KEY)).toBe(guestToken);
    expect(local.map.has(KEY)).toBe(false);
  });

  it('evicts a stranded guest token even when sessionStorage refuses the move', () => {
    const local = fake();
    local.map.set(KEY, guestToken);
    const session: KeyValueStore = {
      getItem: () => null,
      setItem: () => {
        throw new Error('storage disabled');
      },
      removeItem: () => undefined,
    };

    const store = createSplitAuthStorage(session, local);
    // The caller still gets a working session for this page's lifetime...
    expect(store.getItem(KEY)).toBe(guestToken);
    // ...but localStorage, where it must never be, no longer holds it.
    expect(local.map.has(KEY)).toBe(false);
  });

  it('leaves a reader token in localStorage alone on read', () => {
    const session = fake();
    const local = fake();
    local.map.set(KEY, readerToken);
    const store = createSplitAuthStorage(session, local);

    expect(store.getItem(KEY)).toBe(readerToken);
    expect(local.map.get(KEY)).toBe(readerToken);
    expect(session.map.has(KEY)).toBe(false);
  });

  it('never hands this tab another reader signed in on the same machine', () => {
    /*
     * The security finding on #48, and this file asserted the opposite for two commits.
     *
     * Shared machine: Bob is a guest in this tab (`sessionStorage`); Alice signs in with
     * her email in another (`localStorage`, shared). Preferring the account with an address
     * hands Bob Alice's Library, her notes and her address on /account. Nothing at this
     * layer can tell that apart from "the same person converted in another tab", so the
     * preference resolves toward the smaller blast radius: this tab's own session.
     */
    const session = fake();
    const local = fake();
    session.map.set(KEY, guestToken);
    local.map.set(KEY, readerToken);

    expect(createSplitAuthStorage(session, local).getItem(KEY)).toBe(guestToken);
  });

  it('evicts a stranded guest token from localStorage when sessionStorage refuses', () => {
    // Otherwise the upgrade-path token goes on being served from localStorage on every
    // load, surviving exactly the browser restart this module exists to end.
    const local = fake();
    local.map.set(KEY, guestToken);
    const session: KeyValueStore = {
      getItem: () => null,
      setItem: () => {
        throw new Error('storage disabled');
      },
      removeItem: () => undefined,
    };

    createSplitAuthStorage(session, local).setItem(KEY, guestToken);

    expect(local.map.has(KEY)).toBe(false);
  });

  it('reads this tab first whatever the other store holds', () => {
    const session = fake();
    const local = fake();
    session.map.set(KEY, readerToken);
    local.map.set(KEY, legacyToken);

    expect(createSplitAuthStorage(session, local).getItem(KEY)).toBe(readerToken);
  });

  it('does not let a stale guest tab destroy a converted reader session', () => {
    /*
     * The destructive half of the same finding. Tab B converted, so `localStorage` holds
     * the reader token. Tab A is still a guest and its next token refresh writes through
     * this adapter. Unconditionally clearing the other store -- which the first version
     * did -- deleted the reader's persistence on a timer, whenever that forgotten tab
     * happened to refresh.
     */
    const session = fake();
    const local = fake();
    local.map.set(KEY, readerToken);

    createSplitAuthStorage(session, local).setItem(KEY, guestToken);

    expect(session.map.get(KEY)).toBe(guestToken);
    expect(local.map.get(KEY)).toBe(readerToken);
  });

  it('still clears an older guest copy on a guest write', () => {
    // The upgrade path must keep working: only a NON-guest token is protected above.
    const session = fake();
    const local = fake();
    local.map.set(KEY, guestToken);

    createSplitAuthStorage(session, local).setItem(KEY, guestToken);

    expect(session.map.get(KEY)).toBe(guestToken);
    expect(local.map.has(KEY)).toBe(false);
  });

  it('signs out of both stores', () => {
    const session = fake();
    const local = fake();
    session.map.set(KEY, guestToken);
    local.map.set(KEY, readerToken);

    const store = createSplitAuthStorage(session, local);
    store.removeItem(KEY);

    expect(session.map.size).toBe(0);
    expect(local.map.size).toBe(0);
    expect(store.getItem(KEY)).toBe(null);
  });

  it('survives a browser that throws on every storage access', () => {
    // Reading window.sessionStorage throws outright when site data is blocked, and this
    // runs at module scope -- unguarded, a reader with cookies off gets a blank page.
    const local = fake();
    const store = createSplitAuthStorage(throwing(), local);

    expect(() => store.setItem(KEY, readerToken)).not.toThrow();
    expect(store.getItem(KEY)).toBe(readerToken);
    expect(() => store.removeItem(KEY)).not.toThrow();
    expect(store.getItem(KEY)).toBe(null);
  });

  it('degrades to no persistence at all when both stores throw', () => {
    const store = createSplitAuthStorage(throwing(), throwing());
    expect(() => store.setItem(KEY, guestToken)).not.toThrow();
    expect(store.getItem(KEY)).toBe(null);
    expect(() => store.removeItem(KEY)).not.toThrow();
  });
});

describe('browserAuthStorage', () => {
  it('does not touch a storage accessor until it is used', () => {
    // The regression this exists for: passing `globalThis.localStorage` as an argument
    // evaluates it at module scope, and in a browser with site data blocked that raises
    // rather than returning an empty store. The first version of supabase.ts did exactly
    // that and rendered a blank page for anyone with cookies off.
    const boom = {
      get() {
        throw new Error('storage disabled');
      },
      configurable: true,
    };
    const original = {
      local: Object.getOwnPropertyDescriptor(globalThis, 'localStorage'),
      session: Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage'),
    };
    Object.defineProperty(globalThis, 'localStorage', boom);
    Object.defineProperty(globalThis, 'sessionStorage', boom);
    try {
      const store = browserAuthStorage();
      expect(() => store.setItem(KEY, guestToken)).not.toThrow();
      expect(store.getItem(KEY)).toBe(null);
      expect(() => store.removeItem(KEY)).not.toThrow();
    } finally {
      if (original.local) Object.defineProperty(globalThis, 'localStorage', original.local);
      else delete (globalThis as Partial<typeof globalThis>).localStorage;
      if (original.session) Object.defineProperty(globalThis, 'sessionStorage', original.session);
      else delete (globalThis as Partial<typeof globalThis>).sessionStorage;
    }
  });
});

describe('createSplitAuthStorage when a store refuses a write', () => {
  /** Reads and removes fine; only `setItem` throws, the way a full quota behaves. */
  function fullQuota(): KeyValueStore & { map: Map<string, string> } {
    const store = fake();
    return {
      ...store,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
  }

  it('keeps the existing copy when the preferred store rejects the write', () => {
    /*
     * Codex P2 on #48. `guard` swallows the throw, so the first version returned as though
     * it had persisted the token and then deleted the only good copy -- a full quota became
     * a silent sign-out discovered on the next reload.
     */
    const session = fullQuota();
    const local = fake();
    local.map.set(KEY, readerToken);

    createSplitAuthStorage(session, local).setItem(KEY, guestToken);

    expect(local.map.get(KEY)).toBe(readerToken);
  });

  it('falls back to sessionStorage for a reader when localStorage refuses', () => {
    const session = fake();
    const local = fullQuota();

    createSplitAuthStorage(session, local).setItem(KEY, readerToken);

    // A session that ends with the tab beats no session at all.
    expect(session.map.get(KEY)).toBe(readerToken);
  });

  it('does NOT fall back to localStorage for a guest when sessionStorage refuses', () => {
    /*
     * The asymmetry is the feature. `localStorage` is the one place a guest token must
     * never be, so the fallback that would rescue this session is the fallback that breaks
     * the promise the sign-in screen makes to the reader.
     */
    const session = fullQuota();
    const local = fake();

    createSplitAuthStorage(session, local).setItem(KEY, guestToken);

    expect(local.map.has(KEY)).toBe(false);
    expect(session.map.has(KEY)).toBe(false);
  });
});
