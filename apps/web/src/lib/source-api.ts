import { rpcError } from './rpc-error.js';
import { supabase } from './supabase.js';

/**
 * One source, and what a reader still has to learn from it.
 *
 * `get_source_delta` has existed and been tested since round 1 with nothing calling
 * it. It answers the question the product is named for — *you already hold 14 of
 * these 18* — and until now that sentence appeared nowhere a reader could see.
 */

/**
 * The work, with columns enumerated.
 *
 * Never `select('*')`. `20260831013500` dropped the table grant on `works` and
 * re-granted every column except `content_hash`, so a star select is a permission
 * error rather than a fingerprint leak — the safe direction, and the reason a new
 * column is invisible to the API until someone grants it here too.
 */
const WORK_COLUMNS =
  'id, kind, title, subtitle, slug, year, description, source_url, ' +
  // The author, through the join table that has existed since round 1 and was written
  // by nothing but the seed migration until 20260901160000. Embedded rather than
  // fetched separately: a source page already makes several round trips and a byline
  // is not worth another.
  'work_contributors(role, contributor:contributors(name))';

export interface SourceWork {
  id: string;
  kind: string;
  title: string;
  subtitle: string | null;
  slug: string;
  year: number | null;
  description: string | null;
  /**
   * Where to read the original.
   *
   * Null for every work generated before `works.source_url` existed, and for a job
   * that supplied pasted text rather than a URL — so the page must render without it
   * rather than assuming it. `20260901160000` backfills the ones that can be matched.
   */
  sourceUrl: string | null;
  /** Credited authors, in the order the join table gives them. Often empty. */
  authors: string[];
}

export interface SourcePull {
  id: string;
  ordinal: number;
  headline: string;
  body: string;
  whyItMatters: string | null;
  /**
   * The longer form of the idea, and how long it takes.
   *
   * Both are already fetched by the feed and rendered nowhere: `FeedRow` carries
   * `explanation` and `estimatedReadSeconds` and the card shows neither. A card is
   * the wrong surface for them — it is meant to be one idea at a glance — but a
   * source page is exactly the place a reader has chosen to go deeper.
   */
  explanation: string | null;
  estimatedReadSeconds: number | null;
}

/** Both summary queries select the same columns; drift between them is a silent bug. */
const SUMMARY_COLUMNS =
  'id, title, elevator_pitch, why_it_matters, ' +
  'pulls(id, ordinal, headline, body, why_it_matters, explanation, estimated_read_seconds)';

interface SummaryRow {
  title: string | null;
  elevator_pitch: string | null;
  why_it_matters: string | null;
  pulls:
    | {
        id: string;
        ordinal: number;
        headline: string;
        body: string;
        why_it_matters: string | null;
        explanation: string | null;
        estimated_read_seconds: number | null;
      }[]
    | null;
}

function shapeSummary(row: SummaryRow): Omit<SourceDetail, 'work'> {
  return {
    summaryTitle: row.title,
    elevatorPitch: row.elevator_pitch,
    whyItMatters: row.why_it_matters,
    // Ordinal order, because `insertPulls` assigns it as the reading order and this
    // page is the one place the ideas are meant to be met in sequence rather than
    // ranked. Sorted here rather than in the query: PostgREST does not guarantee an
    // embedded resource's order without an explicit order on the embed.
    pulls: [...(row.pulls ?? [])]
      .sort((a, b) => a.ordinal - b.ordinal)
      .map((p) => ({
        id: p.id,
        ordinal: p.ordinal,
        headline: p.headline,
        body: p.body,
        whyItMatters: p.why_it_matters,
        explanation: p.explanation,
        estimatedReadSeconds: p.estimated_read_seconds,
      })),
  };
}

export interface SourceDetail {
  work: SourceWork;
  summaryTitle: string | null;
  elevatorPitch: string | null;
  whyItMatters: string | null;
  pulls: SourcePull[];
}

/**
 * Everything the source page renders, in two round trips.
 *
 * Published **and public**, deterministically ordered. Filtering on status alone was
 * not enough on either count:
 *
 * `summaries_author_insert` (20260830203352) permits a reader's own published-private
 * summary, and `summary_is_readable` lets them read it — so the canonical page could
 * quietly render their private row instead of the library's, for them and nobody else.
 *
 * And `get_source_delta` counts pulls across every readable published summary of the
 * work, so an unordered `limit(1)` could pair "you already hold 9 of these 18" with a
 * list of nine. The Delta describing a different summary than the one underneath it is
 * worse than no Delta: it is a specific, checkable claim that happens to be false.
 * `published_at` gives the pairing something stable to agree on.
 */
