import { useMemo, useState } from 'react';

export type KnowledgeLevel = 'unknown' | 'familiar' | 'mastered';

export interface CalibrationItem {
  id: string;
  workTitle: string;
  author: string;
  concept: string;
  description: string;
  hoursSavedEstimated: number;
}

export const CALIBRATION_ITEMS: CalibrationItem[] = [
  {
    id: 'kahneman-system1',
    workTitle: 'Thinking, Fast and Slow',
    author: 'Daniel Kahneman',
    concept: 'Dual-Process Cognitive Architecture (System 1 vs System 2)',
    description:
      'Automatic heuristic heuristics vs deliberate slow reasoning and cognitive biases.',
    hoursSavedEstimated: 2.5,
  },
  {
    id: 'taleb-antifragile',
    workTitle: 'Antifragile',
    author: 'Nassim Nicholas Taleb',
    concept: 'Antifragility & Convexity',
    description:
      'Systems that gain from disorder, volatility, and stressors rather than merely resisting them.',
    hoursSavedEstimated: 3.0,
  },
  {
    id: 'aurelius-meditations',
    workTitle: 'Meditations',
    author: 'Marcus Aurelius',
    concept: 'Stoic Dichotomy of Control',
    description:
      'Dividing external events from internal judgments to maintain equanimity under duress.',
    hoursSavedEstimated: 1.5,
  },
  {
    id: 'kuhn-paradigms',
    workTitle: 'The Structure of Scientific Revolutions',
    author: 'Thomas Kuhn',
    concept: 'Paradigm Shifts & Incommensurability',
    description:
      'Science proceeds by revolutionary breaks under anomaly pressure, not gradual linear accumulation.',
    hoursSavedEstimated: 2.0,
  },
  {
    id: 'frankl-meaning',
    workTitle: 'Man’s Search for Meaning',
    author: 'Viktor Frankl',
    concept: 'Logotherapy & Tragic Optimism',
    description: 'Finding purpose even in unavoidable suffering through personal responsibility.',
    hoursSavedEstimated: 1.5,
  },
  {
    id: 'munger-latticework',
    workTitle: 'Poor Charlie’s Almanack',
    author: 'Charlie Munger',
    concept: 'Latticework of Mental Models',
    description:
      'Synthesizing principles across disciplines to avoid "man with a hammer" syndrome.',
    hoursSavedEstimated: 3.5,
  },
];

export interface KnowledgeCensusProps {
  onComplete: (calibratedIds: string[]) => void;
  onSkip: () => void;
}

export function KnowledgeCensus({ onComplete, onSkip }: KnowledgeCensusProps) {
  const [levels, setLevels] = useState<Record<string, KnowledgeLevel>>({});

  const stats = useMemo(() => {
    let concepts = 0;
    let hours = 0;
    for (const item of CALIBRATION_ITEMS) {
      const lvl = levels[item.id];
      if (lvl === 'familiar') {
        concepts += 1;
        hours += item.hoursSavedEstimated * 0.5;
      } else if (lvl === 'mastered') {
        concepts += 1;
        hours += item.hoursSavedEstimated;
      }
    }
    return { concepts, hours: Math.round(hours * 10) / 10 };
  }, [levels]);

  const handleLevelChange = (id: string, level: KnowledgeLevel) => {
    setLevels((prev) => ({ ...prev, [id]: level }));
  };

  const handleFinish = () => {
    const calibrated = Object.entries(levels)
      .filter(([, lvl]) => lvl === 'familiar' || lvl === 'mastered')
      .map(([id]) => id);
    onComplete(calibrated);
  };

  return (
    <div className="stack" style={{ gap: 'var(--space-5)' }}>
      <header>
        <p className="meta">Step 1 of 2 · Prior Knowledge Calibration</p>
        <h1 style={{ marginTop: 'var(--space-1)', marginBottom: 'var(--space-2)' }}>
          What have you already mastered?
        </h1>
        <p className="meta">
          Mark concepts you know. The Delta will automatically prune redundant ideas across future
          books, saving you dozens of hours.
        </p>

        <div
          style={{
            border: '1px solid var(--rule)',
            padding: 'var(--space-3) var(--space-4)',
            marginTop: 'var(--space-3)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'baseline',
            flexWrap: 'wrap',
            gap: 'var(--space-2)',
            backgroundColor: 'var(--surface-raised)',
          }}
        >
          <span className="meta" style={{ color: 'var(--accent)' }}>
            {stats.concepts} {stats.concepts === 1 ? 'concept' : 'concepts'} calibrated
          </span>
          <span className="meta">~{stats.hours} hours saved on future reading</span>
        </div>
      </header>

      <div className="stack" style={{ gap: 'var(--space-4)' }}>
        {CALIBRATION_ITEMS.map((item) => {
          const current = levels[item.id] ?? 'unknown';
          return (
            <div
              key={item.id}
              className="stack"
              style={{
                border: '1px solid var(--rule)',
                padding: 'var(--space-4)',
                backgroundColor: 'var(--surface)',
                gap: 'var(--space-2)',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'baseline',
                  flexWrap: 'wrap',
                  gap: 'var(--space-2)',
                }}
              >
                <p className="meta">
                  {item.author} · <em>{item.workTitle}</em>
                </p>
                <span className="meta" style={{ color: 'var(--accent)' }}>
                  +{item.hoursSavedEstimated}h if mastered
                </span>
              </div>

              <h2 style={{ fontSize: 'var(--step-0)', margin: 0, fontWeight: 500 }}>
                {item.concept}
              </h2>
              <p style={{ color: 'var(--text-soft)', margin: 0 }}>{item.description}</p>

              <div
                className="library__filters"
                role="group"
                aria-label={`Knowledge level for ${item.concept}`}
                style={{ marginTop: 'var(--space-2)' }}
              >
                <button
                  type="button"
                  className="btn btn--plain library__filter"
                  aria-pressed={current === 'unknown'}
                  onClick={() => handleLevelChange(item.id, 'unknown')}
                >
                  Unfamiliar
                </button>
                <button
                  type="button"
                  className="btn btn--plain library__filter"
                  aria-pressed={current === 'familiar'}
                  onClick={() => handleLevelChange(item.id, 'familiar')}
                >
                  Familiar (Skim)
                </button>
                <button
                  type="button"
                  className="btn btn--plain library__filter"
                  aria-pressed={current === 'mastered'}
                  onClick={() => handleLevelChange(item.id, 'mastered')}
                >
                  Mastered (Skip)
                </button>
              </div>
            </div>
          );
        })}
      </div>

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
        <button type="button" className="btn btn--plain" onClick={onSkip}>
          Skip calibration
        </button>

        <button type="button" className="btn btn--primary" onClick={handleFinish}>
          Continue to Quick Demo →
        </button>
      </footer>
    </div>
  );
}
