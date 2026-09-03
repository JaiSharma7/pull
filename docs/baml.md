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
- `pnpm baml:check` / `pnpm baml:fmt` / `pnpm baml:generate` / `pnpm baml:test` at the root.
  `baml:test` is the odd one: it runs the `test` blocks against real providers, so it
  needs a provider key and it costs money. It is not part of `pnpm check` and CI never
  runs it.
- CI check 2 fails on a stale generated SDK, an unformatted `.baml` source, or an
  invalid one.
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

1. **A sidecar** — BAML runs as an HTTP service; the Edge Function posts to it.
   Adds a hop, a deployment, and a place for the provider key to live that is neither
   Edge Function secrets nor Vault. Law 7 has opinions about the third. This route was
   `baml-cli serve` under v0, and **v1 has no `serve` subcommand at all** — 0.17.0
   answers `unrecognized subcommand`. So costing it today means costing a hand-written
   server, which is what the closed sidecar branch ended up being anyway, and for a
   separate reason: `serve`'s `/call` dropped token usage, so it could never have fed
   `cost_ledger`.
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

`scripts/cloud-setup.sh` does this and the three other things a container needs, pinned
to `.baml-version`; a Claude Code cloud environment should call it from its **Setup
script** field (`bash scripts/cloud-setup.sh`), because these containers ship without the
toolchain and a session that cannot run `baml fmt` will fail the gate it cannot see. Note
what that script does about PATH: the installer appends `. "$HOME/.baml/env"` to
`~/.bashrc`, which a non-interactive shell never reads, so a successful install still
reports `baml: command not found`. It symlinks into `/usr/local/bin` instead.

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
`0.2.4`): `baml check`, `baml fmt`, `baml generate`, `baml test`, `baml run`,
`baml describe`, `baml agent install`, and `baml init`.

## Formatting

`.baml` is the one source language here that prettier does not format. Not by an
exclusion — `prettier --file-info` reports `inferredParser: null`, so it does not
recognise the extension and skips the files. For a while nothing formatted them at all
and the two sources were hand-kept at the repo's two-space indent.

`baml fmt` is the formatter that does, and it is now canonical: `pnpm baml:fmt`, gated by
check 2. The two tools partition by extension, so they never touch the same file and
cannot disagree.

**Be precise about how much it normalises, because it is less than "four-space with
trailing commas" suggests.** It reformats _declaration bodies_ — enum members, class
fields, function signatures — to four-space with trailing commas, which is why
`canonical_summary.baml` now indents unlike every other file in the tree. It does **not**
touch the layout of call-argument lists: `clients.baml`'s `google.GoogleClient.new(…)`
arguments sit at two spaces, and hand-reindenting them to four leaves `baml fmt`
reporting success and changing nothing (checked against 0.17.0). So the gate pins each
file against _drift from what was committed_, not against one canonical style across the
directory, and two files in `baml_src` legitimately indent differently. Whichever style a
new client declaration lands in is the style the gate then holds it to.

Adopting it is inert to what the model receives, which is what made it safe: BAML dedents
a prompt template before rendering, so reindenting the sources leaves
`generated/prompts.ts` and the other 66 client files byte-identical. It is _not_ inert to
the whole tree — `_inlinedbaml.ts` and the `.baml-generator-output.json` that records its
hash both move, because the bytecode embeds the source. Both are excluded from the
staleness gate, so that is invisible to CI but very visible in a diff.

The gate is run-then-diff rather than a flag, because `baml fmt` has no `--check`:
`--dry-run` prints the formatted text to stdout and still exits 0. It is idempotent, so
running it in the gate is safe.

One thing this closed: **do not parse `baml_src` at a fixed indent.**
`src/schema.test.ts` compares the exported schema's properties against the fields
declared on each class, and read them with `^\s{2}(\w+)\s*:`. Against four-space sources
that matched nothing, so `classFields` returned `[]`. The comparisons then failed —
loudly, naming every exported field as unexpected — which is worth stating exactly,
because the plausible version of this story is that they passed vacuously and they did
not. The defect was a false alarm: three assertions about schema drift broke for a reason
unrelated to schema drift, which reads like the export is broken and invites reverting the
formatting instead. The parser now matches any indent, and every row of the parity table
carries its own non-empty guard rather than leaning on the one in the first `it`.

The TypeScript project integrates with `@boundaryml/baml-bridge`, which provides the
runtime bindings for generated code in `packages/prompts/baml_sdk`. Code generation is
configured in `packages/prompts/baml.toml`.

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

## The agent skills are generated too

`baml agent install` writes the BAML language reference into the repository, and it
writes it **twice on purpose**: `.claude/skills/baml-core/SKILL.md` for Claude Code and
`.agents/skills/baml-core/SKILL.md` for Codex / OpenCode. The two are byte-identical, and
the review on the v1 migration read that as a 351-line file committed twice by accident.
It is not. Each agent reads only its own directory, and this repository's review gate is
Codex (`AGENTS.md`), so deleting `.agents/` would take the reference away from the agent
that reviews the prompts. Deleting either one also loses the argument with the next
refresh, which writes it straight back.

So they are treated like `baml_sdk`: generator output, committed whole, and **in
`.prettierignore`**. That last part was missing and mattered. Prettier reformats markdown
it did not write — `*emphasis*` becomes `_emphasis_`, ` ``double-backtick`` ` spans
collapse — so the committed copies had drifted from generator output on about fifteen
lines that mean nothing. The cost was not cosmetic: every `baml agent install` came back
dirty, and a real upstream change to the reference was indistinguishable from prettier's
churn. Both copies are now pristine output, and a refresh is a clean no-op.

Two mechanics worth knowing before running it:

- **Run it from the repository root**, not from `packages/prompts`. It installs into the
  current working directory rather than the BAML project directory, so running it beside
  `baml.toml` would put a second pair of skill trees under `packages/prompts/`.
- **It cannot reach its source from the Claude Code environment.** It fetches
  `https://codeload.github.com/BoundaryML/baml-skill/tar.gz/main`, and that host is
  authorised per repository against the session's GitHub scope — a third-party repository
  returns 403 with a message about `add_repo`, not a network error. Clone the skill
  repository and pass it directly:

  ```bash
  git clone --depth 1 https://github.com/BoundaryML/baml-skill /tmp/baml-skill
  baml agent install --source /tmp/baml-skill
  ```

  The install is deterministic: the same source produces byte-identical output, which is
  what makes the no-op above checkable. Whatever it replaces is copied to
  `baml-old_skills/` beside the new copy — gitignored, and safe to delete.

  It also renames the skill on the way in: upstream's `core` becomes `baml-core`, by the
  CLI's own account "to avoid registry collisions". Upstream ships the same content as a
  Claude Code plugin (`plugins/baml/skills/core/SKILL.md`, plugin version 0.11.1), and
  the committed copies match it.

Divergence between the two copies is checked by `packages/prompts/src/skills.test.ts`;
staleness against upstream deliberately is not, because that repository moves on its own
schedule and a lag is not a defect. See CLAUDE.md's generated-files rule.

This is not the same host as the toolchain installer. `pkg.boundaryml.com` and GitHub
_release assets_ are both reachable (the review on the v1 migration recorded release
assets as refused; that is no longer true), which is why `pnpm baml:check`,
`baml:generate` and `baml:export` all run here.
