/**
 * The BAML taxonomy and the pipeline's taxonomy are the same taxonomy.
 *
 * `TOPIC_SLUGS` in `supabase/functions/_shared/providers.ts` is the source of
 * truth — it is what `narrowTopics` filters against and what the seeded
 * `public.topics` rows were created from. A BAML enum that drifts from it does
 * not fail loudly: the model returns a slug, the schema accepts it, and
 * `upsertWork` drops it, leaving a work classified under nothing and
 * unreachable by anyone's stated interests.
 *
 * Read as text rather than imported. That module is Deno source outside this
 * package's `rootDir`, and importing it would drag a build-graph edge across a
 * boundary that exists on purpose. The list is a plain `as const` array, so
 * reading it is unambiguous — and a change to its shape fails this test rather
 * than silently matching nothing, because the extraction below asserts it found
 * a non-empty list.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TOPIC_SLUG_BY_MEMBER } from './topics.js';

const PROVIDERS = fileURLToPath(
  new URL('../../../supabase/functions/_shared/providers.ts', import.meta.url),
);

function pipelineTopicSlugs(): string[] {
  const source = readFileSync(PROVIDERS, 'utf8');
  const block = /export const TOPIC_SLUGS = \[([\s\S]*?)\] as const;/.exec(source);
  if (!block?.[1]) throw new Error(`TOPIC_SLUGS not found in ${PROVIDERS}`);
  return [...block[1].matchAll(/'([a-z-]+)'/g)].map((m) => m[1] as string);
}

describe('topic taxonomy parity', () => {
  it('extracts a non-empty list from the pipeline', () => {
    // Guards the regex itself: a refactor that renames or reformats TOPIC_SLUGS
    // must fail here rather than make every assertion below vacuously true.
    expect(pipelineTopicSlugs().length).toBeGreaterThan(20);
  });

  it('maps every BAML member to a slug the pipeline accepts', () => {
    const pipeline = new Set(pipelineTopicSlugs());
    for (const slug of Object.values(TOPIC_SLUG_BY_MEMBER)) {
      expect(pipeline.has(slug), `${slug} is not in TOPIC_SLUGS`).toBe(true);
    }
  });

  it('covers every slug the pipeline accepts', () => {
    // The other direction, and the one that actually bites: a migration adds a
    // topic, the pipeline mirror follows, and BAML can never emit it — so the
    // new topic has no route into any generated work.
    const mapped = new Set(Object.values(TOPIC_SLUG_BY_MEMBER));
    for (const slug of pipelineTopicSlugs()) {
      expect(mapped.has(slug), `${slug} has no BAML enum member`).toBe(true);
    }
  });

  it('maps each member to a distinct slug', () => {
    const slugs = Object.values(TOPIC_SLUG_BY_MEMBER);
    expect(new Set(slugs).size).toBe(slugs.length);
  });
});
