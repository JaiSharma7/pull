import { useState } from 'react';
import { PullCard, SynapseMap } from '@wap/ui';
import { SAMPLE_GRAPH, undirectedEdges } from '../lib/graph.js';

export interface OnboardingDemoProps {
  onComplete: () => void;
  onSkip?: () => void;
}

/* Module scope, so the identity is stable: `SynapseMap` keys its whole simulation off
   this array, and a fresh one each render resets the layout to full alpha. Collapsed to
   one edge per pair, like the other two consumers — `SAMPLE_GRAPH` carries the
   Enchiridion/Meditations lineage in both directions, and drawing both strokes the same
   chord twice. */
const demoEdges = undirectedEdges(SAMPLE_GRAPH.edges);

export function OnboardingDemo({ onComplete, onSkip }: OnboardingDemoProps) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [depth, setDepth] = useState(1);
  const [simulatedPriorKnowledge, setSimulatedPriorKnowledge] = useState(true);

  return (
    <div className="stack" style={{ gap: 'var(--space-5)', maxWidth: '42rem', margin: '0 auto' }}>
      <header>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'baseline',
            flexWrap: 'wrap',
            gap: 'var(--space-2)',
          }}
        >
          {/* The gate is preferences → census → demo. These counters used to read
              "Step 1 of 2" then "Step 1 of 3", so a reader saw three screens described by
              two disagreeing scales. */}
          <p className="meta" style={{ color: 'var(--accent)' }}>
            Step 3 of 3 · A quick tour, {step} of 3
          </p>
          <button type="button" className="btn btn--plain" onClick={onSkip ?? onComplete}>
            Skip demo
          </button>
        </div>

        <h1 style={{ marginTop: 'var(--space-1)', marginBottom: 'var(--space-1)' }}>
          {step === 1 && 'The Depth Dial'}
          {step === 2 && 'The Delta'}
          {step === 3 && 'The graph'}
        </h1>
        <p className="meta">
          {step === 1 &&
            'Control how much of an idea you get. The dial moves from the claim itself to the mechanism and the evidence behind it.'}
          {step === 2 &&
            'Ideas repeat across books. The Delta leaves out the ones your reading already shows you hold.'}
          {step === 3 &&
            'Your thoughts form an enduring lattice. Active recall fires only as memory fades.'}
        </p>
      </header>

      {/* Step 1: The Depth Dial */}
      {step === 1 && (
        <div className="stack" style={{ gap: 'var(--space-4)' }}>
          <div
            style={{
              padding: 'var(--space-3) var(--space-4)',
              border: '1px solid var(--rule)',
              backgroundColor: 'var(--surface-raised)',
            }}
          >
            <p className="meta" style={{ color: 'var(--accent)' }}>
              Try it — slide the dial at the bottom of the card:
            </p>
            <p style={{ margin: 'var(--space-1) 0 0' }}>
              Level 1 captures the thesis in seconds. Level 2 details mechanisms. Level 3 includes
              formal studies and counterarguments.
            </p>
          </div>

          {/*
            A real seeded Pull, word for word from `20260829131035_seed_pulls.sql`, and from a
            public-domain work. `docs/design.md` requires exactly this of an illustrative card,
            and says why: a repository whose rule is that only public-domain material is
            committed should not reach for a title under copyright the moment it wants a
            plausible example. What was here did reach for one — invented prose attributed to
            *Thinking, Fast and Slow*, with an "example" describing the elderly-priming study
            as an established finding.
          */}
          <PullCard
            headline="Some things are up to you. Most are not."
            body="Your judgements, intentions and effort are yours. Reputation, outcomes, other people and the past are not."
            whyItMatters="Almost every practical philosophy since is a variation on where exactly this line falls."
            example="You can control how thoroughly you prepare. You cannot control whether the panel likes you."
            explanation="The distinction is not a comfort but a filter. Effort spent on the second category is spent at a loss, however sincerely it is spent."
            depth={depth}
            onDepthChange={setDepth}
            source={{
              title: 'The Enchiridion',
              kind: 'book',
            }}
            sourceTrail="Epictetus · public-domain translation"
          />
        </div>
      )}

      {/* Step 2: The Delta */}
      {step === 2 && (
        <div className="stack" style={{ gap: 'var(--space-4)' }}>
          <div
            style={{
              padding: 'var(--space-3) var(--space-4)',
              border: '1px solid var(--rule)',
              backgroundColor: 'var(--surface-raised)',
            }}
          >
            <p className="meta" style={{ color: 'var(--accent)' }}>
              Try it — toggle what you already know:
            </p>
            <p style={{ margin: 'var(--space-1) 0 0' }}>
              The same idea turns up in book after book. The Delta leaves out the ones you have
              already met, so what is left is what is new to you.
            </p>
          </div>

          <div className="library__filters" role="group" aria-label="Simulation state">
            <button
              type="button"
              className="btn btn--plain library__filter"
              aria-pressed={!simulatedPriorKnowledge}
              onClick={() => setSimulatedPriorKnowledge(false)}
            >
              First-time reader (No Delta)
            </button>
            <button
              type="button"
              className="btn btn--plain library__filter"
              aria-pressed={simulatedPriorKnowledge}
              onClick={() => setSimulatedPriorKnowledge(true)}
            >
              Calibrated reader (The Delta Active)
            </button>
          </div>

          <div
            style={{
              border: '1px solid var(--rule)',
              padding: 'var(--space-4)',
              backgroundColor: 'var(--surface)',
            }}
          >
            {/* Illustrative, and said so rather than implied. The figures below are a
                worked example of how the Delta reads, not a measurement of anything: this
                screen runs before the reader has a knowledge model to measure. The source
                is a seeded public-domain work for the same reason the card above is. */}
            <p className="meta">Worked example · illustration, not your data</p>
            <div
              style={{
                display: 'flex',
                alignItems: 'baseline',
                gap: 'var(--space-4)',
                margin: 'var(--space-3) 0',
                flexWrap: 'wrap',
              }}
            >
              <div>
                <span style={{ fontSize: 'var(--step-3)', fontFamily: 'var(--font-mono)' }}>
                  {simulatedPriorKnowledge ? '1' : '3'}
                </span>
                <span className="meta"> ideas to read</span>
              </div>
              <div>
                <span
                  style={{
                    fontSize: 'var(--step-3)',
                    fontFamily: 'var(--font-mono)',
                    color: 'var(--accent)',
                  }}
                >
                  {simulatedPriorKnowledge ? '2' : '0'}
                </span>
                <span className="meta"> ideas already held</span>
              </div>
              <div>
                <span
                  style={{
                    fontSize: 'var(--step-3)',
                    fontFamily: 'var(--font-mono)',
                    color: 'var(--accent)',
                  }}
                >
                  {simulatedPriorKnowledge ? '~1m' : '0m'}
                </span>
                <span className="meta"> reading time spared</span>
              </div>
            </div>

            <p style={{ color: 'var(--text-soft)', margin: 0 }}>
              {simulatedPriorKnowledge
                ? 'With two of these three already in your knowledge model, the Delta shows the one that is new to you.'
                : 'Without a knowledge model, all three are shown in order, including the ones you already hold.'}
            </p>
          </div>
        </div>
      )}

      {/* Step 3: Synapse Network */}
      {step === 3 && (
        <div className="stack" style={{ gap: 'var(--space-4)' }}>
          <div
            style={{
              padding: 'var(--space-3) var(--space-4)',
              border: '1px solid var(--rule)',
              backgroundColor: 'var(--surface-raised)',
            }}
          >
            <p className="meta" style={{ color: 'var(--accent)' }}>
              Try it — drag a node, or zoom:
            </p>
            <p style={{ margin: 'var(--space-1) 0 0' }}>
              Drag a node, or zoom. A dashed oxblood chord is a disagreement between two ideas. An
              idea you are still holding is drawn filled; one that is fading is drawn as an outline.
            </p>
          </div>

          <SynapseMap nodes={SAMPLE_GRAPH.nodes} edges={demoEdges} height="380px" />
        </div>
      )}

      {/* Navigation Footer */}
      <footer
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          borderTop: '1px solid var(--rule)',
          paddingTop: 'var(--space-4)',
          flexWrap: 'wrap',
          gap: 'var(--space-3)',
        }}
      >
        {step > 1 ? (
          <button
            type="button"
            className="btn btn--plain"
            onClick={() => setStep((s) => (s - 1) as 1 | 2 | 3)}
          >
            ← Previous step
          </button>
        ) : (
          <span />
        )}

        {step < 3 ? (
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => setStep((s) => (s + 1) as 1 | 2 | 3)}
          >
            {/* Names the heading it actually leads to — step 3 was renamed to "The graph"
                — and drops the arrow, which nothing else in the app puts on a button. */}
            Next: {step === 1 ? 'the Delta' : 'the graph'}
          </button>
        ) : (
          <button type="button" className="btn btn--primary" onClick={onComplete}>
            Finish Demo & Start Reading →
          </button>
        )}
      </footer>
    </div>
  );
}
