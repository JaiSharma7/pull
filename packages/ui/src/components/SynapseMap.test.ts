import { describe, expect, it } from 'vitest';
import { neighborsOf, type SynapseEdge, type SynapseNode } from './SynapseMap.js';

/*
 * The fixture is public-domain, and that is not incidental.
 *
 * It used to be invented prose attributed to *Thinking, Fast and Slow*, *Antifragile* and
 * *The Black Swan* — headlines, bodies and edge rationales, all written here and none of
 * them anyone's words. Law 4 governs what is committed to this repository, and a test
 * fixture is committed. The same mistake was removed from `SAMPLE_GRAPH`, the onboarding
 * demo and the ingestion fixtures; it survived here because nothing checked this file.
 *
 * These are real seeded Pulls from `20260829131035_seed_pulls.sql`.
 */
const nodes: SynapseNode[] = [
  {
    pullId: 'pull-enchiridion',
    workId: 'work-enchiridion',
    workTitle: 'The Enchiridion',
    workKind: 'book',
    headline: 'You are disturbed by your judgement, not by the event.',
    body: 'Events arrive without commentary. The distress comes from the verdict you attach to them.',
    retrievability: 0.95,
    stability: 14.5,
    status: 'solid',
  },
  {
    pullId: 'pull-meditations',
    workId: 'work-meditations',
    workTitle: 'Meditations',
    workKind: 'book',
    headline: 'It is your opinion of the thing that wounds you, and you can revoke it.',
    body: 'The pain is attached to the verdict rather than the event.',
    retrievability: 0.45,
    stability: 1.2,
    status: 'fading',
  },
  {
    pullId: 'pull-walden',
    workId: 'work-walden',
    workTitle: 'Walden',
    workKind: 'book',
    headline: 'The cost of a thing is the amount of life you exchange for it.',
    body: 'Not the price. The hours required to earn the price.',
    retrievability: 0.72,
    stability: 4.0,
    status: 'refreshing',
  },
];

const edges: SynapseEdge[] = [
  {
    fromPullId: 'pull-enchiridion',
    toPullId: 'pull-meditations',
    kind: 'descendant',
    weight: 0.9,
    rationale: 'Marcus was a reader of Epictetus; this is the same claim, restated.',
  },
  {
    fromPullId: 'pull-walden',
    toPullId: 'pull-meditations',
    kind: 'related',
    weight: 0.6,
    rationale: 'Both treat attention as the scarce resource.',
  },
];

const allActive = new Set(nodes.map((n) => n.pullId));

describe('neighborsOf', () => {
  it('has no focus when nothing is selected', () => {
    expect(neighborsOf(null, allActive, edges)).toBeNull();
  });

  it('collects the selection and its neighbours in both directions', () => {
    expect(neighborsOf('pull-meditations', allActive, edges)).toEqual(
      new Set(['pull-meditations', 'pull-enchiridion', 'pull-walden']),
    );
    expect(neighborsOf('pull-enchiridion', allActive, edges)).toEqual(
      new Set(['pull-enchiridion', 'pull-meditations']),
    );
  });

  it('includes a selected node that has no edges', () => {
    expect(neighborsOf('pull-walden', allActive, [])).toEqual(new Set(['pull-walden']));
  });

  /*
   * The regression this exists for. Select a fading node, switch the filter to Solid, and
   * the selection is no longer in the graph. Returning a set containing only that absent
   * id is not "no focus" — every remaining node fails the membership test and is drawn at
   * 22% opacity, so the whole map greys out around nothing.
   */
  it('drops focus when the filter has removed the selection', () => {
    const solidOnly = new Set(['pull-enchiridion']);
    expect(neighborsOf('pull-meditations', solidOnly, edges)).toBeNull();
  });
});
