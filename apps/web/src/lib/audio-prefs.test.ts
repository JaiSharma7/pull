import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  audioSummary,
  clearStoredPlayer,
  DEFAULT_AUDIO_PREFS,
  narrowRate,
  narrowSleep,
  narrowVoice,
  RATE_KEY,
  readStoredAudioPrefs,
  readStoredPlayer,
  SLEEP_KEY,
  sleepMinutes,
  storeAudioPrefs,
  storePlayer,
  VOICE_KEY,
} from './audio-prefs.js';
import { INITIAL_PLAYER, MAX_RATE, MIN_RATE, playerReducer, playerStorageKey } from './player.js';

function fakeStore(map: Map<string, string>) {
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

/**
 * Both stores, because the queue and the settings do not live in the same one.
 *
 * `local` is what survives a browser restart; `session` is what the browser
 * throws away with the tab. Returning them separately is the point — several of
 * the assertions below are about which of the two a thing landed in.
 */
function stubStorage(initial: Record<string, string> = {}) {
  const local = new Map(Object.entries(initial));
  const session = new Map<string, string>();
  vi.stubGlobal('localStorage', fakeStore(local));
  vi.stubGlobal('sessionStorage', fakeStore(session));
  return { local, session };
}

function stubHostileStorage() {
  const boom = () => {
    throw new DOMException('The operation is insecure.', 'SecurityError');
  };
  vi.stubGlobal('localStorage', { getItem: boom, setItem: boom, removeItem: boom });
  vi.stubGlobal('sessionStorage', { getItem: boom, setItem: boom, removeItem: boom });
}

afterEach(() => vi.unstubAllGlobals());

describe('narrowing', () => {
  it('parses a stored rate and clamps it to what a voice can render', () => {
    expect(narrowRate('1.25')).toBe(1.25);
    expect(narrowRate(1.5)).toBe(1.5);
    expect(narrowRate('9')).toBe(MAX_RATE);
    expect(narrowRate('0.1')).toBe(MIN_RATE);
  });

  it('falls to 1 for a rate that is not one', () => {
    // A NaN rate handed to SpeechSynthesisUtterance is not an error; it is a
    // voice that never starts.
    for (const junk of ['fast', '', null, undefined, {}, [], 'NaN', 'Infinity']) {
      expect(narrowRate(junk)).toBe(1);
    }
  });

  it('accepts only the timers the settings screen offers', () => {
    expect(narrowSleep('30')).toBe('30');
    expect(narrowSleep('off')).toBe('off');
    for (const junk of ['25', 30, '', null, 'OFF']) expect(narrowSleep(junk)).toBe('off');
  });

  it('treats an empty voice as no voice', () => {
    expect(narrowVoice('urn:voice')).toBe('urn:voice');
    for (const junk of ['', null, undefined, 4]) expect(narrowVoice(junk)).toBeNull();
  });

  it('turns a timer into minutes', () => {
    expect(sleepMinutes('off')).toBeNull();
    expect(sleepMinutes('45')).toBe(45);
  });
});

describe('reading and storing preferences', () => {
  it('round-trips a full set', () => {
    stubStorage();
    const prefs = { rate: 1.5, voiceURI: 'urn:v', sleep: '30' as const };
    storeAudioPrefs(prefs);
    expect(readStoredAudioPrefs()).toEqual(prefs);
  });

  it('reads the defaults from an empty store', () => {
    stubStorage();
    expect(readStoredAudioPrefs()).toEqual(DEFAULT_AUDIO_PREFS);
  });

  it('removes the voice key rather than storing an empty string', () => {
    const { local: map } = stubStorage({ [VOICE_KEY]: 'urn:old' });
    storeAudioPrefs({ ...DEFAULT_AUDIO_PREFS, voiceURI: null });
    expect(map.has(VOICE_KEY)).toBe(false);
  });

  it('narrows junk left by an older build', () => {
    stubStorage({ [RATE_KEY]: 'warp', [VOICE_KEY]: '', [SLEEP_KEY]: 'forever' });
    expect(readStoredAudioPrefs()).toEqual(DEFAULT_AUDIO_PREFS);
  });

  it('clamps on the way in, so the store never holds an unusable rate', () => {
    const { local: map } = stubStorage();
    storeAudioPrefs({ ...DEFAULT_AUDIO_PREFS, rate: 50 });
    expect(map.get(RATE_KEY)).toBe(String(MAX_RATE));
  });

  it('survives a browser that blocks site data', () => {
    stubHostileStorage();
    expect(readStoredAudioPrefs()).toEqual(DEFAULT_AUDIO_PREFS);
    expect(() => storeAudioPrefs({ rate: 2, voiceURI: 'x', sleep: '15' })).not.toThrow();
  });
});

describe('the stored queue', () => {
  const queued = playerReducer(INITIAL_PLAYER, {
    type: 'enqueue',
    tracks: [{ id: 'a', title: 'Meditations', text: 'Begin the morning.' }],
  });

  it('round-trips under the reader’s own key, coming back paused', () => {
    stubStorage();
    storePlayer(queued, 'u1', true);
    // Paused with its place kept, and under a fresh epoch: nothing has started.
    expect(readStoredPlayer('u1', true)).toEqual({ ...queued, status: 'paused', epoch: 0 });
    expect(readStoredPlayer('u2', true)).toEqual(INITIAL_PLAYER);
    expect(readStoredPlayer(null, true)).toEqual(INITIAL_PLAYER);
  });

  it('removes the key rather than storing an empty queue', () => {
    const { local } = stubStorage();
    storePlayer(queued, 'u1', true);
    storePlayer(INITIAL_PLAYER, 'u1', true);
    expect(local.has(playerStorageKey('u1'))).toBe(false);
  });

  it('can be forgotten on sign-out', () => {
    stubStorage();
    storePlayer(queued, 'u1', true);
    clearStoredPlayer('u1');
    expect(readStoredPlayer('u1', true)).toEqual(INITIAL_PLAYER);
  });

  it('survives a browser that blocks site data', () => {
    stubHostileStorage();
    expect(readStoredPlayer('u1', true)).toEqual(INITIAL_PLAYER);
    expect(() => storePlayer(queued, 'u1', true)).not.toThrow();
    expect(() => clearStoredPlayer('u1')).not.toThrow();
  });
});

/**
 * Where a queue is kept, which is the half of "per reader" the key cannot do.
 *
 * Every signed-out visitor keys to the same `wap:player:guest`, and they are not
 * one person: on a library machine they are whoever sat down next. The key was
 * never going to separate them, so the store has to.
 */
describe('a queue belonging to nobody with an address', () => {
  const queued = playerReducer(INITIAL_PLAYER, {
    type: 'enqueue',
    tracks: [{ id: 'a', title: 'The Body Keeps the Score', text: 'Trauma is not the story of…' }],
  });

  it('goes to sessionStorage, so the next person at the machine never sees it', () => {
    const { local, session } = stubStorage();

    // A visitor queues something and closes the browser.
    storePlayer(queued, null);
    expect(session.has(playerStorageKey(null))).toBe(true);
    expect(local.has(playerStorageKey(null))).toBe(false);
    expect([...local.values()].join('')).not.toContain('The Body Keeps the Score');

    // The next person opens it. A browser restart is a new sessionStorage and the
    // same localStorage, which is exactly what the stub models.
    const next = stubStorage(Object.fromEntries(local));
    expect(readStoredPlayer(null)).toEqual(INITIAL_PLAYER);
    expect(next.session.size).toBe(0);
  });

  it('does the same for a guest, whose account is meant to end with the browser', () => {
    // A guest has a real uuid, so the key separates them from a reader — but
    // `sweep_guest_accounts` deletes the account and nothing was deleting this.
    const { local, session } = stubStorage();
    storePlayer(queued, 'guest-uuid');
    expect(session.has(playerStorageKey('guest-uuid'))).toBe(true);
    expect(local.has(playerStorageKey('guest-uuid'))).toBe(false);
  });

  it('keeps a reader with an address durable, which is what they asked for', () => {
    const { local, session } = stubStorage();
    storePlayer(queued, 'u1', true);
    expect(local.has(playerStorageKey('u1'))).toBe(true);
    expect(session.has(playerStorageKey('u1'))).toBe(false);
    // And it survives the restart the visitor's copy does not.
    stubStorage(Object.fromEntries(local));
    expect(readStoredPlayer('u1', true).queue).toHaveLength(1);
  });

  it('forgets both copies on sign-out, wherever an earlier build left one', () => {
    // A build before this one wrote every queue to localStorage. Sign-out has to
    // take that copy too, or the reading list it was written to protect outlives
    // the account that made it.
    const { local, session } = stubStorage({
      [playerStorageKey('u1')]: 'a queue an older build left behind',
    });
    storePlayer(queued, 'u1');
    expect(session.has(playerStorageKey('u1'))).toBe(true);

    clearStoredPlayer('u1');
    expect(session.has(playerStorageKey('u1'))).toBe(false);
    expect(local.has(playerStorageKey('u1'))).toBe(false);
  });
});

describe('audioSummary', () => {
  it('says so when nothing has changed', () => {
    expect(audioSummary(DEFAULT_AUDIO_PREFS)).toBe('Everything is at its default.');
  });

  it('names what has, and lets the caller name the voice', () => {
    expect(audioSummary({ rate: 1.5, voiceURI: 'urn:v', sleep: '30' }, 'Daniel')).toBe(
      '1.5× speed · Daniel · Sleep after 30 minutes — everything else is at its default.',
    );
    expect(audioSummary({ rate: 1, voiceURI: 'urn:v', sleep: 'off' })).toBe(
      'A chosen voice — everything else is at its default.',
    );
  });
});
