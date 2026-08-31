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

/** A topic as the picker offers it, with its parent for grouping. */
export interface TopicOption {
  slug: string;
  label: string;
  parentSlug: string | null;
}

export interface Preferences {
  stances: Record<string, TopicStance>;
  mediaKinds: WorkKind[];
  /** 0 disables interleaved questions entirely; see `plan_interleave`. */
  interruptRate: number;
  onboardedAt: string | null;
}

/**
 * Topics a reader can choose between.
 *
 * Read from the database rather than a hardcoded list, so a taxonomy the corpus
 * grows into is offered without a frontend change.
 *
 * `hasWorks` filters to topics with at least one work behind them. A picker that
 * offers a choice resolving to an empty feed is worse than one that does not offer
 * it, and the taxonomy deliberately runs ahead of the corpus — several topics exist
 * today with nothing filed under them yet.
 */
export async function fetchTopics(hasWorks = true): Promise<TopicOption[]> {
  const { data, error } = await supabase
    .from('topics')
    .select('slug, label, parent_id, parent:parent_id(slug), work_topics(topic_id)')
    .order('slug');
  if (error) throw error;

  const rows = (data ?? []) as unknown as {
    slug: string;
    label: string;
    parent_id: string | null;
    parent: { slug: string } | null;
    work_topics: { topic_id: string }[] | null;
  }[];

  return rows
    .filter((r) => !hasWorks || (r.work_topics?.length ?? 0) > 0)
    .map((r) => ({ slug: r.slug, label: r.label, parentSlug: r.parent?.slug ?? null }));
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
 *
 * Only "more" and "less" are written. A "default" topic appears in neither column,
 * because `topic_affinity` treats a missing key as no preference — writing a zero
 * would instead say "actively uninterested", which is what `excluded_topics` is for.
 */
export async function savePreferences(
  userId: string,
  prefs: { stances: Record<string, TopicStance>; mediaKinds: WorkKind[]; interruptRate: number },
): Promise<void> {
  const { topicWeights, excluded } = toStoredColumns(prefs.stances);

  const { error } = await supabase
    .from('preference_profiles')
    .update({
      topic_weights: topicWeights,
      excluded_topics: excluded,
      media_kinds: prefs.mediaKinds,
      interrupt_rate: prefs.interruptRate,
      onboarded_at: new Date().toISOString(),
    })
    .eq('user_id', userId);
  if (error) throw error;
}

/**
 * Media kinds the corpus actually contains, so the picker offers nothing empty.
 *
 * Narrowed against `WORK_KINDS` rather than trusted as strings. `media_kinds` is a
 * `work_kind[]` column, and this repo has now been bitten three times by a value that
 * TypeScript accepted, PostgREST forwarded, and Postgres refused at the end. Sorting
 * by the enum's own order keeps the picker stable as the corpus grows, instead of
 * re-ordering itself the day a new medium appears.
 */
export async function fetchAvailableMediaKinds(): Promise<WorkKind[]> {
  const { data, error } = await supabase.from('works').select('kind');
  if (error) throw error;
  const present = new Set((data ?? []).map((r) => (r as { kind: string }).kind));
  return WORK_KINDS.filter((k) => present.has(k));
}

export { toStances, toStoredColumns, type TopicStance } from './preferences.js';
