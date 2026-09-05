import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  listVoices,
  onVoicesChanged,
  pauseSpeaking,
  recognitionSupported,
  resumeSpeaking,
  speak,
  speechSupported,
  startRecognition,
  stopSpeaking,
} from './speech.js';

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

/* The fake `window` is torn down here as well as inline: a failing assertion returns
   before the inline `clearRecognition()`, and the leak makes the *next* test in the file
   fail for a reason that has nothing to do with it. */
afterEach(clearRecognition);

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

describe('startRecognition hardening', () => {
  /*
   * The fallback that failed toward the bug. `resultIndex` is what makes the read
   * incremental; an engine that omits it sent the loop back to zero, so every finalised
   * segment was re-emitted on every event — the original duplication, reintroduced by
   * the fix's own defensive default.
   */
  it('does not re-emit finalised segments when resultIndex never advances', () => {
    const instance = fakeRecognition();
    const kept: string[] = [];
    const teardown = startRecognition({ onResult: (t) => kept.push(t) });

    emit(instance, 0, [{ isFinal: true, 0: { transcript: 'one' } }]);
    emit(instance, 0, [
      { isFinal: true, 0: { transcript: 'one' } },
      { isFinal: true, 0: { transcript: ' two' } },
    ]);

    expect(kept).toEqual(['one', ' two']);
    teardown();
    clearRecognition();
  });

  it('delivers nothing after teardown', () => {
    const instance = fakeRecognition();
    const kept: string[] = [];
    const teardown = startRecognition({ onResult: (t) => kept.push(t) });

    emit(instance, 0, [{ isFinal: true, 0: { transcript: 'kept' } }]);
    teardown();
    // `stop()` still delivers a trailing final result per spec; a teardown that only
    // stopped left the handler attached, so this landed in an unmounted component.
    emit(instance, 1, [
      { isFinal: true, 0: { transcript: 'kept' } },
      { isFinal: true, 0: { transcript: ' after teardown' } },
    ]);

    expect(kept).toEqual(['kept']);
    clearRecognition();
  });

  it('handles one event carrying a finalised and an interim segment', () => {
    const instance = fakeRecognition();
    const kept: string[] = [];
    const interim: string[] = [];
    const teardown = startRecognition({
      onResult: (t) => kept.push(t),
      onInterim: (t) => interim.push(t),
    });

    emit(instance, 0, [
      { isFinal: true, 0: { transcript: 'done' } },
      { isFinal: false, 0: { transcript: ' still going' } },
    ]);

    expect(kept).toEqual(['done']);
    expect(interim).toEqual([' still going']);
    teardown();
    clearRecognition();
  });
});

/*
 * Synthesis, driven with a fake engine.
 *
 * The behaviours worth asserting are the ones a listener would notice: a pause that
 * reports "ended" and lets a player advance while they answer the door; a resume
 * that starts the paragraph over when the engine had said exactly where it was; a
 * chosen voice silently swapped for a similar one. The fake fires `onend` on cancel
 * the way desktop Chrome does, synchronously, which is the ordering `speak`'s
 * cancel-then-onend contract is written for.
 */
interface FakeVoice {
  voiceURI: string;
  name: string;
  lang: string;
  localService: boolean;
  default: boolean;
}

class FakeUtterance {
  text: string;
  rate = 1;
  voice: FakeVoice | null = null;
  onboundary: ((e: { charIndex: number }) => void) | null = null;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ended = false;
  constructor(text: string) {
    this.text = text;
  }
}

function fakeSynthesis(voices: FakeVoice[] = []) {
  const spoken: FakeUtterance[] = [];
  const log: string[] = [];
  const listeners: Array<() => void> = [];
  const synth = {
    speak(u: FakeUtterance) {
      spoken.push(u);
      log.push(`speak:${u.text}`);
    },
    cancel() {
      log.push('cancel');
      const current = spoken.at(-1);
      if (current && !current.ended) {
        current.ended = true;
        current.onend?.();
      }
    },
    getVoices: () => voices,
    addEventListener(_type: string, l: () => void) {
      listeners.push(l);
    },
    removeEventListener(_type: string, l: () => void) {
      const i = listeners.indexOf(l);
      if (i >= 0) listeners.splice(i, 1);
    },
  };
  vi.stubGlobal('window', { speechSynthesis: synth });
  vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance);
  /** The engine finishing the current utterance on its own. */
  const finishCurrent = () => {
    const current = spoken.at(-1);
    if (current && !current.ended) {
      current.ended = true;
      current.onend?.();
    }
  };
  const boundary = (charIndex: number) => spoken.at(-1)?.onboundary?.({ charIndex });
  return { spoken, log, listeners, finishCurrent, boundary };
}

