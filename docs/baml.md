# BAML

Prompts, their output schemas, and their tests are source files in
`packages/prompts/baml_src`. A generated TypeScript SDK is committed beside them in
`packages/prompts/baml_sdk`, and CI check 2 regenerates it and diffs it byte-for-byte —
the same arrangement `packages/db/src/database.types.ts` has, for the same reason.

## Why

Three things describe one contract today, in three places, by hand:

| Where                                         | What it holds                          |
| --------------------------------------------- | -------------------------------------- |
| `_shared/providers.ts` → `CanonicalSummary`   | the TypeScript shape                   |
| `_shared/gemini.ts` → `SUMMARY_SCHEMA`        | the same shape as a Gemini JSON schema |
| `_shared/providers.ts` → `buildSummaryPrompt` | the prompt that asks for it            |

Nothing checks that the three agree. `anthropic.ts` carries a fourth copy, because
Anthropic's tool-use schema is not Gemini's `responseSchema`. Adding a field to a Pull
means editing four places and finding out in production which one was missed — and the
failure is quiet: the schema still validates, the field is absent, the feature no-ops.
`topics` and `question` were both added under exactly that hazard, and both carry a
comment in `providers.ts` explaining what silently returns zero when they are absent.

BAML makes the shape the source and derives the rest. `WriteCanonicalSummary` in
`canonical_summary.baml` is the prompt, the schema and the parse, and `baml check`
fails on a `.baml` file that does not compile.

## What is set up, and what is not

Set up:

- `packages/prompts` — a workspace package holding `baml.toml`, `baml_src`, the generated `baml_sdk`,
  and the small hand-written surface in `src/` that the rest of the monorepo may import.
- `pnpm baml:check` / `pnpm baml:generate` / `pnpm baml:test` at the root.
- CI check 2 fails on a stale generated SDK or an invalid `.baml` source.
- A parity test binding the BAML `TopicSlug` enum to `TOPIC_SLUGS` in the pipeline, in
  both directions.

**Not** set up, and deliberately: nothing in `supabase/functions` calls BAML. The
pipeline still runs `buildSummaryPrompt` and `SUMMARY_SCHEMA`. See the next section for
why that crossing is not a one-line import.

## The Deno boundary

BAML's TypeScript runtime is a napi native addon — `@boundaryml/baml-bridge-linux-x64-gnu` and
seven siblings. Supabase Edge Functions are Deno isolates and cannot load a `.node`
binary. So the generated SDK cannot be imported by `worker/index.ts`, and no
`output_type` fixes that: the generator emits TypeScript that imports the addon.

There are three ways across, and they are not equally good:

1. **`baml serve`** — BAML runs as an HTTP service; the Edge Function posts to it.
   Adds a hop, a deployment, and a place for the provider key to live that is neither
   Edge Function secrets nor Vault. Law 7 has opinions about the third.
2. **Move generation to a Node runtime** and leave Edge Functions holding only queue
   mechanics. The largest change, and the one that removes the 150s wall clock that
   forces the twelve-step split in the first place.
3. **Use BAML for authoring and testing only** — the `.baml` file is where the prompt and
   schema are written and reviewed, and a generator emits the plain prompt string and
   JSON schema that the existing Deno providers already consume. No runtime dependency
   crosses the boundary at all.

**Decided: (3), and it is built.** `pnpm baml:export` uses the standalone BAML CLI
at build time. It renders each function's prompt into a template with `{{name}}` placeholders,
records the client and the model it pins, and emits the return type as plain JSON Schema —
with the topic enum as the database slugs (from `@alias`) and the array bounds preserved —
and writes the lot to `supabase/functions/_shared/generated/prompts.ts`. The Deno providers import
that file; `gemini.ts` converts the schema to Gemini's dialect at module load and
`anthropic.ts` hands it to its tool as-is. `_shared/prompts.test.ts` pins what they rely
on. CI check 2 regenerates the export and fails on any difference.

The sidecar route (1) was built and verified first, then closed unmerged
when this landed within its timebox; its branch remains for reference.

Two limits of the export, stated rather than discovered:

- A template cannot carry a conditional on an argument's value, because a placeholder
  must be the argument verbatim; the exporter refuses a transformed argument. The
  fallback for an empty context therefore lives in `buildSummaryPrompt`.
- Each function must name one pinned client; the exporter refuses a fallback or
  round-robin client, because retry and fallback belong in the worker, where the ledger
  is.

## Enum members are not slugs

The generated `TopicSlug.ArtsAndLetters` has the _value_ `"ArtsAndLetters"`. The
`@alias("arts-and-letters")` shapes the prompt and the parse, not the emitted TypeScript.
Handing the member value to `upsertWork` looks like a successful classification and lands
as nothing, because that function looks slugs up against `public.topics` and drops what it
cannot find.

`packages/prompts/src/topics.ts` writes the crossing down once as a
`Record<TopicSlug, string>`, which is total by construction: a member added without a slug
fails `pnpm typecheck`. Import `topicSlugOf`, never the enum value.

## Cost law still applies

BAML is a way of writing model calls, not a licence to make more of them. Law 2 is
unchanged: models run at generation time, once per canonical summary, and every call
writes to `cost_ledger`. BAML's own retry and fallback policies are worth reading twice
against that — `createFallbackSummaryProvider` falls through only on
`ProviderUnavailableError`, precisely so a _billed_ failure reaches the ledger instead of
being retried elsewhere for free-looking. BAML's `fallback` provider has no such
distinction, so anything routed through `SummaryChain` must still meter each attempt
itself.

## The toolchain

Installed using Boundary's official standalone installer:
```bash
curl -fsSL https://pkg.boundaryml.com/install.sh | sh
```
(or `install.ps1` via PowerShell on Windows).

The standalone toolchain provides the official `baml` CLI (version `0.17.0 (canary)` with
wrapper `0.2.4`): `baml check`, `baml generate`, `baml test`, `baml run`, `baml describe`,
`baml agent install`, and `baml init`.

The TypeScript project integrates with `@boundaryml/baml-bridge`, which provides the
runtime bindings for generated code in `packages/prompts/baml_sdk`. Code generation is
configured in `packages/prompts/baml.toml`.

