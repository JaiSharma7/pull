import { describe, expect, it } from 'vitest';
import { recognitionSupported, speechSupported, startRecognition } from './speech.js';

describe('speech utilities', () => {
  it('detects synthesis support gracefully in node/test environment', () => {
    // In node environment window.speechSynthesis is undefined
    expect(speechSupported()).toBe(false);
  });

  it('detects recognition support gracefully in node/test environment', () => {
    expect(recognitionSupported()).toBe(false);
  });

  it('handles startRecognition gracefully when unsupported', () => {
    let called = false;
    const teardown = startRecognition({
      onResult: () => {
        called = true;
      },
    });
    expect(typeof teardown).toBe('function');
    teardown();
    expect(called).toBe(false);
  });
});

/*
 * The duplication bug had no test, and could not have had one: the previous suite only
 * exercised the unsupported path, where `startRecognition` returns a no-op before it ever
 * installs a handler. These drive the handler with the event shape the Web Speech API
 * actually produces — `results` cumulative for the session, `resultIndex` pointing at the
 * first entry that changed.
 */
interface FakeResult {
  isFinal: boolean;
  0: { transcript: string };
}

function fakeRecognition() {
  const instance = {
    continuous: false,
    interimResults: false,
    lang: '',
    onresult: null as ((e: unknown) => void) | null,
    onend: null as (() => void) | null,
    onerror: null as ((e: unknown) => void) | null,
    start: () => {},
    stop: () => {},
    abort: () => {},
  };
  // Both `recognitionSupported` and `startRecognition` look the constructor up on
  // `window`, so a global alone is not enough — the node environment has no `window` at
  // all, which is exactly why the three tests above pass without ever reaching a handler.
  (globalThis as unknown as Record<string, unknown>)['window'] = {
    SpeechRecognition: function () {
      return instance;
    },
  };
  return instance;
}

function clearRecognition() {
  delete (globalThis as unknown as Record<string, unknown>)['window'];
}

function emit(
  instance: { onresult: ((e: unknown) => void) | null },
  resultIndex: number,
  results: FakeResult[],
) {
  // Built by index rather than spread: the real `results` is an array-like with a
  // `length`, and spreading an array over it sets that key twice.
  const bag: Record<string, unknown> = { length: results.length };
  results.forEach((r, i) => {
    bag[String(i)] = r;
  });
  instance.onresult?.({ resultIndex, results: bag });
}

describe('startRecognition transcript handling', () => {
  it('emits each finalised segment once, not the whole transcript every time', () => {
    const instance = fakeRecognition();
    const kept: string[] = [];
    const teardown = startRecognition({ onResult: (t) => kept.push(t) });

    // "the obstacle" is finalised, then "is the way" — the second event still carries
    // both, which is what made the old loop re-emit the first.
    emit(instance, 0, [{ isFinal: true, 0: { transcript: 'the obstacle' } }]);
    emit(instance, 1, [
      { isFinal: true, 0: { transcript: 'the obstacle' } },
      { isFinal: true, 0: { transcript: ' is the way' } },
    ]);

    expect(kept).toEqual(['the obstacle', ' is the way']);
    expect(kept.join('')).toBe('the obstacle is the way');
    teardown();
    clearRecognition();
  });

  it('reports interim words separately, so a caller never appends them', () => {
    const instance = fakeRecognition();
    const kept: string[] = [];
    const interim: string[] = [];
    const teardown = startRecognition({
      onResult: (t) => kept.push(t),
      onInterim: (t) => interim.push(t),
    });

    emit(instance, 0, [{ isFinal: false, 0: { transcript: 'the obs' } }]);
    emit(instance, 0, [{ isFinal: false, 0: { transcript: 'the obstacle' } }]);

    expect(kept).toEqual([]);
    expect(interim).toEqual(['the obs', 'the obstacle']);
    teardown();
    clearRecognition();
  });
});
