/**
 * How an authored edge reads to a person, from the side the reader is standing on.
 *
 * `pull_relations.kind` describes the `to` pull relative to the `from` pull -- the
 * seed's edge from the Enchiridion to Marcus is `descendant`, and the edge back is
 * `ancestor`. `related_pulls` says which side the anchor is on: `'from'` when the
 * edge was written from it, so the kind describes the neighbour relative to this
 * idea; `'to'` when it was written from the neighbour, so the kind describes this
 * idea relative to the neighbour. One map read from the wrong side inverted
 * `ancestor` and `descendant` -- "Grew out of this idea" over the idea it grew out
 * of -- so there are two, and the side picks.
 *
 * The enum is `relation_kind` in the database. Anything unrecognised falls through
 * to the raw value rather than being dropped, so a member added by a migration
 * shows up as itself instead of silently disappearing from the page.
 */
export type EdgeDirection = 'from' | 'to';

/** The neighbour, described relative to this idea: the edge was written from here. */
const FROM_HERE: Record<string, string> = {
  supports: 'Supports this',
  opposes: 'Argues against this',
  elaborates: 'Elaborates on this',
  ancestor: 'This idea came from it',
  descendant: 'Grew out of this idea',
  related: 'Related',
};

/** This idea, described relative to the neighbour: the edge was written from there. */
const FROM_THERE: Record<string, string> = {
  supports: 'This idea supports it',
  opposes: 'This idea argues against it',
  elaborates: 'This idea elaborates on it',
  ancestor: 'Grew out of this idea',
  descendant: 'This idea came from it',
  related: 'Related',
};

/**
 * A payload without a side -- a `related_pulls` older than 20260909040000 -- is read
 * as `'from'`, which is what the single map assumed and is right for every seeded
 * pair, since both directions are stored and the `from` edge wins the tiebreak.
 */
export function relationLabel(kind: string, direction: EdgeDirection | null): string {
  const map = direction === 'to' ? FROM_THERE : FROM_HERE;
  return map[kind] ?? kind;
}
