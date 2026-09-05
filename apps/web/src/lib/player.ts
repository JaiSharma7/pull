/**
 * The player — a queue of things to hear, as a pure reducer.
 *
 * Read-aloud is free forever (CLAUDE.md law 3) because it is `speechSynthesis`
 * on the device, and until now it was also stateless: one card, one utterance,
 * and a Stop button. That is a Listen control, not a player. A reader who wants
 * to hear a source on a walk needs a queue that outlives the card it was started
 * from — surviving a tab change, a navigation to the Library, a lock screen.
 *
 * The state lives here, in a reducer with no DOM in it, for the reason
 * `packages/ranking` mirrors the planner in TypeScript: every transition can be
 * asserted without a browser. The effect layer — the thing that actually calls
 * `speak` and listens for the utterance to end — is a separate concern that
 * subscribes to this state and dispatches back into it. What that layer must
 * never do is keep its own idea of what is playing.
 *
 * Two rules are worth stating before the actions, because they decide the feel
 * of the thing:
 *
 *   * ADVANCING IS THE PLAYER'S ACT, NOT THE READER'S. Design law 7 forbids
 *     sliding the next card into frame while *reading*; listening is different,
 *     and a queue that stopped after every item would be a Listen button with
 *     extra steps. So `next` is what the effect layer dispatches when an
 *     utterance ends, and it walks the queue until the queue runs out.
 *   * THE END IS AN END. When the last track finishes the queue is cleared and
 *     the player goes idle. Nothing is remembered to be replayed, because a
 *     finished session that lingers as "Paused · 5 of 5" on the next visit is a
 *     feed that never ends, wearing headphones.
 *
 * THE EFFECT LAYER'S CONTRACT, so it can be written once and not re-derived:
 * when `epoch` changes while the status is `playing`, call `speak` on the
 * current track and hand that epoch back in `ended`; when the status becomes
 * `paused`, pause; when it returns to `playing` under the same epoch, resume;
 * when it becomes `idle`, stop. A rate or voice change while something is
 * playing is applied to the live utterance in place (`adjustSpeaking` in
 * `lib/speech.ts` keeps the reader's position) and does not touch the epoch.
 */

export interface Track {
  /** The Pull's id. Also the identity for de-duplication: a card queued twice is queued once. */
  id: string;
  /** What the bar shows — the source title, usually. */
  title: string;
  /** What is read aloud. */
  text: string;
}

export type PlayerStatus = 'idle' | 'playing' | 'paused';

export interface PlayerState {
  queue: Track[];
  /** Position of the current track. Always `0` when the queue is empty. */
  index: number;
  status: PlayerStatus;
  /** Speech rate, clamped to `MIN_RATE`..`MAX_RATE`. */
  rate: number;
  /** The chosen `SpeechSynthesisVoice.voiceURI`, or null for the browser's default. */
  voiceURI: string | null;
  /**
   * Epoch milliseconds after which playback pauses at the next track boundary,
   * or null for no timer. Absolute rather than a duration so the reducer never
   * has to read a clock: the caller that sets it does the addition.
   */
  sleepUntil: number | null;
  /**
   * Which utterance the effect layer should be speaking.
   *
   * Bumped by every transition that needs a fresh `speak` — a new track, a
   * restart after a stop — and left alone by pause and resume, which continue
   * the same one. It exists because of how `speak` ends things: it cancels the
   * previous utterance first, and that utterance's `onEnd` fires DURING the
   * call, before the new one has started. A reducer that advanced on a bare
   * "ended" would hear that stale ending and skip a track every time the reader
   * pressed Next. So the effect layer captures the epoch when it starts an
   * utterance, hands it back in `ended`, and anything that is not current is
   * ignored. Never persisted: a restored queue has not started anything.
   */
  epoch: number;
}

