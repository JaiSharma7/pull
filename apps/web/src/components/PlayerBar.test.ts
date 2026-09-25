import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { INITIAL_PLAYER, type PlayerState, type Track } from '../lib/player.js';
import type { PlayerApi } from './PlayerProvider.js';

/*
 * The bar reads the player through `usePlayer`, which needs a provider, which
 * needs effects and a DOM. Neither is what this file is about: what it asserts is
 * what a listener SEES for a given state, so the player is supplied directly.
 */
const api = vi.hoisted(() => ({ current: null as PlayerApi | null }));
vi.mock('./PlayerProvider.js', () => ({
  usePlayer: () => {
    if (api.current === null) throw new Error('no player set for this test');
    return api.current;
  },
}));

const { PlayerBar, listeningLabel } = await import('./PlayerBar.js');

const track = (id: string, title: string): Track => ({ id, title, text: `${title} spoken` });

function playing(overrides: Partial<PlayerState> = {}): PlayerState {
  return {
    ...INITIAL_PLAYER,
    queue: [track('a', 'Meditations'), track('b', 'The Enchiridion'), track('c', 'Walden')],
    index: 1,
    status: 'playing',
    ...overrides,
  };
}

function render(state: PlayerState, extra: Partial<PlayerApi> = {}): string {
  api.current = {
    state,
    supported: true,
    prefs: { rate: 1, voiceURI: null, sleep: 'off' },
    enqueue: vi.fn(),
    playNow: vi.fn(),
    next: vi.fn(),
    prev: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    stop: vi.fn(),
    remove: vi.fn(),
    dismiss: vi.fn(),
    clear: vi.fn(),
    setRate: vi.fn(),
    setVoice: vi.fn(),
    setSleep: vi.fn(),
    ...extra,
  };
  return renderToStaticMarkup(createElement(PlayerBar));
}

describe('listeningLabel', () => {
  it('names the position and the source', () => {
    expect(listeningLabel(playing())).toBe('Listening · 2 of 3 · The Enchiridion');
  });

  it('counts from one, so the last track is "3 of 3" rather than "2 of 3"', () => {
    expect(listeningLabel(playing({ index: 2 }))).toBe('Listening · 3 of 3 · Walden');
  });

  it('says paused when it is paused', () => {
    expect(listeningLabel(playing({ status: 'paused' }))).toBe('Paused · 2 of 3 · The Enchiridion');
  });

  // `stop` keeps the queue, so the bar stays drawn — and Play from there starts the
  // track again rather than resuming it. Calling that "Paused" made the label promise
  // something the next press would not do.
  it('says stopped when the queue is kept but nothing is playing', () => {
    expect(listeningLabel(playing({ status: 'idle' }))).toBe('Stopped · 2 of 3 · The Enchiridion');
  });

  it('is empty when there is nothing to play', () => {
    expect(listeningLabel(INITIAL_PLAYER)).toBe('');
  });
});

describe('PlayerBar', () => {
  it('draws nothing at all when the queue is empty', () => {
    expect(render(INITIAL_PLAYER)).toBe('');
  });

  it('draws nothing where the browser cannot speak', () => {
    expect(render(playing(), { supported: false })).toBe('');
  });

  it('names itself as a region, and announces the track politely', () => {
    const html = render(playing());
    expect(html).toContain('aria-label="Listening"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('Listening · 2 of 3 · The Enchiridion');
  });

  it('offers Pause while playing and Play while paused', () => {
    expect(render(playing())).toContain('>Pause<');
    expect(render(playing({ status: 'paused' }))).toContain('>Play<');
  });

  it('withholds Next on the last track, where it would end the session', () => {
    expect(render(playing())).toContain('>Next<');
    expect(render(playing({ index: 2 }))).not.toContain('>Next<');
  });

  it('always offers a way to stop', () => {
    expect(render(playing())).toContain('aria-label="Stop listening"');
    expect(render(playing({ index: 2 }))).toContain('aria-label="Stop listening"');
  });

  it('always offers a way to put the bar away, which Stop does not do', () => {
    /*
     * `stop` keeps the queue and the position in it, by design — so after it, a
     * reader on the last track had a bar drawn as "Paused · 3 of 3", a reserved
     * strip under the Colophon, no Next, and no way out but playing to the end or
     * signing out.
     */
    for (const state of [playing(), playing({ status: 'paused' }), playing({ index: 2 })]) {
      expect(render(state)).toContain('aria-label="Clear the listening queue"');
    }
  });

  it('shows the remembered sleep timer as the chosen one', () => {
    const html = render(playing(), {
      prefs: { rate: 1, voiceURI: null, sleep: '30' },
    });
    expect(html).toContain('<option value="30" selected="">30 minutes</option>');
  });
});
