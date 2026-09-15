/**
 * The player bar — the only thing on screen that outlives the card it was
 * started from.
 *
 * A hairline rule and a line of mono, fixed to the bottom of the window. It is
 * not a media player: no scrubber, no artwork, no waveform, because there is
 * nothing to scrub — `speechSynthesis` has no timeline, and drawing one would be
 * a control that lies. What a listener actually needs is where they are in the
 * queue, a way to stop, and a way to stop LATER.
 *
 * Law 7 and an auto-advancing queue are not in tension, and it is worth saying
 * why, because the same behaviour in the feed is forbidden. The queue is built by
 * the reader, one press at a time; it is finite; it never refills itself; and
 * when it ends, it ends and the bar goes away. That is a playlist, not a feed.
 * Reading is still never advanced for anyone.
 *
 * The bar renders nothing at all when there is nothing queued, so the reserved
 * space below the Colophon is spent only while it is being used — and Done is what
 * makes "nothing queued" reachable on purpose rather than only by playing to the end.
 */

import { SLEEP_TIMERS, AUDIO_COPY, type SleepTimer } from '../lib/audio-prefs.js';
import { currentTrack, type PlayerState } from '../lib/player.js';
import { usePlayer } from './PlayerProvider.js';

/**
 * What the bar says it is doing, as one line.
 *
 * Pure and exported so it can be asserted without a browser — the position and
 * the title are the two things a listener reaches for when they have looked away
 * from the screen for ten minutes, and getting "3 of 3" right at the end of a
 * queue is exactly the sort of off-by-one a render test catches and a person
 * does not.
 */
export function listeningLabel(state: PlayerState): string {
  const track = currentTrack(state);
  if (track === null) return '';
  /*
   * THREE STATES, not two. `stop` sets `idle` and deliberately KEEPS the queue, so
   * `currentTrack` is still non-null and this line is still drawn — and calling that
   * "Paused" was a promise the next press could not keep: `resume` from `idle` bumps
   * the epoch, which starts the track again from the top rather than resuming it. The
   * label now says which of the two it is, so Play does what the line implies.
   */
  const verb =
    state.status === 'playing' ? 'Listening' : state.status === 'paused' ? 'Paused' : 'Stopped';
  return `${verb} · ${state.index + 1} of ${state.queue.length} · ${track.title}`;
}

export function PlayerBar() {
  const { state, supported, prefs, pause, resume, next, stop, clear, setSleep } = usePlayer();
  const track = currentTrack(state);

  // Nothing queued is nothing to draw. A bar that sat there empty would be a
  // permanent strip of chrome across the bottom of a reading app.
  if (!supported || track === null) return null;

  const playing = state.status === 'playing';

  return (
    <section className="player" aria-label="Listening">
      <div className="player__inner">
        {/*
          Polite, and on the line rather than on the section: a screen reader
          should hear the track change while the reader is somewhere else on the
          page, and should not hear the whole bar re-announced when a button's
          label flips.
        */}
        <p className="player__now" aria-live="polite">
          {listeningLabel(state)}
        </p>

        <div className="player__controls">
          <button
            type="button"
            className="btn"
            onClick={playing ? pause : resume}
            aria-label={playing ? `Pause: ${track.title}` : `Resume: ${track.title}`}
          >
            {playing ? 'Pause' : 'Play'}
          </button>

          {/*
            Withheld on the last track rather than disabled, because there is
            nothing it could do there: `next` at the end of the queue ends the
            session, which is what Stop is for and would be a surprising thing for
            a button called Next to do.
          */}
          {state.index + 1 < state.queue.length && (
            <button type="button" className="btn" onClick={next} aria-label="Next in the queue">
              Next
            </button>
          )}

          <button type="button" className="btn" onClick={stop} aria-label="Stop listening">
            Stop
          </button>

          {/*
            Stop keeps the queue; Done gives it back.

            `stop` is deliberately not a `clear` — a reader who stops halfway through
            five sources should find them where they left them. But without a way to
            empty the queue, `currentTrack` stays non-null, the bar stays drawn as
            "Paused · 3 of 3", and `:root[data-listening]` keeps reserving a strip
            under the Colophon — so the only ways out were playing the queue to its
            end or signing out. The header of this file promises the bar goes away
            when the session ends; this is what makes that true after Stop as well as
            after the last track.
          */}
          <button
            type="button"
            className="btn btn--plain"
            onClick={clear}
            aria-label="Clear the listening queue"
          >
            Done
          </button>

          <label className="player__sleep">
            <span className="meta">Sleep</span>{' '}
            <select
              className="field__input player__select"
              value={prefs.sleep}
              onChange={(e) => setSleep(e.target.value as SleepTimer)}
            >
              {SLEEP_TIMERS.map((timer) => (
                <option key={timer} value={timer}>
                  {AUDIO_COPY.sleep[timer].label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>
    </section>
  );
}
