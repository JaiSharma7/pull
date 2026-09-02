/**
 * The generation pipeline, as a graph.
 *
 * It was a line: `STEPS` in order, and `nextStep` was `indexOf + 1`. A line cannot
 * say that `extract_evidence` and `synthesize` both need only `chunk` and nothing
 * from each other, so they ran one after the other; it cannot say that `embed` and
 * `artwork` are independent, so they queued behind one another; and it had exactly
 * one exception carved into it -- `jumpTo`, added so a reused job could skip nine
 * steps -- which is the honest description of the first edge in a graph, expressed
 * as a special case because there was nowhere to declare it.
 *
 * Nothing about the platform changed. Edge Functions still cap at 150s wall clock
 * and 2s CPU, so an invocation still runs exactly ONE node and holds nothing
 * between invocations. What changed is what an invocation is told (`needs`) and
 * where it may go next (`after`). Those are two different lists, and keeping them
 * apart is most of the value: `moderate` waits for two nodes and reads neither.
 *
 *   needs  -- outputs this node reads. Handed to `job_step_outputs(uuid, text[])`
 *             so the worker fetches only these. Must be ancestors, or the node
 *             would read something that is not guaranteed to have run.
 *   after  -- nodes that must have SUCCEEDED before this one is dispatched. A node
 *             with several is a join; the last predecessor to finish sends it.
 *
 * The graph is data, checked by `graph.test.ts`: acyclic, every node reachable from
 * the root, every `needs` an ancestor. The database does not hold a copy of it. The
 * worker passes each successor's `after` list to `dispatch_generation_step`, which
 * verifies the rows and guards the send with a unique index -- so two predecessors
 * finishing in the same instant produce one message by construction, not by timing.
 *
 *     resolve_identity
 *           │
 *        acquire ───── reuse? ─────────────────┐   (jumpTo, still a step's decision)
 *           │                                  │
 *         chunk                                │
 *        ┌──┴────────────┐                     │
 *  extract_evidence   synthesize               │
 *        │               │                     │
 *        │           template                  │
 *        └──────┬────────┘                     │
 *            critic                            │
 *               │                              │
 *             cards                            │
 *            ┌──┴───┐                          │
 *        artwork  embed                        │
 *            └──┬───┘                          │
 *           moderate ◄─────────────────────────┘
 *               │
 *            publish
 *
 * Deliberately no framework. LangGraph and its relatives assume a long-lived process
 * holding state between nodes; this pipeline's defining constraint is that it
 * cannot, and its state already lives durably in `job_steps` and `pgmq`. A second
 * state machine on top of the one Postgres runs would disagree with it the first
 * time a worker died. This file is the whole of the graph and should stay that way.
 */

export const STEPS = [
  'resolve_identity',
  'acquire',
  'chunk',
  'extract_evidence',
  'synthesize',
  'template',
  'critic',
  'cards',
  'artwork',
  'embed',
  'moderate',
  'publish',
] as const;

export type Step = (typeof STEPS)[number];

/** A step that has failed this many times is not going to succeed. */
export const MAX_ATTEMPTS = 3;

export interface Node {
  /** Outputs this node reads. Each must be an ancestor. */
  readonly needs: readonly Step[];
  /** Nodes that must have succeeded before this one may run. */
  readonly after: readonly Step[];
}

/**
 * Why `needs` and `after` differ where they do, since a reader will ask:
 *
 * - `reuseOf()` in pipeline.ts reads both `acquire.reuse` and `synthesize.reuse`,
 *   which is why `template`, `critic` and `publish` list both in `needs`. That is
 *   also why those three still receive the source text: `acquire` carries the text
 *   and the reuse marker in one object. Moving the marker is the next cut.
 * - `critic` runs after `template` because it did in the line and its output is
 *   consumed by nothing yet; the plan's back-edge to `synthesize` is a later PR and
 *   will move it. It also waits on `extract_evidence`, so the evidence spans are
 *   present for the critic that will actually read them.
 * - `moderate` needs nothing. It reads the job row. It waits on the two provider
 *   nodes because publication must not outrun embedding -- a summary in search with
 *   no vectors is invisible to the Delta, silently.
 */
export const NODES: Record<Step, Node> = {
  resolve_identity: { needs: [], after: [] },
  acquire: { needs: ['resolve_identity'], after: ['resolve_identity'] },
  chunk: { needs: ['acquire'], after: ['acquire'] },
  extract_evidence: { needs: ['chunk'], after: ['chunk'] },
  synthesize: { needs: ['acquire'], after: ['chunk'] },
  template: { needs: ['acquire', 'synthesize'], after: ['synthesize'] },
  critic: { needs: ['acquire', 'synthesize'], after: ['template', 'extract_evidence'] },
  cards: { needs: ['template', 'synthesize'], after: ['critic'] },
  artwork: { needs: [], after: ['cards'] },
  embed: { needs: ['cards', 'synthesize'], after: ['cards'] },
  moderate: { needs: [], after: ['artwork', 'embed'] },
  publish: { needs: ['acquire', 'synthesize', 'template'], after: ['moderate'] },
};

/** The root: the one node `enqueue_generation_job` sends directly. */
export const ROOT: Step = 'resolve_identity';

/** What each step reads, in the shape the worker hands to the database. */
export const NEEDS: Record<Step, readonly Step[]> = Object.fromEntries(
  STEPS.map((s) => [s, NODES[s].needs]),
) as Record<Step, readonly Step[]>;

/** Every node that lists `step` in its `after` -- what completing it may unblock. */
export function successorsOf(step: Step): Step[] {
  return STEPS.filter((s) => NODES[s].after.includes(step));
}

/** Every node that must run before `step`, transitively. */
export function ancestorsOf(step: Step): Set<Step> {
  const seen = new Set<Step>();
  const stack = [...NODES[step].after];
  while (stack.length > 0) {
    const s = stack.pop() as Step;
    if (seen.has(s)) continue;
    seen.add(s);
    stack.push(...NODES[s].after);
  }
  return seen;
}

/**
 * The line, for anything that still wants one.
 *
 * Kept because a job queued before the graph existed is mid-walk along `STEPS`, and
 * because the resume path has no step result to read a `jumpTo` off. It is no longer
 * how the worker advances: that is `successorsOf`, and a node with one successor in
 * the graph gets the same answer here it always did.
 */
export function nextStep(current: Step): Step | null {
  const i = STEPS.indexOf(current);
  if (i < 0 || i === STEPS.length - 1) return null;
  return STEPS[i + 1] ?? null;
}
