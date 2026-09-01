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

  it('adopts a guest token already in localStorage, then moves it on the next write', () => {
    // The upgrade path. A guest signed in before this module existed must not be signed
    // out by the deploy that adds it.
    const session = fake();
    const local = fake();
    local.map.set(KEY, guestToken);
    const store = createSplitAuthStorage(session, local);

    expect(store.getItem(KEY)).toBe(guestToken);

    store.setItem(KEY, guestToken);
    expect(session.map.get(KEY)).toBe(guestToken);
    expect(local.map.has(KEY)).toBe(false);
  });

  it('prefers the session copy when both are somehow set', () => {
    const session = fake();
    const local = fake();
    session.map.set(KEY, guestToken);
    local.map.set(KEY, readerToken);

    expect(createSplitAuthStorage(session, local).getItem(KEY)).toBe(guestToken);
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
