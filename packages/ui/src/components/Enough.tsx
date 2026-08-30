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

      {/*
        The numbers are the product's whole claim, so they are set like a result rather
        than a receipt. Two counts sit side by side at --step-5 with their labels beneath;
        time saved is separated below a rule and carries the accent, because it is the one
        number that *is* the business model — time saved rather than time spent is the
        whole difference between this and a feed. See docs/design-first-run.md.
      */}
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

      <p style={{ color: 'var(--accent)', fontSize: 'var(--step-1)' }}>
        {minutesSaved < 1 ? 'Under a minute saved' : `${minutesSaved} minutes saved`}
      </p>
      <p className="meta" style={{ marginTop: 'calc(var(--space-2) * -1)' }}>
        against reading the sources in full
      </p>

      <p className="pull-card__body">Mind fed. Go and use some of it.</p>

      {onContinue && (
        <button type="button" className="btn btn--plain" onClick={onContinue}>
          Keep reading anyway
        </button>
      )}
    </section>
  );
}
