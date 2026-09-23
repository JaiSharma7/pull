import type { SourceDelta } from '../lib/types.js';

export function SourceDeltaSummary({ delta }: { delta: SourceDelta | null }) {
  if (!delta || delta.total <= 0) return null;

  return (
    <p className="source__delta">
      {delta.known === 0 ? (
        <>No ideas in this source are confirmed as known yet.</>
      ) : (
        <>
          <strong>{delta.known}</strong> of {delta.total}{' '}
          {delta.total === 1 ? 'idea matches' : 'ideas match'} what you have recalled or explicitly
          marked as known. <strong className="source__delta-new">{delta.new}</strong>{' '}
          {delta.new === 1 ? 'remains' : 'remain'} unverified
          {delta.minutesSaved > 0 ? (
            <>
              {' '}
              — about <strong>{delta.minutesSaved} min</strong> of estimated reading in the matched
              ideas
            </>
          ) : null}
          .
        </>
      )}
    </p>
  );
}
