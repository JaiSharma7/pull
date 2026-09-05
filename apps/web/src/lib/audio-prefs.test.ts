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

/** A localStorage that behaves, and one that throws the way a blocked one does. */
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
    const map = stubStorage({ [VOICE_KEY]: 'urn:old' });
    storeAudioPrefs({ ...DEFAULT_AUDIO_PREFS, voiceURI: null });
    expect(map.has(VOICE_KEY)).toBe(false);
  });

  it('narrows junk left by an older build', () => {
    stubStorage({ [RATE_KEY]: 'warp', [VOICE_KEY]: '', [SLEEP_KEY]: 'forever' });
    expect(readStoredAudioPrefs()).toEqual(DEFAULT_AUDIO_PREFS);
  });

  it('clamps on the way in, so the store never holds an unusable rate', () => {
    const map = stubStorage();
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
    storePlayer(queued, 'u1');
    expect(readStoredPlayer('u1')).toEqual({ ...queued, status: 'paused' });
    expect(readStoredPlayer('u2')).toEqual(INITIAL_PLAYER);
    expect(readStoredPlayer(null)).toEqual(INITIAL_PLAYER);
  });

  it('removes the key rather than storing an empty queue', () => {
    const map = stubStorage();
    storePlayer(queued, 'u1');
    storePlayer(INITIAL_PLAYER, 'u1');
    expect(map.has(playerStorageKey('u1'))).toBe(false);
  });

  it('can be forgotten on sign-out', () => {
    stubStorage();
    storePlayer(queued, 'u1');
    clearStoredPlayer('u1');
    expect(readStoredPlayer('u1')).toEqual(INITIAL_PLAYER);
  });

  it('survives a browser that blocks site data', () => {
    stubHostileStorage();
    expect(readStoredPlayer('u1')).toEqual(INITIAL_PLAYER);
    expect(() => storePlayer(queued, 'u1')).not.toThrow();
    expect(() => clearStoredPlayer('u1')).not.toThrow();
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
