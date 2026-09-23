export interface EnoughProps {
  ideasRead: number;
  recalled: number;
  /** Estimated reading time in matches from the latest feed search; null if unmeasured. */
  minutesSaved: number | null;
  onContinue?: () => void;
}

/** The screen that ends a reading session. */
export function Enough({ ideasRead, recalled, minutesSaved, onContinue }: EnoughProps) {
  return (
    <section className="stack measure" aria-labelledby="enough-heading">
      <p className="meta">Daily Pull</p>
      <h2 id="enough-heading" style={{ fontSize: 'var(--step-4)' }}>
        Enough for today.
      </h2>

      <dl className="tally" style={{ margin: 0 }}>
        <div>
          <dd className="tally__value" style={{ margin: 0 }}>
            {ideasRead}
          </dd>
          <dt className="tally__label">{ideasRead === 1 ? 'idea' : 'ideas'}</dt>
        </div>
        <div>
          <dd className="tally__value" style={{ margin: 0 }}>
            {recalled}
          </dd>
          <dt className="tally__label">recalled</dt>
        </div>
      </dl>

      <hr className="rule" />

      {minutesSaved !== null && (
        <p style={{ color: 'var(--accent)', fontSize: 'var(--step-1)' }}>
          {minutesSaved === 0
            ? 'No matched reading in the latest search'
            : minutesSaved < 1
              ? 'Latest search: under a minute of estimated reading in matched ideas'
              : 'Latest search: ' +
                minutesSaved +
                ' ' +
                (minutesSaved === 1 ? 'minute' : 'minutes') +
                ' of estimated reading in matched ideas'}
        </p>
      )}

      <p className="pull-card__body">Mind fed. Go and use some of it.</p>

      {onContinue && (
        <button type="button" className="btn btn--plain" onClick={onContinue}>
          Keep reading anyway
        </button>
      )}
    </section>
  );
}
