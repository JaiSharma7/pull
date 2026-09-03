/**
 * BAML prompts and their generated client, as the rest of the monorepo sees them.
 *
 * The generated `baml_sdk` is deliberately not the public surface. Its enum values
 * are not database slugs, and `baml_sdk/index.ts` calls
 * `initializeRuntimeFromBytecode` at module scope — so importing it *at all* boots a
 * native NAPI addon and 3.3 MB of bytecode. Everything crossing this file is
 * therefore either hand-written here or `export type`, which erases at compile time.
 * Nothing below causes a consumer of `@wap/prompts` to load the runtime, and
 * `@boundaryml/baml-bridge` is a devDependency so it does not follow the package.
 *
 * Nothing here runs in the read path (law 2), and nothing here runs in a Supabase
 * Edge Function either — BAML's TypeScript runtime is a napi binary and Deno
 * isolates cannot load one. See docs/baml.md.
 */
export { TOPIC_SLUG_BY_MEMBER, topicSlugOf } from './topics.js';
export type { TopicSlug } from '../baml_sdk/index.js';
export type { CanonicalSummary, Pull, RecallQuestion } from '../baml_sdk/index.js';
