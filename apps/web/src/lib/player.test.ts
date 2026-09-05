import { describe, expect, it } from 'vitest';
import {
  currentTrack,
  hydrate,
  INITIAL_PLAYER,
  MAX_RATE,
  MIN_RATE,
  playerReducer,
  playerStorageKey,
  serialize,
  type PlayerAction,
  type PlayerState,
  type Track,
} from './player.js';

/**
 * The player, driven without a browser.
 *
 * Every transition here is one the player bar will dispatch on a real device, and
 * the failures worth guarding are the ones a reader would hear: a card queued
 * twice playing twice, a queue that starts over after it ends, a sleep timer that
 * pauses tomorrow's first track because it was set last night.
 */

const track = (id: string, title = 'Meditations'): Track => ({
  id,
  title,
  text: `Text of ${id}.`,
});

const run = (actions: PlayerAction[], from: PlayerState = INITIAL_PLAYER): PlayerState =>
  actions.reduce(playerReducer, from);

const three = [track('a'), track('b'), track('c')];

describe('enqueue', () => {
  it('starts an idle player at the first thing added', () => {
    const s = run([{ type: 'enqueue', tracks: three }]);
    expect(s.status).toBe('playing');
    expect(s.index).toBe(0);
    expect(currentTrack(s)?.id).toBe('a');
  });

  it('appends without interrupting what is playing', () => {
    const s = run([
      { type: 'enqueue', tracks: [track('a')] },
      { type: 'enqueue', tracks: [track('b')] },
    ]);
    expect(s.queue.map((t) => t.id)).toEqual(['a', 'b']);
    expect(s.index).toBe(0);
  });

  it('leaves a paused player paused', () => {
    // The reader paused for a reason; a new card arriving is not that reason.
    const s = run([
      { type: 'enqueue', tracks: [track('a')] },
      { type: 'pause' },
      { type: 'enqueue', tracks: [track('b')] },
    ]);
    expect(s.status).toBe('paused');
    expect(s.queue).toHaveLength(2);
  });

  it('queues a card once however many times it is queued', () => {
    const s = run([
      { type: 'enqueue', tracks: [track('a'), track('a')] },
      { type: 'enqueue', tracks: [track('a'), track('b')] },
    ]);
    expect(s.queue.map((t) => t.id)).toEqual(['a', 'b']);
  });

  it('returns the same state when nothing new arrives', () => {
    const before = run([{ type: 'enqueue', tracks: [track('a')] }]);
    expect(playerReducer(before, { type: 'enqueue', tracks: [track('a')] })).toBe(before);
    expect(playerReducer(before, { type: 'enqueue', tracks: [] })).toBe(before);
  });

  it('starts at the new track, not the old position, when queued onto a stopped player', () => {
    const s = run([
      { type: 'enqueue', tracks: three },
      { type: 'next' },
      { type: 'stop' },
      { type: 'enqueue', tracks: [track('d')] },
    ]);
    expect(s.status).toBe('playing');
    expect(currentTrack(s)?.id).toBe('d');
  });
});

describe('playNow', () => {
  it('plays a new track next, keeping the rest of the queue', () => {
    const s = run([
      { type: 'enqueue', tracks: three },
      { type: 'playNow', track: track('x') },
    ]);
    expect(s.queue.map((t) => t.id)).toEqual(['a', 'x', 'b', 'c']);
    expect(currentTrack(s)?.id).toBe('x');
    expect(s.status).toBe('playing');
  });

  it('jumps to a track that is already queued rather than adding it again', () => {
    const s = run([
      { type: 'enqueue', tracks: three },
      { type: 'playNow', track: track('c') },
    ]);
    expect(s.queue).toHaveLength(3);
    expect(s.index).toBe(2);
  });

  it('works on an empty player', () => {
    const s = run([{ type: 'playNow', track: track('a') }]);
    expect(s.queue.map((t) => t.id)).toEqual(['a']);
    expect(s.status).toBe('playing');
  });
});

describe('walking the queue', () => {
  it('advances, and ends by emptying the queue', () => {
    const playing = run([{ type: 'enqueue', tracks: three }]);
    const second = playerReducer(playing, { type: 'next' });
    expect(second.index).toBe(1);
    const third = playerReducer(second, { type: 'next' });
    expect(third.index).toBe(2);
    /*
     * The end is an end. A finished queue that lingered would come back on the
     * next visit as "Paused · 3 of 3", which is a session that never ends.
     */
    const done = playerReducer(third, { type: 'next' });
    expect(done.status).toBe('idle');
    expect(done.queue).toEqual([]);
    expect(done.index).toBe(0);
  });

  it('ignores next and prev while idle', () => {
    expect(playerReducer(INITIAL_PLAYER, { type: 'next' })).toBe(INITIAL_PLAYER);
    expect(playerReducer(INITIAL_PLAYER, { type: 'prev' })).toBe(INITIAL_PLAYER);
  });

  it('goes back, and stays put at the start', () => {
    const s = run([{ type: 'enqueue', tracks: three }, { type: 'next' }, { type: 'prev' }]);
    expect(s.index).toBe(0);
    expect(playerReducer(s, { type: 'prev' })).toBe(s);
  });

  it('resumes playback when a paused reader skips', () => {
    const s = run([{ type: 'enqueue', tracks: three }, { type: 'pause' }, { type: 'next' }]);
    expect(s.status).toBe('playing');
    expect(s.index).toBe(1);
  });
});

