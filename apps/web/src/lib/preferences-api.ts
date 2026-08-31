import { WORK_KINDS, type WorkKind } from '@wap/schemas';
import { toStances, toStoredColumns, type TopicStance } from './preferences.js';
import { supabase } from './supabase.js';

/**
 * Reading preferences: the one screen that makes the largest ranking signal real.
 *
 * `topic_affinity` is 28% of the score in `get_feed`, computed as
 * `max(topic_weights ->> slug * work_topics.weight)` over a work's topics. Until a
 * reader states a preference every card scores the same on it, so this is not a
 * settings page in the ordinary sense — it is the input the feed has been missing.
 *
 * No RPC and no migration. `preference_profiles_own` is
 * `for all using ((select auth.uid()) = user_id)`, so a reader reads and writes their
 * own row straight through PostgREST, and `topics_read_all` is `select using (true)`.
 * The row itself already exists: `handle_new_user` creates one at sign-up.
 */

/** PostgREST's `max_rows` (supabase/config.toml). Every list read here pages by it. */
const PAGE = 100;

/** A topic as the picker offers it, with its parent for grouping. */
export interface TopicOption {
  slug: string;
  label: string;
  parentSlug: string | null;
  /** The parent's display label, resolved even when the parent has no works itself. */
  parentLabel: string | null;
}

export interface Preferences {
  stances: Record<string, TopicStance>;
  mediaKinds: WorkKind[];
  /** 0 disables interleaved questions entirely; see `plan_interleave`. */
  interruptRate: number;
  onboardedAt: string | null;
}

/** Every topic row, paged. There are ~30 today; `max_rows` still applies. */
async function allTopics(): Promise<
  { id: string; slug: string; label: string; parent_id: string | null }[]
