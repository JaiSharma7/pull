/**
 * The effect layer the player reducer was written for.
 *
 * `lib/player.ts` holds every transition as a pure function and states, at
 * length, what the layer that actually speaks must do. This is that layer, and
 * it is deliberately the only place in the app that calls `speak`: a queue that
 * outlives the card it was started from cannot be owned by a card.
 *
 * Four jobs, and nothing else:
 *
 *   1. Turn state into sound. Keyed on THE EPOCH IT IS SPEAKING, per the
 *      contract in `lib/player.ts` — not on what changed at a transition, which
 *      is unimplementable for a queue restored from storage at epoch 0.
 *   2. Remember the queue, through `lib/audio-prefs.ts`, which decides whether
 *      it goes anywhere durable.
 *   3. Hold the three listening settings, which are a property of the device
 *      rather than of the queue. The reducer carries a rate and a voice because
 *      an utterance needs them; `lib/audio-prefs.ts` is where they persist, and
 *      this is the seam between the two. The bar and the Appearance screen both
 *      set them through here, so there is one answer rather than two.
 *   4. Tell the operating system what is playing, so the lock screen and a
 *      headset button reach the same reducer the bar does.
 *
 * THE QUEUE BELONGS TO ONE READER, which is why there are two components here.
 * `PlayerEngine` is keyed on the reader's id, so a sign-in or a sign-out gives a
 * new engine that reads its own stored queue and writes only under its own key;
 * the outgoing one's teardown stops the voice mid-sentence, which is exactly
 * what signing out should do to it. `PlayerProvider` does not remount, so it is
 * the one that can see an identity change happen and forget what the previous
 * reader had queued.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  INITIAL_PLAYER,
  clampRate,
  currentTrack,
  playerReducer,
  type PlayerState,
  type Track,
} from '../lib/player.js';
import {
  clearStoredPlayer,
  DEFAULT_AUDIO_PREFS,
  readStoredAudioPrefs,
  readStoredPlayer,
  sleepMinutes,
  storeAudioPrefs,
  storePlayer,
  type AudioPrefs,
  type SleepTimer,
} from '../lib/audio-prefs.js';
import {
  adjustSpeaking,
  pauseSpeaking,
  resumeSpeaking,
  speak,
  speechSupported,
  stopSpeaking,
} from '../lib/speech.js';

/**
 * Decided once, for the reason `Feed` decides it once: a control that cannot
 * work should not be drawn at all, and the answer cannot change inside a
 * session.
 */
const CAN_SPEAK = speechSupported();

const MINUTE_MS = 60_000;

export interface PlayerApi {
  state: PlayerState;
  /** False where the browser has no speech synthesis; every control is withheld. */
  supported: boolean;
  /** The device's listening settings, as stored. `state` carries the live rate and voice. */
  prefs: AudioPrefs;
  enqueue: (tracks: Track[]) => void;
  playNow: (track: Track) => void;
  next: () => void;
  prev: () => void;
  pause: () => void;
  resume: () => void;
  stop: () => void;
  remove: (id: string) => void;
  clear: () => void;
  setRate: (rate: number) => void;
  setVoice: (voiceURI: string | null) => void;
  /**
   * Choose how long a listening session runs before it pauses itself.
   *
   * Takes the remembered choice rather than a deadline: the reducer's
   * `sleepUntil` is an absolute timestamp belonging to this session, and turning
   * "30 minutes" into one is a clock read, which is the thing the reducer is
   * written never to do.
   */
  setSleep: (sleep: SleepTimer) => void;
}

const PlayerContext = createContext<PlayerApi | null>(null);

/**
 * The player, for a screen that wants to hand it something to say.
 *
 * Throws outside a provider rather than returning a player that silently
 * swallows a queue: a Listen button that does nothing is the bug this whole
 * package exists to remove, and it should not be reachable by forgetting a
 * wrapper.
 */