/** The shape PostgREST returns for `WORK_COLUMNS`, before it is given nicer names. */
interface WorkRow {
  id: string;
  kind: string;
  title: string;
  subtitle: string | null;
  slug: string;
  year: number | null;
  description: string | null;
  source_url: string | null;
  work_contributors:
    { role: string; contributor: { name: string } | { name: string }[] | null }[] | null;
}

/*
 * `contributor` arrives as an object or an array depending on how PostgREST resolves
 * the embed, so both are handled rather than assumed. Only `role = 'author'` is taken:
 * the table can hold translators, editors and narrators, and a byline that silently
 * included a translator would be a misattribution rather than extra credit.
 */
function toWork(r: WorkRow): SourceWork {
  const authors = (r.work_contributors ?? [])
    .filter((wc) => wc.role === 'author')
    .flatMap((wc) => (Array.isArray(wc.contributor) ? wc.contributor : [wc.contributor]))
    .map((c) => c?.name)
    .filter((n): n is string => Boolean(n));

  return {
    id: r.id,
    kind: r.kind,
    title: r.title,
    subtitle: r.subtitle,
    slug: r.slug,
    year: r.year,
    description: r.description,
    sourceUrl: r.source_url,
    authors,
  };
}

export async function fetchSource(
  workId: string,
  preferSummaryId?: string,
): Promise<SourceDetail | null> {
  const { data: workRows, error: workError } = await supabase
    .from('works')
    .select(WORK_COLUMNS)
    .eq('id', workId)
    .limit(1);
  if (workError) throw rpcError(workError);

  const workRow = (workRows ?? [])[0] as WorkRow | undefined;
  if (!workRow) return null;
  const work = toWork(workRow);

  /*
   * `preferSummaryId` names the summary a Pull actually belongs to.
   *
   * `/pull/:id` resolves to a *work*, and the page then picks a summary of its own
   * accord. When those differ the anchor `#p-<pullId>` names an element that is not
   * on the page, so a shared link lands at the top of a source whose ideas are not
   * the one that was shared — and nothing reports it, because every query succeeded.
   *
   * Falls back to the canonical row when the preferred one is not readable or not
   * published, so a stale link degrades to the right source rather than to an error.
   */
  const preferred = preferSummaryId ? await fetchSummaryById(preferSummaryId, workId) : null;
  if (preferred) return { work, ...preferred };

  const { data: summaryRows, error: summaryError } = await supabase
    .from('summaries')
    .select(SUMMARY_COLUMNS)
    .eq('work_id', workId)
    .eq('status', 'published')
    .eq('visibility', 'public')
    .order('published_at', { ascending: true })
    .limit(1);
  if (summaryError) throw rpcError(summaryError);

  const summary = (summaryRows ?? [])[0] as SummaryRow | undefined;
  if (!summary) {
    return { work, summaryTitle: null, elevatorPitch: null, whyItMatters: null, pulls: [] };
  }
  return { work, ...shapeSummary(summary) };
}

/** One specific summary, when a Pull named it. Null if it is gone or unreadable. */
async function fetchSummaryById(
  summaryId: string,
  workId: string,
): Promise<Omit<SourceDetail, 'work'> | null> {
  const { data, error } = await supabase
    .from('summaries')
    .select(SUMMARY_COLUMNS)
    .eq('id', summaryId)
    .eq('work_id', workId)
    .eq('status', 'published')
    .limit(1);
  // A failure here is not fatal: the caller falls back to the canonical summary.
  if (error) return null;
  const row = (data ?? [])[0] as SummaryRow | undefined;
  return row ? shapeSummary(row) : null;
}

/**
 * The work *and summary* a Pull belongs to, so `/pull/:id` can resolve to both.
 *
 * The deployed `og` Edge Function already redirects browsers to `${APP_ORIGIN}/pull/
 * ${id}`, a path that until now landed on the feed. This is what makes that promise
 * true rather than a redirect into the wrong screen.
 */
export async function fetchPullLocation(
  pullId: string,
): Promise<{ workId: string; summaryId: string } | null> {
  const { data, error } = await supabase
    .from('pulls')
    .select('summary_id, summaries(work_id)')
    .eq('id', pullId)
    .limit(1);
  if (error) throw rpcError(error);

  const row = (data ?? [])[0] as
    { summary_id: string; summaries: { work_id: string } | null } | undefined;
  const workId = row?.summaries?.work_id;
  return workId ? { workId, summaryId: row!.summary_id } : null;
}
