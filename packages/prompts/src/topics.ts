/**
 * BAML's enum member names are not the database's topic slugs.
 *
 * This is the one place the generated client will quietly do the wrong thing.
 * `TopicSlug.ArtsAndLetters` carries the *value* `"ArtsAndLetters"` in generated
 * TypeScript — the `@alias("arts-and-letters")` only shapes the prompt and the
 * parse. Handing that value to `upsertWork` would look like a successful
 * classification and land as nothing, because that function looks slugs up
 * against `public.topics` and silently drops what it cannot find. That is the
 * exact failure `topics` was added to fix.
 *
 * So the crossing is written down once, exhaustively. `Record<TopicSlug, string>`
 * is total by construction: adding a member to the BAML enum without adding its
 * slug here fails `pnpm typecheck`, in the same commit, the same way
 * `packages/db/src/enum-parity.ts` catches a drifted database enum.
 */
import { TopicSlug } from '../baml_client/types.js';

/** Every BAML topic member, mapped to the `topics.slug` it stands for. */
export const TOPIC_SLUG_BY_MEMBER: Record<TopicSlug, string> = {
  [TopicSlug.Philosophy]: 'philosophy',
  [TopicSlug.Ethics]: 'ethics',
  [TopicSlug.Stoicism]: 'stoicism',
  [TopicSlug.Logic]: 'logic',
  [TopicSlug.Metaphysics]: 'metaphysics',
  [TopicSlug.Aesthetics]: 'aesthetics',
  [TopicSlug.Psychology]: 'psychology',
  [TopicSlug.Attention]: 'attention',
  [TopicSlug.Habits]: 'habits',
  [TopicSlug.Learning]: 'learning',
  [TopicSlug.Emotion]: 'emotion',
  [TopicSlug.Science]: 'science',
  [TopicSlug.Evolution]: 'evolution',
  [TopicSlug.Physics]: 'physics',
  [TopicSlug.Chemistry]: 'chemistry',
  [TopicSlug.Astronomy]: 'astronomy',
  [TopicSlug.Medicine]: 'medicine',
  [TopicSlug.Society]: 'society',
  [TopicSlug.Economics]: 'economics',
  [TopicSlug.Liberty]: 'liberty',
  [TopicSlug.Government]: 'government',
  [TopicSlug.Justice]: 'justice',
  [TopicSlug.Education]: 'education',
  [TopicSlug.ArtsAndLetters]: 'arts-and-letters',
  [TopicSlug.Literature]: 'literature',
  [TopicSlug.Rhetoric]: 'rhetoric',
  [TopicSlug.Criticism]: 'criticism',
  [TopicSlug.History]: 'history',
  [TopicSlug.Biography]: 'biography',
  [TopicSlug.Revolutions]: 'revolutions',
};

/** The slug a generated topic actually files a work under. */
export function topicSlugOf(member: TopicSlug): string {
  return TOPIC_SLUG_BY_MEMBER[member];
}
