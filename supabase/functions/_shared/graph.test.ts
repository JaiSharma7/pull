import { describe, expect, it } from 'vitest';
import { ancestorsOf, NEEDS, NODES, ROOT, STEPS, successorsOf } from './graph.ts';

/**
 * The graph is data, so its shape is asserted rather than trusted. Each of these
 * is a property the worker relies on without checking at runtime.
 */
describe('the generation graph', () => {
  it('has a node for every step and a step for every node', () => {
    expect(Object.keys(NODES).sort()).toEqual([...STEPS].sort());
  });

  it('has one root, and it is the step enqueue sends', () => {
    const roots = STEPS.filter((s) => NODES[s].after.length === 0);
    expect(roots).toEqual([ROOT]);
  });

  it('has one sink, and it is publish', () => {
    const sinks = STEPS.filter((s) => successorsOf(s).length === 0);
    expect(sinks).toEqual(['publish']);
  });

  it('reaches every node from the root', () => {
    // A node nothing dispatches is a node that never runs, and the job it belongs
    // to sits at its predecessor forever with nothing to say why.
    const reached = new Set<string>([ROOT]);
    const queue = [ROOT];
    while (queue.length > 0) {
      for (const s of successorsOf(queue.shift() as never)) {
        if (!reached.has(s)) {
          reached.add(s);
          queue.push(s);
        }
      }
    }
    expect([...reached].sort()).toEqual([...STEPS].sort());
  });

  it('is acyclic', () => {
    // The plan adds one bounded back-edge later, as a step's decision (`jumpTo`)
    // rather than as an `after` edge. `after` must stay a DAG or the readiness check
    // waits on itself.
    for (const s of STEPS) expect(ancestorsOf(s).has(s), `${s} is its own ancestor`).toBe(false);
  });

  it('only reads outputs of ancestors', () => {
    // `needs` is what a node is handed; `after` is what is guaranteed to have run.
    // Reading a non-ancestor would not throw -- the key would simply be absent --
    // so the node would run with an input silently missing.
    for (const s of STEPS) {
      const ancestors = ancestorsOf(s);
      for (const need of NODES[s].needs) {
        expect(ancestors.has(need), `${s} needs ${need}, which is not an ancestor`).toBe(true);
      }
    }
  });

  it('names no step twice in either list', () => {
    for (const s of STEPS) {
      expect(new Set(NODES[s].needs).size).toBe(NODES[s].needs.length);
      expect(new Set(NODES[s].after).size).toBe(NODES[s].after.length);
    }
  });

  it('fans out where the line serialised for no reason', () => {
    // The two concurrencies the graph was drawn for. Asserted so a later edit that
    // quietly re-serialises them has to say why.
    expect(successorsOf('chunk').sort()).toEqual(['extract_evidence', 'synthesize']);
    expect(successorsOf('cards').sort()).toEqual(['artwork', 'embed']);
    expect(NODES.moderate.after.slice().sort()).toEqual(['artwork', 'embed']);
  });

  it('still fetches the source text for five steps', () => {
    const readsAcquire = STEPS.filter((s) => NEEDS[s].includes('acquire'));
    expect(readsAcquire).toEqual(['chunk', 'synthesize', 'template', 'critic', 'publish']);
  });
});