describe('pause, resume, stop', () => {
  it('pauses only what is playing', () => {
    const s = run([{ type: 'enqueue', tracks: three }, { type: 'pause' }]);
    expect(s.status).toBe('paused');
    expect(playerReducer(s, { type: 'pause' })).toBe(s);
    expect(playerReducer(INITIAL_PLAYER, { type: 'pause' })).toBe(INITIAL_PLAYER);
  });

  it('resumes from paused, and from stopped with a queue left', () => {
    const paused = run([{ type: 'enqueue', tracks: three }, { type: 'pause' }]);
    expect(playerReducer(paused, { type: 'resume' }).status).toBe('playing');

    const stopped = run([{ type: 'enqueue', tracks: three }, { type: 'next' }, { type: 'stop' }]);
    const back = playerReducer(stopped, { type: 'resume' });
    expect(back.status).toBe('playing');
    expect(back.index).toBe(1);
  });

  it('has nothing to resume on an empty player', () => {
    expect(playerReducer(INITIAL_PLAYER, { type: 'resume' })).toBe(INITIAL_PLAYER);
  });

  it('stops without forgetting the queue or the place in it', () => {
    const s = run([{ type: 'enqueue', tracks: three }, { type: 'next' }, { type: 'stop' }]);
    expect(s.status).toBe('idle');
    expect(s.queue).toHaveLength(3);
    expect(s.index).toBe(1);
  });

  it('clears the sleep timer on stop — the session it was set for is over', () => {
    const s = run([
      { type: 'enqueue', tracks: three },
      { type: 'setSleep', until: 10_000 },
      { type: 'stop' },
    ]);
    expect(s.sleepUntil).toBeNull();
  });
});

describe('remove and clear', () => {
  it('removes a track ahead of the needle without moving it', () => {
    const s = run([
      { type: 'enqueue', tracks: three },
      { type: 'remove', id: 'c' },
    ]);
    expect(s.queue.map((t) => t.id)).toEqual(['a', 'b']);
    expect(s.index).toBe(0);
  });

  it('keeps the needle on the same track when one before it goes', () => {
    const s = run([
      { type: 'enqueue', tracks: three },
      { type: 'next' },
      { type: 'next' },
      { type: 'remove', id: 'a' },
    ]);
    expect(currentTrack(s)?.id).toBe('c');
    expect(s.index).toBe(1);
  });

  it('moves to the next track when the current one is removed', () => {
    const s = run([
      { type: 'enqueue', tracks: three },
      { type: 'remove', id: 'a' },
    ]);
    expect(currentTrack(s)?.id).toBe('b');
    expect(s.status).toBe('playing');
  });

  it('stops when the current track was the last and is removed', () => {
    const s = run([
      { type: 'enqueue', tracks: three },
      { type: 'next' },
      { type: 'next' },
      { type: 'remove', id: 'c' },
    ]);
    expect(s.status).toBe('idle');
    expect(s.index).toBe(1);
    expect(s.queue).toHaveLength(2);
  });

  it('goes idle when the only track is removed', () => {
    const s = run([
      { type: 'enqueue', tracks: [track('a')] },
      { type: 'remove', id: 'a' },
    ]);
    expect(s).toMatchObject({ queue: [], index: 0, status: 'idle' });
  });

  it('ignores an id it does not have', () => {
    const s = run([{ type: 'enqueue', tracks: three }]);
    expect(playerReducer(s, { type: 'remove', id: 'zz' })).toBe(s);
  });

  it('clears everything but the listening settings', () => {
    const s = run([
      { type: 'enqueue', tracks: three },
      { type: 'setRate', rate: 1.5 },
      { type: 'setVoice', voiceURI: 'urn:voice' },
      { type: 'clear' },
    ]);
    expect(s).toMatchObject({ queue: [], index: 0, status: 'idle', rate: 1.5 });
    expect(s.voiceURI).toBe('urn:voice');
    expect(playerReducer(INITIAL_PLAYER, { type: 'clear' })).toBe(INITIAL_PLAYER);
  });
});

describe('the sleep timer', () => {
  it('pauses at the boundary once the time has passed, and forgets itself', () => {
    const s = run([
      { type: 'enqueue', tracks: three },
      { type: 'setSleep', until: 1_000 },
      { type: 'next', now: 1_000 },
    ]);
    expect(s.status).toBe('paused');
    expect(s.index).toBe(0);
    expect(s.sleepUntil).toBeNull();
  });

  it('lets the queue advance while there is time left', () => {
    const s = run([
      { type: 'enqueue', tracks: three },
      { type: 'setSleep', until: 5_000 },
      { type: 'next', now: 4_999 },
    ]);
    expect(s.status).toBe('playing');
    expect(s.index).toBe(1);
    expect(s.sleepUntil).toBe(5_000);
  });

  it('does not fire on a Next press that carries no clock', () => {
    // A reader pressing Next is awake.
    const s = run([
      { type: 'enqueue', tracks: three },
      { type: 'setSleep', until: 1 },
      { type: 'next' },
    ]);
    expect(s.status).toBe('playing');
    expect(s.index).toBe(1);
  });

  it('can be cancelled, and refuses a timestamp that is not one', () => {
    const set = run([{ type: 'setSleep', until: 99 }]);
    expect(set.sleepUntil).toBe(99);
    expect(playerReducer(set, { type: 'setSleep', until: null }).sleepUntil).toBeNull();
    expect(playerReducer(set, { type: 'setSleep', until: Number.NaN })).toBe(set);
  });
});

