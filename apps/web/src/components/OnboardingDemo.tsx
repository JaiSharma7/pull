import { useState } from 'react';
import { PullCard, SynapseMap } from '@wap/ui';
import { SAMPLE_GRAPH } from '../lib/graph.js';

export interface OnboardingDemoProps {
  onComplete: () => void;
  onSkip?: () => void;
}

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
          <p className="meta" style={{ color: 'var(--accent)' }}>
            Quick Demo · Step {step} of 3
          </p>
          <button type="button" className="btn btn--plain" onClick={onSkip ?? onComplete}>
            Skip demo
          </button>
        </div>

        <h1 style={{ marginTop: 'var(--space-1)', marginBottom: 'var(--space-1)' }}>
          {step === 1 && '1. The Depth Dial'}
          {step === 2 && '2. The Delta (Time Saved)'}
          {step === 3 && '3. The Synapse Network'}
        </h1>
        <p className="meta">
          {step === 1 &&
            'Control reading compression. Scale reading time from 20 seconds to deep analysis.'}
          {step === 2 &&
            'Never re-read ideas you already know. Skip the redundant 80% across books.'}
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
              Interactive Try-It · Slide the dial at the bottom of the card:
            </p>
            <p style={{ margin: 'var(--space-1) 0 0' }}>
              Level 1 captures the thesis in seconds. Level 2 details mechanisms. Level 3 includes
              formal studies and counterarguments.
            </p>
          </div>

          <PullCard
            headline="Dual-process cognitive architecture: System 1 heuristic intuition vs System 2 deliberate calculation"
            body="System 1 operates automatically and fast with little or no effort. System 2 allocates attention to effortful mental operations. Errors arise when System 1 substitutes a simple heuristic for complex probability."
            whyItMatters="Most real-world blunders in investing, policy, and negotiation stem from uncritical reliance on System 1 heuristics when volatile conditions demand System 2 deliberate rigor."
            example="In experimental trials, subjects primed with words associated with the elderly walked demonstrably slower down the hall—a subconscious ideomotor effect occurring without conscious awareness."
            explanation="Kahneman and Tversky established bounded rationality through empirical cognitive biases, falsifying classical economics' Homo economicus assumption."
            depth={depth}
            onDepthChange={setDepth}
            source={{
              title: 'Thinking, Fast and Slow',
              kind: 'book',
            }}
            sourceTrail="Daniel Kahneman · 2011"
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
              Interactive Try-It · Toggle your prior knowledge:
            </p>
            <p style={{ margin: 'var(--space-1) 0 0' }}>
              Standard microlearning apps make you read 15 minutes of filler every time. The Delta
              removes what you already know.
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
            <p className="meta">Source Analysis: Antifragile by Nassim Nicholas Taleb (18 Ideas)</p>
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
                  {simulatedPriorKnowledge ? '3' : '18'}
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
                  {simulatedPriorKnowledge ? '15' : '0'}
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
                  {simulatedPriorKnowledge ? '35m' : '0m'}
                </span>
                <span className="meta"> reading time spared</span>
              </div>
            </div>

            <p style={{ color: 'var(--text-soft)', margin: 0 }}>
              {simulatedPriorKnowledge
                ? '✓ The Delta detected your mastery of Black Swan theory and Stoic resilience. Only the 3 novel antifragility mechanisms are shown.'
                : 'Reading all 18 ideas linearly without accounting for your existing mental models.'}
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
              Interactive Try-It · Explore your seed lattice:
            </p>
            <p style={{ margin: 'var(--space-1) 0 0' }}>
              Drag nodes, zoom, or tap to inspect connections. Red dashed lines represent opposing
              viewpoints. Nodes decay in brightness as retrievability drops, queuing review.
            </p>
          </div>

          <SynapseMap nodes={SAMPLE_GRAPH.nodes} edges={SAMPLE_GRAPH.edges} height="380px" />
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
            Next: {step === 1 ? 'The Delta →' : 'Synapse Network →'}
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
