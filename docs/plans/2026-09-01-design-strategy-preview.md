# Design strategy preview implementation plan

**Goal:** Publish a no-auth, fixture-backed preview of the bounded sitting and Depth
Dial without changing production data or security behavior.

**Architecture:** `main.tsx` chooses between the normal app and a dedicated preview at
bootstrap time. The preview owns a small pure state machine and public-domain fixture
content. Its CSS is scoped to the preview root and uses design tokens. It never imports
or mounts the Supabase-backed application.

## Tasks

1. Add failing tests for 210-wpm labels, cumulative depth copy, and the bounded-sitting
   state transitions; implement the pure preview model until they pass.
2. Add failing tests for bootstrap route selection; route only `/design-preview` and its
   trailing-slash form to the preview entry.
3. Add a static-markup test for the gate's accessible controls; implement the React
   preview with gate, face-up manifest, five-stop dial, and Enough terminus.
4. Add Source Serif 4 and scoped preview styles. Keep every colour and radius behind an
   existing token.
5. Run changed-file formatting, lint, typecheck, unit tests, build, and the repository
   design checks. Inspect the preview at desktop and mobile widths.
6. Commit with sign-off, run the secret scan, push the branch, deploy a Vercel preview,
   and open a PR stacked on `claude/mvp-readiness-review-eec364` so its diff contains only
   the design preview.
