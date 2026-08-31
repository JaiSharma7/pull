import { Enough, Meter, PullCard } from '@wap/ui';
import { Interrupt } from '../components/Interrupt.js';
import type { FeedRow } from '../lib/types.js';

/**
 * A visual test page for the design system — every component, with fixed
 * content, on one screen. Reachable at `?specimen` in development.
 *
 * It exists so a design regression is visible in one glance rather than
 * discovered in the feed, and so `/design-check` has something to screenshot.
 */

const sample: FeedRow = {
  id: 'specimen',
  summaryId: 'specimen',
  ordinal: 1,
  headline: 'You are disturbed by your judgement, not by the event.',
  body: 'Events arrive without commentary. The distress comes from the verdict you attach to them, which is why two people meet the same news very differently.',
  explanation: null,
  example: 'The delayed train is a fact. "This always happens to me" is the part doing the damage.',
  whyItMatters:
    'It is the direct ancestor of cognitive behavioural therapy, which industrialised exactly this move.',
  estimatedReadSeconds: 32,
  summaryTitle: 'The Enchiridion — the discipline of what is yours',
  work: { id: 'w', title: 'The Enchiridion', slug: 'the-enchiridion', kind: 'book', year: 125 },
  score: 0.82,
};

export function Specimen() {
  return (
    <main className="stack" style={{ padding: 'var(--space-6) var(--space-5)', maxWidth: '48rem' }}>
      <p className="meta">Specimen · The Archive</p>
      <h1>Every component, one screen.</h1>

      <p className="meta" data-testid="delta-banner">
        Skipped 14 ideas you already know —{' '}
        <span style={{ color: 'var(--accent)' }}>about 6.2 min saved</span>
      </p>

      <PullCard
        source={{ title: sample.work.title, creator: 'Epictetus', kind: 'Book' }}
        headline={sample.headline}
        body={sample.body}
        whyItMatters={sample.whyItMatters}
        example={sample.example}
        sourceTrail="ch. 5"
        saved={false}
        onSave={() => undefined}
        onAsk={() => undefined}
        onListen={() => undefined}
      />

      <Interrupt
        kind="recall"
        pull={sample}
        onAnswer={() => undefined}
        onDismiss={() => undefined}
      />

      <Interrupt
        kind="say_it_back"
        pull={sample}
        onAnswer={() => undefined}
        onDismiss={() => undefined}
      />

      <Interrupt
        kind="conviction"
        pull={sample}
        onAnswer={() => undefined}
        onDismiss={() => undefined}
      />

      <div>
        <p className="meta" style={{ marginBottom: 'var(--space-2)' }}>
          Recall strength 68%
        </p>
        <Meter value={0.68} label="Specimen recall strength" />
      </div>

      {/* All three states. Only the flattering one used to be here, and both
          copy bugs this component has shipped lived in the other two. */}
      <Enough ideasRead={7} recalled={2} minutesSaved={6.2} onContinue={() => undefined} />
      <Enough ideasRead={3} recalled={1} minutesSaved={0} />
      <Enough ideasRead={4} recalled={0} minutesSaved={null} />
    </main>
  );
}
