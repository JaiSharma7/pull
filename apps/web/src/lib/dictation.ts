/**
 * What dictation says about itself, in one place.
 *
 * Two screens dictate -- the feed's Say It Back interrupt and a path's say-it-back
 * step -- and each carried its own copy of the microphone disclosure and the failure
 * sentence. Two copies of a privacy sentence is how one of them drifts past
 * `docs/privacy.md`. The words live here; `use-dictation.ts` is the behaviour.
 */

/**
 * Said where the decision is made, not only in docs/privacy.md. In most browsers
 * speech recognition is not on the device -- the audio goes to the browser's own
 * vendor. It never reaches us, but it does leave the reader's machine, and they are
 * about to press the button that does it.
 */
export const DICTATION_DISCLOSURE =
  "Dictation uses your browser's speech recognition, which in most browsers sends the " +
  "audio to your browser's vendor. We never receive it. Typing sends nothing.";

/**
 * What to tell the reader when the engine reports an error -- or nothing.
 *
 * `startRecognition` routes every engine error through one callback, and the first
 * version of both screens answered every one of them with "your browser may have
 * refused the microphone". Chrome raises `no-speech` a few seconds after a successful
 * start when the reader has not said anything yet, so a reader who clicked Dictate
 * and paused to think was shown a refusal that had not happened.
 *
 * The event's `error` field says which it was. A refusal is a refusal; silence and an
 * abort are the engine stopping, which the button already shows, and get no sentence;
 * anything else is reported as a stop with its reason. A value with no `error` field
 * is the synchronous throw from `start()`, which is the one case the old sentence
 * described correctly.
 */
export function dictationFailure(err: unknown): string | null {
  const code =
    typeof err === 'object' && err !== null && 'error' in err
      ? String((err as { error: unknown }).error)
      : null;
  switch (code) {
    case null:
      return 'Could not start dictation — your browser may have refused the microphone.';
    case 'not-allowed':
    case 'service-not-allowed':
      return 'Could not start dictation — your browser refused the microphone.';
    case 'no-speech':
    case 'aborted':
      return null;
    case 'audio-capture':
      return 'Dictation stopped — no microphone could be used.';
    case 'network':
      return 'Dictation stopped — the speech service could not be reached.';
    default:
      return 'Dictation stopped.';
  }
}
