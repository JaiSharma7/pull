import { rpcError } from './rpc-error.js';
import { supabase } from './supabase.js';

/**
 * The Daily Pull.
 *
 * `daily_pulls` has been created, seeded and RLS'd with a public read policy since
 * `20260829124635_feeds.sql`, and it has had **no readers**: no RPC selects it and no
 * client code referenced it. The only occurrence of the phrase anywhere in the app was
 * a `<p className="meta">Daily Pull</p>` label in `packages/ui/src/components/Enough.tsx`.
 * It was a string, not a feature — while "curated Daily Pulls" is one of the five
 * things CLAUDE.md law 3 promises free forever.
 */

/**
 * Columns enumerated, never `select('*')` on `works`.
 *
 * `20260831013500` dropped the table grant and re-granted every column except
 * `content_hash`, so a star select is a permission error rather than a leak — the safe
 * direction, and the reason this list has to be written out.
 */
const DAILY_COLUMNS =
  'ordinal, blurb, curator, ' +
  'pulls(id, headline, body, why_it_matters, ' +
  'summaries(title, works(id, title, kind, year)))';

export interface DailyPull {
  pullId: string;
  ordinal: number;
  /** The curator's note. Null where the row carries none. */
  blurb: string | null;
  curator: string;
  headline: string;
  body: string;
  whyItMatters: string | null;
  workId: string;
  workTitle: string;
  workKind: string;
  workYear: number | null;
  summaryTitle: string | null;
}

export interface DailyCuration {
  /** The day these were curated for, as `YYYY-MM-DD`. */
  day: string;
  pulls: DailyPull[];
}

interface DailyRow {
  ordinal: number;
  blurb: string | null;
  curator: string;
  pulls: {
    id: string;
    headline: string;
    body: string;
    why_it_matters: string | null;
    summaries: {
      title: string | null;
      works: { id: string; title: string; kind: string; year: number | null } | null;
    } | null;
  } | null;
}

/** The reader's own calendar day, as Postgres writes a `date`. */
function today(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * The most recent curation at or before the reader's today, or null if there is none.
 *
 * **Not strictly `day = current_date`,** and that is deliberate. Two things go wrong
 * with an exact match. The reader's calendar day and the database's are not the same
 * day for several hours out of every twenty-four, so a reader east of the server would
 * see an empty screen while a curation sat waiting. And the job that fills today's row
 * can be late or can not have run at all — every one of the five seeded rows carries
 * the `current_date` of the migration that inserted it, so an exact match returns
 * nothing at all today.
 *
 * Showing the most recent curation and **naming its date** is both more useful and
 * more honest than showing nothing: the reader gets the ideas, and the screen does not
 * claim they are today's when they are not. What it will never do is invent one.
 *
 * Two round trips rather than one: find the day, then read it. A single query would
 * have to over-fetch and group client-side, and PostgREST caps a response at
 * `max_rows` (100) — a bound that is invisible until the day it truncates something.
 */
export async function fetchDailyCuration(): Promise<DailyCuration | null> {
  const { data: dayRows, error: dayError } = await supabase
    .from('daily_pulls')
    .select('day')
    .lte('day', today())
    .order('day', { ascending: false })
    .limit(1);
  if (dayError) throw rpcError(dayError);

  const day = (dayRows ?? [])[0]?.day as string | undefined;
  if (!day) return null;

  const { data, error } = await supabase
    .from('daily_pulls')
    .select(DAILY_COLUMNS)
    .eq('day', day)
    .order('ordinal', { ascending: true });
  if (error) throw rpcError(error);

  const pulls = ((data ?? []) as unknown as DailyRow[]).flatMap((r) => {
    const pull = r.pulls;
    const work = pull?.summaries?.works;
    // A curated row whose pull or work is no longer readable is dropped rather than
    // rendered half-empty. `daily_pulls` is publicly readable but `pulls` is not, so
    // the join can legitimately come back null for a summary that was unpublished
    // after it was curated.
    if (!pull || !work) return [];
    return [
      {
        pullId: pull.id,
        ordinal: r.ordinal,
        blurb: r.blurb,
        curator: r.curator,
        headline: pull.headline,
        body: pull.body,
        whyItMatters: pull.why_it_matters,
        workId: work.id,
        workTitle: work.title,
        workKind: work.kind,
        workYear: work.year,
        summaryTitle: pull.summaries?.title ?? null,
      } satisfies DailyPull,
    ];
  });

  // A day whose every row has become unreadable is the same as no curation, and
  // saying so is better than rendering a heading over an empty list.
  return pulls.length > 0 ? { day, pulls } : null;
}
