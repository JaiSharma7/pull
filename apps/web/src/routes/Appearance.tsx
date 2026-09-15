import { useEffect, useState } from 'react';
import {
  APPEARANCE_COPY,
  CONTRAST,
  DEFAULT_APPEARANCE,
  TEXT_SIZE,
  THEME,
  applyAppearance,
  appearanceSummary,
  readStoredAppearance,
  storeAppearance,
  type Appearance as Choice,
} from '../lib/appearance.js';
import {
  AUDIO_COPY,
  RATE_STEPS,
  SLEEP_TIMERS,
  audioSummary,
  type SleepTimer,
} from '../lib/audio-prefs.js';
import { listVoices, onVoicesChanged } from '../lib/speech.js';
import { usePlayer } from '../components/PlayerProvider.js';

/**
 * Appearance — the display settings and the listening settings, finally reachable.
 *
 * `lib/appearance.ts` explains at length why these live in `localStorage` rather
 * than in the `preferences` row. This file is the consequence of that decision
 * rather than a restatement of it, and two things follow from it visibly:
 *
 *   * NO SAVE BUTTON. Every other settings screen in this app collects an
 *     intention and writes it once, because the result of a topic weight is a
 *     feed you have not fetched yet. Here the result is the page you are looking
 *     at. Choosing applies and persists in the same gesture, so the evidence
 *     that the control worked is the screen changing under the reader's hand —
 *     deferring that to a Save button would hide the answer behind a second
 *     click, at the moment they have already stopped looking at the option.
 *   * NO ACCOUNT. This is the only settings screen a signed-out visitor can
 *     open, and it has to be: somebody reading a shared Pull at two in the
 *     morning needs the dark theme more than the reader who has an account, not
 *     less. `App` lists it as a public route for that reason. The listening
 *     settings belong here for the same reason twice over — read-aloud is free
 *     forever under law 3, so it works signed out, and a voice is an engine
 *     installed on this machine rather than a fact about a reader.
 *
 * RADIOS, NOT BUTTONS WITH A PRESSED STATE. The rest of the app uses
 * `.btn[aria-pressed]` for its choosers, and that is right where a choice is a
 * toggle or where the set is built from data. Three mutually exclusive named
 * options are the thing `<input type="radio">` exists for: the platform gives
 * roving arrow-key focus inside the group, one tab stop for the group rather
 * than one per option, and a `<legend>` that a screen reader reads out with
 * every option in it. Rebuilding that on buttons means reimplementing all of it,
 * and the versions that get shipped usually implement about half.
 */
export function Appearance() {
  /*
   * Read once during the first render, not in an effect — the same reasoning
   * `App` gives for focus mode. The inline script in `index.html` has already
   * put these attributes on the document before the first paint, so what is read
   * here agrees with what the reader is currently looking at, and there is
   * nothing to apply on mount.
   */
  const [choice, setChoice] = useState(readStoredAppearance);

  /*
   * Apply, persist, then re-render — in that order, and none of it can fail.
   *
   * `applyAppearance` goes first because it is the half the reader can see, and
   * `storeAppearance` swallows the exception a browser blocking site data
   * throws. So there is no error state to render here: a setting that cannot be
   * remembered is still a setting that works for this session.
   */
  function commit(next: Choice) {
    applyAppearance(next, document.documentElement);
    storeAppearance(next);
    setChoice(next);
  }

  return (
    <section className="appearance measure">
      <p className="meta">Appearance</p>
      <h2>How this reads</h2>

      {/*
        What has already been changed, before offering more to change — the same
        move the catalogue makes with its totals and the Library with its count.
      */}
      <p className="appearance__summary">{appearanceSummary(choice)}</p>

      <p className="appearance__intro">
        These apply as you choose them, and they are kept on this device rather than in an account —
        so they work signed out, they work offline, and this phone at midnight can differ from that
        desk at noon without either being wrong.
      </p>

      <Group
        legend="Theme"
        name="appearance-theme"
        options={THEME.options}
        copy={APPEARANCE_COPY.theme}
        value={choice.theme}
        onChoose={(theme) => commit({ ...choice, theme })}
      />

      <Group
        legend="Contrast"
        name="appearance-contrast"
        options={CONTRAST.options}
        copy={APPEARANCE_COPY.contrast}
        value={choice.contrast}
        onChoose={(contrast) => commit({ ...choice, contrast })}
      />

      <Group
        legend="Text size"
        name="appearance-text"
        options={TEXT_SIZE.options}
        copy={APPEARANCE_COPY.text}
        value={choice.text}
        onChoose={(text) => commit({ ...choice, text })}
      />

      <div className="appearance__actions">
        {/*
          Never disabled, even when everything is already at its default. It
          still does something in that case — it writes the three base values
          over whatever unrecognised strings a previous version of this app or
          another tab may have left in storage — and a control that leaves the
          tab order when the screen happens to be in one particular state is a
          worse trade than a button that is occasionally a no-op.
        */}
        {/*
          Named for what it resets, now that the listening settings sit below it.
          "Reset to defaults" beneath one half of a screen and above the other is a
          button whose scope the reader has to guess at, and the guess that costs
          them is the wrong one.
        */}
        <button type="button" className="btn btn--plain" onClick={() => commit(DEFAULT_APPEARANCE)}>
          Reset display to defaults
        </button>
      </div>

      <Listening />

      {/* The end is a sentence, not the page simply stopping. */}
      <p className="meta appearance__end">That is every setting this device keeps.</p>
    </section>
  );
}

