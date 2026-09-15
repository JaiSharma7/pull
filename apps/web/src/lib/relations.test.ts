import { describe, expect, it } from 'vitest';
import { relationLabel } from './relations.js';

describe('relationLabel', () => {
  it('reads an edge written from this idea as describing the neighbour', () => {
    // The seed's Enchiridion -> Marcus edge is `descendant`: Marcus grew out of it.
    expect(relationLabel('descendant', 'from')).toBe('Grew out of this idea');
    expect(relationLabel('ancestor', 'from')).toBe('This idea came from it');
    expect(relationLabel('opposes', 'from')).toBe('Argues against this');
  });

  it('reads an edge written from the neighbour as describing this idea', () => {
    // Standing on Marcus, the same Enchiridion -> Marcus `descendant` edge says
    // Marcus came from the Enchiridion -- the label the single map inverted.
    expect(relationLabel('descendant', 'to')).toBe('This idea came from it');
    expect(relationLabel('ancestor', 'to')).toBe('Grew out of this idea');
    expect(relationLabel('elaborates', 'to')).toBe('This idea elaborates on it');
    expect(relationLabel('supports', 'to')).toBe('This idea supports it');
  });

  it('inverts exactly the antisymmetric pair', () => {
    expect(relationLabel('ancestor', 'to')).toBe(relationLabel('descendant', 'from'));
    expect(relationLabel('descendant', 'to')).toBe(relationLabel('ancestor', 'from'));
    expect(relationLabel('related', 'to')).toBe(relationLabel('related', 'from'));
  });

  it('reads a payload with no side as written from this idea', () => {
    expect(relationLabel('descendant', null)).toBe('Grew out of this idea');
  });

  it('shows an unknown kind as itself rather than dropping it', () => {
    expect(relationLabel('refines', 'from')).toBe('refines');
    expect(relationLabel('refines', 'to')).toBe('refines');
  });
});
