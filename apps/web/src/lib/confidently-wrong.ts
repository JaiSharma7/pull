export interface ConfidentlyWrongItem {
  id: string;
  pullId: string;
  appliedAt: string;
  headline: string;
  workTitle: string;
}

export const CONFIDENTLY_WRONG_COPY = {
  sectionTitle: 'Confidently wrong',
  description:
    "Ideas you marked 'I’m sure' before missing the recall in the last 30 days. These are the misconceptions worth repairing first.",
  empty:
    'No confident lapses in the last 30 days. When you are certain of an answer and miss it, it surfaces here for repair.',
  // Three states, because "No confident lapses" was shown while the list was still
  // loading and after the request had failed -- a false negative about the reader's
  // own record, on the one screen that is named for measurement.
  loading: 'Checking your recent recalls…',
  failed: 'Could not load your confident lapses just now.',
  offline: 'You appear to be offline. Your confident lapses need an active connection.',
  /** The list is cut at twenty ideas; the reader is told what the cut left out. */
  more: (n: number) => `And ${n} more in the last 30 days.`,
} as const;

/** What `fetchConfidentlyWrong` returns: the ideas shown, and how many there were. */
export interface ConfidentlyWrongList {
  items: ConfidentlyWrongItem[];
  /** Distinct ideas in the window, before the cut. `items.length` when nothing was cut. */
  total: number;
}

type RawWork = { id?: string; title?: string };
type RawSummary = { works?: RawWork | RawWork[] | null };
type RawPullData = {
  id?: string;
  headline?: string;
  summaries?: RawSummary | RawSummary[] | null;
};

type RawRecallEventRow = {
  id?: string;
  pull_id?: string;
  applied_at?: string;
  pulls?: RawPullData | RawPullData[] | null;
};

/**
 * Parses raw PostgREST rows from recall_events into ConfidentlyWrongItem.
 * Pure function — does not touch the network or environment.
 *
 * A row whose embedded `pulls` came back empty is dropped, not kept as "Untitled idea".
 * The event is the reader's own, but the embed is read under RLS on `pulls`, and an
 * empty one means the idea is no longer theirs to read -- the summary withdrawn or the
 * import undone -- so the entry would be a repair the reader cannot make, linking to
 * Not found from a list whose copy calls it the misconception worth repairing first.
 */
export function parseConfidentlyWrongRows(rows: unknown[]): ConfidentlyWrongItem[] {
  if (!Array.isArray(rows)) return [];

  const items: ConfidentlyWrongItem[] = [];

  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as RawRecallEventRow;
    const id = typeof row.id === 'string' ? row.id : null;
    const pullId = typeof row.pull_id === 'string' ? row.pull_id : null;
    const appliedAt = typeof row.applied_at === 'string' ? row.applied_at : null;

    if (!id || !pullId || !appliedAt) continue;

    const pullObj = Array.isArray(row.pulls) ? row.pulls[0] : row.pulls;
    if (!pullObj || typeof pullObj !== 'object') continue;
    const headline = pullObj.headline?.trim() || 'Untitled idea';

    const summaryObj = Array.isArray(pullObj.summaries) ? pullObj.summaries[0] : pullObj.summaries;
    const workObj = Array.isArray(summaryObj?.works) ? summaryObj?.works[0] : summaryObj?.works;
    const workTitle = workObj?.title?.trim() || 'Unknown source';

    items.push({ id, pullId, appliedAt, headline, workTitle });
  }

  return items;
}

/**
 * Newest first, then by id, so two events in the same instant keep a fixed order.
 * Pure. The API walks `recall_events` keyed on `id`, which is a uuid and so in no
 * useful order; this is where the list becomes a list.
 */
export function newestFirst(items: ConfidentlyWrongItem[]): ConfidentlyWrongItem[] {
  return [...items].sort(
    (a, b) => Date.parse(b.appliedAt) - Date.parse(a.appliedAt) || a.id.localeCompare(b.id),
  );
}

/**
 * Keeps the first event for each distinct pull_id -- the most recent, once the list
 * has been through `newestFirst`.
 * Pure function.
 */
export function dedupeConfidentlyWrong(items: ConfidentlyWrongItem[]): ConfidentlyWrongItem[] {
  const seenPulls = new Set<string>();
  const deduped: ConfidentlyWrongItem[] = [];

  for (const item of items) {
    if (seenPulls.has(item.pullId)) continue;
    seenPulls.add(item.pullId);
    deduped.push(item);
  }

  return deduped;
}

/**
 * Format timestamp into relative day or short date string.
 * Pure function.
 */
export function formatAttemptDate(isoString: string, now: Date = new Date()): string {
  const date = new Date(isoString);
  const diffMs = now.getTime() - date.getTime();
  if (Number.isNaN(diffMs) || diffMs < 0) return 'Just now';

  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  if (diffHours < 1) return 'Just now';
  if (diffHours < 24) return `${diffHours}h ago`;

  const diffDays = Math.floor(diffHours / 24);
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return `${diffDays}d ago`;

  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
