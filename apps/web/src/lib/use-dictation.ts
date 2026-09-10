import { useCallback, useEffect, useRef, useState } from 'react';
import { recognitionSupported, startRecognition } from './speech.js';
import { dictationFailure } from './dictation.js';

/**
 * Dictation for one text field: the microphone, the interim preview, and the reason
 * it stopped -- with the teardown held where Stop, submitting and unmounting can all
 * reach it.
 *
 * Extracted from `Interrupt.tsx` after `Path.tsx` copied it by hand and got it wrong
 * (review findings on #101 and #109): the copy returned the engine's teardown from a
 * click handler, which React discards, so Stop, advancing the step and leaving the
 * route all left a continuous recognition session live; and it set `listening` to
 * true after `onError`, which `startRecognition` calls SYNCHRONOUSLY when `start()`
 * throws. One hook, one set of rules:
 *
 *   * the teardown lives in a ref; `stop()` calls it, and so does unmount
 *   * a `failed` flag set by `onError` guards the flip to listening, for the
 *     synchronous case
 *   * an engine error is classified by `dictationFailure` -- silence is not a refusal
 *   * `onText` is read through a ref, so the caller may pass a fresh closure on every
 *     render without restarting the engine
 *
 * `interim` is a preview the engine may still revise; show it, never append it.
 */
export interface Dictation {
  supported: boolean;
  listening: boolean;
  interim: string;
  error: string | null;
  toggle: () => void;
  stop: () => void;
}

export function useDictation(onText: (text: string) => void): Dictation {
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState('');
  const [error, setError] = useState<string | null>(null);
  const stopRef = useRef<(() => void) | null>(null);
  /*
   * Which engine's events are current (review finding). An engine that has errored
   * still delivers a trailing `end`, and a reader who clicks Dictate in that gap
   * starts a second engine -- whose teardown the late `end` would then have cleared
   * from the ref, leaving the microphone live with no Stop, submit or unmount able to
   * reach it. Every start takes a new generation; an event from any other is ignored.
   */
  const generation = useRef(0);
  const onTextRef = useRef(onText);

  useEffect(() => {
    onTextRef.current = onText;
  });

  useEffect(() => {
    return () => {
      stopRef.current?.();
    };
  }, []);

  const stop = useCallback(() => {
    generation.current += 1;
    // A failure said under one field must not survive into the next: the path screen
    // keeps one hook across its steps, and a stale role="alert" under a later step
    // would announce a failure the reader never had there (review finding).
    setError(null);
    if (stopRef.current === null) return;
    stopRef.current();
    stopRef.current = null;
    setListening(false);
    setInterim('');
  }, []);

  const toggle = useCallback(() => {
    if (stopRef.current !== null) {
      stop();
      return;
    }
    let failed = false;
    setError(null);
    const mine = ++generation.current;
    let teardown: (() => void) | null = null;
    const ended = () => {
      if (generation.current !== mine) return;
      stopRef.current = null;
      setListening(false);
      setInterim('');
    };
    teardown = startRecognition({
      onResult: (text) => {
        if (generation.current === mine) onTextRef.current(text);
      },
      onInterim: (text) => {
        if (generation.current === mine) setInterim(text);
      },
      onEnd: ended,
      onError: (err) => {
        failed = true;
        ended();
        // Detach the failed engine's handlers now rather than at its trailing `end`,
        // so nothing it says afterwards reaches this hook. Null on the synchronous
        // path, where `start()` threw before a teardown existed.
        teardown?.();
        const message = dictationFailure(err);
        if (message && generation.current === mine) setError(message);
      },
    });
    if (failed) return;
    stopRef.current = teardown;
    setListening(true);
  }, [stop]);

  return { supported: recognitionSupported(), listening, interim, error, toggle, stop };
}
