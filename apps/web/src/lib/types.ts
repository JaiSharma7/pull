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
  /** How many ideas the Delta filtered because the reader already holds them. */
  skippedKnownCount: number;
  minutesSaved: number;
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
  savedAt: string;
  work: { id: string; title: string; kind: string | null };
}

/** One source the reader has saved from, with its Delta. */
export interface LibrarySource {
  workId: string;
  title: string;
  kind: string | null;
  savedCount: number;
}
