# Design strategy preview

This preview turns the September 2026 Design Component study into a runnable slice of
the product. It is a test surface, not a claim that every frame in the study has shipped.

## The proposition

A sitting is dealt, visible, and finite. Before reading, a person chooses a time budget
and sees the complete contents. The last item is always **Enough**. Reading more is an
explicit choice after the terminus rather than an infinite runway.

Each Pull has five depth stops. Moving the dial reveals more of one local, stored
structure; it never performs a request or implies per-impression generation. Every
duration is derived from the words actually visible at 210 words per minute.

Source identity comes from type, rules, and spacing rather than cover art. Fraunces
remains the display face, JetBrains Mono remains the metadata face, and Source Serif 4
is the reading face for the preview.

## Preview boundary

`/design-preview` is rendered before the application shell. It mounts no Supabase
client, restores no session, and writes no reader data. The content is a small set of
public-domain fixtures embedded with the component, so reviewers can test the design
without credentials or a shared account.

This boundary is intentional:

- It does not weaken RLS, MFA, or the existing auth gate.
- It does not create anonymous users in the hosted project.
- Save, Listen, and source links are presented only when their preview behavior is real.
- It does not add depth columns to `pulls`. The production database currently stores one
  body plus explanation fields; a five-layer persisted model needs a separate product and
  migration decision after this interaction is validated.

## What the preview must prove

1. The gate offers bounded sittings whose labels come from their word counts.
2. Contents are face-up before reading, including the Enough terminus.
3. The depth dial is keyboard-reachable and exposes five computed reading lengths.
4. The sitting ends without loading more content.
5. The route works on a cold Vercel load without signing in.

## Candidate amendments after validation

The original study proposes four global design-law changes. They are documented here,
not applied globally by this preview, because the current app does not yet satisfy all
four:

1. Every text role, including faint metadata, reaches 4.5:1 on its own ground.
2. Blocks use at most a 3px radius and controls at most 2px.
3. Hex colours live only in the token file, including fixed-theme panels.
4. Every reader-facing duration is computed from word count at 210 words per minute.

Promoting these from preview constraints to repository laws should be its own PR with
executable checks and fixes for every existing violation.