export function usePlayer(): PlayerApi {
  const api = useContext(PlayerContext);
  if (api === null) throw new Error('usePlayer must be used inside a PlayerProvider');
  return api;
}

/**
 * The two questions a card asks the player, as their own context.
 *
 * Separate from `PlayerApi` because they change far less often than it does: the api's
 * identity moves on every reducer transition, and a list of cards that re-renders on a
 * rate change is a list re-rendering for an answer that did not move.
 */
export interface PlayerSelection {
  /** The Pull being spoken right now, if any. */
  playingId: string | null;
  /** Every Pull anywhere in the queue. */
  queuedIds: ReadonlySet<string>;
}

const SelectionContext = createContext<PlayerSelection | null>(null);

/**
 * The things a screen DOES to the player, with an identity that does not move.
 *
 * Every one is a `useCallback` over refs, so this object is built once and outlives
 * every transition — which is what lets a list of cards subscribe to the two answers it
 * draws (`PlayerSelection`) without also subscribing to the state it does not.
 */
export type PlayerActions = Pick<
  PlayerApi,
  | 'supported'
  | 'enqueue'
  | 'playNow'
  | 'next'
  | 'prev'
  | 'pause'
  | 'resume'
  | 'stop'
  | 'remove'
  | 'clear'
>;

const ActionsContext = createContext<PlayerActions | null>(null);

/** What a screen may ask the player to do. Throws outside a provider, as `usePlayer` does. */
export function usePlayerActions(): PlayerActions {
  const actions = useContext(ActionsContext);
  if (actions === null) throw new Error('usePlayerActions must be used inside a PlayerProvider');
  return actions;
}

const NOTHING_SELECTED: PlayerSelection = { playingId: null, queuedIds: new Set() };

/**
 * What is playing and what is queued, for a screen that draws a list of cards.
 *
 * Does NOT throw outside a provider, unlike `usePlayer`: this answers a question about
 * appearance, and a card rendered in a test or a specimen with no player around it is
 * simply a card with nothing playing. `usePlayer` throws because a Listen button that
 * silently swallows a queue is the bug the whole module exists to prevent.
 */
export function usePlayerSelection(): PlayerSelection {
  return useContext(SelectionContext) ?? NOTHING_SELECTED;
}

/** Whether a Pull is the one being spoken right now — for a card's own label. */
export function isPlaying(selection: PlayerSelection, pullId: string): boolean {
  return selection.playingId === pullId;
}

/** Whether a Pull is anywhere in the queue — for a Queue button's `aria-pressed`. */
export function isQueued(selection: PlayerSelection, pullId: string): boolean {
  return selection.queuedIds.has(pullId);
}

interface ProviderProps {
  /** The reader whose queue this is; null for a signed-out visitor. */
  userId: string | null;
  /**
   * Whether the queue may be written somewhere that survives closing the
   * browser. False for a guest, whose reading list is no more durable than the
   * anonymous account it belongs to — `lib/audio-prefs.ts` ANDs this with a
   * non-null id again, so forgetting it loses persistence rather than leaking.
   */
  durable: boolean;
  children: ReactNode;
}

export function PlayerProvider({ userId, durable, children }: ProviderProps) {
  /*
   * A queue does not cross an identity.
   *
   * The engine below is keyed on the reader, so the incoming one reads its own
   * stored queue; this is the outgoing half. `clearStoredPlayer` clears both the
   * named key and the visitor's, so signing in forgets what was queued without an
   * address and signing out leaves the machine silent for whoever is next.
   *
   * Child effects run before a parent's, so by the time this fires the new engine
   * has already read storage under its own key and written its own state there.
   * Clearing the OUTGOING id afterwards is therefore safe in both directions, and
   * would not be if the order were reversed.
   */
  const previous = useRef(userId);
  useEffect(() => {
    if (previous.current === userId) return;
    const outgoing = previous.current;
    previous.current = userId;
    clearStoredPlayer(outgoing);
  }, [userId]);

  return (
    <PlayerEngine key={userId ?? 'visitor'} userId={userId} durable={durable}>
      {children}
    </PlayerEngine>
  );
}

