import { useEffect, useMemo, useState } from 'react';
import { computeGraphStats, graphAbsence, personalGraph, undirectedEdges } from '../lib/graph.js';
import { PROGRESS_COPY } from '../lib/progress.js';
import { fetchKnowledgeGraph } from '../lib/graph-api.js';
import type { KnowledgeGraphData } from '../lib/types.js';
import {
  CONFIDENTLY_WRONG_COPY,
  formatAttemptDate,
  type ConfidentlyWrongList,
} from '../lib/confidently-wrong.js';
import { fetchConfidentlyWrong } from '../lib/confidently-wrong-api.js';
import {
  BELIEF_COPY,
  BELIEF_COPY_EMPTY,
  changeLine,
  fetchBeliefs,
  fetchCaseAgainst,
  mindsChanged,
  type Belief,
  type RelatedPull,
} from '../lib/convictions-api.js';
import { isOfflineFailure } from '../lib/offline.js';

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
  /*
   * Loading, failed, or loaded -- three states, not a list that starts empty. "No
   * confident lapses" was rendered while the request was in flight and after it had
   * failed, which is a false negative about the reader's own record. The answer is
   * tagged with the session it was fetched for, so a change of reader shows "checking"
   * again rather than the previous reader's list, without a reset inside the effect.
   */
  const [lapses, setLapses] = useState<
    | ({ forUser: string | null } & ConfidentlyWrongList)
    | { forUser: string | null; failed: string; offline: boolean }
    | null
  >(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetchConfidentlyWrong(userId)
      .then((list) => {
        if (live) setLapses({ forUser: userId, ...list });
      })
      .catch((e: unknown) => {
        if (!live) return;
        console.error('Failed to load confidently wrong items:', e);
        setLapses({
          forUser: userId,
          failed: e instanceof Error ? e.message : String(e),
          // The same distinction Paths and Path draw: a request that never left the
          // device is told as "offline", not as a transport error's own words.
          offline: isOfflineFailure(e),
        });
      });

    return () => {
      live = false;
    };
  }, [userId]);

  const confidentlyWrong = lapses && lapses.forUser === userId ? lapses : null;
  const repairs = confidentlyWrong && 'items' in confidentlyWrong ? confidentlyWrong.items : [];
  const repairTotal = confidentlyWrong && 'total' in confidentlyWrong ? confidentlyWrong.total : 0;

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

          {/* Confidently Wrong Misconceptions Breakdown */}
          <section
            style={{
              border: '1px solid var(--rule)',
              padding: 'var(--space-4)',
              backgroundColor: 'var(--surface)',
            }}
            className="stack"
          >
            <div
              style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}
            >
              <h2 style={{ fontSize: 'var(--step-0)', margin: 0 }}>
                {CONFIDENTLY_WRONG_COPY.sectionTitle}
              </h2>
              {repairTotal > 0 && (
                <span className="meta" style={{ color: 'var(--accent)' }}>
                  {repairTotal} to repair
                </span>
              )}
            </div>
            <p className="meta">{CONFIDENTLY_WRONG_COPY.description}</p>

            {confidentlyWrong === null ? (
              <p className="meta" role="status" style={{ margin: 0 }}>
                {CONFIDENTLY_WRONG_COPY.loading}
              </p>
            ) : 'failed' in confidentlyWrong ? (
              <p className="meta" role="alert" style={{ margin: 0 }}>
                {confidentlyWrong.offline
                  ? CONFIDENTLY_WRONG_COPY.offline
                  : `${CONFIDENTLY_WRONG_COPY.failed} ${confidentlyWrong.failed}`}
              </p>
            ) : repairs.length === 0 ? (
              <p className="meta" style={{ color: 'var(--text-faint)', margin: 0 }}>
                {CONFIDENTLY_WRONG_COPY.empty}
              </p>
            ) : (
              <ul
                style={{
                  listStyle: 'none',
                  padding: 0,
                  margin: 0,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 'var(--space-3)',
                }}
              >
                {repairs.map((item) => (
                  <li
                    key={item.id}
                    style={{
                      paddingTop: 'var(--space-2)',
                      borderTop: '1px solid var(--rule)',
                    }}
                  >
                    <button
                      type="button"
                      className="btn btn--plain"
                      style={{
                        textAlign: 'left',
                        padding: 0,
                        display: 'block',
                        width: '100%',
                        fontWeight: 500,
                        lineHeight: 'var(--line-tight)',
                      }}
                      onClick={() => onNavigate(`/pull/${item.pullId}`)}
                    >
                      {item.headline}
                    </button>
                    <p className="meta" style={{ marginTop: 'var(--space-1)', marginBottom: 0 }}>
                      {item.workTitle} · {formatAttemptDate(item.appliedAt)}
                    </p>
                  </li>
                ))}
              </ul>
            )}
            {repairTotal > repairs.length && (
              <p className="meta" style={{ margin: 0 }}>
                {CONFIDENTLY_WRONG_COPY.more(repairTotal - repairs.length)}
              </p>
            )}
          </section>

          <WhatYouBelieve userId={userId} onNavigate={onNavigate} />

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

/**
 * What you believe — the Conviction Ledger, finally readable.
 *
 * `docs/contributing-map.md` has carried this as an open item since the ledger was
 * written: stances are recorded by `Interrupt.tsx` and read back by nothing, so the
 * README's own feature — "you agreed with this in March; here is the strongest case
 * against it" — had data and no screen.
 *
 * Its own component, with its own fetch, for the reason the graph and the lapses
 * have theirs: three independent requests that each render as soon as they land
 * beat one that makes the whole page wait for the slowest.
 */
