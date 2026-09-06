/**
 * What the progress screen promises about its own numbers.
 *
 * Here rather than inline in the route for the reason `APPEARANCE_COPY` and
 * `AUDIO_COPY` are: a sentence the product makes a claim in is a value, testable
 * without rendering a screen that needs a live session and a network call.
 *
 * The claim it replaces was "Every number here is computed from your own recall
 * history — nothing is estimated", and the second half was never true.
 * Retrievability is not measured, it is derived: `public.retrievability` reads it
 * off a decay curve from `stability` and `last_seen_at`, and "Solid",
 * "Refreshing" and "Fading" are bands of that curve — so the sentence disclaimed
 * the three headline numbers on the screen it headed. The counts ARE the
 * reader's own history, and saying so is worth keeping; the estimate is worth
 * admitting, because a reader deciding what to revise should know which of the
 * two kinds of number they are looking at.
 *
 * AND THE CURVE RESTARTS ON A READ, not only on a recall, which the first draft
 * of this sentence got wrong. `record_read` (20260829222803) opens a
 * `knowledge_states` row with `last_seen_at = now()` and stamps the same on every
 * later read, so a reader who merely reopens an idea moves the curve without
 * answering anything. Telling them the estimate comes from "when you last
 * recalled it" would explain a number that had just gone up for a reason the
 * explanation does not contain.
 */
/*
 * AND THE SENTENCE HAS TO BE TRUE OF THE NUMBERS BESIDE IT, which the first
 * replacement was not. It said "Every count here comes from your own recall history",
 * and not one figure on the screen does:
 *
 *   `retentionHealth`, `solidCount`, `refreshingCount` and `fadingCount` are band
 *   membership of `n.retrievability` (`lib/graph.ts`) — counts OF the estimate the
 *   very next sentence disclaims, not of anything recalled.
 *
 *   "Connections" and "N dialectical tensions" count `pull_relations` edges, which
 *   are corpus data written by the seed rather than by anything the reader did.
 *
 * So a reader was told all of it came from what they had done, then shown "12 solid ·
 * 3 fading" and "47 connections" and reasonably believed it. That is the same defect
 * this file exists to fix, one sentence along — and the test below had begun asserting
 * the false version, which is how a wrong claim becomes load-bearing.
 *
 * AND THE REPLACEMENT OVERSHOT IN THE OTHER DIRECTION. It said "Connections and
 * tensions describe the library itself, not you", and that is false of the number on
 * the screen. `MetacognitiveDashboard` counts `undirectedEdges(measured.edges)` off
 * `personalGraph(...)`, and the RPC behind it — `user_edges` in
 * `20260903000000_user_knowledge_graph_rpc.sql` — keeps only edges with BOTH ends in
 * `active_pull_ids`, the reader's own `knowledge_states`. So the count moves as the
 * reader reads, and a reader told it was nothing to do with them would have no way to
 * explain it going up.
 *
 * That mechanism is named precisely because the first version of this paragraph named
 * `filterConnectedEdges`, which has no production callers at all: `personalGraph` is
 * `graph?.source === 'personal' ? graph : null` and filters nothing. The claim was
 * true and the reason given for it was dead code, in the one file whose whole subject
 * is the product asserting things the code does not do.
 *
 * Both halves are true and the sentence has to hold them together: the relationships
 * belong to the library, the selection belongs to the reader. Which is also the one
 * thing worth saying here, because it is why the number is not a score.
 *
 * AND THE SELECTION HAS A CEILING. `fetchKnowledgeGraph` asks for 150 and the RPC
 * takes the 150 most recent by `last_seen_at desc`, so past 150 read ideas a new one
 * EVICTS the least recently seen and the count can fall while the reader reads. A
 * clause promising it only rises would be the same defect as the one above, arriving
 * from the other direction — so the sentence says recent rather than promising a
 * direction. The same cap silently bounds the solid, refreshing and fading counts;
 * this is the commit that started making a claim about it, so this is where it is said.
 */
export const PROGRESS_COPY = {
  /** Under the title. Says where each kind of number comes from. */
  provenance:
    'What you have read, and how well you are still holding on to it. Which ideas you have ' +
    'read comes from your own history. How well you are holding on to each one is an estimate ' +
    'rather than a measurement: it is read off a curve that starts again each time you open or ' +
    'recall the idea, and stretches further the better you recalled it — so the solid, ' +
    'refreshing and fading counts are readings off that curve rather than records of what you ' +
    'did. Connections and tensions are relationships the library draws between ideas, not ' +
    'judgements about you — but only the ones running between ideas you have read are ' +
    'counted, so that number is about your reading too. Every figure here is drawn from ' +
    'your 150 most recently seen ideas rather than everything you have ever read. ' +
    'Nothing here asks you today.',
} as const;