const voice = (over: Partial<FakeVoice> & { voiceURI: string }): FakeVoice => ({
  name: over.voiceURI,
  lang: 'en-GB',
  localService: true,
  default: false,
  ...over,
});

describe('speak', () => {
  afterEach(() => {
    // Leave nothing paused or live for the next test to inherit.
    stopSpeaking();
    vi.unstubAllGlobals();
  });

  it('sets the rate and picks the voice by URI', () => {
    const { spoken } = fakeSynthesis([voice({ voiceURI: 'urn:a' }), voice({ voiceURI: 'urn:b' })]);
    speak('The obstacle is the way.', { rate: 1.5, voiceURI: 'urn:b' });
    expect(spoken).toHaveLength(1);
    expect(spoken[0]!.rate).toBe(1.5);
    expect(spoken[0]!.voice?.voiceURI).toBe('urn:b');
  });

  it('leaves the voice to the browser when the URI is unknown', () => {
    // A voice chosen on another device, or removed by an update, must not become
    // a different voice the reader never picked.
    const { spoken } = fakeSynthesis([voice({ voiceURI: 'urn:a' })]);
    speak('x', { voiceURI: 'urn:gone' });
    expect(spoken[0]!.voice).toBeNull();
    speak('y');
    expect(spoken[1]!.voice).toBeNull();
  });

  it('cancels the previous utterance, whose onEnd fires during the call', () => {
    const { log } = fakeSynthesis();
    const order: string[] = [];
    speak('first', { onEnd: () => order.push('first ended') });
    speak('second', { onEnd: () => order.push('second ended') });
    expect(order).toEqual(['first ended']);
    expect(log).toEqual(['cancel', 'speak:first', 'cancel', 'speak:second']);
  });

  it('reports a natural finish, and an error, exactly once each', () => {
    const { spoken, finishCurrent } = fakeSynthesis();
    let ended = 0;
    speak('a', { onEnd: () => ended++ });
    finishCurrent();
    spoken[0]!.onerror?.();
    expect(ended).toBe(1);

    speak('b', { onEnd: () => ended++ });
    spoken[1]!.ended = true;
    spoken[1]!.onerror?.();
    expect(ended).toBe(2);
  });

  it('does nothing when unsupported', () => {
    expect(() => speak('x', { onEnd: () => {} })).not.toThrow();
    expect(() => pauseSpeaking()).not.toThrow();
    expect(() => resumeSpeaking()).not.toThrow();
    expect(() => stopSpeaking()).not.toThrow();
  });
});

