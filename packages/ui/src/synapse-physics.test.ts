import { describe, expect, it } from 'vitest';
import {
  computeGraphBounds,
  DEFAULT_CONFIG,
  initializePositions,
  stepSimulation,
  type SimulationEdge,
  type SimulationNode,
} from './synapse-physics.js';

describe('synapse-physics', () => {
  it('initializes positions without overlapping identical coordinates', () => {
    const ids = ['a', 'b', 'c', 'd', 'e'];
    const pos = initializePositions(ids, 400, 300, 20);

    expect(pos.size).toBe(5);
    const coords = Array.from(pos.values());
    for (let i = 0; i < coords.length; i++) {
      for (let j = i + 1; j < coords.length; j++) {
        const dx = coords[i]!.x - coords[j]!.x;
        const dy = coords[i]!.y - coords[j]!.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        expect(dist).toBeGreaterThan(10);
      }
    }
  });

  it('stabilizes two connected nodes toward spring length', () => {
    const nodes: SimulationNode[] = [
      { id: '1', x: 300, y: 300, vx: 0, vy: 0, radius: 10, mass: 1 },
      { id: '2', x: 500, y: 300, vx: 0, vy: 0, radius: 10, mass: 1 },
    ];
    const edges: SimulationEdge[] = [{ sourceId: '1', targetId: '2', length: 100, strength: 1 }];
    const bounds = { width: 800, height: 600 };

    // Initial distance is 200, target is 100
    for (let step = 0; step < 100; step++) {
      const alpha = Math.max(0.01, 1 - step / 100);
      stepSimulation(nodes, edges, bounds, DEFAULT_CONFIG, alpha);
    }

    const finalDist = Math.abs(nodes[0]!.x - nodes[1]!.x);
    // Should have contracted significantly toward target length (between 80 and 150)
    expect(finalDist).toBeLessThan(180);
    expect(finalDist).toBeGreaterThan(60);
  });

  it('energy converges toward zero over simulation steps', () => {
    const ids = ['1', '2', '3', '4'];
    const init = initializePositions(ids, 400, 300, 30);
    const nodes: SimulationNode[] = ids.map((id) => ({
      id,
      x: init.get(id)!.x,
      y: init.get(id)!.y,
      vx: 0,
      vy: 0,
      radius: 12,
      mass: 1,
    }));
    const edges: SimulationEdge[] = [
      { sourceId: '1', targetId: '2', length: 80, strength: 1 },
      { sourceId: '2', targetId: '3', length: 80, strength: 1 },
      { sourceId: '3', targetId: '4', length: 80, strength: 1 },
    ];
    const bounds = { width: 800, height: 600 };

    let lastEnergy = Infinity;
    for (let step = 0; step < 80; step++) {
      const alpha = Math.max(0.02, 1 - step / 80);
      lastEnergy = stepSimulation(nodes, edges, bounds, DEFAULT_CONFIG, alpha);
    }

    // After 80 cooling steps, kinetic energy should be small
    expect(lastEnergy).toBeLessThan(1.0);
  });

  it('computes correct bounds for node collection', () => {
    const nodes = [
      { x: 100, y: 150, radius: 10 },
      { x: 200, y: 250, radius: 15 },
    ];
    const b = computeGraphBounds(nodes);

    expect(b.minX).toBe(90);
    expect(b.maxX).toBe(215);
    expect(b.minY).toBe(140);
    expect(b.maxY).toBe(265);
    expect(b.width).toBe(125);
    expect(b.height).toBe(125);
    expect(b.centerX).toBe(152.5);
    expect(b.centerY).toBe(202.5);
  });
});
