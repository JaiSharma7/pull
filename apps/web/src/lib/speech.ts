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
