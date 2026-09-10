import type { InterruptKind } from '@wap/schemas';

/** Shape returned by the `get_feed` RPC. */
export interface FeedRow {
  id: string;
  summaryId: string;
  ordinal: number;
  headline: string;
  body: string;
  explanation: string | null;
  example: string | null;
  whyItMatters: string | null;
  estimatedReadSeconds: number;
  summaryTitle: string;
  work: { id: string; title: string; slug: string; kind: string; year: number | null };
  score: number;
}

export interface InterleaveSlot {
  slotIndex: number;
  kind: InterruptKind;
}

export interface FeedResponse {
  rows: FeedRow[];
  /**
   * How many ideas the Delta filtered because the reader already holds them.
   * null when the Delta never ran (offline) -- distinct from a measured zero.
   */
  skippedKnownCount: number | null;
  /**
   * Minutes saved by not re-teaching what the reader knows.
   * null when the Delta never ran (offline) -- distinct from a measured zero.
   */
  minutesSaved: number | null;
  interleaveSlots: InterleaveSlot[];
  page: number;
}

export interface ReviewQuestion {
  id: string;
  source: 'user' | 'canonical';
  kind: 'recall' | 'mcq' | 'cloze' | 'short_answer' | 'ordering' | 'scenario';
  prompt: string;
  answer: string | null;
  distractors: string[] | null;
  cloze: string | null;
  explanation: string | null;
  rationale: Array<{ distractor: string; why: string }> | null;
}

export interface DueReview {
  pullId: string;
  headline: string;
  body: string;
  whyItMatters: string | null;
  example?: string | null;
  explanation?: string | null;
  workTitle: string;
  workSlug: string;
  contentVersion?: number;
  retrievability: number;
  stability: number;
  difficulty?: number;
  lapses?: number;
  reps: number;
  dueAt: string;
  question: string | null;
  /**
   * The id of the question `question` came from, and which table it came from.
   *
   * Both have been in `get_due_reviews`'s payload since
   * `20260905110000_your_highlights_are_yours_to_keep`, and were declared by nothing --
   * so the screen could not send the id back even though `grade_recall` takes it and
   * `recall_events` has a column for it. A grade filed against no question is a grade
   * that cannot answer "which of my questions do I keep getting wrong".
   *
   * `questionSource` says which table, and the client does not have to care: one
   * `p_question_id` goes to `grade_recall`, which looks it up under the caller's own RLS
   * and files it in `user_question_id` or `quiz_question_id` accordingly.
   *
   * All three describe `questions[0]` and nothing else. Since 20260909030000 the screen
   * rotates through `questions` (`resolveActiveQuestion`), so whose question is being
   * asked, which id to grade against and what to show come from the rotated element's
   * own `source`, `id` and `prompt`; these three are the fallback when there is none.
   *
   * Null together when a pull has no question at all, which is most of the corpus until
   * 3b seeds it.
   */
  questionId: string | null;
  questionSource: 'user' | 'canonical' | null;
  questions?: ReviewQuestion[];
}

export interface SourceDelta {
  total: number;
  known: number;
  new: number;
  minutesSaved: number;
}

/** A saved Pull as the Library lists it, with enough source to be identifiable. */
export interface LibraryItem {
  id: string;
  headline: string;
  body: string;
  whyItMatters: string | null;
  /** The deeper stops on the Depth Dial, so a saved card reads like a fed one. */
  explanation: string | null;
  example: string | null;
  savedAt: string;
  work: { id: string; title: string; kind: string | null };
  /**
   * The `saved_items` row, as distinct from the Pull it points at.
   *
   * Every organising action — moving it into a stash, marking it for later,
   * archiving it, attaching a note — updates the SAVE, not the Pull, and the
   * Library previously had no reason to know the difference. It does now.
   */
  saveId: string;
  stashId: string | null;
  note: string | null;
  archived: boolean;
  readLater: boolean;
}

/** One source the reader has saved from, with its Delta. */
export interface LibrarySource {
  workId: string;
  title: string;
  kind: string | null;
  savedCount: number;
}

/** Node in the personal knowledge graph. */
export interface GraphNode {
  pullId: string;
  workId: string;
  workTitle: string;
  workKind: string;
  headline: string;
  body: string;
  stability: number;
  difficulty: number;
  retrievability: number;
  lastSeenAt: string;
  status: 'solid' | 'refreshing' | 'fading';
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
}

/** Edge in the personal knowledge graph. */
export interface GraphEdge {
  fromPullId: string;
  toPullId: string;
  kind: 'ancestor' | 'descendant' | 'opposes' | 'elaborates' | 'related' | 'supports';
  weight: number;
  rationale: string | null;
}

/**
 * Where a graph's numbers came from, which anything that reports a count to a reader
 * has to check before calling them theirs.
 *
 *   * `personal` — the reader's own `knowledge_states`, with real retrievability.
 *   * `seed`     — the published corpus, returned by the RPC when a reader has no
 *                  states yet. Real rows, but not this reader's history.
 *   * `sample`   — the hard-coded `SAMPLE_GRAPH`, served when the RPC could not be
 *                  reached at all. Not data.
 */
export type GraphSource = 'personal' | 'seed' | 'sample';

/** Full data structure returned for the knowledge graph. */
export interface KnowledgeGraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  source: GraphSource;
}
