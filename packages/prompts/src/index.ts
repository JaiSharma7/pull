/**
 * BAML prompts and their generated client, as the rest of the monorepo sees them.
 *
 * The generated `baml_client` is deliberately not the public surface. It carries
 * `@ts-nocheck`, its enum values are not database slugs, and it imports a native
 * Node addon — three things every consumer would otherwise have to know. What is
 * exported here is the part that is safe to depend on.
 *
 * Nothing here runs in the read path (law 2), and nothing here runs in a Supabase
 * Edge Function either — BAML's TypeScript runtime is a napi binary and Deno
 * isolates cannot load one. See docs/baml.md.
 */
export { TOPIC_SLUG_BY_MEMBER, topicSlugOf } from './topics.js';
export { TopicSlug } from '../baml_client/types.js';
export type { CanonicalSummary, Pull, RecallQuestion } from '../baml_client/types.js';