function PlayerEngine({ userId, durable, children }: ProviderProps) {
  // `DEFAULT_AUDIO_PREFS`, not a second copy of it: `lib/audio-prefs.ts` owns what a
  // default is, and a literal here would apply a changed default to every reader whose
  // browser can speak and to none of the rest, with nothing to catch the divergence.
  const [prefs, setPrefs] = useState<AudioPrefs>(() =>
    CAN_SPEAK ? readStoredAudioPrefs() : DEFAULT_AUDIO_PREFS,
  );

  /*
   * The restored queue, at the device's rate and in the device's voice.
   *
   * The stored payload carries a rate and a voice of its own, and they are
   * overridden here on purpose: those two are settings of the MACHINE — see the
   * header of `lib/audio-prefs.ts` on why a voice cannot be a property of a
   * reader — so a queue restored on the laptop must not reinstate the phone's
   * rate alongside it.
   */
  const [state, dispatch] = useReducer(playerReducer, null, () => {
    if (!CAN_SPEAK) return INITIAL_PLAYER;
    const restored = readStoredPlayer(userId, durable);
    return { ...restored, rate: clampRate(prefs.rate), voiceURI: prefs.voiceURI };
  });

  /*
   * What the voice is actually doing, as distinct from what the state says it
   * should be doing.
   *
   * `spokenEpoch` is the epoch the live (or suspended) utterance was started
   * under, and null when nothing has been started at all. The contract in
   * `lib/player.ts` is written against exactly this value: speak whenever the
   * state's epoch is not the one being spoken, and never on a bare "something
   * changed". A queue restored from storage arrives at epoch 0 with nothing
   * started, and null is what makes that case speak rather than resume.
   *
   * `spokenRate` and `spokenVoice` are what that utterance was started WITH, so a
   * settings change mid-sentence can be told from an ordinary re-render and
   * applied in place rather than restarting the passage from the top.
   */
  const spokenEpoch = useRef<number | null>(null);
  const spokenRate = useRef(state.rate);
  const spokenVoice = useRef(state.voiceURI);

  useEffect(() => {
    if (!CAN_SPEAK) return;
    const track = currentTrack(state);
    const sameUtterance = spokenEpoch.current !== null && spokenEpoch.current === state.epoch;

    // A rate or voice change reaches whatever is live or suspended, at any
    // status, and is not an ending: `adjustSpeaking` keeps the reader's place and
    // the utterance keeps its token. Done before the transport below so a change
    // made while paused is already waiting when Resume is pressed.
    const changed = state.rate !== spokenRate.current || state.voiceURI !== spokenVoice.current;
    if (sameUtterance && changed) {
      spokenRate.current = state.rate;
      spokenVoice.current = state.voiceURI;
      adjustSpeaking({ rate: state.rate, voiceURI: state.voiceURI });
    }

    if (state.status === 'idle' || track === null) {
      if (spokenEpoch.current !== null) {
        spokenEpoch.current = null;
        stopSpeaking();
      }
      return;
    }

    if (state.status === 'paused') {
      // A no-op when nothing is live, which is the sleep timer's case: it pauses
      // at a boundary, so the utterance it paused after has already ended.
      pauseSpeaking();
      return;
    }

    if (!sameUtterance) {
      /*
       * THE EPOCH THIS CLOSURE WAS STARTED UNDER, not the token `speak` returns.
       *
       * `ended` is checked against `state.epoch` in the reducer — `token` there is
       * named for the epoch it carries — and `speak` hands `onEnd` its OWN counter
       * (`lib/speech.ts` mints `++lastToken` per utterance). The two only look
       * interchangeable because, on a fresh page played straight through, each
       * epoch bump is followed by exactly one `speak` and the counters walk in
       * step. They come apart the moment anything breaks that one-to-one:
       *
       *   - Resume from `paused` deliberately does NOT bump the epoch (the same
       *     utterance continues), so a queue restored from storage at epoch 0 and
       *     then played speaks under token 1 against epoch 0 — every ending is
       *     discarded and the player sits silent on "Listening · 1 of 5".
       *   - `PlayerEngine` is keyed on the user id, so a sign-in or sign-out
       *     remounts it at epoch 0 while `lastToken` keeps its page-lifetime
       *     value. After that the two never meet again and the queue never
       *     advances for the rest of the page.
       *
       * The epoch is what the guard is FOR — telling this utterance's ending from
       * the one `speak` abandons while starting it — so the epoch is what goes in.
       * An abandoned utterance's closure still carries its own older epoch, which
       * is exactly the stale ending the reducer drops.
       */
      const epoch = state.epoch;
      spokenEpoch.current = epoch;
      spokenRate.current = state.rate;
      spokenVoice.current = state.voiceURI;
      speak(track.text, {
        rate: state.rate,
        voiceURI: state.voiceURI,
        // `now` so the sleep timer is read at the boundary it fires on. The
        // reducer never reads a clock; the caller that has one passes it.
        onEnd: () => dispatch({ type: 'ended', token: epoch, now: Date.now() }),
      });
      return;
    }

    // The same utterance, playing. Either the reader pressed Resume, or this is a
    // re-render for something the voice does not care about; `resumeSpeaking` is a
    // no-op when nothing is suspended, so one call covers both.
    resumeSpeaking();
  }, [state]);

  /*
   * Speech outlives React — `speechSynthesis` is global — so an engine that goes
   * away without stopping leaves a voice with no control left to reach it. This is
   * also what makes a sign-out silent: the outgoing engine unmounts.
   */
  useEffect(() => () => stopSpeaking(), []);

  useEffect(() => {
    if (!CAN_SPEAK) return;
    storePlayer(state, userId, durable);
  }, [state, userId, durable]);

  /*
   * The remembered timer is armed when a listening session begins, not when the
   * app loads.
   *
   * `sleepUntil` is an absolute deadline, so setting it at mount would count an
   * hour of reading against a queue that had not started. "Thirty minutes, most
   * nights" means thirty minutes from the moment the voice starts.
   *
   * KEYED ON `playing`, NOT ON "NOT IDLE", which is the same mistake one step
   * smaller and is what the first version did. `hydrate` returns `paused` for any
   * restored queue, so a reader reloading with something queued mounted at
   * `paused` -- not idle -- and armed the timer against a voice that had not said
   * a word. Leave the tab for forty minutes, press Play, and the player paused
   * itself at the end of the first track on a deadline already spent.
   */
  const wasPlaying = useRef(false);
  useEffect(() => {
    const playing = state.status === 'playing';
    const starting = !wasPlaying.current && playing;
    wasPlaying.current = playing;
    if (!starting || state.sleepUntil !== null) return;
    const minutes = sleepMinutes(prefs.sleep);
    if (minutes === null) return;
    dispatch({ type: 'setSleep', until: Date.now() + minutes * MINUTE_MS });
  }, [state.status, state.sleepUntil, prefs.sleep]);

  /*
   * Room at the foot of the shell for a bar the shell cannot see.
   *
   * `PlayerBar` is mounted inside the shell and positioned over it, so the
   * padding that keeps `Enough` and the Colophon clear of it cannot be a prop —
   * the shell renders the provider, not the other way round. The root attribute
   * is the same seam focus mode uses (`:root[data-focus='on']`), and the
   * stylesheet that reserves the space is beside the one that draws the bar.
   */
  useEffect(() => {
    const root = document.documentElement;
    if (CAN_SPEAK && state.queue.length > 0) root.dataset.listening = 'on';
    else delete root.dataset.listening;
    return () => {
      delete root.dataset.listening;
    };
  }, [state.queue.length]);

  /*
   * The lock screen, the headset button, and the notification a phone draws while
   * the tab is in the background.
   *
   * Metadata and handlers are separate effects because they change at different
   * rates: the metadata is the track, and the handlers are constant for the life
   * of the engine.
   *
   * NOT VERIFIABLE FROM THIS REPOSITORY. `speechSynthesis` is not a media element,
   * so whether a given browser attaches these controls to it is a fact about that
   * browser. Every call is guarded and the feature degrades to the bar on screen.
   */
  const track = currentTrack(state);
  useEffect(() => {
    const session = navigator.mediaSession;
    if (!session) return;
    if (track === null) {
      session.metadata = null;
      session.playbackState = 'none';
      return;
    }
    try {
      session.metadata = new MediaMetadata({ title: track.title, artist: 'What a Pull' });
    } catch {
      // A browser with `mediaSession` but no `MediaMetadata` constructor. The
      // handlers below still work; only the title on the lock screen is lost.
    }
    session.playbackState = state.status === 'playing' ? 'playing' : 'paused';
    // Keyed on the track and the status rather than on the whole state, which is what
    // the comment above claims. On `[state]` every `setRate` drag, every enqueue and
    // every `ended` tick allocated a fresh `MediaMetadata` and reassigned it — and a
    // metadata reassignment repaints the lock screen on some browsers, so a rate
    // slider dragged through ten steps repainted it ten times.
    //
    // `track` by reference, not by id: the reducer keeps a Track's identity across
    // every transition that does not replace it — `enqueue` spreads the existing
    // entries, `remove` filters them, `setRate` does not touch the queue — so this is
    // both what the rule wants and what the effect actually depends on.
  }, [track, state.status]);

  useEffect(() => {
    const session = navigator.mediaSession;
    if (typeof session?.setActionHandler !== 'function') return;
    const handlers: [MediaSessionAction, () => void][] = [
      ['play', () => dispatch({ type: 'resume' })],
      ['pause', () => dispatch({ type: 'pause' })],
      ['stop', () => dispatch({ type: 'stop' })],
      ['nexttrack', () => dispatch({ type: 'next' })],
      ['previoustrack', () => dispatch({ type: 'prev' })],
    ];
    for (const [action, handler] of handlers) {
      try {
        session.setActionHandler(action, handler);
      } catch {
        // An action this browser does not know. The others are unaffected.
      }
    }
    return () => {
      for (const [action] of handlers) {
        try {
          session.setActionHandler(action, null);
        } catch {
          // Nothing was registered; nothing to unregister.
        }
      }
    };
  }, []);

  /*
   * The setters below read the latest preferences through a ref rather than
   * closing over them, so they stay stable across a change to any one of the
   * three. Two settings changed in the same tick would otherwise both start from
   * the same stale object, and the second write would drop the first.
   */
  const prefsRef = useRef(prefs);
  useEffect(() => {
    prefsRef.current = prefs;
  }, [prefs]);

  /** What the player is doing, for the setters, which must not close over it. */
  const statusRef = useRef(state.status);
  useEffect(() => {
    statusRef.current = state.status;
  }, [state.status]);

  const writePrefs = useCallback((next: AudioPrefs) => {
    prefsRef.current = next;
    setPrefs(next);
    storeAudioPrefs(next);
  }, []);

  const enqueue = useCallback((tracks: Track[]) => dispatch({ type: 'enqueue', tracks }), []);
  const playNow = useCallback((track: Track) => dispatch({ type: 'playNow', track }), []);
  const next = useCallback(() => dispatch({ type: 'next' }), []);
  const prev = useCallback(() => dispatch({ type: 'prev' }), []);
  const pause = useCallback(() => dispatch({ type: 'pause' }), []);
  const resume = useCallback(() => dispatch({ type: 'resume' }), []);
  const stop = useCallback(() => dispatch({ type: 'stop' }), []);
  const remove = useCallback((id: string) => dispatch({ type: 'remove', id }), []);
  const clear = useCallback(() => dispatch({ type: 'clear' }), []);

  const setRate = useCallback(
    (rate: number) => {
      dispatch({ type: 'setRate', rate });
      writePrefs({ ...prefsRef.current, rate: clampRate(rate) });
    },
    [writePrefs],
  );
  const setVoice = useCallback(
    (voiceURI: string | null) => {
      dispatch({ type: 'setVoice', voiceURI });
      writePrefs({ ...prefsRef.current, voiceURI: voiceURI || null });
    },
    [writePrefs],
  );
  /*
   * A deadline only while something is playing; otherwise only a preference.
   *
   * `sleepUntil` is an absolute timestamp, and turning "30 minutes" into one against
   * an idle player starts the clock on silence. A reader choosing 30 minutes in
   * Appearance at 20:00 and starting to listen at 22:00 had a deadline two hours in
   * the past — and the arming effect refuses to refresh it, because it only arms when
   * `sleepUntil` is null. The first track ended, `advance` read a deadline already
   * passed, and the player paused itself immediately.
   *
   * So a choice made in silence is remembered and nothing more; the arming effect
   * turns it into a deadline at the moment the voice starts, which is what the
   * duration means.
   */
  const setSleep = useCallback(
    (sleep: SleepTimer) => {
      writePrefs({ ...prefsRef.current, sleep });
      const minutes = sleepMinutes(sleep);
      const live = statusRef.current === 'playing';
      dispatch({
        type: 'setSleep',
        until: minutes === null || !live ? null : Date.now() + minutes * MINUTE_MS,
      });
    },
    [writePrefs],
  );

  const api = useMemo<PlayerApi>(
    () => ({
      state,
      supported: CAN_SPEAK,
      prefs,
      enqueue,
      playNow,
      next,
      prev,
      pause,
      resume,
      stop,
      remove,
      clear,
      setRate,
      setVoice,
      setSleep,
    }),
    [
      state,
      prefs,
      enqueue,
      playNow,
      next,
      prev,
      pause,
      resume,
      stop,
      remove,
      clear,
      setRate,
      setVoice,
      setSleep,
    ],
  );

  /*
   * What a CARD needs, and nothing that changes without it.
   *
   * `api` carries the whole reducer state, so its identity changes on every transition —
   * a track ending, a step of the rate slider, a sleep timer armed. Feed, Library and
   * Source consume it only to ask two questions per card, `isPlaying` and `isQueued`,
   * and they were being re-rendered wholesale for answers that had not moved: four
   * hundred `PullCard`s, each re-running `depthLevels` and `textAtDepth`, ten times
   * while somebody dragged the rate through its steps. The `onReadRef`/`onVisibleRef`
   * dance in `Feed.tsx` exists because those re-renders were tearing down every card's
   * `IntersectionObserver`; that is the symptom, and this is the cause.
   *
   * Memoised on the three fields the answers actually depend on, so a rate or voice
   * change publishes the same object and the lists do not re-render at all.
   */
  const { status, index, queue } = state;
  const selection = useMemo<PlayerSelection>(
    () => ({
      playingId: status === 'playing' ? (queue[index]?.id ?? null) : null,
      queuedIds: new Set(queue.map((t) => t.id)),
    }),
    // The three fields the two answers depend on, and not `state` — which is the whole
    // point: depending on the object would publish a new selection on every transition,
    // which is the re-render this exists to stop. `currentTrack` is `queue[index]`, so
    // it is inlined rather than reached for through the state it came from.
    [status, index, queue],
  );

  const actions = useMemo<PlayerActions>(
    () => ({
      supported: CAN_SPEAK,
      enqueue,
      playNow,
      next,
      prev,
      pause,
      resume,
      stop,
      remove,
      clear,
    }),
    [enqueue, playNow, next, prev, pause, resume, stop, remove, clear],
  );

  return (
    <PlayerContext.Provider value={api}>
      <ActionsContext.Provider value={actions}>
        <SelectionContext.Provider value={selection}>{children}</SelectionContext.Provider>
      </ActionsContext.Provider>
    </PlayerContext.Provider>
  );
}
