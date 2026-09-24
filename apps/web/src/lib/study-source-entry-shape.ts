import type { SearchResult } from './search.js';

/** Match the Edge preview's fixed allowlist and the source provenance field. */
export const STUDY_URL_HOSTS = [
  'en.wikisource.org',
  'classics.mit.edu',
  'www.gutenberg.org',
] as const;
export const MAX_STUDY_URL_CHARS = 240;

export function isPreviewableStudyUrl(raw: string): boolean {
  if (!raw || raw.length > MAX_STUDY_URL_CHARS) return false;
  try {
    const url = new URL(raw);
    return (
      url.protocol === 'https:' &&
      STUDY_URL_HOSTS.some((host) => host === url.hostname.toLowerCase()) &&
      !url.username &&
      !url.password &&
      (!url.port || url.port === '443')
    );
  } catch {
    return false;
  }
}

export interface StudySuggestion {
  id: string;
  title: string;
  description: string | null;
  url: string;
}

/** Search supplies relevance, but rights and URL are checked again on the work row. */
export function candidateWorkIds(result: SearchResult): string[] {
  return [
    ...new Set(
      [
        ...result.sources.map((source) => source.id),
        ...result.ideas.map((idea) => idea.workId),
      ].filter(Boolean),
    ),
  ].slice(0, 16);
}

export function shapeStudySuggestions(
  candidates: readonly string[],
  rows: readonly {
    id: string;
    title: string;
    description: string | null;
    source_url: string | null;
    rights_status: string;
  }[],
): StudySuggestion[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  return candidates
    .flatMap((id) => {
      const row = byId.get(id);
      return row?.rights_status === 'public_domain' &&
        row.source_url &&
        isPreviewableStudyUrl(row.source_url)
        ? [
            {
              id: row.id,
              title: row.title,
              description: row.description,
              url: row.source_url,
            },
          ]
        : [];
    })
    .slice(0, 6);
}

const GOAL_FILLER = new Set([
  'i',
  'me',
  'my',
  'want',
  'need',
  'to',
  'learn',
  'study',
  'understand',
  'explain',
  'prepare',
  'for',
  'an',
  'a',
  'the',
  'about',
  'of',
  'on',
  'how',
  'why',
  'what',
  'is',
  'are',
  'can',
  'do',
  'does',
  'in',
  'from',
  'reading',
  'read',
  'assessment',
  'exam',
  'argument',
]);

/** Try the reader's words first, then a bounded topic phrase without goal filler. */
export function goalSearchQueries(raw: string): string[] {
  const full = raw.trim().replace(/\s+/g, ' ').slice(0, 160);
  if (full.length < 2) return [];
  const topic = full
    .split(/\s+/)
    .map((part) => part.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
    .filter((part) => part && !GOAL_FILLER.has(part.toLowerCase()))
    .join(' ');
  return topic.length >= 2 && topic.toLowerCase() !== full.toLowerCase() ? [full, topic] : [full];
}
