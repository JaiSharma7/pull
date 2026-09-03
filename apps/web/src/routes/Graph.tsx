import { useEffect, useMemo, useState } from 'react';
import { PullCard, SynapseMap, type SynapseNode } from '@wap/ui';
import { computeGraphStats, formatRetrievabilityLabel } from '../lib/graph.js';
import { fetchKnowledgeGraph } from '../lib/graph-api.js';
import type { KnowledgeGraphData } from '../lib/types.js';

export function Graph({
  userId,
  onOpenSource,
}: {
  userId: string | null;
  onOpenSource?: (workId: string) => void;
}) {
  const [data, setData] = useState<KnowledgeGraphData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<SynapseNode | null>(null);
  const [filter, setFilter] = useState<'all' | 'solid' | 'fading'>('all');
  const [depth, setDepth] = useState(1);

  const loading = data === null && error === null;

  useEffect(() => {
    let cancelled = false;

    fetchKnowledgeGraph(userId)
      .then((res) => {
        if (cancelled) return;
        setData(res);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        console.error('Failed to load knowledge graph', e);
        setError(e instanceof Error ? e.message : 'Could not load knowledge graph');
      });

    return () => {
      cancelled = true;
    };
  }, [userId]);

  const stats = useMemo(() => {
    if (!data) return null;
    return computeGraphStats(data.nodes, data.edges);
  }, [data]);

  return (
    <div className="stack" style={{ gap: 'var(--space-4)' }}>
      <header>
        <p className="meta">Synapse Knowledge Graph</p>
        <h1 style={{ marginTop: 'var(--space-1)', marginBottom: 'var(--space-2)' }}>
          Your Mental Landscape
        </h1>
        {stats && (
          <p className="meta">
            {stats.totalNodes} {stats.totalNodes === 1 ? 'idea' : 'ideas'} connected ·{' '}
            <span style={{ color: 'var(--accent)' }}>
              {stats.solidCount} solid ({stats.retentionHealth}% retention)
            </span>{' '}
            · {stats.fadingCount} fading · {stats.opposesCount}{' '}
            {stats.opposesCount === 1 ? 'debate' : 'debates'}
          </p>
        )}
      </header>

      {error ? (
        <section className="stack measure" role="alert">
          <p className="meta">Knowledge Graph</p>
          <h2>Could not load your mental map.</h2>
          <p className="meta">{error}</p>
        </section>
      ) : loading ? (
        <p className="meta" role="status">
          Mapping your knowledge network…
        </p>
      ) : data ? (
        <section className="stack" style={{ gap: 'var(--space-4)' }}>
          <SynapseMap
            nodes={data.nodes}
            edges={data.edges}
            selectedNodeId={selectedNode?.pullId}
            onSelectNode={setSelectedNode}
            filter={filter}
            onFilterChange={setFilter}
            height="580px"
          />

          {selectedNode && (
            <div
              className="stack"
              style={{
                border: '1px solid var(--accent)',
                padding: 'var(--space-4)',
                backgroundColor: 'var(--surface-raised)',
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
                <p className="meta" style={{ color: 'var(--accent)' }}>
                  Selected Node · {formatRetrievabilityLabel(selectedNode.retrievability)} ·
                  Stability {selectedNode.stability}d
                </p>
                <button
                  type="button"
                  className="btn btn--plain"
                  onClick={() => setSelectedNode(null)}
                >
                  Deselect
                </button>
              </div>

              <PullCard
                headline={selectedNode.headline}
                body={selectedNode.body}
                depth={depth}
                onDepthChange={setDepth}
                source={{
                  title: selectedNode.workTitle,
                  kind: selectedNode.workKind,
                }}
                sourceTrail={selectedNode.workTitle}
                onOpenSource={
                  onOpenSource && selectedNode.workId
                    ? () => onOpenSource(selectedNode.workId)
                    : undefined
                }
              />
            </div>
          )}
        </section>
      ) : null}
    </div>
  );
}
