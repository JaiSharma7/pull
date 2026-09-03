/**
 * The step list, re-exported from the graph that now owns it.
 *
 * Kept so nothing that imports `./steps.ts` moves. The graph is in `graph.ts`;
 * read that.
 */
export { MAX_ATTEMPTS, NEEDS, nextStep, STEPS, type Step } from './graph.ts';
