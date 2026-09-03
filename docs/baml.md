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

**Not** set up, and deliberately: nothing in `supabase/functions` _calls_ BAML — no
runtime import crosses into Deno. That is a narrower statement than it used to be, and
the difference matters: `buildSummaryPrompt` and `SUMMARY_SCHEMA` are still the names the
pipeline uses, but they are no longer hand-written copies of the contract. Both are
derived from `baml_src` at build time and read out of
`_shared/generated/prompts.ts` — `buildSummaryPrompt` renders the exported template
through `promptFor`, `gemini.ts` converts the exported schema to Gemini's dialect at
module load, and `anthropic.ts` hands it to its tool as-is. See the next section for why
the _runtime_ crossing is not a one-line import, and "The export" below for what does
cross.

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

The schema is _derived_, not restated: the exporter asks the compiler to lower the
function's declared return type (`baml.json.schema(F$spec(...).output_type())`), so the
class in `baml_src` is the only place the shape is written down. References are inlined
on the way out, because Gemini's `responseSchema` dialect has no `$ref`.

Three limits of the export, stated rather than discovered:

- A template cannot carry a conditional on an argument's value, because a placeholder
  must be the argument verbatim; the exporter refuses a transformed argument. The
  fallback for an empty context therefore lives in `buildSummaryPrompt`.
- Each function must name one pinned client; the exporter refuses a fallback or
  round-robin client, because retry and fallback belong in the worker, where the ledger
  is.
- Array bounds are not derivable. BAML v1 has no constraint syntax — v0 carried
  `@assert` on the field, and nothing replaced it. Worth knowing precisely, because the
  failure mode is quiet: v1 still **parses** `@assert(name, {{ ... }})` without an
  error and then ignores it entirely — `baml describe` does not report it,
  `baml.json.schema` lowers no bounds from it, and `$parse` on `{"topics": []}` returns
  an empty list rather than throwing (checked against 0.17.0). So putting the v0
  annotation back would read as enforcement and do nothing. `minItems`/`maxItems` cannot
  be lowered from the class and are layered on from `BOUNDS` in `scripts/export.mjs`
  after lowering. That is the one hand-kept part of the schema. Be precise about what
  guards it: `packages/prompts/src/schema.test.ts` pins that each bound landed on the
  node it was meant for, and that the exported properties still match the classes they
  came from, so a renamed or added field fails the build. It cannot check the _numbers_ —
  there is nothing in `baml_src` to check them against, and a docstring saying "one to
  four" is prose. Changing a bound means changing the docstring and `BOUNDS` together.

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
curl -fsSL https://pkg.boundaryml.com/install.sh | sh -s -- --version 0.17.0
```

(or `install.ps1` via PowerShell on Windows).

**Install the pinned version, not the channel.** Left to itself the installer takes
`canary`, which is re-cut under the same version string, so two toolchains that both
call themselves `0.17.0` need not be the same build. `manifest/v1/version/0.17.0.json`
is sha256-pinned and immutable; the channel is not. CI installs the same pin from
`BAML_VERSION` in `.github/workflows/ci.yml`, and the two move together.

Pinning is necessary but not sufficient, and it is worth knowing why. `baml generate`
writes 3.3 MB of compiled bytecode into `baml_sdk/_inlinedbaml.ts`, and that file is
**not reproducible across machines**: the same pinned toolchain over the same sources
emits different bytes on a CI runner than on a laptop, and different bytes again from a
different working directory. The other 66 generated files are byte-identical. So the
staleness gate in check 2 diffs those and excludes `_inlinedbaml.ts` together with the
`.baml-generator-output.json` that records its hash — a diff on either reports which
machine ran the generator, not whether anyone forgot to. Nothing is lost by that: a type
change still moves `_typemap.ts` and its neighbours, and a prompt, client or schema
change still moves `generated/prompts.ts`, which is rendered text and does reproduce.
Commit the regenerated bytecode anyway — the runtime loads it.

The standalone toolchain provides the official `baml` CLI (version `0.17.0`, wrapper
`0.2.4`): `baml check`, `baml generate`, `baml test`, `baml run`, `baml describe`,
`baml agent install`, and `baml init`.

The TypeScript project integrates with `@boundaryml/baml-bridge`, which provides the
runtime bindings for generated code in `packages/prompts/baml_sdk`. Code generation is
configured in `packages/prompts/baml.toml`.

`baml agent install` refreshes the vendored `baml-core` reference skill, and **it cannot
run from the Claude Code environment this repository is worked on from**: it fetches
`https://codeload.github.com/BoundaryML/baml-skill/tar.gz/main`, which the egress policy
refuses with a 403 (checked today, while `pkg.boundaryml.com` and GitHub release assets
both answer 200 — so the toolchain installs fine and only this command is blocked).
Consequently the skill is committed twice, byte-identical, at
`.agents/skills/baml-core/SKILL.md` and `.claude/skills/baml-core/SKILL.md`, and which
one the CLI actually owns is unverified — running the command is what would establish it.
Do not delete either on a guess: the `.claude/` copy is what Claude Code discovers, and
the `.agents/` copy is what `.claude/skills/baml/SKILL.md` points readers at. Allowlisting
`codeload.github.com` would settle it.

`baml_sdk` is generator output and committed whole, which is why it is 4.8 MB and carries
vendored `openai`, `aws`, `vercel` and `claude_code` clients alongside the `google` and
`anthropic` ones. Nothing in this repository imports them and they are not prunable by
hand — regenerating would put them straight back.

**Nothing outside `packages/prompts` may import `baml_sdk` as a value.** Its `index.ts`
calls `initializeRuntimeFromBytecode` at module scope, so a value import — an `enum`
counts, which is how this regressed once — loads the native addon into whatever imports
it, `apps/web` included. `src/index.ts` re-exports types only, `@boundaryml/baml-bridge`
is a devDependency so it does not follow the package, and `src/boundary.test.ts` fails on
any value import from `baml_sdk` under `src/`.
