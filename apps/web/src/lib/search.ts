/**
 * Search, minus the network.
 *
 * The shaping and the counting live here rather than in `Search.tsx` for the
 * reason `lib/feed-items.ts` gives: Vitest runs in `environment: 'node'` and
 * importing `lib/supabase.js` constructs a client that throws without `VITE_*`
 * env, so anything reachable from the API module cannot be unit-tested at all.
 * Everything below is a pure function over plain data.
 */

/**
 * Mirrors the guard inside `public.search_catalogue`.
 *
 * One character matches a large slice of the corpus by trigram and nothing by
 * word, so it is noise rather than a search. The server is authoritative — it
 * returns `tooShort` and the client believes it — but knowing the same number
 * here means the input can say so before spending a round trip on an answer it
 * can already predict.
 */
export const MIN_QUERY_LENGTH = 2;

export type QueryState = 'empty' | 'too-short' | 'ready';

/** Collapse the whitespace a paste brings with it. Never lower-cases: `websearch_to_tsquery` does its own folding, and the raw text is what gets echoed back to the reader. */
export function normaliseQuery(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

export function classifyQuery(raw: string): QueryState {
  const q = normaliseQuery(raw);
  if (q.length === 0) return 'empty';
  if (q.length < MIN_QUERY_LENGTH) return 'too-short';
  return 'ready';
}

export interface SearchIdea {
  id: string;
  summaryId: string;
  workId: string;
  headline: string;
  body: string;
  workTitle: string;
  workKind: string;
  workYear: number | null;
  estimatedReadSeconds: number | null;
  /**
   * Annotated, never filtered.
   *
   * The Delta decides what to serve unbidden; it has no business deciding what
   * may be looked for. A reader must be able to find something they read last
   * week — so a known result is marked and still returned.
   * `supabase/tests/search.sql` asserts this rather than trusting it.
   */
  alreadyKnown: boolean;
}

export interface SearchSource {
  id: string;
  title: string;
  subtitle: string | null;
  slug: string;
  kind: string;
  year: number | null;
  matchingIdeas: number;
}

/** An idea the words missed but the vectors found. */
export interface SearchNeighbour {
  id: string;
  summaryId: string;
  workId: string;
  headline: string;
  workTitle: string;
}

export interface SearchResult {
  query: string;
  tooShort: boolean;
  ideas: SearchIdea[];
  sources: SearchSource[];
  alsoClose: SearchNeighbour[];
  counts: { ideas: number; sources: number; capped: boolean };
}

export const EMPTY_RESULT: SearchResult = {
  query: '',
  tooShort: false,
  ideas: [],
  sources: [],
  alsoClose: [],
  counts: { ideas: 0, sources: 0, capped: false },
};

/* --------------------------------------------------------------------------
 * Shaping
 *
 * `search_catalogue` returns one jsonb blob, and supabase-js types it as `Json`.
 * Casting it straight to `SearchResult` would make every field a lie the moment
 * the RPC changes shape — and this repo has already been bitten once by values
 * TypeScript accepted and the database did not. So the boundary is narrowed
 * here, with the same posture the pipeline uses: an unrecognised value is
 * dropped rather than propagated.
 * -------------------------------------------------------------------------- */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function nullableStr(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function nullableInt(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function int(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function rows(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? v.filter(isRecord) : [];
}

/**
 * A row without an id cannot be linked to or keyed, so it is dropped rather than
 * rendered as a dead entry.
 */
function shapeIdea(r: Record<string, unknown>): SearchIdea | null {
  const id = str(r.id);
  if (!id) return null;
  return {
    id,
    summaryId: str(r.summaryId),
    workId: str(r.workId),
    headline: str(r.headline),
    body: str(r.body),
    workTitle: str(r.workTitle),
    workKind: str(r.workKind),
    workYear: nullableInt(r.workYear),
    estimatedReadSeconds: nullableInt(r.estimatedReadSeconds),
    alreadyKnown: r.alreadyKnown === true,
  };
}

function shapeSource(r: Record<string, unknown>): SearchSource | null {
  const id = str(r.id);
  if (!id) return null;
  return {
    id,
    title: str(r.title),
    subtitle: nullableStr(r.subtitle),
    slug: str(r.slug),
    kind: str(r.kind),
    year: nullableInt(r.year),
    matchingIdeas: int(r.matchingIdeas),
  };
}

function shapeNeighbour(r: Record<string, unknown>): SearchNeighbour | null {
  const id = str(r.id);
  if (!id) return null;
  return {
    id,
    summaryId: str(r.summaryId),
    workId: str(r.workId),
    headline: str(r.headline),
    workTitle: str(r.workTitle),
  };
}

function nonNull<T>(v: T | null): v is T {
  return v !== null;
}

export function shapeSearchResult(raw: unknown): SearchResult {
  if (!isRecord(raw)) return EMPTY_RESULT;
  const counts = isRecord(raw.counts) ? raw.counts : {};
  return {
    query: str(raw.query),
    tooShort: raw.tooShort === true,
    ideas: rows(raw.ideas).map(shapeIdea).filter(nonNull),
    sources: rows(raw.sources).map(shapeSource).filter(nonNull),
    alsoClose: rows(raw.alsoClose).map(shapeNeighbour).filter(nonNull),
    counts: {
      ideas: int(counts.ideas),
      sources: int(counts.sources),
      capped: counts.capped === true,
    },
  };
}

/* --------------------------------------------------------------------------
 * Counting
 *
 * Law 7: a session has visible edges, and a result list is a session too. The
 * count leads the results rather than trailing them, because a list that merely
 * runs out has told the reader nothing about how much there was.
 * -------------------------------------------------------------------------- */

export function isEmptyResult(result: SearchResult): boolean {
  return result.ideas.length === 0 && result.sources.length === 0;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "17 ideas in 6 sources" — what the whole catalogue holds for this query. */
export function countLine(result: SearchResult): string {
  const { ideas, sources } = result.counts;
  if (ideas === 0 && sources === 0) return 'Nothing matches';
  if (ideas === 0) return plural(sources, 'source', 'sources');
  if (sources === 0) return plural(ideas, 'idea', 'ideas');
  return `${plural(ideas, 'idea', 'ideas')} in ${plural(sources, 'source', 'sources')}`;
}

/**
 * The sentence that ends the list.
 *
 * Two different terminal states, and conflating them is the bug: a list showing
 * everything there is has ended, while a truncated one has been cut. Only the
 * second invites the reader to narrow the query — telling someone to be more
 * specific when they are already looking at every match is an instruction they
 * cannot act on.
 */
export function terminalLine(result: SearchResult): string {
  const shown = result.ideas.length;
  const { ideas, capped } = result.counts;
  if (ideas === 0) return '';
  if (!capped) return `That is every idea matching “${result.query}”.`;
  return `Showing the ${shown} closest of ${ideas}. Narrow the search to see others.`;
}
