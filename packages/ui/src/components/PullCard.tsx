import { useId, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { clampDepth, defaultDepth, depthLevels, HEADLINE_SCALE } from '../depth.js';

/**
 * The three bodies of text a card can render through `renderBody`.
 *
 * Mirrors `HIGHLIGHTABLE_FIELDS` in `apps/web/src/lib/highlights.ts`, which this
 * package cannot import; the names are the database columns, so a caller
 * holding highlights keyed by field can place them without a translation.
 */
export type PullCardTextField = 'body' | 'why_it_matters' | 'explanation';

export interface PullCardSource {
  title: string;
  creator?: string | null;
  kind?: string | null;
  year?: number | null;
}

export interface PullCardProps {
  source: PullCardSource;
  headline: string;
  body: string;
  /** The third stop — the named second movement. */
  whyItMatters?: string | null;
  example?: string | null;
  /**
   * The fourth stop — the full argument.
   *
   * `get_feed` has returned this since `20260829130428_get_feed` and no screen
   * ever rendered it: the card had two faces and this was neither of them. It is
   * the deepest thing the feed already pays for.
   */
  explanation?: string | null;
  /** Chapter, timestamp or section the claim is anchored to. */
  sourceTrail?: string | null;
  /**
   * Open the source this Pull came from.
   *
   * Also what decides whether the dial gets its last stop: a card without a
   * resolvable source — the design specimen, an offline row whose work is not
   * cached — should not draw one that goes nowhere.
   */
  onOpenSource?: () => void;
  saved?: boolean;
  onSave?: () => void;
  onListen?: () => void;
  /**
   * Whether this card is the one currently being read aloud.
   *
   * The Listen button was a one-way door: it started speech and there was no way to
   * stop it, on a screen where scrolling to the next card leaves the previous one
   * still talking. A toggle needs to say which way it is pointing, so this drives the
   * label and `aria-pressed` rather than being inferred from a click.
   */
  listening?: boolean;
  onAsk?: () => void;
  /**
   * Add this Pull to the listening queue, or take it out.
   *
   * Optional for the reason `onListen` is: the control is drawn only where a
   * screen has a queue to add to. `queued` drives the label and `aria-pressed`
   * rather than being inferred from a click, because whether this card is
   * already in the queue is the queue's knowledge, not the card's — the same
   * card can be queued from the Library and seen again in the feed.
   */
  onQueue?: () => void;
  queued?: boolean;
  /**
   * Render a body of text in place of the plain string.
   *
   * The source page keeps a reader's highlight marks inside the text, which is
   * markup a card cannot produce from a string. Called for each stop that
   * carries a body — the claim, why it matters, the full argument — with the
   * field named, so a caller with marks on more than the claim can place them.
   * The headline is never passed: it is the title, not a passage.
   *
   * INLINE CONTENT ONLY. What comes back is rendered inside the card's own
   * `<p class="pull-card__body">`, so a block element — a `div`, another `p`, a
   * list — is closed out of it by the HTML parser, and the text loses the card's
   * measure, leading and spacing. `renderToStaticMarkup` shows nothing wrong,
   * which is exactly why this needs saying rather than testing. `<mark>`,
   * `<span>`, `<em>` and a plain string are all fine, and are what the highlight
   * caller returns.
   */
  renderBody?: (text: string, field: PullCardTextField) => ReactNode;
  /**
   * Hand this idea to somebody else.
   *
   * Optional for the same reason `onOpenSource` is: the design specimen and any
   * card without a resolvable `/pull/:id` should not offer a control that goes
   * nowhere. The label is passed in rather than decided here, because what the
   * button will actually do — open a share sheet or copy a link — depends on the
   * browser, and a control that says "Share" while silently copying is a small
   * lie the component has no way to detect on its own.
   */
  onShare?: () => void;
  shareLabel?: string;
  /**
   * Depth, lifted out of the card when a screen wants to remember it.
   *
   * The feed does, across cards: a reader who opened one Pull to its full
   * argument is saying something about how they want to read, not about that one
   * idea. Uncontrolled when omitted, so a card rendered on its own still works.
   */
  depth?: number;
  onDepthChange?: (depth: number) => void;
  /** Rendered with the argument — counterpoint, conviction controls, etc. */
  children?: ReactNode;
}

/**
 * The product's core object: one idea, anchored to a real source.
 *
 * The card carries the Depth Dial from `docs/product.md`: one canonical record
 * rendered at the length the reader asks for. Nothing is fetched and nothing
 * regenerates between stops, which is why depth is free and why law 2 permits it
 * at all — the dial is a lens, not a request.
 *
 * It replaces a two-sided flip, and the flip is worth recording because its
 * failure was structural rather than cosmetic. `.flip__face--back` was
 * `position: absolute; inset: 0`, so the back was sized by the *front* — and
 * carried `overflow-y: auto` to cope. Every Pull whose "why it matters" ran
 * longer than its claim therefore got a scrollbar inside the card, on a screen
 * that is already a scroll: more detail made the reading area smaller, which is
 * the wrong direction for a control whose whole purpose is more detail. Depth
 * that appends to the flow cannot reproduce it — there is no fixed height left
 * to overflow.
 *
 * It also cost three stops. The card had exactly two states, so `explanation` had
 * nowhere to go and the headline could not be read on its own.
 */
export function PullCard({
  source,
  headline,
  body,
  whyItMatters,
  example,
  explanation,
  sourceTrail,
  saved = false,
  onSave,
  onListen,
  listening = false,
  onAsk,
  onQueue,
  queued = false,
  renderBody,
  onShare,
  shareLabel = 'Share',
  onOpenSource,
  depth: controlledDepth,
  onDepthChange,
  children,
}: PullCardProps) {
  const levels = depthLevels({
    headline,
    body,
    whyItMatters,
    example,
    explanation,
    hasSource: Boolean(onOpenSource),
  });

  const [ownDepth, setOwnDepth] = useState(() => defaultDepth(levels));
  const panelId = useId();
  const dialId = useId();

  // Clamped rather than trusted: a remembered depth arrives from a card that may
  // have had more stops than this one.
  const depth = clampDepth(controlledDepth ?? ownDepth, levels);
  /*
   * Which stops are open, by name rather than by index.
   *
   * The stops a card offers depend on the text it has, so position is not
   * identity: a Pull with an `explanation` and no `why_it_matters` puts 'full'
   * one turn in. Keying the panels off the index rendered that card an empty
   * "Why this matters" heading and never showed the argument underneath.
   */
  const shown = new Set(levels.slice(0, depth + 1).map((level) => level.key));

  const setDepth = (next: number) => {
    const clamped = clampDepth(next, levels);
    setOwnDepth(clamped);
    onDepthChange?.(clamped);
  };

  /*
   * A radio group is driven by the arrows, not by Tab — the group takes one tab
   * stop and the arrows move within it. Both axes are bound because the dial is
   * a column in the margin at most widths and a row at the foot at the rest, and
   * which one a reader reaches for follows what they can see.
   *
   * Bound to the stops rather than to the group, because the group is not itself
   * focusable: with a roving tabindex the focus is always on a radio, so that is
   * where the key arrives. Selection and focus move together, which is what makes
   * it a radio group rather than a row of buttons — the reader arrows through
   * depths and the card follows, without a second keystroke to commit.
   */
  const onStopKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (step === undefined) return;
    event.preventDefault();

    const next = clampDepth(depth + step, levels);
    setDepth(next);
    // The DOM order of the stops is the level order, so the index addresses the
    // button directly and no ref array is needed to keep the two in step.
    const stops = event.currentTarget.parentElement?.querySelectorAll('[role="radio"]');
    (stops?.[next] as HTMLElement | undefined)?.focus();
  };

  const chip = [source.title, source.creator, source.kind].filter(Boolean) as string[];
  const atSource = levels[depth]?.key === 'source';
  const passage = (text: string, field: PullCardTextField) =>
    renderBody ? renderBody(text, field) : text;

  return (
    <article className="pull-card" data-depth={depth}>
      {/*
        The chip becomes the way into the source when there is one to open.
        A button rather than a link because the shell routes in-process, and
        `btn--plain` keeps it looking like the metadata it already was: this is
        an affordance the reader discovers, not a call to action competing with
        the idea underneath it.
      */}
      {onOpenSource ? (
        <button
          type="button"
          className="btn btn--plain pull-card__chip pull-card__chip--link"
          // The visible text is metadata, so on its own it announces as a title
          // with no indication it does anything -- unlike Save and Listen, which
          // carry explicit labels. The underline is a sighted-only affordance.
          aria-label={`Open the source: ${source.title}`}
          onClick={onOpenSource}
        >
          {chip.map((part, i) => (
            <span key={part}>
              {i > 0 && <span className="pull-card__chip-sep"> · </span>}
              {part}
            </span>
          ))}
        </button>
      ) : (
        <p className="pull-card__chip">
          {chip.map((part, i) => (
            <span key={part}>
              {i > 0 && <span className="pull-card__chip-sep"> · </span>}
              {part}
            </span>
          ))}
        </p>
      )}
      <hr className="pull-card__rule" />

      <div className="pull-card__spread">
        <div className="pull-card__reading">
          {/*
            The headline scales down as the dial turns out, so the card reads as
            one object changing rather than a page with things appended to it.
          */}
          <h2
            className="pull-card__headline"
            style={{ '--headline-scale': HEADLINE_SCALE[depth] ?? 1.45 } as CSSProperties}
          >
            {headline}
          </h2>

          {/*
            One region for everything past the headline, so a screen reader is
            told once that the card grew rather than once per paragraph, and so
            the dial has a single thing to point `aria-controls` at.
          */}
          <div className="pull-card__depth-panel" id={panelId} aria-live="polite">
            {shown.has('claim') && (
              <div className="pull-card__stop">
                <p className="pull-card__body">{passage(body, 'body')}</p>
              </div>
            )}

            {shown.has('why') && (
              <div className="pull-card__stop">
                <p className="pull-card__movement">Why this matters</p>
                {whyItMatters && (
                  <p className="pull-card__body">{passage(whyItMatters, 'why_it_matters')}</p>
                )}
                {example && (
                  <p className="pull-card__body">
                    <span className="meta">Example</span>
                    <br />
                    {example}
                  </p>
                )}
              </div>
            )}

            {shown.has('full') && (
              <div className="pull-card__stop">
                <p className="pull-card__movement">In full</p>
                <p className="pull-card__body">
                  {explanation ? passage(explanation, 'explanation') : null}
                </p>
              </div>
            )}

            {/*
              The terminus is an offer rather than a wall: every source in the
              corpus is public domain and readable without an account, which is
              the whole reason the dial can end by sending the reader away.
            */}
            {atSource && onOpenSource && (
              <div className="pull-card__stop">
                <p className="pull-card__movement">Go to the source</p>
                <button type="button" className="btn pull-card__out" onClick={onOpenSource}>
                  {`Read ${source.title} in full`}
                </button>
              </div>
            )}

            {/* Counterpoint and the conviction controls belong to the argument,
                so they arrive with it rather than under a bare headline. */}
            {shown.has('why') && children}
          </div>
        </div>

        {/*
          The dial follows the idea in the DOM, and is placed back into the margin
          beside it by the grid where there is room.

          Written this way round because the narrow layout is the one that cannot
          cheat: with no margin to put the dial in it has to go somewhere in the
          flow, and above the headline it pushed the idea 212px down a phone screen
          — a reader scrolling past a control to reach the thing it controls. The
          design session said as much ("the dial drops to a foot row"); the canvas
          it shipped with put the dial first and I followed the code rather than
          the sentence. The sentence was right.

          Content-then-control is also the honest source order for a screen reader
          and for the tab sequence, and `aria-controls` carries the relationship
          that the position no longer implies.

          Rendered at all only when there is somewhere to go. A dial with one stop
          is furniture.
        */}
        {levels.length > 1 && (
          <div className="pull-card__dial" role="radiogroup" aria-labelledby={dialId}>
            <p className="pull-card__dial-label" id={dialId}>
              Depth
            </p>
            {levels.map((level, i) => (
              <button
                key={level.key}
                type="button"
                role="radio"
                className="btn btn--plain pull-card__stop-btn"
                aria-checked={i === depth}
                aria-controls={panelId}
                // The visible label is a duration, and "35 sec" announced on its
                // own says nothing about which way the dial is being turned.
                aria-label={level.aria}
                // One tab stop for the group; the arrows move within it.
                tabIndex={i === depth ? 0 : -1}
                onClick={() => setDepth(i)}
                onKeyDown={onStopKey}
              >
                <span
                  className="pull-card__tick"
                  style={{ width: level.tick }}
                  aria-hidden="true"
                />
                <span className="pull-card__stop-label">{level.label}</span>
              </button>
            ))}
            {/*
              The words behind the clock. A duration is a claim about the reader;
              a word count is a fact about the card, and showing both is what
              stops the first from drifting.
            */}
            <p className="pull-card__dial-words">{levels[depth]?.words ?? 0} words</p>
          </div>
        )}
      </div>

      <div className="pull-card__footer">
        {sourceTrail && <span className="pull-card__trail">{sourceTrail}</span>}
        {onSave && (
          <button
            type="button"
            className="btn"
            aria-pressed={saved}
            onClick={onSave}
            aria-label={saved ? `Unsave: ${headline}` : `Save: ${headline}`}
          >
            {saved ? 'Saved' : 'Save'}
          </button>
        )}
        {onAsk && (
          <button type="button" className="btn" onClick={onAsk}>
            Ask
          </button>
        )}
        {onShare && (
          <button
            type="button"
            className="btn"
            onClick={onShare}
            aria-label={`${shareLabel}: ${headline}`}
          >
            {shareLabel}
          </button>
        )}
        {onListen && (
          <button
            type="button"
            className="btn"
            onClick={onListen}
            aria-pressed={listening}
            aria-label={listening ? `Stop reading: ${headline}` : `Listen to: ${headline}`}
          >
            {listening ? 'Stop' : 'Listen'}
          </button>
        )}
        {onQueue && (
          <button
            type="button"
            className="btn"
            onClick={onQueue}
            aria-pressed={queued}
            /*
             * NAMED FOR WHAT PRESSING IT DOES, like the two buttons above it.
             *
             * This said `Queued: …` when pressed, which is a STATUS rather than an
             * action — so a screen reader announced a control whose name had changed
             * out from under it and still did not say that activating it takes the Pull
             * back out. `Save` and `Listen` both name the action in both states
             * (`Unsave`/`Save`, `Stop reading`/`Listen to`) and let `aria-pressed`
             * carry the state; this is the one that did not, and now does.
             *
             * The visible label stays `Queued`, which is the right word for a chip you
             * are reading rather than one you are being asked to press.
             */
            aria-label={queued ? `Remove from queue: ${headline}` : `Add to queue: ${headline}`}
          >
            {queued ? 'Queued' : 'Queue'}
          </button>
        )}
      </div>
    </article>
  );
}