/**
 * Listening — speed, voice and a sleep timer.
 *
 * Set through the player rather than through `lib/audio-prefs.ts` directly, and
 * that is the whole reason this is a component rather than three more `Group`s
 * above. A rate changed while something is being read has to reach the utterance
 * that is running — `adjustSpeaking` keeps the reader's place — and only the
 * player knows whether anything is. Writing storage from here as well would give
 * the same setting two owners, which is how a screen and a voice come to
 * disagree about how fast to read.
 */
function Listening() {
  const { supported, prefs, setRate, setVoice, setSleep } = usePlayer();

  /*
   * `getVoices()` is empty in Chrome until `voiceschanged` fires, often after the
   * first paint, so the list is state rather than a render-time read. The
   * subscription is what turns an empty dropdown into a populated one without a
   * reload.
   */
  const [voices, setVoices] = useState(() => listVoices());
  useEffect(() => onVoicesChanged(() => setVoices(listVoices())), []);

  /*
   * Withheld entirely where the browser cannot speak. A settings group for a
   * capability the device does not have is worse than its absence: it implies
   * the feature exists and is simply misconfigured.
   */
  if (!supported) return null;

  const chosen = voices.find((v) => v.voiceURI === prefs.voiceURI) ?? null;

  return (
    <>
      <h2>How this sounds</h2>

      <p className="appearance__summary">{audioSummary(prefs, chosen?.name ?? null)}</p>

      <p className="appearance__intro">
        Read-aloud is free permanently and runs on this device — nothing about what you listen to is
        sent to us. A voice marked local speaks entirely here; any other one is your browser sending
        the text to its own vendor, which is why the list puts local voices first.
      </p>

      <Group
        legend="Speed"
        name="audio-rate"
        options={RATE_STEPS.map((r) => String(r))}
        copy={Object.fromEntries(RATE_STEPS.map((r) => [String(r), AUDIO_COPY.rate(r)]))}
        value={String(prefs.rate)}
        onChoose={(rate) => setRate(Number(rate))}
      />

      <fieldset className="appearance__set">
        <legend className="prefs__legend">Voice</legend>
        <div className="appearance__option">
          {/*
            A select rather than radios, unlike every other group on this screen.
            The set is not three named options: it is whatever engines this machine
            has installed, which on a laptop is routinely forty. Radios are right
            for a small fixed set and wrong for a list of that length.
          */}
          <label className="appearance__label" htmlFor="audio-voice">
            Reading voice
          </label>
          <select
            id="audio-voice"
            className="field__input"
            value={prefs.voiceURI ?? ''}
            aria-describedby="audio-voice-note"
            onChange={(e) => setVoice(e.target.value || null)}
          >
            <option value="">Whatever this browser picks</option>
            {voices.map((v) => (
              <option key={v.voiceURI} value={v.voiceURI}>
                {v.name} · {v.lang}
                {v.localService ? ' · on this device' : ''}
              </option>
            ))}
          </select>
          <p className="appearance__note" id="audio-voice-note">
            {voices.length === 0
              ? 'This browser has not reported its voices yet. It usually does a moment after the page loads.'
              : 'Left alone, a local voice in your own language is preferred over one that speaks through a server.'}
          </p>
        </div>
      </fieldset>

      <Group
        legend="Sleep timer"
        name="audio-sleep"
        options={SLEEP_TIMERS}
        copy={AUDIO_COPY.sleep}
        value={prefs.sleep}
        onChoose={(sleep: SleepTimer) => setSleep(sleep)}
      />
    </>
  );
}

/**
 * One setting: a `<legend>`, and one radio per value the stylesheet implements.
 *
 * Generic over the setting's own union rather than over `string`, so `onChoose`
 * hands back a `Theme` or a `TextSize` and the three call sites above cannot
 * quietly put a contrast value in the theme slot.
 *
 * The note is a description, not part of the label. Folding it into the `<label>`
 * would make the accessible name of the first theme option "Match my system
 * Follows whatever this device is set to." — a name is what you say to pick a
 * thing, and nobody says that. `aria-describedby` announces it after the name
 * instead, which is the order a sighted reader takes them in too.
 */
function Group<T extends string>({
  legend,
  name,
  options,
  copy,
  value,
  onChoose,
}: {
  legend: string;
  name: string;
  options: readonly T[];
  copy: Record<T, { label: string; note: string }>;
  value: T;
  onChoose: (next: T) => void;
}) {
  return (
    <fieldset className="appearance__set">
      {/* Reused from the preferences screen rather than restyled. A second
          legend style is a second thing to keep in step with the type ramp. */}
      <legend className="prefs__legend">{legend}</legend>

      {options.map((option) => {
        const id = `${name}-${option}`;
        return (
          <div key={option} className="appearance__option">
            <input
              type="radio"
              className="appearance__radio"
              id={id}
              name={name}
              value={option}
              checked={value === option}
              aria-describedby={`${id}-note`}
              onChange={() => onChoose(option)}
            />
            <label className="appearance__label" htmlFor={id}>
              {copy[option].label}
            </label>
            <p className="appearance__note" id={`${id}-note`}>
              {copy[option].note}
            </p>
          </div>
        );
      })}
    </fieldset>
  );
}
