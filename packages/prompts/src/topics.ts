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
// `import type`, deliberately: `baml_sdk/index.ts` calls
// `initializeRuntimeFromBytecode` at module scope, so a value import would boot the
// native addon in every consumer of this package. The keys below are the enum's
// string values, so `Record<TopicSlug, string>` stays total either way -- adding a
// member to the BAML enum without adding its slug here still fails `pnpm typecheck`.
import type { TopicSlug } from '../baml_sdk/index.js';

/** Every BAML topic member, mapped to the `topics.slug` it stands for. */
export const TOPIC_SLUG_BY_MEMBER: Record<TopicSlug, string> = {
  Philosophy: 'philosophy',
  Ethics: 'ethics',
  Stoicism: 'stoicism',
  Logic: 'logic',
  Metaphysics: 'metaphysics',
  Aesthetics: 'aesthetics',
  Psychology: 'psychology',
  Attention: 'attention',
  Habits: 'habits',
  Learning: 'learning',
  Emotion: 'emotion',
  Science: 'science',
  Evolution: 'evolution',
  Physics: 'physics',
  Chemistry: 'chemistry',
  Astronomy: 'astronomy',
  Medicine: 'medicine',
  Society: 'society',
  Economics: 'economics',
  Liberty: 'liberty',
  Government: 'government',
  Justice: 'justice',
  Education: 'education',
  ArtsAndLetters: 'arts-and-letters',
  Literature: 'literature',
  Rhetoric: 'rhetoric',
  Criticism: 'criticism',
  History: 'history',
  Biography: 'biography',
  Revolutions: 'revolutions',
  Mathematics: 'mathematics',
  Computation: 'computation',
  Architecture: 'architecture',
  WorldPhilosophy: 'world-philosophy',
  Strategy: 'strategy',
  Ecology: 'ecology',
};

/** The slug a generated topic actually files a work under. */
export function topicSlugOf(member: TopicSlug): string {
  return TOPIC_SLUG_BY_MEMBER[member];
}
