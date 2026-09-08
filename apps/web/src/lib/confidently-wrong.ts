export interface ConfidentlyWrongItem {
  id: string;
  pullId: string;
  appliedAt: string;
  headline: string;
  workTitle: string;
  workSlug?: string | null;
}

export const CONFIDENTLY_WRONG_COPY = {
  sectionTitle: 'Confidently wrong',
  description:
    "Ideas you marked 'I’m sure' before missing the recall in the last 30 days. These are the misconceptions worth repairing first.",
  empty:
    'No confident lapses in the last 30 days. When you are certain of an answer and miss it, it surfaces here for repair.',
} as const;

type RawPullData = {
  id?: string;
  headline?: string;
  summaries?:
    | {
        works?:
          | {
              id?: string;
              title?: string;
              slug?: string | null;
            }
          | Array<{ id?: string; title?: string; slug?: string | null }>
          | null;
      }
    | Array<{
        works?:
          | {
              id?: string;
              title?: string;
              slug?: string | null;
            }
          | Array<{ id?: string; title?: string; slug?: string | null }>
          | null;
      }>
    | null;
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
    const headline = pullObj?.headline?.trim() || 'Untitled idea';

    const summaryObj = Array.isArray(pullObj?.summaries)
      ? pullObj?.summaries[0]
      : pullObj?.summaries;

    const workObj = Array.isArray(summaryObj?.works) ? summaryObj?.works[0] : summaryObj?.works;

    const workTitle = workObj?.title?.trim() || 'Unknown source';
    const workSlug = typeof workObj?.slug === 'string' ? workObj.slug : null;

    items.push({
      id,
      pullId,
      appliedAt,
      headline,
      workTitle,
      workSlug,
    });
  }

  return items;
}

/**
 * Keeps the most recent event for each distinct pull_id.
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
