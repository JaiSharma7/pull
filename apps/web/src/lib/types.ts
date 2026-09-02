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

export interface DueReview {
  pullId: string;
  headline: string;
  body: string;
  whyItMatters: string | null;
  workTitle: string;
  workSlug: string;
  retrievability: number;
  stability: number;
  reps: number;
  dueAt: string;
  question: string | null;
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
  kind: 'ancestor' | 'descendant' | 'opposes' | 'elaborates' | 'related';
  weight: number;
  rationale: string | null;
}

/** Full data structure returned for the knowledge graph. */
export interface KnowledgeGraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}