function WhatYouBelieve({
  userId,
  onNavigate,
}: {
  userId: string | null;
  onNavigate: (path: string) => void;
}) {
  /*
   * Loading, failed, or loaded — the same three states the lapses list draws, and
   * for the same reason: "nothing recorded yet" rendered while the request is in
   * flight is a false statement about the reader's own record. Tagged with the
   * session it was fetched for, so a change of reader shows "checking" again
   * rather than the previous reader's beliefs.
   */
  const [state, setState] = useState<
    | { forUser: string | null; beliefs: Belief[] }
    | { forUser: string | null; failed: boolean; offline: boolean }
    | null
  >(null);

  useEffect(() => {
    let live = true;
    fetchBeliefs(userId)
      .then((beliefs) => {
        if (live) setState({ forUser: userId, beliefs });
      })
      .catch((e: unknown) => {
        if (!live) return;
        console.error('Failed to load convictions:', e);
        setState({ forUser: userId, failed: true, offline: isOfflineFailure(e) });
      });
    return () => {
      live = false;
    };
  }, [userId]);

  const answer = state && state.forUser === userId ? state : null;
  const beliefs = answer && 'beliefs' in answer ? answer.beliefs : [];
  const changed = mindsChanged(beliefs);

  return (
    <section
      style={{
        border: '1px solid var(--rule)',
        padding: 'var(--space-4)',
        backgroundColor: 'var(--surface)',
      }}
      className="stack"
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h2 style={{ fontSize: 'var(--step-0)', margin: 0 }}>What you believe</h2>
        {/*
          Minds changed, not stances recorded. The second is a measure of how much
          somebody has used the app, which `docs/product.md` lists as an anti-goal;
          the first is the only number on this screen that is about thinking.
        */}
        {changed > 0 && (
          <span className="meta" style={{ color: 'var(--accent)' }}>
            {changed} {changed === 1 ? 'mind changed' : 'minds changed'}
          </span>
        )}
      </div>
      <p className="meta">
        Every claim the feed put to you, and what you said. Changing your mind is the point of
        keeping it, so a stance that moved says where it came from.
      </p>

      {answer === null ? (
        <p className="meta" role="status" style={{ margin: 0 }}>
          Checking what you have decided…
        </p>
      ) : 'failed' in answer ? (
        <p className="meta" role="alert" style={{ margin: 0 }}>
          {answer.offline
            ? 'Offline, so your convictions could not be read. They are on the server, not on this device.'
            : 'Could not read your convictions just now.'}
        </p>
      ) : beliefs.length === 0 ? (
        <p className="meta" style={{ color: 'var(--text-faint)', margin: 0 }}>
          {BELIEF_COPY_EMPTY}
        </p>
      ) : (
        <ul
          style={{
            listStyle: 'none',
            padding: 0,
            margin: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-3)',
          }}
        >
          {beliefs.map((belief) => (
            <BeliefRow key={belief.pullId} belief={belief} onNavigate={onNavigate} />
          ))}
        </ul>
      )}
    </section>
  );
}

function BeliefRow({ belief, onNavigate }: { belief: Belief; onNavigate: (path: string) => void }) {
  /*
   * The case against, fetched when the reader asks for it and not before.
   *
   * One `related_pulls` call per belief on mount would be twenty round trips to
   * render a screen — and the case against something is read one at a time, if at
   * all. `null` is untouched, `'asking'` is in flight, and a settled answer is
   * either the opposing idea or the honest absence of one.
   */
  const [against, setAgainst] = useState<'asking' | RelatedPull | 'none' | null>(null);
  const moved = changeLine(belief);

  return (
    <li style={{ paddingTop: 'var(--space-2)', borderTop: '1px solid var(--rule)' }}>
      <button
        type="button"
        className="btn btn--plain"
        style={{
          textAlign: 'left',
          padding: 0,
          display: 'block',
          width: '100%',
          fontWeight: 500,
          lineHeight: 'var(--line-tight)',
        }}
        onClick={() => onNavigate(`/pull/${belief.pullId}`)}
      >
        {belief.headline}
      </button>
      <p className="meta" style={{ marginTop: 'var(--space-1)', marginBottom: 0 }}>
        {BELIEF_COPY[belief.stance].label} · {belief.workTitle}
        {moved ? ` · ${moved}` : ''}
      </p>

      {/*
        Offered where the reader agreed, which is the README's own sentence: "you
        agreed with this in March; here is the strongest case against it." A case
        against something you already reject is an argument you have made.
      */}
      {belief.stance === 'agree' && (
        <p style={{ margin: 'var(--space-2) 0 0' }}>
          {against === null ? (
            <button
              type="button"
              className="btn btn--plain"
              style={{ padding: 0 }}
              onClick={() => {
                setAgainst('asking');
                fetchCaseAgainst(belief.pullId)
                  .then((found) => setAgainst(found ?? 'none'))
                  .catch(() => setAgainst('none'));
              }}
            >
              The case against
            </button>
          ) : against === 'asking' ? (
            <span className="meta" role="status">
              Looking…
            </span>
          ) : against === 'none' ? (
            /*
              Only an authored `opposes` edge counts, so this is a true statement
              about the catalogue rather than a failure. A vector neighbour dressed
              up as an objection is how a Counterpull surface starts lying.
            */
            <span className="meta" style={{ color: 'var(--text-faint)' }}>
              Nobody has written one down yet.
            </span>
          ) : (
            <button
              type="button"
              className="btn btn--plain"
              style={{ padding: 0, textAlign: 'left' }}
              onClick={() => onNavigate(`/pull/${against.id}`)}
            >
              <span className="meta" style={{ color: 'var(--accent)' }}>
                Against ·{' '}
              </span>
              {against.headline}
              <span className="meta"> · {against.workTitle}</span>
            </button>
          )}
        </p>
      )}
    </li>
  );
}