describe('pause and resume', () => {
  afterEach(() => {
    stopSpeaking();
    vi.unstubAllGlobals();
  });

  it('pauses by cancelling, without telling the caller anything ended', () => {
    const { log } = fakeSynthesis();
    let ended = 0;
    speak('The obstacle is the way.', { onEnd: () => ended++ });
    pauseSpeaking();
    expect(log).toEqual(['cancel', 'speak:The obstacle is the way.', 'cancel']);
    expect(ended).toBe(0);
  });

  it('resumes from the last word boundary, with the same rate, voice and onEnd', () => {
    const { spoken, boundary, finishCurrent } = fakeSynthesis([voice({ voiceURI: 'urn:a' })]);
    let ended = 0;
    speak('The obstacle is the way.', { rate: 1.25, voiceURI: 'urn:a', onEnd: () => ended++ });
    boundary(0);
    boundary(4);
    boundary(13);
    pauseSpeaking();
    resumeSpeaking();
    expect(spoken).toHaveLength(2);
    expect(spoken[1]!.text).toBe('is the way.');
    expect(spoken[1]!.rate).toBe(1.25);
    expect(spoken[1]!.voice?.voiceURI).toBe('urn:a');
    finishCurrent();
    expect(ended).toBe(1);
  });

  it('keeps offsets absolute across a second pause', () => {
    // The resumed utterance is a slice, so its boundaries are relative to the
    // slice. Without adding the base back, the second resume would rewind.
    const { spoken, boundary } = fakeSynthesis();
    speak('aaaa bbbb cccc dddd');
    boundary(5);
    pauseSpeaking();
    resumeSpeaking();
    expect(spoken[1]!.text).toBe('bbbb cccc dddd');
    boundary(5);
    pauseSpeaking();
    resumeSpeaking();
    expect(spoken[2]!.text).toBe('cccc dddd');
  });

  it('starts the utterance over when the engine gave no boundaries', () => {
    // The honest cost of cancel-plus-offset, stated in the header: a paragraph.
    const { spoken } = fakeSynthesis();
    speak('no boundaries here');
    pauseSpeaking();
    resumeSpeaking();
    expect(spoken[1]!.text).toBe('no boundaries here');
  });

  it('ignores a pause with nothing live, and a resume with nothing paused', () => {
    const { log, finishCurrent } = fakeSynthesis();
    pauseSpeaking();
    resumeSpeaking();
    expect(log).toEqual([]);

    speak('done');
    finishCurrent();
    pauseSpeaking();
    resumeSpeaking();
    expect(log).toEqual(['cancel', 'speak:done']);
  });

  it('pauses once, however many times it is asked', () => {
    const { log } = fakeSynthesis();
    speak('x');
    pauseSpeaking();
    pauseSpeaking();
    expect(log.filter((l) => l === 'cancel')).toHaveLength(2);
  });

  it('tells the caller when a paused utterance is stopped', () => {
    const { log } = fakeSynthesis();
    let ended = 0;
    speak('x', { onEnd: () => ended++ });
    pauseSpeaking();
    stopSpeaking();
    expect(ended).toBe(1);
    // And nothing is left to resume.
    resumeSpeaking();
    expect(log.filter((l) => l.startsWith('speak:'))).toHaveLength(1);
  });

  it('tells the caller when a paused utterance is replaced by a new speak', () => {
    fakeSynthesis();
    const order: string[] = [];
    speak('first', { onEnd: () => order.push('first ended') });
    pauseSpeaking();
    speak('second', { onEnd: () => order.push('second ended') });
    expect(order).toEqual(['first ended']);
    resumeSpeaking();
    expect(order).toEqual(['first ended']);
  });
});

describe('listVoices', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is empty when unsupported', () => {
    expect(listVoices()).toEqual([]);
  });

  it('puts local voices first, then the default, then language and name', () => {
    fakeSynthesis([
      voice({ voiceURI: 'remote-en', localService: false, lang: 'en-GB', name: 'Aria' }),
      voice({ voiceURI: 'local-fr', lang: 'fr-FR', name: 'Amelie' }),
      voice({ voiceURI: 'local-en-z', lang: 'en-GB', name: 'Zoe' }),
      voice({ voiceURI: 'local-en-default', lang: 'en-GB', name: 'Daniel', default: true }),
      voice({ voiceURI: 'local-en-a', lang: 'en-GB', name: 'Alice' }),
    ]);
    expect(listVoices().map((v) => v.voiceURI)).toEqual([
      'local-en-default',
      'local-en-a',
      'local-en-z',
      'local-fr',
      'remote-en',
    ]);
  });

  it('keeps the browser’s order for ties, so the list is stable between calls', () => {
    const twins = [
      voice({ voiceURI: 'one', name: 'Same', lang: 'en-GB' }),
      voice({ voiceURI: 'two', name: 'Same', lang: 'en-GB' }),
    ];
    fakeSynthesis(twins);
    const first = listVoices().map((v) => v.voiceURI);
    expect(first).toEqual(['one', 'two']);
    expect(listVoices().map((v) => v.voiceURI)).toEqual(first);
    // And the browser's array is not sorted in place.
    expect(twins.map((v) => v.voiceURI)).toEqual(['one', 'two']);
  });
});

describe('onVoicesChanged', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('subscribes, and the teardown unsubscribes', () => {
    const { listeners } = fakeSynthesis();
    const listener = () => {};
    const off = onVoicesChanged(listener);
    expect(listeners).toEqual([listener]);
    off();
    expect(listeners).toEqual([]);
  });

  it('is a no-op when unsupported', () => {
    expect(() => onVoicesChanged(() => {})()).not.toThrow();
  });
});