/**
 * The usable range of `SpeechSynthesisUtterance.rate`.
 *
 * The API accepts 0.1 to 10; voices distort well inside that. Half speed is
 * where words still sound like words, and double is where a listener can still
 * follow an argument rather than a blur of it.
 */
export const MIN_RATE = 0.5;
export const MAX_RATE = 2;

export const INITIAL_PLAYER: PlayerState = {
  queue: [],
  index: 0,
  status: 'idle',
  rate: 1,
  voiceURI: null,
  sleepUntil: null,
  epoch: 0,
};

export type PlayerAction =
  /** Append to the queue. An idle player starts at the first of what was added. */
  | { type: 'enqueue'; tracks: Track[] }
  /** Hear this now, ahead of whatever is queued. The queue is kept, not replaced. */
  | { type: 'playNow'; track: Track }
  /**
   * Advance. Pass `now` from the end-of-utterance path so the sleep timer can
   * be honoured; a reader's own Next press omits it, because a reader pressing
   * Next is awake.
   */
  | { type: 'next'; now?: number }
  | { type: 'prev' }
  | { type: 'pause' }
  | { type: 'resume' }
  /** Stop, keeping the queue and the position in it. */
  | { type: 'stop' }
  | { type: 'remove'; id: string }
  | { type: 'clear' }
  | { type: 'setRate'; rate: number }
  | { type: 'setVoice'; voiceURI: string | null }
  | { type: 'setSleep'; until: number | null }
  /**
   * The effect layer's report that the utterance it started under `token` —
   * the epoch it captured at the time — has ended on its own. Ignored when the
   * token is not the current epoch or nothing is playing: see `epoch`.
   */
  | { type: 'ended'; token: number; now?: number };

export function clampRate(rate: number): number {
  return Math.min(MAX_RATE, Math.max(MIN_RATE, rate));
}

/**
 * Move to the next track, or honour the sleep timer, or end.
 *
 * The timer fires at a boundary rather than mid-sentence, and pauses rather
 * than stops: the reader who set it was going to sleep, and the morning wants
 * to pick up where the evening left off.
 */
function advance(state: PlayerState, now: number | undefined): PlayerState {
  if (state.sleepUntil !== null && now !== undefined && now >= state.sleepUntil) {
    return { ...state, status: 'paused', sleepUntil: null };
  }
  if (state.index + 1 < state.queue.length) {
    return { ...state, index: state.index + 1, status: 'playing', epoch: state.epoch + 1 };
  }
  // The end is an end. See the header — and the deadline ends with it: it is an
  // absolute timestamp belonging to the session that set it, unlike the
  // remembered duration in `lib/audio-prefs.ts`. Carried into idle, it would
  // pause the next queue started in this tab at a boundary nobody asked for.
  return { ...state, queue: [], index: 0, status: 'idle', sleepUntil: null };
}

/**
 * The reducer. Returns the same object when an action changes nothing, so a
 * subscriber comparing by reference can skip the work.
 */
