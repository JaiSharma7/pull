/**
 * Read-aloud, free forever (CLAUDE.md law 3) — and dictation, which is not the same thing.
 *
 * `speechSynthesis` is on the device, so read-aloud costs nothing per user and needs no
 * server. Deepstash puts playback behind Pro; here it is affordable precisely because of
 * where it runs.
 *
 * "On the device" has one qualification, and `listVoices` exists to make it. A browser
 * ships local voices and may also offer remote ones — Chrome's "Google" voices synthesise
 * on Google's servers, which means the text of the card goes there to be read. That is
 * a smaller thing than dictation (the text is a published summary, not a reader's
 * voice) but it is still a network round trip and it still does not work offline, so
 * the local voices come first in the list and a reader who picks nothing gets the
 * browser's default.
 *
 * PAUSE IS CANCEL PLUS A REMEMBERED OFFSET, not `speechSynthesis.pause()`. The native
 * call is unreliable where it matters most: on Chrome for Android it either does
 * nothing or ends the utterance outright, and `resume()` after it starts again from
 * the top; on desktop Chrome an utterance paused for more than about fifteen seconds
 * is quietly killed by the engine and never resumes at all. So pausing here cancels
 * the utterance and remembers the `charIndex` of the last `onboundary` event — the
 * start of the word being spoken — and resuming speaks the text again from that word.
 * One path that behaves the same everywhere beats a native path that is only true on
 * the machines we do not have. The cost is honest: an engine that fires no boundary
 * events (Chrome Android's remote voices among them) resumes from the start of the
 * utterance, and a card is a paragraph, so the price is a paragraph.
 *
 * `SpeechRecognition` is **not** the same bargain, and this header used to vouch for both.
 * In most browsers it streams the captured audio to that browser's own speech
 * service — Chrome to Google, Safari to Apple, Edge to Microsoft; only a few
 * configurations run it locally. It still costs us nothing
 * and calls no model of ours — law 2 is untouched — but "on the device" is false for it,
 * and a reader pressing Dictate is sending their voice to their browser's vendor. That is
 * their call to make, so `docs/privacy.md` says so and the control says so beside itself.
 * Nothing here records, stores or transmits audio to us.
 */
export interface SpeechState {
  supported: boolean;
  speaking: boolean;
}

export function speechSupported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

export interface SpeakOptions {
  rate?: number;
  /**
   * A `SpeechSynthesisVoice.voiceURI`, as returned by `listVoices()`.
   *
   * Unknown or null means the browser's default rather than the nearest match:
   * a voice the reader chose on another device, or one an update removed, must
   * not become a different voice they never picked.
   */
  voiceURI?: string | null;
  /**
   * Called when this utterance stops for any reason — finished, cancelled by the
   * next `speak`, or ended by `stopSpeaking`.
   *
   * Without it a caller showing a Stop control has no way to learn that playback
   * finished on its own, so the button sits there offering to stop silence.
   * `error` counts as an ending too: a voice that fails to load must not leave the
   * UI claiming it is still speaking.
   *
   * A pause is NOT an ending. The utterance is cancelled under the hood (see the
   * header), but the caller is not told, because from where they stand nothing
   * has finished — and a player that heard "ended" on every pause would advance
   * to the next track while the reader was answering the door.
   *
   * Handed the token `speak` returned for this utterance, so a caller holding
   * the token can tell its own ending from the previous utterance's — which,
   * because of the cancel above, fires during the very call that starts the
   * new one. A caller that ignores the argument keeps today's behaviour.
   */
  onEnd?: (token: SpeechToken) => void;
}

/**
 * Names one call to `speak`. Pause and resume continue the same utterance and
 * keep its token; only a new `speak` mints a new one.
 */
export type SpeechToken = number;

let lastToken: SpeechToken = 0;

/** What is being spoken right now, and where in the full text it began. */
interface Live {
  /** The whole text handed to `speak`, not the slice this utterance is reading. */
  text: string;
  /** Where in `text` this utterance started, so boundary offsets can be made absolute. */
  base: number;
  /** The start of the last word heard, absolute in `text`. Resume picks up here. */
  offset: number;
  options: SpeakOptions;
  token: SpeechToken;
  /**
   * Set before a cancel that is not an ending — a pause, or a rate change
   * applied in place — so the `onend` it causes is not reported.
   */
  silenced: boolean;
  /** Both `onend` and `onerror` route through `finish`; this keeps `onEnd` to once. */
  done: boolean;
}

interface Suspended {
  text: string;
  offset: number;
  options: SpeakOptions;
  token: SpeechToken;
}

let live: Live | null = null;
let suspended: Suspended | null = null;

function findVoice(voiceURI: string): SpeechSynthesisVoice | null {
  return window.speechSynthesis.getVoices().find((v) => v.voiceURI === voiceURI) ?? null;
}

function finish(record: Live): void {
  if (record.done) return;
  record.done = true;
  if (live === record) live = null;
  if (record.silenced) return;
  record.options.onEnd?.(record.token);
}

