/**
 * The preference mapping, with no I/O.
 *
 * Separate from `preferences-api.ts` for the same reason `library.ts` is separate:
 * importing the Supabase client throws at module scope without env vars, so logic
 * that lives beside it cannot be unit-tested at all. This half is pure and is where
 * the rules that would fail silently are written down.
 */

/**
 * What a reader has said about one topic.
 *
 * Three states rather than a checkbox, because the model genuinely has three and
 * collapsing them loses the middle one. `excluded_topics` is a different mechanism
 * from a low weight: exclusion drops the work from `get_feed`'s pool outright, while
 * a weight only changes where it ranks. "Default" is the absence of both — no opinion
 * stated, which is not the same as no interest.
 */
export type TopicStance = 'more' | 'default' | 'less';

/** The weight a "more of this" topic carries into `topic_affinity`. */
const PREFERRED_WEIGHT = 1;

/**
 * Stances → the two columns Postgres stores them in.
 *
 * Pure, and separated from the write so it can be tested without a database. The
 * mapping is not symmetric and that asymmetry is the whole reason it deserves a test:
 * "default" is written to *neither* column, because `topic_affinity` reads a missing
 * key as no preference, while writing a zero would say "actively uninterested" — a
 * claim `excluded_topics` already makes properly, and one the reader did not make.
 */
export function toStoredColumns(stances: Record<string, TopicStance>): {
  topicWeights: Record<string, number>;
  excluded: string[];
} {
  const topicWeights: Record<string, number> = {};
  const excluded: string[] = [];
  for (const [slug, stance] of Object.entries(stances)) {
    if (stance === 'more') topicWeights[slug] = PREFERRED_WEIGHT;
    else if (stance === 'less') excluded.push(slug);
  }
  return { topicWeights, excluded };
}

/**
 * The two columns → stances, for rendering the picker.
 *
 * Exclusion is applied second and wins. A slug in both columns is a contradiction
 * the database does not prevent, and honouring the more explicit statement is the
 * safer resolution: showing "Not for me" for something being filtered out is
 * truthful, while showing "More of this" for it would not be.
 */
export function toStances(
  topicWeights: Record<string, number> | null,
  excluded: string[] | null,
): Record<string, TopicStance> {
  const stances: Record<string, TopicStance> = {};
  for (const slug of Object.keys(topicWeights ?? {})) stances[slug] = 'more';
  for (const slug of excluded ?? []) stances[slug] = 'less';
  return stances;
}
