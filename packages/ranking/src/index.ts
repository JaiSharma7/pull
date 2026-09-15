// A record of when the read path's scoring semantics changed, and nothing more:
// no cache key, query key or IndexedDB store reads this. Wire it into one before
// treating a bump as something that invalidates anything.
//
// 2: the feed scorer stopped comparing a candidate against ideas it contradicts,
// so `covered` and the novelty term changed meaning for opposed pairs.
// 3: a muted work leaves the pool before scoring, and every row carries the reason
// it was served -- the term that contributed most, with neutral defaults excluded.
export const RANKING_VERSION = 3;
