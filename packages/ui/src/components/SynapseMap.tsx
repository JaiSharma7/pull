import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_CONFIG,
  initializePositions,
  stepSimulation,
  type SimulationEdge,
  type SimulationNode,
} from '../synapse-physics.js';

export interface SynapseNode {
  pullId: string;
  workId: string;
  workTitle: string;
  workKind: string;
  headline: string;
  body: string;
  retrievability: number;
  stability: number;
  difficulty?: number;
  status: 'solid' | 'refreshing' | 'fading';
}

export interface SynapseEdge {
  fromPullId: string;
  toPullId: string;
  kind: 'ancestor' | 'descendant' | 'opposes' | 'elaborates' | 'related';
  weight: number;
  rationale?: string | null;
}

export interface SynapseMapProps {
  nodes: SynapseNode[];
  edges: SynapseEdge[];
  selectedNodeId?: string | null;
  onSelectNode?: (node: SynapseNode | null) => void;
  height?: number | string;
  filter?: 'all' | 'solid' | 'fading';
  onFilterChange?: (filter: 'all' | 'solid' | 'fading') => void;
  className?: string;
}

interface ResolvedTokens {
  accent: string;
  accentHover: string;
  text: string;
  textMuted: string;
  surface: string;
  surfaceRaised: string;
  rule: string;
  ruleStrong: string;
}

function resolveTokens(element: HTMLElement | null): ResolvedTokens {
  if (!element || typeof window === 'undefined') {
    return {
      accent: 'currentColor',
      accentHover: 'currentColor',
      text: 'currentColor',
      textMuted: 'currentColor',
      surface: 'transparent',
      surfaceRaised: 'transparent',
      rule: 'currentColor',
      ruleStrong: 'currentColor',
    };
  }

  const style = window.getComputedStyle(element);
  return {
    accent: style.getPropertyValue('--accent').trim() || 'currentColor',
    accentHover: style.getPropertyValue('--accent-hover').trim() || 'currentColor',
    text: style.getPropertyValue('--text').trim() || 'currentColor',
    textMuted: style.getPropertyValue('--text-muted').trim() || 'currentColor',
    surface: style.getPropertyValue('--surface').trim() || 'transparent',
    surfaceRaised: style.getPropertyValue('--surface-raised').trim() || 'transparent',
    rule: style.getPropertyValue('--rule').trim() || 'currentColor',
    ruleStrong: style.getPropertyValue('--rule-strong').trim() || 'currentColor',
  };
}

