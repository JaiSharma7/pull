/**
 * Listening — how fast, in whose voice, and for how long before it stops.
 *
 * Three settings, device-scoped, in `localStorage`, for the reasons
 * `lib/appearance.ts` gives for the display settings and one more that is
 * specific to sound:
 *
 *   * A visitor can listen now. Read-aloud is free forever (law 3) and needs no
 *     account, so a rate chosen while signed out has to be kept somewhere that
 *     exists while signed out.
 *   * A VOICE IS A PROPERTY OF THE DEVICE, NOT THE READER. `voiceURI` names an
 *     engine installed on this machine; the same string means nothing on the
 *     phone. A synced column would faithfully carry a laptop's voice to a
 *     device that cannot produce it, and the reader would get the fallback
 *     with no idea why. Per-device is the only scope in which the setting is
 *     even true.
 *   * The sleep timer is a habit rather than a decision — "thirty minutes, most
 *     nights" — and the device by the bed is the one that has it.
 *
 * This module also remembers the QUEUE, because it is the one place that touches
 * storage on the player's behalf and a second module with the same try/catch
 * would be a copy. The queue's shape and its owner check live in `lib/player.ts`;
 * this only reads and writes the string — and decides WHICH store it goes in,
 * which is a different decision from the three settings above and is made at
 * `queueStore` below.
 *
 * Every storage access is guarded. `localStorage` throws rather than returning
 * null in a browser set to block site data, and an unguarded read here would be
 * the exception that stops the app rendering at all.
 */

import { clampRate, hydrate, playerStorageKey, serialize, type PlayerState } from './player.js';

/** How long the player runs before pausing itself, in minutes; `off` for no timer. */
export type SleepTimer = 'off' | '15' | '30' | '45' | '60';

export const SLEEP_TIMERS: readonly SleepTimer[] = ['off', '15', '30', '45', '60'];

/**
 * The rates the settings screen offers.
 *
 * Steps rather than a slider because the differences that matter are coarse:
 * "a little faster" and "as fast as I can still follow". The stored value is
 * not narrowed to these, though — a rate set by an older build, or by the
 * player bar's own control, is kept as long as it is inside the range voices can
 * still be understood at.
 */
export const RATE_STEPS: readonly number[] = [0.75, 1, 1.25, 1.5, 2];

export const RATE_KEY = 'wap:audio:rate';
export const VOICE_KEY = 'wap:audio:voice';
export const SLEEP_KEY = 'wap:audio:sleep';

export interface AudioPrefs {
  rate: number;
  /** A `SpeechSynthesisVoice.voiceURI`, or null for whatever the browser picks. */
  voiceURI: string | null;
  sleep: SleepTimer;
}

export const DEFAULT_AUDIO_PREFS: AudioPrefs = {
  rate: 1,
  voiceURI: null,
  sleep: 'off',
};

/**
 * Narrow a stored rate to a number the player will accept.
 *
 * `localStorage` holds strings, so the number has to be parsed, and anything
 * that does not parse — or parses to a rate no voice can render — falls to 1
 * rather than being passed through. A rate of `NaN` handed to
 * `SpeechSynthesisUtterance` is not an error; it is a voice that never starts.
 */
export function narrowRate(value: unknown): number {
  // `Number('')` is 0, which is finite and would clamp to half speed. An empty
  // key is an absent key, not a request to go slowly.
  const n =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : NaN;
  return Number.isFinite(n) ? clampRate(n) : DEFAULT_AUDIO_PREFS.rate;
}

export function narrowSleep(value: unknown): SleepTimer {
  return typeof value === 'string' && (SLEEP_TIMERS as readonly string[]).includes(value)
    ? (value as SleepTimer)
    : DEFAULT_AUDIO_PREFS.sleep;
}