> {
  const out: { id: string; slug: string; label: string; parent_id: string | null }[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('topics')
      .select('id, slug, label, parent_id')
      // Ordered so the pages partition the set: without it PostgREST may return rows
      // in any order and a range walk can repeat or skip.
      .order('slug', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const rows = (data ?? []) as typeof out;
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
}

/**
 * Topic ids with at least one **published** work behind them.
 *
 * Published is the part that matters. `work_topics` alone counts drafts and private
 * summaries, so a topic backed only by those passes the filter and still resolves to
 * an empty feed — the exact failure the filter exists to prevent. Intersecting with
 * published summaries is what makes "has works" mean what the picker claims.
 */
async function topicIdsWithPublishedWorks(): Promise<Set<string>> {
  /*
   * Two plain queries rather than one nested embed.
   *
   * PostgREST can express this as `work_topics -> works!inner -> summaries!inner`
   * with a filter on the embedded status, and that would be one round trip instead
   * of two. It is also syntax that fails as a 400 at runtime rather than at compile
   * time, and nothing in this repo can exercise it before deploy: the agent
   * container has no route to the REST API, and the generated types do not check
   * embedded filter paths. A picker that fails to load is a worse outcome than one
   * extra request over a few hundred rows, so this uses shapes already proven
   * elsewhere in `lib/api.ts`.
   */
  const publishedWorkIds = new Set<string>();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('summaries')
      .select('work_id')
      .eq('status', 'published')
      .order('work_id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const rows = (data ?? []) as { work_id: string | null }[];
    for (const r of rows) if (r.work_id) publishedWorkIds.add(r.work_id);
    if (rows.length < PAGE) break;
  }

  const ids = new Set<string>();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('work_topics')
      .select('topic_id, work_id')
      .order('topic_id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const rows = (data ?? []) as { topic_id: string; work_id: string }[];
    for (const r of rows) if (publishedWorkIds.has(r.work_id)) ids.add(r.topic_id);
    if (rows.length < PAGE) return ids;
  }
}

/**
 * Topics a reader can choose between.
 *
 * Read from the database rather than a hardcoded list, so a taxonomy the corpus grows
 * into is offered without a frontend change.
 *
 * `onlyWithWorks` filters to topics something published is actually filed under. A
 * picker that offers a choice resolving to an empty feed is worse than one that does
 * not offer it, and the taxonomy deliberately runs ahead of the corpus.
 *
 * Parent labels resolve from the *unfiltered* set on purpose: a parent can be empty
 * while its children are not, and a heading reading `psychology` instead of
 * "Psychology" is the visible symptom of filtering before grouping.
 */
export async function fetchTopics(onlyWithWorks = true): Promise<TopicOption[]> {
  const [topics, withWorks] = await Promise.all([
    allTopics(),
    onlyWithWorks ? topicIdsWithPublishedWorks() : Promise.resolve(null),
  ]);

  const byId = new Map(topics.map((t) => [t.id, t]));

  return topics
    .filter((t) => !withWorks || withWorks.has(t.id))
    .map((t) => {
      const parent = t.parent_id ? byId.get(t.parent_id) : undefined;
      return {
        slug: t.slug,
        label: t.label,
        parentSlug: parent?.slug ?? null,
        parentLabel: parent?.label ?? null,
      };
    });
}

/** A reader's stored preferences, or null if the row is somehow missing. */
export async function fetchPreferences(userId: string): Promise<Preferences | null> {
  const { data, error } = await supabase
    .from('preference_profiles')
    .select('topic_weights, excluded_topics, media_kinds, interrupt_rate, onboarded_at')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;

  const row = data as unknown as {
    topic_weights: Record<string, number> | null;
    excluded_topics: string[] | null;
    media_kinds: WorkKind[] | null;
    interrupt_rate: number | null;
    onboarded_at: string | null;
  };

  return {
    stances: toStances(row.topic_weights, row.excluded_topics),
    mediaKinds: row.media_kinds ?? [],
    interruptRate: row.interrupt_rate ?? 1,
    onboardedAt: row.onboarded_at,
  };
}

/**
 * Persist a reader's choices, and mark them onboarded.
 *
 * `onboarded_at` is set by every save rather than only by the first-run screen. A
 * reader who opens settings and saves has stated their preferences as surely as one
 * who came through onboarding, and asking again afterwards would be the app failing
 * to notice it had been answered.
 */
export async function savePreferences(
  userId: string,
  prefs: { stances: Record<string, TopicStance>; mediaKinds: WorkKind[]; interruptRate: number },
): Promise<void> {
  const { topicWeights, excluded } = toStoredColumns(prefs.stances);

  /*
   * `.select()` so a save that matched nothing is an error rather than a shrug.
   *
   * An UPDATE affecting zero rows is a success as far as PostgREST is concerned, so
   * without this a reader whose `preference_profiles` row is missing — or invisible
   * to them under RLS — would watch the screen say "Saved" having changed nothing.
   * `handle_new_user` should make that impossible; this is what proves it rather than
   * assuming it.
   */
  const { data, error } = await supabase
    .from('preference_profiles')
    .update({
      topic_weights: topicWeights,
      excluded_topics: excluded,
      media_kinds: prefs.mediaKinds,
      interrupt_rate: prefs.interruptRate,
      onboarded_at: new Date().toISOString(),
    })
    .eq('user_id', userId)
    .select('user_id');
  if (error) throw error;
  if (!data || data.length === 0) {
    throw new Error('No preferences row to update. Sign out and back in, then try again.');
  }
}

/**
 * Media kinds the corpus actually contains, so the picker offers nothing empty.
 *
 * Paged: `max_rows` is 100, and an unpaged read would silently stop finding kinds once
 * the corpus passes it — losing exactly the newer media this control exists to admit.
 *
 * Narrowed against `WORK_KINDS` rather than trusted as strings, and returned in the
 * enum's own order so the picker does not re-order itself the day a medium appears.
 */
export async function fetchAvailableMediaKinds(): Promise<WorkKind[]> {
  const present = new Set<string>();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('works')
      .select('id, kind')
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const rows = (data ?? []) as { id: string; kind: string }[];
    for (const r of rows) present.add(r.kind);
    if (rows.length < PAGE) break;
  }
  return WORK_KINDS.filter((k) => present.has(k));
}

export { toStances, toStoredColumns, type TopicStance } from './preferences.js';
