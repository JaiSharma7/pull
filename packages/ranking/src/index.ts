// A record of when the read path's scoring semantics changed, and nothing more:
// no cache key, query key or IndexedDB store reads this. Wire it into one before
// treating a bump as something that invalidates anything.
//
// 2: the feed scorer stopped comparing a candidate against ideas it contradicts,
// so `covered` and the novelty term changed meaning for opposed pairs.
export const RANKING_VERSION = 2;