function begin(text: string, from: number, options: SpeakOptions, token: SpeechToken): void {
  const { rate = 1, voiceURI = null } = options;
  // Cancelling first means the previous utterance's own `onend` fires during this
  // call. Callers distinguish the two by the id they were speaking — see `Feed.tsx`.
  window.speechSynthesis.cancel();

  const utterance = new SpeechSynthesisUtterance(from > 0 ? text.slice(from) : text);
  utterance.rate = rate;
  const voice = voiceURI ? findVoice(voiceURI) : null;
  if (voice) utterance.voice = voice;

  const record: Live = {
    text,
    base: from,
    offset: from,
    options,
    token,
    silenced: false,
    done: false,
  };
  utterance.onboundary = (event) => {
    // Word boundaries only. A sentence boundary lands on the same index as the
    // first word of the sentence, so it is harmless, but resuming at a word is
    // what a listener expects — the engine picks the last word up again.
    record.offset = from + event.charIndex;
  };
  utterance.onend = () => finish(record);
  utterance.onerror = () => finish(record);

  live = record;
  window.speechSynthesis.speak(utterance);
}

/**
 * Speak, ending whatever was being spoken. Returns the token that names this
 * utterance; `onEnd` is handed the same token. Zero when unsupported, which is
 * never a token an utterance gets.
 */
export function speak(text: string, options: SpeakOptions = {}): SpeechToken {
  if (!speechSupported()) return 0;
  // A paused utterance has no live object for `cancel` to end, so its ending is
  // reported here, before the new one starts — the same order the live case gets.
  const abandoned = suspended;
  suspended = null;
  abandoned?.options.onEnd?.(abandoned.token);
  const token = ++lastToken;
  begin(text, 0, options, token);
  return token;
}

/**
 * Pause. The utterance is cancelled and its place remembered; `onEnd` does not
 * fire. A no-op when nothing is being spoken, including when already paused.
 */
export function pauseSpeaking(): void {
  if (!speechSupported() || !live) return;
  const record = live;
  record.silenced = true;
  suspended = {
    text: record.text,
    offset: record.offset,
    options: record.options,
    token: record.token,
  };
  live = null;
  window.speechSynthesis.cancel();
}

/**
 * Resume from the last word boundary heard before the pause, with the same rate,
 * voice and `onEnd` as the original call. A no-op when nothing is paused.
 */
export function resumeSpeaking(): void {
  if (!speechSupported() || !suspended) return;
  const { text, offset, options, token } = suspended;
  suspended = null;
  begin(text, offset, options, token);
}

/**
 * Change the rate or voice of what is being spoken, keeping the place.
 *
 * Neither can change on a live utterance, so this is a cancel and a fresh
 * utterance from the last word boundary — the same move as a pause and a
 * resume, and like a pause it is not an ending: `onEnd` stays silent and the
 * token stays the same, because from where the listener stands it is the same
 * passage, faster. Applied to a paused utterance it takes effect on resume. A
 * no-op when nothing is live or paused.
 */
export function adjustSpeaking(changes: Pick<SpeakOptions, 'rate' | 'voiceURI'>): void {
  if (!speechSupported()) return;
  if (live) {
    const record = live;
    record.silenced = true;
    live = null;
    // `begin` cancels, which ends the silenced record without reporting it.
    begin(record.text, record.offset, { ...record.options, ...changes }, record.token);
    return;
  }
  if (suspended) {
    suspended = { ...suspended, options: { ...suspended.options, ...changes } };
  }
}

export function stopSpeaking(): void {
  if (!speechSupported()) return;
  // A paused utterance is already cancelled, so nothing will fire for it on its
  // own. It has still stopped, and the contract says its caller is told.
  const abandoned = suspended;
  suspended = null;
  window.speechSynthesis.cancel();
  abandoned?.options.onEnd?.(abandoned.token);
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The voices this device can speak in, local ones first.
 *
 * Local first because a local voice works offline and sends nothing anywhere
 * (see the header); the device's default next, since it is the one the reader
 * has already been hearing; then by language and name so the list reads as a
 * list. Ties keep the browser's order, so two calls over the same voices give
 * the same sequence and a settings screen does not reshuffle under the pointer.
 *
 * `getVoices()` is empty in Chrome until `voiceschanged` fires, often after the
 * first paint. `onVoicesChanged` is how a screen learns to ask again.
 */
export function listVoices(): SpeechSynthesisVoice[] {
  if (!speechSupported()) return [];
  return window.speechSynthesis
    .getVoices()
    .map((voice, order) => ({ voice, order }))
    .sort(
      (a, b) =>
        Number(b.voice.localService) - Number(a.voice.localService) ||
        Number(b.voice.default) - Number(a.voice.default) ||
        compare(a.voice.lang, b.voice.lang) ||
        compare(a.voice.name, b.voice.name) ||
        a.order - b.order,
    )
    .map(({ voice }) => voice);
}

/** Be told when the voice list changes. Returns a teardown; a no-op when unsupported. */
export function onVoicesChanged(listener: () => void): () => void {
  if (!speechSupported()) return () => {};
  const synth = window.speechSynthesis;
  if (typeof synth.addEventListener !== 'function') return () => {};
  synth.addEventListener('voiceschanged', listener);
  return () => synth.removeEventListener('voiceschanged', listener);
}

interface SpeechRecognitionEventResult {
  /** False while the engine may still revise this segment. */
  isFinal: boolean;
  [index: number]: {
    transcript: string;
  };
}

interface SpeechRecognitionEventLike {
  /**
   * The index of the first result this event actually changed.
   *
   * `results` is cumulative for the whole session, so an event fired after the tenth
   * word still carries all ten. Reading the list from zero on every event, as this did,
   * is how the same words get delivered again and again.
   */
  resultIndex: number;
  results: {
    length: number;
    [index: number]: SpeechRecognitionEventResult;
  };
}

interface SpeechRecognitionInstance {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: unknown) => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}

