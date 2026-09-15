import { describe, expect, it } from 'vitest';
import { DICTATION_DISCLOSURE, dictationFailure } from './dictation.js';

describe('dictationFailure', () => {
  it('reports a synchronous start() failure as a possible refusal', () => {
    expect(dictationFailure(new Error('InvalidStateError'))).toMatch(/refused the microphone/);
  });

  it('reports a refused microphone as a refusal', () => {
    expect(dictationFailure({ error: 'not-allowed' })).toMatch(/refused the microphone/);
    expect(dictationFailure({ error: 'service-not-allowed' })).toMatch(/refused the microphone/);
  });

  it('says nothing for silence or an abort -- the engine stopping is not a failure', () => {
    // Chrome raises no-speech a few seconds after a successful start when the reader
    // has not said anything yet. A reader pausing to think was told the browser had
    // refused the microphone.
    expect(dictationFailure({ error: 'no-speech' })).toBeNull();
    expect(dictationFailure({ error: 'aborted' })).toBeNull();
  });

  it('names the reason for the rest without claiming a refusal', () => {
    expect(dictationFailure({ error: 'network' })).toMatch(/^Dictation stopped/);
    expect(dictationFailure({ error: 'network' })).not.toMatch(/refused/);
    expect(dictationFailure({ error: 'audio-capture' })).toMatch(/microphone/);
    expect(dictationFailure({ error: 'something-new' })).toBe('Dictation stopped.');
  });
});

describe('DICTATION_DISCLOSURE', () => {
  it('says where the audio goes and that typing sends nothing', () => {
    expect(DICTATION_DISCLOSURE).toMatch(/browser's vendor/);
    expect(DICTATION_DISCLOSURE).toMatch(/Typing sends nothing/);
  });
});