export function playerReducer(state: PlayerState, action: PlayerAction): PlayerState {
  switch (action.type) {
    case 'enqueue': {
      const seen = new Set(state.queue.map((t) => t.id));
      const fresh: Track[] = [];
      for (const track of action.tracks) {
        if (seen.has(track.id)) continue;
        seen.add(track.id);
        fresh.push(track);
      }
      if (fresh.length === 0) return state;

      const queue = [...state.queue, ...fresh];
      // Queueing onto silence is "listen, then keep going". Queueing onto a
      // paused player is just queueing — the reader paused for a reason.
      if (state.status === 'idle') {
        return {
          ...state,
          queue,
          index: state.queue.length,
          status: 'playing',
          epoch: state.epoch + 1,
        };
      }
      return { ...state, queue };
    }

    case 'playNow': {
      const at = state.queue.findIndex((t) => t.id === action.track.id);

      // Already the one playing: start it again rather than reordering around it.
      if (at >= 0 && at === state.index) {
        return { ...state, status: 'playing', epoch: state.epoch + 1 };
      }

      // After the current track rather than at the head: the reader chose
      // something else over *this one*, not over everything after it. A track
      // already further down the queue is MOVED here rather than jumped to —
      // moving the cursor instead would leave everything between skipped, and
      // since the end of the queue clears it, those tracks would never play.
      const queue = [...state.queue];
      let anchor = state.index;
      const existing = at >= 0 ? (state.queue[at] as Track) : action.track;
      if (at >= 0) {
        queue.splice(at, 1);
        if (at < anchor) anchor -= 1;
      }
      const position = Math.min(anchor + (state.queue.length === 0 ? 0 : 1), queue.length);
      queue.splice(position, 0, existing);
      return { ...state, queue, index: position, status: 'playing', epoch: state.epoch + 1 };
    }

    case 'next':
      return state.status === 'idle' ? state : advance(state, action.now);

    case 'ended':
      // A stale ending is not rare: it is what `speak` fires for the previous
      // utterance while starting the next one. See `epoch`.
      if (state.status !== 'playing' || action.token !== state.epoch) return state;
      return advance(state, action.now);

    case 'prev': {
      if (state.status === 'idle' || state.index === 0) return state;
      return { ...state, index: state.index - 1, status: 'playing', epoch: state.epoch + 1 };
    }

    case 'pause':
      return state.status === 'playing' ? { ...state, status: 'paused' } : state;

    case 'resume': {
      // From paused the same utterance continues. From stopped there is nothing
      // to continue, so this is a fresh one.
      if (state.status === 'paused') return { ...state, status: 'playing' };
      if (state.status === 'idle' && state.queue.length > 0) {
        return { ...state, status: 'playing', epoch: state.epoch + 1 };
      }
      return state;
    }

    case 'stop':
      if (state.status === 'idle' && state.sleepUntil === null) return state;
      return { ...state, status: 'idle', sleepUntil: null };

    case 'remove': {
      const at = state.queue.findIndex((t) => t.id === action.id);
      if (at < 0) return state;

      const queue = state.queue.filter((t) => t.id !== action.id);
      if (queue.length === 0) return { ...state, queue, index: 0, status: 'idle' };
      if (at < state.index) return { ...state, queue, index: state.index - 1 };
      if (at > state.index) return { ...state, queue };

      // The current track went. The one after it takes its place, and if there
      // was none the player stops rather than silently rewinding.
      if (state.index < queue.length) return { ...state, queue, epoch: state.epoch + 1 };
      return { ...state, queue, index: queue.length - 1, status: 'idle' };
    }

    case 'clear':
      if (state.queue.length === 0 && state.status === 'idle' && state.sleepUntil === null) {
        return state;
      }
      return { ...state, queue: [], index: 0, status: 'idle', sleepUntil: null };

    case 'setRate': {
      if (!Number.isFinite(action.rate)) return state;
      const rate = clampRate(action.rate);
      return rate === state.rate ? state : { ...state, rate };
    }

    case 'setVoice': {
      const voiceURI = action.voiceURI || null;
      return voiceURI === state.voiceURI ? state : { ...state, voiceURI };
    }

    case 'setSleep': {
      if (action.until !== null && !Number.isFinite(action.until)) return state;
      return action.until === state.sleepUntil ? state : { ...state, sleepUntil: action.until };
    }
  }
}

/** The track under the needle, or null when there is nothing to play. */
export function currentTrack(state: PlayerState): Track | null {
  return state.queue[state.index] ?? null;
}

/* --- Persistence ---------------------------------------------------------- */

/**
 * The queue is stored per reader, and the stored copy says whose it is.
 *
 * Two readers on one device must not hear each other's queue, and a guest's
 * queue must not follow them into an account. The key carries the owner so the
 * lookup is already scoped, and the payload carries it again so that a copy
 * moved between keys — by an older build, or by hand — is still refused. Belt
 * and braces, because the failure is a stranger's reading list starting to play.
 */