/**
 * Check if the browser supports speech-to-text dictation (Web Speech API).
 */
export function recognitionSupported(): boolean {
  if (typeof window === 'undefined') return false;
  const win = window as unknown as Record<string, unknown>;
  return 'SpeechRecognition' in win || 'webkitSpeechRecognition' in win;
}

export interface RecognitionOptions {
  /**
   * Called once per newly *finalised* segment, with only that segment's text.
   *
   * It used to be called on every event with the entire session transcript, while its
   * one caller appended what it received to a textarea. So a reader dictating "the
   * obstacle is the way" watched it arrive as "the / the obstacle / the obstacle is"
   * concatenated — the sentence repeated back several times over, growing as they spoke.
   * A caller may now append what it is handed, which is what a caller will do.
   */
  onResult: (transcript: string) => void;
  /**
   * The words the engine has heard but not yet committed, replaced on every event.
   *
   * Separate from `onResult` because it is not additive: this is a preview to show, not
   * text to keep. Optional — a caller that only wants finished sentences can ignore it.
   */
  onInterim?: (transcript: string) => void;
  onEnd?: () => void;
  onError?: (err: unknown) => void;
}

/**
 * Start listening to the microphone and stream transcript in real time.
 * Returns a teardown function to stop listening.
 */
export function startRecognition(options: RecognitionOptions): () => void {
  if (!recognitionSupported()) return () => {};
  const win = window as unknown as Record<string, new () => SpeechRecognitionInstance>;
  const RecognitionConstructor = win['SpeechRecognition'] ?? win['webkitSpeechRecognition'];
  if (!RecognitionConstructor) return () => {};

  const recognition = new RecognitionConstructor();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = 'en-US';

  /*
   * How much of `results` has already been handed over as final.
   *
   * `resultIndex` alone is not enough to rely on. It is the only thing that makes the
   * loop below correct, and an engine that omits it would send the read back to zero and
   * re-emit every finalised segment on every event — which is exactly the bug this
   * rewrite fixed, reintroduced by its own fallback. Tracking the high-water mark here
   * means a missing or rewound `resultIndex` degrades to "emit nothing twice" rather than
   * "emit everything again".
   */
  let finalisedThrough = 0;

  recognition.onresult = (event: SpeechRecognitionEventLike) => {
    let settled = '';
    let pending = '';
    // From `resultIndex`, not from zero: everything before it was delivered by an
    // earlier event and has not changed.
    const start = Math.max(event.resultIndex ?? 0, finalisedThrough);
    for (let i = start; i < event.results.length; i++) {
      const res = event.results[i];
      const text = res?.[0]?.transcript;
      if (!text) continue;
      if (res.isFinal) {
        settled += text;
        finalisedThrough = i + 1;
      } else {
        pending += text;
      }
    }
    if (settled) options.onResult(settled);
    options.onInterim?.(pending);
  };

  if (options.onEnd) {
    recognition.onend = () => options.onEnd?.();
  }
  if (options.onError) {
    recognition.onerror = (e) => options.onError?.(e);
  }

  try {
    recognition.start();
  } catch (err) {
    options.onError?.(err);
    return () => {};
  }

  return () => {
    /*
     * Detach first, then abort.
     *
     * `stop()` alone asks the engine to finish, and per spec it still delivers a final
     * result for what it had already captured — with the handlers still attached. So a
     * caller that had torn down, or a component that had unmounted, received one more
     * segment and appended it to state that was no longer on screen. Nulling the
     * handlers before aborting means the teardown is actually a teardown, and `abort()`
     * discards the pending audio rather than transcribing it on the way out.
     */
    recognition.onresult = null;
    recognition.onend = null;
    recognition.onerror = null;
    try {
      recognition.abort();
    } catch {
      // safe no-op if it never started or is already finished
    }
  };
}
