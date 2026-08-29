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

export function speak(text: string, rate = 1): void {
  if (!speechSupported()) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = rate;
  window.speechSynthesis.speak(utterance);
}

export function stopSpeaking(): void {
  if (speechSupported()) window.speechSynthesis.cancel();
}
