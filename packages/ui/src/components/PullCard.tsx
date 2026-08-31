import { useId, useState, type ReactNode } from 'react';

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
  /** Shown on the flip side — the "why this matters" half of the card. */
  whyItMatters?: string | null;
  example?: string | null;
  /** Chapter, timestamp or section the claim is anchored to. */
  sourceTrail?: string | null;
  /**
   * Open the source this Pull came from.
   *
   * Optional because the chip has always been able to stand as plain text, and a
   * card rendered without a destination — the design specimen, an offline row whose
   * work is not cached — should not present a control that goes nowhere.
   */
  onOpenSource?: () => void;
  saved?: boolean;
  onSave?: () => void;
  onListen?: () => void;
  onAsk?: () => void;
  /** Rendered under the flip content — counterpoint, conviction controls, etc. */
  children?: ReactNode;
}

/**
 * The product's core object: one idea, anchored to a real source.
 *
 * Front is the claim; the flip carries why it matters and the trail back to the
 * original. Both faces stay mounted so the back is readable by a screen reader
 * and reachable by keyboard — `inert` keeps whichever face is hidden out of the
 * tab order rather than relying on visual stacking.
 */
export function PullCard({
  source,
  headline,
  body,
  whyItMatters,
  example,
  sourceTrail,
  saved = false,
  onSave,
  onListen,
  onAsk,
  onOpenSource,
  children,
}: PullCardProps) {
  const [flipped, setFlipped] = useState(false);
  const backId = useId();

  const chip = [source.title, source.creator, source.kind].filter(Boolean) as string[];

  return (
    <article className="flip" data-flipped={flipped}>
      <div className="flip__inner">
        <div className="pull-card flip__face flip__face--front" inert={flipped}>
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

          <h2 className="pull-card__headline">{headline}</h2>
          <p className="pull-card__body">{body}</p>

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
            {onListen && (
              <button
                type="button"
                className="btn"
                onClick={onListen}
                aria-label={`Listen to: ${headline}`}
              >
                Listen
              </button>
            )}
            <button
              type="button"
              className="btn btn--plain"
              aria-expanded={flipped}
              aria-controls={backId}
              onClick={() => setFlipped(true)}
            >
              Why
            </button>
          </div>
        </div>

        <div className="pull-card flip__face flip__face--back" id={backId} inert={!flipped}>
          <p className="pull-card__chip">Why this matters</p>
          <hr className="pull-card__rule" />

          {whyItMatters && <p className="pull-card__body">{whyItMatters}</p>}
          {example && (
            <p className="pull-card__body">
              <span className="meta">Example</span>
              <br />
              {example}
            </p>
          )}

          {children}

          <div className="pull-card__footer">
            {sourceTrail && <span className="pull-card__trail">From {sourceTrail}</span>}
            <button type="button" className="btn btn--plain" onClick={() => setFlipped(false)}>
              Back
            </button>
          </div>
        </div>
      </div>
    </article>
  );
}
