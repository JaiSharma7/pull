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
