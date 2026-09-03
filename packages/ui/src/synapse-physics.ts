/**
 * Physics and layout arithmetic for the Synapse Knowledge Graph.
 *
 * Designed to be pure, deterministic, and fast: runs without DOM or Canvas
 * so that layout bounds and convergence can be verified in Vitest.
 */

export interface SimulationNode {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  mass: number;
  pinned?: boolean;
}

export interface SimulationEdge {
  sourceId: string;
  targetId: string;
  length: number;
  strength: number;
}

export interface SimulationBounds {
  width: number;
  height: number;
}

export interface SimulationConfig {
  repulsion: number;
  springK: number;
  centerGravity: number;
  damping: number;
  maxVelocity: number;
}

export const DEFAULT_CONFIG: SimulationConfig = {
  repulsion: 800,
  springK: 0.04,
  centerGravity: 0.015,
  damping: 0.86,
  maxVelocity: 8,
};

/**
 * Perform one step of force-directed simulation.
 * Mutates node positions and velocities in place.
 * Returns the kinetic energy (sum of squared velocities) to measure convergence.
 */
export function stepSimulation(
  nodes: SimulationNode[],
  edges: SimulationEdge[],
  bounds: SimulationBounds,
  config: SimulationConfig = DEFAULT_CONFIG,
  alpha: number = 1.0,
): number {
  if (nodes.length === 0) return 0;

  const cx = bounds.width / 2;
  const cy = bounds.height / 2;
  const nodeMap = new Map<string, SimulationNode>();
  for (const n of nodes) {
    nodeMap.set(n.id, n);
  }

  // 1. Repulsion between all node pairs (O(n^2), bounded for N <= 250)
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i]!;
    for (let j = i + 1; j < nodes.length; j++) {
      const b = nodes[j]!;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const distSq = dx * dx + dy * dy;
      const dist = Math.sqrt(distSq) || 0.01;
      const minDist = a.radius + b.radius + 8;

      // Stronger repulsion when nodes overlap or are very close
      const effectiveDist = Math.max(dist, minDist * 0.5);
      const force = (config.repulsion / (effectiveDist * effectiveDist)) * alpha;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;

      if (!a.pinned) {
        a.vx -= fx / a.mass;
        a.vy -= fy / a.mass;
      }
      if (!b.pinned) {
        b.vx += fx / b.mass;
        b.vy += fy / b.mass;
      }
    }
  }

  // 2. Spring attraction along edges
  for (const e of edges) {
    const a = nodeMap.get(e.sourceId);
    const b = nodeMap.get(e.targetId);
    if (!a || !b) continue;

    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
    const displacement = dist - e.length;
    const force = displacement * config.springK * e.strength * alpha;
    const fx = (dx / dist) * force;
    const fy = (dy / dist) * force;

    if (!a.pinned) {
      a.vx += fx / a.mass;
      a.vy += fy / a.mass;
    }
    if (!b.pinned) {
      b.vx -= fx / b.mass;
      b.vy -= fy / b.mass;
    }
  }

  // 3. Center gravity and position integration
  let totalEnergy = 0;
  for (const n of nodes) {
    if (!n.pinned) {
      // Weak gravitational pull toward canvas center
      n.vx += (cx - n.x) * config.centerGravity * alpha;
      n.vy += (cy - n.y) * config.centerGravity * alpha;

      // Velocity clamping
      const speed = Math.sqrt(n.vx * n.vx + n.vy * n.vy);
      if (speed > config.maxVelocity) {
        n.vx = (n.vx / speed) * config.maxVelocity;
        n.vy = (n.vy / speed) * config.maxVelocity;
      }

      // Position update
      n.x += n.vx;
      n.y += n.vy;

      // Friction / damping
      n.vx *= config.damping;
      n.vy *= config.damping;
    }

    totalEnergy += n.vx * n.vx + n.vy * n.vy;
  }

  return totalEnergy;
}

/**
 * Compute the bounding box of simulated nodes.
 */
export function computeGraphBounds(nodes: { x: number; y: number; radius: number }[]): {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  width: number;
  height: number;
  centerX: number;
  centerY: number;
} {
  if (nodes.length === 0) {
    return { minX: 0, maxX: 0, minY: 0, maxY: 0, width: 0, height: 0, centerX: 0, centerY: 0 };
  }

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  for (const n of nodes) {
    if (n.x - n.radius < minX) minX = n.x - n.radius;
    if (n.x + n.radius > maxX) maxX = n.x + n.radius;
    if (n.y - n.radius < minY) minY = n.y - n.radius;
    if (n.y + n.radius > maxY) maxY = n.y + n.radius;
  }

  return {
    minX,
    maxX,
    minY,
    maxY,
    width: maxX - minX,
    height: maxY - minY,
    centerX: (minX + maxX) / 2,
    centerY: (minY + maxY) / 2,
  };
}

/**
 * Initialize node positions on a spiral or ring around center.
 */
export function initializePositions(
  nodeIds: string[],
  cx: number,
  cy: number,
  radiusStep: number = 24,
): Map<string, { x: number; y: number }> {
  const result = new Map<string, { x: number; y: number }>();
  const goldenAngle = Math.PI * (3 - Math.sqrt(5)); // ~2.399 rad

  for (let i = 0; i < nodeIds.length; i++) {
    const r = Math.sqrt(i + 1) * radiusStep;
    const theta = i * goldenAngle;
    result.set(nodeIds[i]!, {
      x: cx + r * Math.cos(theta),
      y: cy + r * Math.sin(theta),
    });
  }

  return result;
}
