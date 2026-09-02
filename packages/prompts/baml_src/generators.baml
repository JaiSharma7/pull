// Generated client for the BAML functions in this directory.
//
// Committed rather than gitignored, for the same reason
// `packages/db/src/database.types.ts` is: a generated file nobody can see is a
// generated file nobody notices going stale. `pnpm baml:generate` rewrites it and
// CI diffs it byte-for-byte.
//
// One generator only. The Edge Functions are Deno and cannot load BAML's native
// Node runtime (see docs/baml.md), so a second `output_type` aimed at them would
// emit a client that imports a `.node` binary into an isolate that has no loader
// for one. That boundary is crossed over HTTP, not by a second generator.
generator typescript {
    output_type "typescript"
    output_dir "../"
    version "0.226.2"
    default_client_mode async
}
