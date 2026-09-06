import { useEffect, useMemo, useState } from 'react';
import { computeGraphStats, graphAbsence, personalGraph, undirectedEdges } from '../lib/graph.js';
import { PROGRESS_COPY } from '../lib/progress.js';
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

  /*
   * Only the reader's own graph is counted here.
   *
   * `fetchKnowledgeGraph` has two fallbacks that both return a populated graph: the RPC
   * serves the published seed corpus to a reader with no `knowledge_states` yet, and a
   * failed RPC serves `SAMPLE_GRAPH`. Neither is anybody's history. Without this check a
   * reader who had just signed up — or was simply offline — was shown a retention health
   * percentage, a count of concepts retained and a list of ideas due for review, all
   * computed over rows they had never seen. A dashboard that reports the corpus back as
   * personal progress is worse than no dashboard, and this one is named for measurement.
   */
  const measured = personalGraph(graphData);
  const absence = graphAbsence(graphData);

  const stats = useMemo(() => {
    if (!measured) return null;
    return computeGraphStats(measured.nodes, measured.edges);
  }, [measured]);

  return (
    <div className="stack" style={{ gap: 'var(--space-5)', maxWidth: '42rem' }}>
      <header>
        <p className="meta">Your reading</p>
        <h1 style={{ marginTop: 'var(--space-1)', marginBottom: 'var(--space-2)' }}>
          What you are holding on to
        </h1>
        {/*
          NO `measure` CLASS, and the version of this comment that argued for one was
          wrong in both of its facts.

          It said the container is 42rem. `App.tsx` renders this screen inside
          `<div className="shell__column">`, which `components.css` pins at
          `max-width: var(--measure)` — so the rendered width is
          `min(--measure, 42rem)`, and adding `.measure` sets `max-width: var(--measure)`
          a second time, which cannot narrow a box already bounded by it. No viewport and
          no appearance setting changes by a pixel. That conclusion is measured and holds.

          WHAT IS NOT TRUE IS THAT THE 42rem IS DEAD. An earlier draft of this paragraph
          said so, reasoning that `--measure` is always the smaller of the two. It is 34rem
          with focus off, so it is smaller then — but `tokens.css` defines it again under
          `:root[data-focus='on']` as `calc(var(--step-0) * 32)`, and `--step-0` is
          `clamp(1.0625rem, 0.95rem + 0.6vw, 1.625rem)`, so the measure reaches 52rem and
          crosses 42rem at a viewport of about 967px. Focus mode is a reader toggle
          persisted on `documentElement`, so at the three desktop widths `docs/design.md`
          says to test — 1128, 1504 and 1920 — the column is 832px and this container is
          the operative 672px, left-aligned inside it because `.stack` has no
          `margin-inline: auto`. The 42rem binds, on a screen a reader can reach in two
          clicks. It is left alone here because removing it changes the layout, which
          belongs to a change that owns the layout rather than the copy — but it is left
          alone as a live value, not as a dead one.

          It also said `--measure` follows large text. `tokens.css` defines it twice —
          `:root` at 34rem and `:root[data-focus='on']` from `--step-0`.
          `[data-text='large']` sets the type steps and not the measure, so with focus
          off, which is the default, the column is a flat 34rem while `--step--1` rises
          from 0.78rem to 1rem. The line gets SHORTER in characters, not longer.

          One thing this paragraph really is wearing wrongly, and it predates this
          change: `.meta` is mono, uppercase and `--step--1`, so four sentences of
          provenance render as small capitals. It is the disclosure that makes every
          number above it honest, and it is the least readable text on the screen. That
          is a type-ramp decision for a change that owns the screen's design, and it is
          recorded here rather than fixed in a copy PR.
        */}
        <p className="meta">{PROGRESS_COPY.provenance}</p>
      </header>

      {error ? (
        <p className="meta" role="alert" style={{ color: 'var(--accent)' }}>
          {error}
        </p>
      ) : !graphData ? (
        <p className="meta" role="status">
          Calculating retention metrics…
        </p>
      ) : absence === 'unreachable' ? (
        /* Not the same sentence as "nothing yet", and that distinction is the point of
           `source`. Telling a reader with two years of history that they have read nothing,
           because their train went into a tunnel, is worse than telling them nothing. */
        <p className="meta" role="status">
          Could not reach your reading history just now. These numbers come from it, so there is
          nothing to show until the connection is back.
        </p>
      ) : !stats ? (
        <p className="meta" role="status">
          Nothing measured yet. These numbers come from your own reading — read and recall a few
          ideas and this fills in. Until then there is nothing here that would be true.
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
            {/*
              There was a "Time Spared (The Delta)" tile here, reading `totalNodes * 0.45`
              hours. It is gone rather than corrected because there is no number to correct
              it to. `totalNodes` counts `knowledge_states` rows, which `record_read`
              creates whenever a card is read — so the figure rose by 0.45h every time the
              reader read anything, including an idea the Delta had just told them they
              already knew, and it was labelled with the name of the one mechanism in this
              product that does compute what a reader was spared. Attaching "The Delta" to a
              typed-in constant costs more than the tile was worth. It comes back when the
              Delta reports minutes.
            */}
            <div
              style={{
                border: '1px solid var(--rule)',
                padding: 'var(--space-4)',
                backgroundColor: 'var(--surface-raised)',
              }}
            >
              <p className="meta">Still holding</p>
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
              <p className="meta">Connections</p>
              <div
                style={{
                  fontSize: 'var(--step-4)',
                  fontFamily: 'var(--font-mono)',
                  margin: 'var(--space-2) 0',
                }}
              >
                {measured ? undirectedEdges(measured.edges).length : 0}
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
            <h2 style={{ fontSize: 'var(--step-0)', margin: 0 }}>How well each idea is holding</h2>
            <p className="meta">
              An idea you do not revisit fades on a curve. Recalling one resets its clock, and each
              success buys a longer interval than the last.
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
              Open the graph
            </button>

            {onGoToReview && stats.fadingCount > 0 && (
              /* No number on this button. `fadingCount` is retrievability < 0.6 across up
                 to 150 graph nodes; Review's queue is `get_due_reviews`, which selects on
                 `next_due_at <= now()` and caps at 20. Different predicate, different cap,
                 so "Review 34 Fading Ideas" led to a screen showing 20 — or to "everything
                 you have saved is still solid", on the very next click. */
              <button type="button" className="btn btn--plain" onClick={onGoToReview}>
                Go to review
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
