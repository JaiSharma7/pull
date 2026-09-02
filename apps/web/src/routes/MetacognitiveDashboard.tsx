import { useEffect, useMemo, useState } from 'react';
import { computeGraphStats } from '../lib/graph.js';
import { fetchKnowledgeGraph } from '../lib/graph-api.js';
import type { KnowledgeGraphData } from '../lib/types.js';

export interface MetacognitiveDashboardProps {
  userId: string | null;
  onNavigate: (path: string) => void;
  onGoToReview?: () => void;
}

export function MetacognitiveDashboard({
  userId,
  onNavigate,
  onGoToReview,
}: MetacognitiveDashboardProps) {
  const [graphData, setGraphData] = useState<KnowledgeGraphData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetchKnowledgeGraph(userId)
      .then((data) => {
        if (live) setGraphData(data);
      })
      .catch((e: unknown) => {
        if (live) setError(e instanceof Error ? e.message : 'Failed to load stats');
      });

    return () => {
      live = false;
    };
  }, [userId]);

  const stats = useMemo(() => {
    if (!graphData) return null;
    return computeGraphStats(graphData.nodes, graphData.edges);
  }, [graphData]);

  // Derived estimates for metacognitive time saved:
  // Each retained node spares an estimated 20-30 mins of re-reading or research
  const hoursSpared = useMemo(() => {
    if (!stats) return 0;
    return Math.round(stats.totalNodes * 0.45 * 10) / 10;
  }, [stats]);

  return (
    <div className="stack" style={{ gap: 'var(--space-5)', maxWidth: '42rem' }}>
      <header>
        <p className="meta">Learning Efficiency Analytics</p>
        <h1 style={{ marginTop: 'var(--space-1)', marginBottom: 'var(--space-2)' }}>
          Metacognitive ROI
        </h1>
        <p className="meta">
          Every minute invested in What a Pull is measured in time spared, enduring recall, and
          interleaved understanding.
        </p>
      </header>

      {error ? (
        <p className="meta" role="alert" style={{ color: 'var(--accent)' }}>
          {error}
        </p>
      ) : !stats ? (
        <p className="meta" role="status">
          Calculating retention metrics…
        </p>
      ) : (
        <div className="stack" style={{ gap: 'var(--space-5)' }}>
          {/* Key Metrics Grid */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
              gap: 'var(--space-4)',
            }}
          >
            <div
              style={{
                border: '1px solid var(--rule)',
                padding: 'var(--space-4)',
                backgroundColor: 'var(--surface-raised)',
              }}
            >
              <p className="meta">Time Spared (The Delta)</p>
              <div
                style={{
                  fontSize: 'var(--step-4)',
                  fontFamily: 'var(--font-mono)',
                  color: 'var(--accent)',
                  margin: 'var(--space-2) 0',
                }}
              >
                {hoursSpared}h
              </div>
              <p className="meta">reading time saved vs whole books</p>
            </div>

            <div
              style={{
                border: '1px solid var(--rule)',
                padding: 'var(--space-4)',
                backgroundColor: 'var(--surface-raised)',
              }}
            >
              <p className="meta">Retention Health</p>
              <div
                style={{
                  fontSize: 'var(--step-4)',
                  fontFamily: 'var(--font-mono)',
                  color: stats.retentionHealth >= 70 ? 'var(--accent)' : 'inherit',
                  margin: 'var(--space-2) 0',
                }}
              >
                {stats.retentionHealth}%
              </div>
              <p className="meta">
                {stats.solidCount} solid · {stats.fadingCount} fading
              </p>
            </div>

            <div
              style={{
                border: '1px solid var(--rule)',
                padding: 'var(--space-4)',
                backgroundColor: 'var(--surface-raised)',
              }}
            >
              <p className="meta">Lattice Connections</p>
              <div
                style={{
                  fontSize: 'var(--step-4)',
                  fontFamily: 'var(--font-mono)',
                  margin: 'var(--space-2) 0',
                }}
              >
                {graphData?.edges.length ?? 0}
              </div>
              <p className="meta">{stats.opposesCount} dialectical tensions</p>
            </div>
          </div>

          {/* Half-Life Decay Status Breakdown */}
          <section
            style={{
              border: '1px solid var(--rule)',
              padding: 'var(--space-4)',
              backgroundColor: 'var(--surface)',
            }}
            className="stack"
          >
            <h2 style={{ fontSize: 'var(--step-0)', margin: 0 }}>FSRS Retrievability Spectrum</h2>
            <p className="meta">
              Ideas decay exponentially along Ebbinghaus forgetting curves. Active recall resets
              stability with increasing half-life intervals.
            </p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span className="meta" style={{ color: 'var(--accent)' }}>
                    Solid (R ≥ 80%)
                  </span>
                  <span className="meta">{stats.solidCount} concepts</span>
                </div>
                <div
                  style={{
                    height: '6px',
                    width: '100%',
                    backgroundColor: 'var(--rule)',
                    marginTop: 'var(--space-1)',
                  }}
                >
                  <div
                    style={{
                      height: '100%',
                      width: `${stats.totalNodes ? (stats.solidCount / stats.totalNodes) * 100 : 0}%`,
                      backgroundColor: 'var(--accent)',
                    }}
                  />
                </div>
              </div>

              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span className="meta">Refreshing (60% ≤ R &lt; 80%)</span>
                  <span className="meta">{stats.refreshingCount} concepts</span>
                </div>
                <div
                  style={{
                    height: '6px',
                    width: '100%',
                    backgroundColor: 'var(--rule)',
                    marginTop: 'var(--space-1)',
                  }}
                >
                  <div
                    style={{
                      height: '100%',
                      width: `${stats.totalNodes ? (stats.refreshingCount / stats.totalNodes) * 100 : 0}%`,
                      backgroundColor: 'var(--text)',
                    }}
                  />
                </div>
              </div>

              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span className="meta" style={{ color: 'var(--accent)' }}>
                    Fading / Due Review (R &lt; 60%)
                  </span>
                  <span className="meta">{stats.fadingCount} concepts</span>
                </div>
                <div
                  style={{
                    height: '6px',
                    width: '100%',
                    backgroundColor: 'var(--rule)',
                    marginTop: 'var(--space-1)',
                  }}
                >
                  <div
                    style={{
                      height: '100%',
                      width: `${stats.totalNodes ? (stats.fadingCount / stats.totalNodes) * 100 : 0}%`,
                      backgroundColor: 'var(--accent)',
                    }}
                  />
                </div>
              </div>
            </div>
          </section>

          {/* Quick Actions */}
          <div
            style={{
              display: 'flex',
              gap: 'var(--space-3)',
              flexWrap: 'wrap',
              borderTop: '1px solid var(--rule)',
              paddingTop: 'var(--space-4)',
            }}
          >
            <button type="button" className="btn btn--primary" onClick={() => onNavigate('/graph')}>
              Open Synapse Graph →
            </button>

            {onGoToReview && stats.fadingCount > 0 && (
              <button type="button" className="btn btn--plain" onClick={onGoToReview}>
                Review {stats.fadingCount} Fading Ideas
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
