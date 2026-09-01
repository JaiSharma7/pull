import { afterEach, describe, expect, it, vi } from 'vitest';
import { PENDING_TTL_MS, rememberDestination, takeDestination } from './pending-destination.js';

function stubStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  });
  return map;
}

function stubHostileStorage() {
  const boom = () => {
    throw new DOMException('The operation is insecure.', 'SecurityError');
  };
  vi.stubGlobal('localStorage', { getItem: boom, setItem: boom, removeItem: boom });
}

afterEach(() => vi.unstubAllGlobals());

const T0 = 1_700_000_000_000;

describe('rememberDestination / takeDestination', () => {
  it('round-trips a destination within the window', () => {
    stubStorage();
    rememberDestination('/source/abc?s=1#p-2', T0);
    expect(takeDestination(T0 + 1000)).toBe('/source/abc?s=1#p-2');
  });

  it('spends the destination, so a later sign-in is not hijacked by it', () => {
    // The case that makes "take" the right verb. A value that survives being
    // read fires again on the next sign-in, which asked for somewhere else.
    stubStorage();
    rememberDestination('/source/abc', T0);
    expect(takeDestination(T0)).toBe('/source/abc');
    expect(takeDestination(T0)).toBeNull();
  });

  it('forgets one older than the link that would carry it', () => {
    stubStorage();
    rememberDestination('/source/abc', T0);
    expect(takeDestination(T0 + PENDING_TTL_MS + 1)).toBeNull();
  });

  it('honours one at exactly the boundary', () => {
    stubStorage();
    rememberDestination('/source/abc', T0);
    expect(takeDestination(T0 + PENDING_TTL_MS)).toBe('/source/abc');
  });

  it('treats a clock that moved backwards as stale rather than fresh', () => {
    // A one-sided `age > TTL` test would read a negative age as very fresh. The
    // machine's clock is not something this app controls.
    stubStorage();
    rememberDestination('/source/abc', T0);
    expect(takeDestination(T0 - 60_000)).toBeNull();
  });

  it('clears rather than stores when there is nowhere to return to', () => {
    /*
     * A sign-in started from the front door must erase a destination left by an
     * abandoned earlier one — otherwise the previous attempt's address outlives
     * it and redirects a reader who asked for nothing.
     */
    const map = stubStorage();
    rememberDestination('/source/abc', T0);
    rememberDestination(null, T0);
    expect(map.size).toBe(0);
    expect(takeDestination(T0)).toBeNull();
  });

  it('returns null for a stored value that is not what this module wrote', () => {
    // Another tab, an older version, a devtools console.
    for (const junk of ['', 'not json', '{}', '[]', '"/source/abc"', '{"to":"/x"}', 'null']) {
      stubStorage({ 'wap:pending-destination': junk });
      expect(takeDestination(T0), `junk: ${junk}`).toBeNull();
    }
  });

  it('clears a malformed value instead of leaving it to be re-read forever', () => {
    const map = stubStorage({ 'wap:pending-destination': 'not json' });
    takeDestination(T0);
    expect(map.size).toBe(0);
  });

  it('survives a browser that blocks site data', () => {
    stubHostileStorage();
    expect(() => rememberDestination('/source/abc', T0)).not.toThrow();
    expect(takeDestination(T0)).toBeNull();
  });

  it('does not decide what is safe — that stays with safeNext', () => {
    /*
     * Deliberately stored and returned verbatim, including a value no navigation
     * should ever use. There is one place in the app that decides what a safe
     * destination is, and duplicating that judgement here would make two.
     */
    stubStorage();
    rememberDestination('//evil.example/x', T0);
    expect(takeDestination(T0)).toBe('//evil.example/x');
  });
});