export function narrowVoice(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Minutes for a timer, or null when it is off. */
export function sleepMinutes(sleep: SleepTimer): number | null {
  return sleep === 'off' ? null : Number(sleep);
}

function readKey(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * Where a QUEUE is kept, which is not the same question as where a preference is.
 *
 * A rate, a voice and a sleep timer are facts about the device — the machine is
 * fast, the machine has this voice installed, this is the machine by the bed —
 * so `localStorage` is right for them and a second person at the same machine
 * learns nothing from finding them.
 *
 * A queue is not. It is a list of titles and their text: what someone chose to
 * listen to. `lib/guest-storage.ts` already decided what to do with material
 * belonging to a reader who has no address, and the reasoning transfers exactly:
 * `localStorage` survives a browser restart, so on a shared machine the next
 * person to open the browser would find the previous one's reading list loaded
 * and ready to play. That module puts a guest's token in `sessionStorage` for
 * precisely that reason; this puts their queue there for the same one.
 *
 * `durable` is passed rather than derived, because it cannot be derived here. A
 * null `userId` is a signed-out visitor and a non-null one may still be a guest —
 * an anonymous account with a real uuid — and only the caller holding the session
 * can tell a guest from a reader with an address. It defaults to `false` so a
 * caller who forgets loses persistence rather than leaks a reading list; that is
 * the direction this has to fail in.
 */
function queueStore(durable: boolean): KeyValueStore | null {
  try {
    // Read through `globalThis` at call time. A browser configured to block site
    // data throws on the property access itself, not on the method, so the guard
    // has to be around this.
    return durable ? globalThis.localStorage : globalThis.sessionStorage;
  } catch {
    return null;
  }
}

/** The parts of `Storage` used here. Narrowed so a test can pass a plain fake. */
interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function readStoredAudioPrefs(): AudioPrefs {
  return {
    rate: narrowRate(readKey(RATE_KEY)),
    voiceURI: narrowVoice(readKey(VOICE_KEY)),
    sleep: narrowSleep(readKey(SLEEP_KEY)),
  };
}

export function storeAudioPrefs(next: AudioPrefs): void {
  try {
    localStorage.setItem(RATE_KEY, String(clampRate(next.rate)));
    if (next.voiceURI) localStorage.setItem(VOICE_KEY, next.voiceURI);
    else localStorage.removeItem(VOICE_KEY);
    localStorage.setItem(SLEEP_KEY, next.sleep);
  } catch {
    // A preference that cannot be remembered is still a preference that works
    // for this session. Same trade as appearance and focus mode.
  }
}

/* --- The queue ------------------------------------------------------------ */

/** The reader's queue, or an empty player when there is none or it cannot be read. */
export function readStoredPlayer(
  userId: string | null,
  durable: boolean = false,
  now: number = Date.now(),
): PlayerState {
  const store = queueStore(durable);
  if (store === null) return hydrate(null, userId, now);
  try {
    return hydrate(store.getItem(playerStorageKey(userId)), userId, now);
  } catch {
    return hydrate(null, userId, now);
  }
}

export function storePlayer(
  state: PlayerState,
  userId: string | null,
  durable: boolean = false,
): void {
  const store = queueStore(durable);
  if (store === null) return;
  try {
    const key = playerStorageKey(userId);
    if (state.queue.length === 0) store.removeItem(key);
    else store.setItem(key, serialize(state, userId));
  } catch {
    // The queue still plays; it just will not survive a reload on this device.
  }
}

/**
 * Forget a reader's queue — on sign-out, so the next account on this device
 * starts silent.
 *
 * Clears BOTH stores unconditionally, rather than the one the caller would have
 * written to. Whether this reader's queue was durable is a fact about the session
 * that is ending, and by sign-out it is exactly the thing that has just stopped
 * being knowable; a copy left behind by an earlier build, or by a conversion from
 * guest to member, is still a reading list on a shared machine. Removing a key
 * that was never there costs nothing.
 */
export function clearStoredPlayer(userId: string | null): void {
  const key = playerStorageKey(userId);
  for (const durable of [true, false]) {
    const store = queueStore(durable);
    if (store === null) continue;
    try {
      store.removeItem(key);
    } catch {
      // Nothing to forget, or nowhere it could have been kept.
    }
  }
}

/* --- Copy ----------------------------------------------------------------- */

/**
 * What to say about a choice, rather than only what to call it — the same rule
 * `APPEARANCE_COPY` follows. A rate is a number and a number is not a sentence.
 */
export const AUDIO_COPY = {
  rate: (rate: number): { label: string; note: string } => {
    if (rate === 1) return { label: 'Normal', note: 'The voice at the pace it was made for.' };
    if (rate < 1) return { label: `${rate}×`, note: 'Slower. Room to hear each clause land.' };
    if (rate >= 2)
      return { label: `${rate}×`, note: 'As fast as an argument can still be followed.' };
    return { label: `${rate}×`, note: 'Faster. Most listeners settle here after a week.' };
  },
  sleep: {
    off: { label: 'Off', note: 'Plays until the queue is done.' },
    '15': { label: '15 minutes', note: 'Pauses at the next idea after a quarter hour.' },
    '30': { label: '30 minutes', note: 'Pauses at the next idea after half an hour.' },
    '45': { label: '45 minutes', note: 'Pauses at the next idea after three quarters of an hour.' },
    '60': { label: '1 hour', note: 'Pauses at the next idea after an hour.' },
  } satisfies Record<SleepTimer, { label: string; note: string }>,
};

/**
 * A one-line summary of what is not at its default, for the same reason
 * `appearanceSummary` exists: a settings screen leads with what has been changed.
 *
 * The voice is named by the caller because only the browser can turn a
 * `voiceURI` into a name, and this module never touches the browser.
 */
export function audioSummary(p: AudioPrefs, voiceName: string | null = null): string {
  const changed = [
    p.rate === 1 ? null : `${p.rate}× speed`,
    p.voiceURI === null ? null : (voiceName ?? 'A chosen voice'),
    p.sleep === 'off' ? null : `Sleep after ${AUDIO_COPY.sleep[p.sleep].label.toLowerCase()}`,
  ].filter((x): x is string => x !== null);

  if (changed.length === 0) return 'Everything is at its default.';
  return `${changed.join(' · ')} — everything else is at its default.`;
}