export const PLAYER_KEY = 'wap:player';

export function playerStorageKey(userId: string | null): string {
  return `${PLAYER_KEY}:${userId ?? 'guest'}`;
}

interface Stored {
  v: 1;
  owner: string | null;
  queue: Track[];
  index: number;
  rate: number;
  voiceURI: string | null;
  sleepUntil: number | null;
}

/**
 * What survives a reload. Status does not: a browser will not speak without a
 * gesture, so a queue comes back paused with its place kept, never playing.
 */
export function serialize(state: PlayerState, userId: string | null): string {
  const stored: Stored = {
    v: 1,
    owner: userId,
    queue: state.queue,
    index: state.index,
    rate: state.rate,
    voiceURI: state.voiceURI,
    sleepUntil: state.sleepUntil,
  };
  return JSON.stringify(stored);
}

function isTrack(value: unknown): value is Track {
  if (typeof value !== 'object' || value === null) return false;
  const t = value as Record<string, unknown>;
  return (
    typeof t.id === 'string' &&
    t.id.length > 0 &&
    typeof t.title === 'string' &&
    typeof t.text === 'string'
  );
}

/**
 * Rebuild a state from whatever was stored, or from nothing.
 *
 * Tolerant of garbage in every field rather than all-or-nothing, and the
 * distinction matters: the value comes from `localStorage`, which is to say
 * from an older build of this app or a devtools console. A queue with one
 * malformed entry keeps its other entries; a rate that is not a number becomes
 * 1; an index past the end lands on the last track. The one thing that is
 * refused whole is a payload belonging to somebody else.
 *
 * A sleep timer that has already passed is dropped, since honouring it would
 * pause the first track the reader plays tomorrow for a reason set last night.
 */
export function hydrate(
  raw: unknown,
  userId: string | null,
  now: number = Date.now(),
): PlayerState {
  if (typeof raw !== 'string' || raw.length === 0) return INITIAL_PLAYER;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return INITIAL_PLAYER;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return INITIAL_PLAYER;
  }

  const s = parsed as Record<string, unknown>;
  if (s.v !== 1) return INITIAL_PLAYER;
  if ((s.owner ?? null) !== userId) return INITIAL_PLAYER;

  const seen = new Set<string>();
  const queue: Track[] = [];
  // The stored cursor counts positions in the payload, and the payload may hold
  // entries this rebuild drops. Clamping alone would silently move the cursor
  // onto a different track — `[invalid, a, b]` at index 1 means `a`, and a clamp
  // lands it on `b`. Count how many entries before it survived instead, so the
  // cursor keeps pointing at the track it named.
  const storedIndex =
    typeof s.index === 'number' && Number.isInteger(s.index) ? Math.max(0, s.index) : 0;
  let retainedBefore = 0;
  for (const [position, entry] of (Array.isArray(s.queue) ? s.queue : []).entries()) {
    if (!isTrack(entry) || seen.has(entry.id)) continue;
    seen.add(entry.id);
    if (position < storedIndex) retainedBefore += 1;
    queue.push({ id: entry.id, title: entry.title, text: entry.text });
  }

  const index = queue.length === 0 ? 0 : Math.min(queue.length - 1, retainedBefore);

  const rate = typeof s.rate === 'number' && Number.isFinite(s.rate) ? clampRate(s.rate) : 1;
  const voiceURI = typeof s.voiceURI === 'string' && s.voiceURI.length > 0 ? s.voiceURI : null;
  const sleepUntil =
    typeof s.sleepUntil === 'number' && Number.isFinite(s.sleepUntil) && s.sleepUntil > now
      ? s.sleepUntil
      : null;

  return {
    queue,
    index,
    status: queue.length > 0 ? 'paused' : 'idle',
    rate,
    voiceURI,
    sleepUntil,
    epoch: 0,
  };
}
