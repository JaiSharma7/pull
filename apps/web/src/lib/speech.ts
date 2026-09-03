/**
 * Read-aloud, free forever (CLAUDE.md law 3) — and dictation, which is not the same thing.
 *
 * `speechSynthesis` is on the device, so read-aloud costs nothing per user and needs no
 * server. Deepstash puts playback behind Pro; here it is affordable precisely because of
 * where it runs.
 *
 * `SpeechRecognition` is **not** the same bargain, and this header used to vouch for both.
 * In Chrome and Edge it streams the captured audio to Google's speech service, and in
 * Safari to Apple's; only a few configurations run it locally. It still costs us nothing
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
   * Called when this utterance stops for any reason — finished, cancelled by the
   * next `speak`, or ended by `stopSpeaking`.
   *
   * Without it a caller showing a Stop control has no way to learn that playback
   * finished on its own, so the button sits there offering to stop silence.
   * `error` counts as an ending too: a voice that fails to load must not leave the
   * UI claiming it is still speaking.
   */
  onEnd?: () => void;
}

export function speak(text: string, options: SpeakOptions = {}): void {
  if (!speechSupported()) return;
  const { rate = 1, onEnd } = options;
  // Cancelling first means the previous utterance's own `onend` fires during this
  // call. Callers distinguish the two by the id they were speaking — see `Feed.tsx`.
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = rate;
  if (onEnd) {
    utterance.onend = () => onEnd();
    utterance.onerror = () => onEnd();
  }
  window.speechSynthesis.speak(utterance);
}

export function stopSpeaking(): void {
  if (speechSupported()) window.speechSynthesis.cancel();
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