describe('listening settings', () => {
  it('clamps the rate to the range voices can still be understood at', () => {
    expect(playerReducer(INITIAL_PLAYER, { type: 'setRate', rate: 9 }).rate).toBe(MAX_RATE);
    expect(playerReducer(INITIAL_PLAYER, { type: 'setRate', rate: 0 }).rate).toBe(MIN_RATE);
    expect(playerReducer(INITIAL_PLAYER, { type: 'setRate', rate: 1.25 }).rate).toBe(1.25);
  });

  it('ignores a rate that is not a number', () => {
    expect(playerReducer(INITIAL_PLAYER, { type: 'setRate', rate: Number.NaN })).toBe(
      INITIAL_PLAYER,
    );
    expect(playerReducer(INITIAL_PLAYER, { type: 'setRate', rate: 1 })).toBe(INITIAL_PLAYER);
  });

  it('treats an empty voice as the default voice', () => {
    const chosen = playerReducer(INITIAL_PLAYER, { type: 'setVoice', voiceURI: 'urn:v' });
    expect(chosen.voiceURI).toBe('urn:v');
    expect(playerReducer(chosen, { type: 'setVoice', voiceURI: '' }).voiceURI).toBeNull();
    expect(playerReducer(INITIAL_PLAYER, { type: 'setVoice', voiceURI: null })).toBe(
      INITIAL_PLAYER,
    );
  });
});

describe('serialize and hydrate', () => {
  const full = run([
    { type: 'enqueue', tracks: three },
    { type: 'next' },
    { type: 'setRate', rate: 1.5 },
    { type: 'setVoice', voiceURI: 'urn:v' },
    { type: 'setSleep', until: 9_000 },
  ]);

  it('round-trips the queue, the place in it and the settings — paused, never playing', () => {
    // A browser will not speak without a gesture, so a queue comes back with
    // its place kept and a Resume control, not mid-sentence.
    const back = hydrate(serialize(full, 'u1'), 'u1', 0);
    expect(back).toEqual({ ...full, status: 'paused' });
  });

  it('comes back idle when there was nothing queued', () => {
    expect(hydrate(serialize(INITIAL_PLAYER, null), null)).toEqual(INITIAL_PLAYER);
  });

  it('refuses another reader’s queue, and a guest’s queue for an account', () => {
    const raw = serialize(full, 'u1');
    expect(hydrate(raw, 'u2')).toEqual(INITIAL_PLAYER);
    expect(hydrate(raw, null)).toEqual(INITIAL_PLAYER);
    expect(hydrate(serialize(full, null), 'u1')).toEqual(INITIAL_PLAYER);
  });

  it('keys storage by reader', () => {
    expect(playerStorageKey('u1')).not.toBe(playerStorageKey('u2'));
    expect(playerStorageKey(null)).not.toBe(playerStorageKey('u1'));
    expect(playerStorageKey(null)).toMatch(/^wap:player/);
  });

  it('drops a sleep timer that has already passed', () => {
    const back = hydrate(serialize(full, 'u1'), 'u1', 9_000);
    expect(back.sleepUntil).toBeNull();
  });

  it('survives garbage of every kind', () => {
    for (const junk of [null, undefined, 7, '', 'not json', '[]', '{}', '{"v":2}', '"str"']) {
      expect(hydrate(junk, 'u1')).toEqual(INITIAL_PLAYER);
    }
  });

  it('keeps the good entries of a partly broken queue', () => {
    const raw = JSON.stringify({
      v: 1,
      owner: 'u1',
      queue: [
        track('a'),
        { id: 7 },
        'b',
        null,
        { id: '', title: '', text: '' },
        track('a'),
        track('c'),
      ],
      index: 12,
      rate: 'fast',
      voiceURI: '',
      sleepUntil: 'never',
    });
    const back = hydrate(raw, 'u1', 0);
    expect(back.queue.map((t) => t.id)).toEqual(['a', 'c']);
    // An index past the end lands on the last track rather than off the queue.
    expect(back.index).toBe(1);
    expect(back.rate).toBe(1);
    expect(back.voiceURI).toBeNull();
    expect(back.sleepUntil).toBeNull();
    expect(back.status).toBe('paused');
  });

  it('clamps a stored rate the way the reducer would', () => {
    const raw = JSON.stringify({ v: 1, owner: null, queue: [], index: 0, rate: 40 });
    expect(hydrate(raw, null).rate).toBe(MAX_RATE);
  });
});
