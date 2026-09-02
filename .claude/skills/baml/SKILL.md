---
name: baml
description: How to write, generate and test BAML prompts in What a Pull. Read before editing anything under packages/prompts/baml_src or wiring a model call.
---

# Writing BAML in this repo

`baml agent install` could not run here — `pkg.boundaryml.com` is blocked by egress
policy, and the npm CLI is BAML v0, which has no `agent` subcommand. This file is the
repo-local stand-in. `docs/baml.md` holds the architecture; this holds the workflow.

## Rules

1. **Regenerate and commit.** `pnpm baml:generate` after any `.baml` edit. The client in
   `packages/prompts/baml_client` is committed and CI check 2 diffs it byte-for-byte.
   Never hand-edit it.
2. **`pnpm baml:check` before generating.** A `.baml` file that does not parse produces a
   confusing diff instead of a clear error.
3. **Nothing in `supabase/functions` imports BAML.** The runtime is a native Node addon
   and Edge Functions are Deno isolates. If a change seems to need it there, read the
   "Deno boundary" section of `docs/baml.md` — the answer is an architecture decision,
   not an import.
4. **Never use a generated enum value as a database value.** `TopicSlug.ArtsAndLetters`
   is `"ArtsAndLetters"`, not `"arts-and-letters"`. Go through `topicSlugOf`.
5. **Law 2 is unchanged.** BAML at generation time, never in the read path. A new
   `function` is a new model call — say what it costs and where it writes to
   `cost_ledger`.
6. **Mirrors change in the same commit.** The `TopicSlug` enum mirrors `TOPIC_SLUGS` in
   `supabase/functions/_shared/providers.ts`, which mirrors the seeded `public.topics`.
   `packages/prompts/src/topics.test.ts` asserts both directions and will fail if you
   change one.

## Workflow

```bash
pnpm baml:check       # parse and typecheck baml_src
pnpm baml:generate    # rewrite packages/prompts/baml_client
pnpm --filter @wap/prompts test   # parity tests, no API key needed
pnpm baml:test        # runs the `test` blocks against real providers — costs money
```

`pnpm baml:test` makes real provider calls. It needs `GOOGLE_AI_API_KEY` or
`ANTHROPIC_API_KEY` in the environment and it is not part of `pnpm check` for that
reason. CI never runs it.

## Writing a function

- Put the shape in a `class`, the taxonomy in an `enum`, and the constraints in
  `@assert` — not in a comment and not in a downstream narrowing pass. An assert that
  BAML can check is worth more than a paragraph explaining what the model should not do.
- Name ONE pinned `client` from `clients.baml` — never `SummaryChain` or any fallback or
  round-robin client. Retry and fallback live in the worker, where the ledger is; a
  chain chosen in BAML would pay for attempts `cost_ledger` never hears about. Do not
  inline `provider/model` strings either: the model names there are mirrored from
  `_shared/gemini.ts` and `_shared/anthropic.ts` and are meant to move together.
- Every function gets at least one `test` block with a **public-domain** fixture. Law 4:
  no copyrighted source text in this repository, including in test args.
- `@@assert` in a test block checks the parsed result. Reference enum members by their
  alias string (`"stoicism"`), not by `TopicSlug.Stoicism` — the jinja scope has no
  binding for the enum type.
