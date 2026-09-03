---
name: baml
description: How to write, generate and test BAML prompts in What a Pull. Read before editing anything under packages/prompts/baml_src or wiring a model call.
---

# Writing BAML in this repo

The project uses the official standalone BAML v1 toolchain (`baml`).
General BAML language syntax and stdlib reference are available in the `baml-core` skill
(`.agents/skills/baml-core/SKILL.md`). `docs/baml.md` holds the architecture; this holds
the repo workflow.

## Rules

1. **Regenerate, export, and commit.** `pnpm baml:generate && pnpm baml:export` after any
   `.baml` edit. The generated SDK in `packages/prompts/baml_sdk` and the export in
   `supabase/functions/_shared/generated` are both committed and CI check 2 diffs them
   byte-for-byte. Never hand-edit either.
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
pnpm baml:generate    # rewrite packages/prompts/baml_sdk
pnpm baml:export      # rewrite supabase/functions/_shared/generated/prompts.ts
pnpm --filter @wap/prompts test   # parity tests, no API key needed
pnpm baml:test        # runs the `test` blocks against real providers — costs money
```

`pnpm baml:test` makes real provider calls. It needs `GOOGLE_AI_API_KEY` or
`ANTHROPIC_API_KEY` in the environment and it is not part of `pnpm check` for that
reason. CI never runs it.

## Writing a function

- Put the shape in a `class`, the taxonomy in an `enum`, and docstrings in `///`.
- Name ONE pinned `client` from `clients.baml` (e.g. `client: GeminiFlash`) — never
  `SummaryChain` or any fallback or round-robin client. Retry and fallback live in the
  worker, where the ledger is; a chain chosen in BAML would pay for attempts
  `cost_ledger` never hears about. Do not inline `provider/model` strings either: the model
  names are mirrored from `_shared/gemini.ts` and `_shared/anthropic.ts` and move together.
- Use backtick strings and `${...}` interpolation for prompts: `prompt: ` `...` `` and
  include `${ctx.output_format}`.
- Every function gets at least one `test "name"` block with a **public-domain** fixture.
  Law 4: no copyrighted source text in this repository, including in test args.
- Use `assert.*` methods in test blocks (`assert.is_true`, `assert.equal`, etc.).
