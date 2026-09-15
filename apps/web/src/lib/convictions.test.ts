import { describe, expect, it } from 'vitest';
import {
  BELIEF_COPY,
  chainStances,
  changeLine,
  isStance,
  mindsChanged,
  type ConvictionRow,
  type Stance,
} from './convictions.js';

let seq = 0;
function row(
  pullId: string,
  stance: Stance,
  createdAt: string,
  over: Partial<ConvictionRow> = {},
): ConvictionRow {
  seq += 1;
  return {
    id: `c${seq}`,
    pullId,
    stance,
    createdAt,
    headline: `Headline for ${pullId}`,
    workId: `w-${pullId}`,
    workTitle: `Work of ${pullId}`,
    ...over,
  };
}

describe('chainStances', () => {
  it('returns nothing for a reader who has recorded nothing', () => {
    expect(chainStances([])).toEqual([]);
  });

  it('takes the most recent stance as the current one, whatever order the rows arrive in', () => {
    const beliefs = chainStances([
      row('p1', 'disagree', '2026-03-02T00:00:00Z'),
      row('p1', 'agree', '2026-01-01T00:00:00Z'),
    ]);
    expect(beliefs).toHaveLength(1);
    expect(beliefs[0]!.stance).toBe('disagree');
    expect(beliefs[0]!.since).toBe('2026-03-02T00:00:00Z');
    expect(beliefs[0]!.from).toBe('agree');
    expect(beliefs[0]!.changes).toBe(1);
  });

  it('counts a change only when the stance differs from the one before it', () => {
    // Four rows, one reversal. A reader re-answering a Counterpull the same way is
    // reaffirming, and counting that would tell somebody who has held one position
    // for a year that they had changed their mind three times.
    const beliefs = chainStances([
      row('p1', 'agree', '2026-01-01T00:00:00Z'),
      row('p1', 'agree', '2026-02-01T00:00:00Z'),
      row('p1', 'agree', '2026-03-01T00:00:00Z'),
      row('p1', 'disagree', '2026-04-01T00:00:00Z'),
    ]);
    expect(beliefs[0]!.changes).toBe(1);
    expect(beliefs[0]!.from).toBe('agree');
  });

  it('counts a move through unsure as two changes, because unsure is a position', () => {
    const beliefs = chainStances([
      row('p1', 'agree', '2026-01-01T00:00:00Z'),
      row('p1', 'unsure', '2026-02-01T00:00:00Z'),
      row('p1', 'disagree', '2026-03-01T00:00:00Z'),
    ]);
    expect(beliefs[0]!.changes).toBe(2);
  });

  it('reports no origin when the reader ended where they started', () => {
    const beliefs = chainStances([
      row('p1', 'agree', '2026-01-01T00:00:00Z'),
      row('p1', 'disagree', '2026-02-01T00:00:00Z'),
      row('p1', 'agree', '2026-03-01T00:00:00Z'),
    ]);
    expect(beliefs[0]!.from).toBeNull();
    expect(beliefs[0]!.changes).toBe(2);
  });

  it('keeps one belief per idea, newest decision first', () => {
    const beliefs = chainStances([
      row('p1', 'agree', '2026-01-01T00:00:00Z'),
      row('p2', 'disagree', '2026-05-01T00:00:00Z'),
      row('p3', 'unsure', '2026-03-01T00:00:00Z'),
    ]);
    expect(beliefs.map((b) => b.pullId)).toEqual(['p2', 'p3', 'p1']);
  });

  it('orders a tie on the id, so two stances in the same millisecond cannot swap', () => {
    const a = row('p1', 'agree', '2026-01-01T00:00:00Z', { id: 'a' });
    const b = row('p1', 'disagree', '2026-01-01T00:00:00Z', { id: 'b' });
    expect(chainStances([a, b])[0]!.stance).toBe('disagree');
    expect(chainStances([b, a])[0]!.stance).toBe('disagree');
  });

  it('carries the whole chain, oldest first, so a screen can show the history', () => {
    const beliefs = chainStances([
      row('p1', 'disagree', '2026-02-01T00:00:00Z'),
      row('p1', 'agree', '2026-01-01T00:00:00Z'),
    ]);
    expect(beliefs[0]!.chain.map((c) => c.stance)).toEqual(['agree', 'disagree']);
  });

  it('names the idea and the work from the most recent row', () => {
    const beliefs = chainStances([
      row('p1', 'agree', '2026-01-01T00:00:00Z', { headline: 'Old wording' }),
      row('p1', 'agree', '2026-02-01T00:00:00Z', { headline: 'Current wording' }),
    ]);
    expect(beliefs[0]!.headline).toBe('Current wording');
  });
});

describe('mindsChanged', () => {
  it('counts ideas whose stance moved, not stances recorded', () => {
    const beliefs = chainStances([
      row('p1', 'agree', '2026-01-01T00:00:00Z'),
      row('p1', 'disagree', '2026-02-01T00:00:00Z'),
      row('p2', 'agree', '2026-01-01T00:00:00Z'),
      row('p2', 'agree', '2026-02-01T00:00:00Z'),
      row('p3', 'unsure', '2026-01-01T00:00:00Z'),
    ]);
    expect(beliefs).toHaveLength(3);
    expect(mindsChanged(beliefs)).toBe(1);
  });
});

describe('changeLine', () => {
  it('says nothing about an idea the reader has never moved on', () => {
    const [belief] = chainStances([row('p1', 'agree', '2026-01-01T00:00:00Z')]);
    expect(changeLine(belief!)).toBeNull();
  });

  it('names where a single reversal came from', () => {
    const [belief] = chainStances([
      row('p1', 'disagree', '2026-01-01T00:00:00Z'),
      row('p1', 'agree', '2026-02-01T00:00:00Z'),
    ]);
    expect(changeLine(belief!)).toBe('Changed once, from disagreeing.');
  });

  it('counts rather than names once the question is live', () => {
    const [belief] = chainStances([
      row('p1', 'agree', '2026-01-01T00:00:00Z'),
      row('p1', 'disagree', '2026-02-01T00:00:00Z'),
      row('p1', 'agree', '2026-03-01T00:00:00Z'),
    ]);
    expect(changeLine(belief!)).toBe('Changed 2 times.');
  });
});

describe('isStance', () => {
  it('accepts exactly what the database enum allows', () => {
    for (const s of ['agree', 'disagree', 'unsure']) expect(isStance(s)).toBe(true);
    for (const s of ['', 'AGREE', 'maybe', null, undefined, 1]) expect(isStance(s)).toBe(false);
  });
});

describe('BELIEF_COPY', () => {
  it('has a label and a note for every stance', () => {
    for (const s of ['agree', 'disagree', 'unsure'] as Stance[]) {
      expect(BELIEF_COPY[s].label.length).toBeGreaterThan(0);
      expect(BELIEF_COPY[s].note.length).toBeGreaterThan(0);
    }
  });
});
