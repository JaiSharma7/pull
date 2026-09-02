# BAML

Prompts, their output schemas, and their tests are source files in
`packages/prompts/baml_src`. A generated TypeScript client is committed beside them in
`packages/prompts/baml_client`, and CI check 2 regenerates it and diffs it byte-for-byte —
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
`canonical_summary.baml` is the prompt, the schema and the parse, and `baml-cli check`
fails on a `.baml` file that does not typecheck against its own asserts.

## What is set up, and what is not

Set up:

- `packages/prompts` — a workspace package holding `baml_src`, the generated client, and
  the small hand-written surface in `src/` that the rest of the monorepo may import.
- `pnpm baml:check` / `pnpm baml:generate` / `pnpm baml:test` at the root.
- CI check 2 fails on a stale generated client or an invalid `.baml` source.
- A parity test binding the BAML `TopicSlug` enum to `TOPIC_SLUGS` in the pipeline, in
  both directions.

**Not** set up, and deliberately: nothing in `supabase/functions` calls BAML. The
pipeline still runs `buildSummaryPrompt` and `SUMMARY_SCHEMA`. See the next section for
why that crossing is not a one-line import.

## The Deno boundary

BAML's TypeScript runtime is a napi native addon — `@boundaryml/baml-linux-x64-gnu` and
seven siblings. Supabase Edge Functions are Deno isolates and cannot load a `.node`
binary. So the generated client cannot be imported by `worker/index.ts`, and no
`output_type` fixes that: the generator emits TypeScript that imports the addon.

There are three ways across, and they are not equally good:

1. **`baml-cli serve`** — BAML runs as an HTTP service; the Edge Function posts to it.
   Adds a hop, a deployment, and a place for the provider key to live that is neither
   Edge Function secrets nor Vault. Law 7 has opinions about the third.
2. **Move generation to a Node runtime** and leave Edge Functions holding only queue
   mechanics. The largest change, and the one that removes the 150s wall clock that
   forces the twelve-step split in the first place.
3. **Use BAML for authoring and testing only** — the `.baml` file is where the prompt and
   schema are written and reviewed, and a generator emits the plain prompt string and
   JSON schema that the existing Deno providers already consume. No runtime dependency
   crosses the boundary at all.

**Decided (Fable 5.1): (1), the sidecar, for now.** It is the only one of the three that
works today without a spike. What it costs is a deployment, a network hop inside the
generation path, and a new place for a provider key to live — which is why law 7 in
`CLAUDE.md` carries two rows for it and the three conditions under which that is
acceptable: not publicly reachable, key held in the sidecar's environment only, every
call metered by the worker. Getting BAML into the Edge Function properly — (3), through
a WASM build of the schema engine — is a separate, timeboxed track; if it lands, the
sidecar and the two law rows go.

## Running the sidecar

`packages/prompts/src/server.ts` is the process. It is not `baml-cli serve`: that
command's `/call/<Function>` returns the parsed result and nothing else (verified
against its own OpenAPI document), so a worker behind it could not write `cost_ledger`.
This one answers with the result, the usage summed over every attempt BAML made, the
client that answered and the model it pins — and a failure after a billed attempt is a
`502` with `billed: true` and the same usage, which the worker turns into the same
`BilledProviderError` it raises for any other vendor.

```bash
# in the database, once (returns the token; it is not shown again)
select public.mint_baml_sidecar_token();

# where the sidecar runs
export BAML_SIDECAR_TOKEN='<the token>'    # refuses to start without one
export GOOGLE_AI_API_KEY='<provider key>'  # read by BAML; the worker never sees it
pnpm --filter @wap/prompts sidecar         # CommonJS build, then node on :2024

# on the worker (Edge Function secrets)
SUMMARY_PROVIDER=baml
BAML_SIDECAR_URL=https://<where it runs>
# BAML_SIDECAR_TOKEN is optional here: unset, the worker reads Vault's baml_sidecar_token
```

Everything but `GET /_debug/ping` requires `x-baml-sidecar-token`. Rotation is
`mint_baml_sidecar_token()` again, then redeploy the sidecar with the new value; the
worker picks it up within its sixty-second provider cache.

The CommonJS build exists because the generated client's imports are extensionless,
which Vitest resolves and Node's ESM loader refuses. `pnpm --filter @wap/prompts test`
exercises the door and the ledger accounting over a real socket with injected handlers;
the provider is never called in tests.

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

Installed from npm as `@boundaryml/baml`, not from `pkg.boundaryml.com`. That host is
blocked by this environment's egress policy, and the npm package is the documented
integration for a TypeScript project regardless — it ships the same `baml-cli` binary.

The npm CLI is BAML v0: `init`, `generate`, `check`, `test`, `dev`, `serve`, `lsp`,
`optimize`. The newer standalone CLI's `baml agent install`, `baml run`, `baml bridge`
and `baml describe` are not available here.
