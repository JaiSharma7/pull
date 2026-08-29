import type { CSSProperties } from 'react';

export interface EnoughProps {
  ideasRead: number;
  recalled: number;
  /** Minutes the Delta saved by not re-teaching what the reader already knows. */
  minutesSaved: number;
  onContinue?: () => void;
}

/**
 * The screen that ends a session.
 *
 * Most feeds are built to never stop. This one is built to finish, and says so.
 * The reader can always continue — the button is right there — but the default
 * message is that they are done, and the headline number is time *saved* rather
 * than time spent.
 */
export function Enough({ ideasRead, recalled, minutesSaved, onContinue }: EnoughProps) {
  return (
    <section className="stack measure" aria-labelledby="enough-heading">
      <p className="meta">Daily Pull</p>
      <h2 id="enough-heading" style={{ fontSize: 'var(--step-4)' }}>
        Enough for today.
      </h2>

      <dl className="stack" style={{ '--stack-gap': 'var(--space-2)' } as CSSProperties}>
        <div>
          <dt className="meta">Ideas read</dt>
          <dd style={{ margin: 0, fontSize: 'var(--step-2)' }}>{ideasRead}</dd>
        </div>
        <div>
          <dt className="meta">Recalled</dt>
          <dd style={{ margin: 0, fontSize: 'var(--step-2)' }}>{recalled}</dd>
        </div>
        <div>
          <dt className="meta">Time saved by skipping what you knew</dt>
          <dd style={{ margin: 0, fontSize: 'var(--step-2)', color: 'var(--accent)' }}>
            {minutesSaved < 1 ? 'under a minute' : `${minutesSaved} min`}
          </dd>
        </div>
      </dl>

      <p className="pull-card__body">Mind fed. Go and use some of it.</p>

      {onContinue && (
        <button type="button" className="btn btn--plain" onClick={onContinue}>
          Keep reading anyway
        </button>
      )}
    </section>
  );
}
