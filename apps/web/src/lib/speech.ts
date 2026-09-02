/**
 * Read-aloud, free forever (CLAUDE.md law 3).
 *
 * The Web Speech API is on the device, so audio costs nothing per user and
 * needs no server. Deepstash puts playback behind Pro; here it is affordable
 * precisely because of where it runs.
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
  [index: number]: {
    transcript: string;
  };
}

interface SpeechRecognitionEventLike {
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
  onResult: (transcript: string) => void;
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

  recognition.onresult = (event: SpeechRecognitionEventLike) => {
    let full = '';
    for (let i = 0; i < event.results.length; i++) {
      const res = event.results[i];
      if (res && res[0]) {
        full += res[0].transcript;
      }
    }
    options.onResult(full);
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
    try {
      recognition.stop();
    } catch {
      // safe no-op if already stopped
    }
  };
}