export function SynapseMap({
  nodes,
  edges,
  selectedNodeId = null,
  onSelectNode,
  height = '540px',
  filter = 'all',
  onFilterChange,
  className = '',
}: SynapseMapProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Viewport transformation: pan and zoom
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);

  // Dragging state refs (kept in refs to avoid re-triggering simulation loops)
  const isPanningRef = useRef(false);
  const draggedNodeIdRef = useRef<string | null>(null);
  const lastMousePosRef = useRef({ x: 0, y: 0 });
  const didMoveRef = useRef(false);

  // Filtered nodes and active node set
  const filteredNodes = useMemo(() => {
    if (filter === 'solid') return nodes.filter((n) => n.retrievability >= 0.8);
    if (filter === 'fading') return nodes.filter((n) => n.retrievability < 0.6);
    return nodes;
  }, [nodes, filter]);

  const activePullIds = useMemo(() => new Set(filteredNodes.map((n) => n.pullId)), [filteredNodes]);

  const filteredEdges = useMemo(
    () => edges.filter((e) => activePullIds.has(e.fromPullId) && activePullIds.has(e.toPullId)),
    [edges, activePullIds],
  );

  // Direct neighbors of selected node (for highlight focus)
  const neighborSet = useMemo(() => {
    if (!selectedNodeId) return null;
    // A selection the current filter has removed is not a focus. Without this the set
    // is non-null and holds only the absent id, so nothing matches it and every node
    // still on screen is drawn dimmed — select a fading node, switch to Solid, and the
    // whole graph greys out around a node that is no longer in it.
    if (!activePullIds.has(selectedNodeId)) return null;
    const s = new Set<string>();
    s.add(selectedNodeId);
    for (const e of filteredEdges) {
      if (e.fromPullId === selectedNodeId) s.add(e.toPullId);
      if (e.toPullId === selectedNodeId) s.add(e.fromPullId);
    }
    return s;
  }, [selectedNodeId, filteredEdges, activePullIds]);

  // Simulation state maintained across renders
  const simNodesRef = useRef<SimulationNode[]>([]);
  const simEdgesRef = useRef<SimulationEdge[]>([]);
  const alphaRef = useRef(1.0);
  const [dragTick, setDragTick] = useState(0);

  // Initialize simulation nodes when filteredNodes change
  useEffect(() => {
    const canvas = canvasRef.current;
    const width = canvas ? canvas.clientWidth : 800;
    const heightPx = canvas ? canvas.clientHeight : 540;
    const cx = width / 2;
    const cy = heightPx / 2;

    const existingMap = new Map<string, SimulationNode>();
    for (const n of simNodesRef.current) {
      existingMap.set(n.id, n);
    }

    const nodeIds = filteredNodes.map((n) => n.pullId);
    const initialPositions = initializePositions(nodeIds, cx, cy, 32);

    simNodesRef.current = filteredNodes.map((n) => {
      const prev = existingMap.get(n.pullId);
      const initPos = initialPositions.get(n.pullId) ?? { x: cx, y: cy };
      const baseRadius = 7 + Math.round(n.retrievability * 7);
      return {
        id: n.pullId,
        x: prev ? prev.x : initPos.x,
        y: prev ? prev.y : initPos.y,
        vx: prev ? prev.vx : 0,
        vy: prev ? prev.vy : 0,
        radius: baseRadius,
        mass: 1 + n.retrievability,
      };
    });

    simEdgesRef.current = filteredEdges.map((e) => ({
      sourceId: e.fromPullId,
      targetId: e.toPullId,
      length: 70 + (1 - e.weight) * 50,
      strength: e.weight || 0.6,
    }));

    alphaRef.current = 1.0;
  }, [filteredNodes, filteredEdges]);

  // Render loop
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const heightPx = canvas.clientHeight;
    const tokens = resolveTokens(canvas);

    // Ensure backing store size matches client size * dpr
    if (canvas.width !== width * dpr || canvas.height !== heightPx * dpr) {
      canvas.width = width * dpr;
      canvas.height = heightPx * dpr;
    }

    ctx.save();
    ctx.scale(dpr, dpr);

    // 1. Clear ground (The Archive paper ground)
    ctx.fillStyle = tokens.surface;
    ctx.fillRect(0, 0, width, heightPx);

    // 2. Physics step if alpha is active
    if (alphaRef.current > 0.005) {
      stepSimulation(
        simNodesRef.current,
        simEdgesRef.current,
        { width, height: heightPx },
        DEFAULT_CONFIG,
        alphaRef.current,
      );
      alphaRef.current *= 0.985;
    }

    // 3. Apply Viewport Pan & Zoom
    ctx.translate(pan.x + width / 2, pan.y + heightPx / 2);
    ctx.scale(zoom, zoom);
    ctx.translate(-width / 2, -heightPx / 2);

    const simMap = new Map<string, SimulationNode>();
    for (const n of simNodesRef.current) {
      simMap.set(n.id, n);
    }

    // 4. Draw Edges
    for (const edge of filteredEdges) {
      const source = simMap.get(edge.fromPullId);
      const target = simMap.get(edge.toPullId);
      if (!source || !target) continue;

      const isConnectedToSelected =
        neighborSet === null ||
        (neighborSet.has(edge.fromPullId) && neighborSet.has(edge.toPullId));

      ctx.save();
      ctx.beginPath();
      ctx.moveTo(source.x, source.y);
      ctx.lineTo(target.x, target.y);

      if (edge.kind === 'opposes') {
        // Tension edge (opposes/contradiction): dashed oxblood line
        ctx.strokeStyle = tokens.accent;
        ctx.globalAlpha = isConnectedToSelected ? 0.75 : 0.15;
        ctx.lineWidth = isConnectedToSelected ? 1.5 : 1;
        ctx.setLineDash([4, 4]);
      } else if (edge.kind === 'ancestor' || edge.kind === 'descendant') {
        // Lineage edge: directed ink line
        ctx.strokeStyle = tokens.text;
        ctx.globalAlpha = isConnectedToSelected ? 0.45 : 0.1;
        ctx.lineWidth = isConnectedToSelected ? 1.25 : 0.75;
        ctx.setLineDash([]);
      } else {
        // General relation edge
        ctx.strokeStyle = tokens.ruleStrong;
        ctx.globalAlpha = isConnectedToSelected ? 0.4 : 0.1;
        ctx.lineWidth = isConnectedToSelected ? 1 : 0.5;
        ctx.setLineDash([]);
      }

      ctx.stroke();
      ctx.restore();
    }

    // 5. Draw Nodes
    const nodeMap = new Map<string, SynapseNode>();
    for (const n of filteredNodes) {
      nodeMap.set(n.pullId, n);
    }

    for (const simNode of simNodesRef.current) {
      const data = nodeMap.get(simNode.id);
      if (!data) continue;

      const isSelected = selectedNodeId === simNode.id;
      const isHovered = hoveredNodeId === simNode.id;
      const isDimmed = neighborSet !== null && !neighborSet.has(simNode.id);
      const r = simNode.radius;

      ctx.save();
      ctx.globalAlpha = isDimmed ? 0.22 : 1.0;

      // Selection halo / ring
      if (isSelected) {
        ctx.beginPath();
        ctx.arc(simNode.x, simNode.y, r + 5, 0, Math.PI * 2);
        ctx.strokeStyle = tokens.accent;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }

      // Main node circle
      ctx.beginPath();
      ctx.arc(simNode.x, simNode.y, r, 0, Math.PI * 2);

      if (data.retrievability >= 0.8) {
        // Solid: Solid oxblood with subtle inner depth
        ctx.fillStyle = isHovered ? tokens.accentHover : tokens.accent;
        ctx.fill();
        ctx.strokeStyle = tokens.text;
        ctx.lineWidth = 1.25;
        ctx.stroke();

        // Inner dot
        ctx.beginPath();
        ctx.arc(simNode.x, simNode.y, 2, 0, Math.PI * 2);
        ctx.fillStyle = tokens.surface;
        ctx.fill();
      } else if (data.retrievability >= 0.6) {
        // Refreshing: Ink border with surface fill
        ctx.fillStyle = tokens.surfaceRaised;
        ctx.fill();
        ctx.strokeStyle = tokens.text;
        ctx.lineWidth = 1.5;
        ctx.stroke();

        // Core dot
        ctx.beginPath();
        ctx.arc(simNode.x, simNode.y, 3, 0, Math.PI * 2);
        ctx.fillStyle = isHovered ? tokens.accent : tokens.text;
        ctx.fill();
      } else {
        // Fading: Dashed perimeter
        ctx.fillStyle = tokens.surfaceRaised;
        ctx.fill();
        ctx.strokeStyle = tokens.accent;
        ctx.lineWidth = 1.25;
        ctx.setLineDash([3, 3]);
        ctx.stroke();
        ctx.setLineDash([]);

        // Small fading dot
        ctx.beginPath();
        ctx.arc(simNode.x, simNode.y, 2, 0, Math.PI * 2);
        ctx.fillStyle = tokens.textMuted;
        ctx.fill();
      }

      // Label (rendered for selected, hovered, or prominent nodes)
      if (isSelected || isHovered || zoom >= 1.25) {
        ctx.font = '500 11px Fraunces, serif';
        ctx.fillStyle = isSelected ? tokens.accent : tokens.text;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';

        // Clip headline if long
        const text = data.headline.length > 36 ? data.headline.slice(0, 34) + '…' : data.headline;
        ctx.fillText(text, simNode.x, simNode.y + r + 6);
      }

      ctx.restore();
    }

    ctx.restore();
  }, [filteredNodes, filteredEdges, neighborSet, selectedNodeId, hoveredNodeId, pan, zoom]);

  // Animation frame loop
  useEffect(() => {
    let frameId: number;
    const loop = () => {
      draw();
      if (alphaRef.current > 0.005) {
        frameId = requestAnimationFrame(loop);
      }
    };
    frameId = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(frameId);
    };
  }, [draw, dragTick]);

  // Coordinate conversion helpers
  const toWorldCoords = useCallback(
    (clientX: number, clientY: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return { x: 0, y: 0 };
      const rect = canvas.getBoundingClientRect();
      const screenX = clientX - rect.left;
      const screenY = clientY - rect.top;
      const width = canvas.clientWidth;
      const heightPx = canvas.clientHeight;

      const worldX = (screenX - (pan.x + width / 2)) / zoom + width / 2;
      const worldY = (screenY - (pan.y + heightPx / 2)) / zoom + heightPx / 2;
      return { x: worldX, y: worldY };
    },
    [pan, zoom],
  );

  const findNodeAt = useCallback(
    (clientX: number, clientY: number) => {
      const { x, y } = toWorldCoords(clientX, clientY);
      for (let i = simNodesRef.current.length - 1; i >= 0; i--) {
        const node = simNodesRef.current[i]!;
        const dx = node.x - x;
        const dy = node.y - y;
        const hitRadius = node.radius + 6;
        if (dx * dx + dy * dy <= hitRadius * hitRadius) {
          return node;
        }
      }
      return null;
    },
    [toWorldCoords],
  );

  // Mouse & Touch events
  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    lastMousePosRef.current = { x: e.clientX, y: e.clientY };
    didMoveRef.current = false;

    const hit = findNodeAt(e.clientX, e.clientY);
    if (hit) {
      draggedNodeIdRef.current = hit.id;
      hit.pinned = true;
    } else {
      isPanningRef.current = true;
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const dx = e.clientX - lastMousePosRef.current.x;
    const dy = e.clientY - lastMousePosRef.current.y;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
      didMoveRef.current = true;
    }

    if (draggedNodeIdRef.current) {
      const world = toWorldCoords(e.clientX, e.clientY);
      const node = simNodesRef.current.find((n) => n.id === draggedNodeIdRef.current);
      if (node) {
        node.x = world.x;
        node.y = world.y;
        alphaRef.current = Math.max(alphaRef.current, 0.2);
        setDragTick((t) => (t + 1) % 1000);
      }
    } else if (isPanningRef.current) {
      setPan((p) => ({ x: p.x + dx, y: p.y + dy }));
    } else {
      // Hover detection
      const hit = findNodeAt(e.clientX, e.clientY);
      setHoveredNodeId(hit ? hit.id : null);
    }

    lastMousePosRef.current = { x: e.clientX, y: e.clientY };
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (draggedNodeIdRef.current) {
      const node = simNodesRef.current.find((n) => n.id === draggedNodeIdRef.current);
      if (node) node.pinned = false;
      draggedNodeIdRef.current = null;
    }

    isPanningRef.current = false;

    // Click selection if not dragged
    if (!didMoveRef.current) {
      const hit = findNodeAt(e.clientX, e.clientY);
      if (hit) {
        const fullNode = filteredNodes.find((n) => n.pullId === hit.id) ?? null;
        onSelectNode?.(fullNode);
      } else {
        onSelectNode?.(null);
      }
    }
  };

  // Wheel zoom
  const handleWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const zoomFactor = e.deltaY < 0 ? 1.12 : 0.89;
    setZoom((z) => Math.min(3.0, Math.max(0.4, z * zoomFactor)));
    alphaRef.current = Math.max(alphaRef.current, 0.05);
  };

  // Zoom control buttons
  const zoomIn = () => setZoom((z) => Math.min(3.0, z * 1.25));
  const zoomOut = () => setZoom((z) => Math.max(0.4, z * 0.8));
  const resetView = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
    alphaRef.current = 0.5;
  };

  const solidCount = useMemo(() => nodes.filter((n) => n.retrievability >= 0.8).length, [nodes]);
  const fadingCount = useMemo(() => nodes.filter((n) => n.retrievability < 0.6).length, [nodes]);

  return (
    <div
      ref={containerRef}
      className={`synapse-container ${className}`}
      style={{ height }}
      aria-label="Knowledge Synapse Graph"
    >
      {/* Filter Tabs */}
      <div className="synapse-filter-bar" role="toolbar" aria-label="Filter graph nodes">
        <button
          type="button"
          className={`synapse-filter-tab ${filter === 'all' ? 'is-active' : ''}`}
          aria-pressed={filter === 'all'}
          onClick={() => onFilterChange?.('all')}
        >
          All ({nodes.length})
        </button>
        <button
          type="button"
          className={`synapse-filter-tab ${filter === 'solid' ? 'is-active' : ''}`}
          aria-pressed={filter === 'solid'}
          onClick={() => onFilterChange?.('solid')}
        >
          Solid ({solidCount})
        </button>
        <button
          type="button"
          className={`synapse-filter-tab ${filter === 'fading' ? 'is-active' : ''}`}
          aria-pressed={filter === 'fading'}
          onClick={() => onFilterChange?.('fading')}
        >
          Fading ({fadingCount})
        </button>
      </div>

      {/* Zoom Controls */}
      <div className="synapse-controls" role="toolbar" aria-label="Zoom controls">
        <button type="button" className="synapse-btn" aria-label="Zoom in" onClick={zoomIn}>
          +
        </button>
        <button type="button" className="synapse-btn" aria-label="Zoom out" onClick={zoomOut}>
          −
        </button>
        <button type="button" className="synapse-btn" aria-label="Reset view" onClick={resetView}>
          ⊙
        </button>
      </div>

      {/* Main Interactive Canvas */}
      <canvas
        ref={canvasRef}
        className="synapse-canvas"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onWheel={handleWheel}
      />

      {/* Legend */}
      <div className="synapse-legend" aria-hidden="true">
        <span className="synapse-legend-item">
          <span className="synapse-legend-dot synapse-legend-dot--solid" /> Solid (≥80%)
        </span>
        <span className="synapse-legend-item">
          <span className="synapse-legend-dot synapse-legend-dot--fading" /> Fading (&lt;60%)
        </span>
        <span className="synapse-legend-item">
          <span className="synapse-legend-line--opposes" /> Opposes (Debate)
        </span>
      </div>

      {/* Empty State */}
      {filteredNodes.length === 0 && (
        <div className="synapse-empty">
          <p className="meta">Knowledge Graph</p>
          <p>No concepts matching this filter.</p>
        </div>
      )}
    </div>
  );
}
