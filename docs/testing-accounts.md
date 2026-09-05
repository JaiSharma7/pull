# Test accounts, and recording them

Four accounts, two device shapes, one command each. This is the loop for finding the
bugs that only appear when a real reader with real history opens a real screen on a
393-pixel-wide phone.

Everything here is **local-stack only**. Nothing in this document creates an account on
the hosted project, and `scripts/testkit/stack.mjs` refuses to run if `supabase status`
reports anything but loopback — see [Why not the hosted project](#why-not-the-hosted-project).

## The loop

```bash
pnpm db:start          # Postgres, GoTrue, PostgREST, Mailpit — Docker must be running
pnpm db:reset          # replay 86 migrations; the seed corpus rides in with them
pnpm personas          # build the four accounts
pnpm dev               # the app on 127.0.0.1:5173
pnpm record            # drive each persona through the app on each device
```

The first two are the ordinary dev loop. `pnpm db:reset` also reseeds the content — the
topics, works, Pulls, Daily Pulls and quiz questions are rows in the migrations, not
generated, so **there is no model call anywhere in this** and no `cost_ledger` entry.
Law 2 is not at risk here; this whole document runs for nothing.

## The four accounts

| `pnpm record --persona=` | Address               | What it is for                                                                                                                                                                                                                                         |
| ------------------------ | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `visitor`                | —                     | No account. The recorder presses "Look around as a guest", which is a real anonymous session in `sessionStorage`. The persona that shows whether the guest bounds — no generation, no authoring, no reports — read as explanations or as dead buttons. |
| `first-run`              | `first-run@pull.test` | Created seconds ago, `onboarded_at` null. `OnboardingGate` holds the shell, so this is the only way to see the first-run screens. Must be rebuilt before each recording: answering onboarding once spends it.                                          |
| `reader`                 | `reader@pull.test`    | Three weeks of reading — 24 reads, 14 graded, 4 convictions, 9 saves across two stashes, spread over 14 days. Feed interleaves, Review has a queue, History has something to scroll, the Delta has covered distance. Judge most screens on this one.   |
| `lapsed`                 | `lapsed@pull.test`    | Read a lot, stopped two months ago. Every knowledge state is past due, so the Delta shows decay rather than progress. The state that only exists after time passes.                                                                                    |

`@pull.test` is not decoration. RFC 2606 reserves the suffix, so none of these addresses
can route anywhere — which matters because `pnpm personas` **deletes and recreates** an
account by address every time it runs.

Rebuild rather than top up, because two recordings of a screen are only comparable when
the state behind them is. `pnpm personas reader` rebuilds one.

### How the state gets there

Through the app's own API, under the persona's own token: `record_read`, `grade_recall`,
`set_conviction`, an insert into `saved_items`. Not as `service_role` and not as
`postgres`. A fixture written with an admin credential can sit in a state no reader could
ever reach through the UI, and then the bug you reproduce from it is not a bug.

One step is not the app's, and is deliberately quarantined in `backdate()`: the
timestamps. `record_read` stamps `now()` by design, so a hundred RPC calls produce a
reader who did everything this second — no decay, no due reviews, an empty Delta, a
History with a single date on it. Time passing is the one thing the write path cannot
fake, so it is faked in SQL, in one function, where it can be read.

## What a recording produces

```
artifacts/recordings/<run>/<persona>-<device>/
  video.webm         the whole pass
  NN-<step>.png      a full-page frame per step, at CSS pixels
  report.json        per step: console errors, failed requests, overflow, tap targets
artifacts/recordings/<run>/report.md
```

`artifacts/` is gitignored. Read `report.md` first and watch the video second. A
recording that only _looks_ right is a recording of the bugs you cannot see:

- **Console errors and `pageerror`**, attached to the step that caused them.
- **Requests that 4xx or 5xx.** A failed RPC usually renders as an empty section, which
  looks like a design decision.
- **Horizontal overflow.** One element wider than the viewport drags the whole page
  sideways, and a still frame shows nothing at all. The report names the offending
  elements and their bounds.
- **Tap targets under 44px** (mobile only — Apple's HIG floor, and WCAG 2.5.5). The first
  run of this reported the masthead navigation at 39px tall on an iPhone 15 Pro.

One artefact to know about when reading the frames: the bottom navigation is
`position: sticky`, so in a full-page screenshot it appears wherever it was pinned when
the shot was taken — usually partway down a long page rather than at the bottom. It is
not a layout bug; the video shows where it actually sits.

Useful flags:

```bash
pnpm record --persona=reader --device=iphone   # one pass
pnpm record --headed --slow=250                # watch it happen
pnpm record --base=http://127.0.0.1:4173       # against `vite preview`, i.e. a real build
```

That last one is worth doing before shipping: `pnpm dev` is not the bundle, and the
service worker — which is what offline (law 3) actually runs on — only registers in a
built app.

## Driving an account by hand

```bash
pnpm personas:link reader
```

prints a `?token_hash=…` URL. Opening it runs the app's ordinary `verifyOtp` path, the
same one `{{ .TokenHash }}` in the sign-in email carries, so nothing in the app knows it
was a test. Single-use, ten-minute expiry (`otp_expiry` in `supabase/config.toml`); run
it again rather than saving one.

There is no password anywhere in this. The app has no password field — sign-in is a
six-digit code or a link — so a test account with a password would be an account no
reader could have.

### On a real iPhone

Emulation is not iOS Safari, and the difference is exactly where the phone bugs live.
Chromium at 393×852 will not reproduce the dynamic-viewport `100vh` behaviour, the
safe-area insets under the notch and home indicator, momentum scrolling and rubber-band
overscroll, or the Web Speech voices that law 3's free audio runs on. Use emulation for
layout, reflow, tap targets and flow; use a phone for the rest.

1. Bind the dev server to the LAN: `pnpm dev --host` (Vite prints the Network URL).
2. Add that origin to `additional_redirect_urls` in `supabase/config.toml` and restart
   the stack — `supabase start` does **not** re-read the file on a stack that is already
   up, which is the same trap the `enable_anonymous_sign_ins` comment describes.
3. `pnpm personas:link reader --base=http://192.168.x.x:5173`, and open that on the phone.
4. Record the screen with the iOS control-centre recorder, or over a cable with QuickTime
   (**File → New Movie Recording**, then pick the phone as the camera).
5. For the console and the element inspector, connect the phone by cable and use
   **Safari → Develop → \<your iPhone\>**, with Web Inspector enabled in iOS Settings →
   Safari → Advanced.

The phone must be on the same network as the laptop. Note that the local stack signs its
tokens with a published default secret — binding it to a LAN address is a real exposure
on a shared or public network, so do this at home and stop the stack afterwards.

## Adding to it

Both files are small on purpose.

- **A persona** is an entry in `scripts/testkit/personas.mjs`. `seed` is read by
  `make-personas.mjs`: `onboarded`, `topicWeights`, `reads`, `grades`, `convictions`,
  `stashes`, `saves`, `ageDays`. Add a field there and handle it in `seed()`.
- **A step** is `{ name, run }` in `scripts/testkit/record.mjs`. `section('Library')`
  presses a masthead or rail control; `destination('/graph')` navigates. A step that
  throws is recorded as a finding and the tour continues, so a broken selector costs one
  step rather than the run.

A persona with a verified TOTP factor would be the obvious fifth — `SecondFactorGate` is
a full-screen gate nobody has looked at on a phone. It needs a TOTP code generated in the
script (`mfa/enroll` then `mfa/verify` through the admin API), which is thirty lines and
has not been written.

## Why not the hosted project

`stack.mjs` holds the **secret key** — it has to, since creating a user and minting a
sign-in link are both admin operations. Against `zjvfwhjwaytyogdxeddo` that same script
would delete and rebuild accounts by address on a project with real readers on it, and
RLS does not bound a secret key the way it bounds everything else. So the loopback check
has no opt-out flag, and the key is read from `supabase status` at the moment it is used
rather than living in a file (law 7).

The key is never written to disk and never reaches the browser: the recorder is handed a
single-use sign-in link, not a credential.

If the deployed app needs exercising — and it should be, for the service worker, for real
network latency and for iOS Safari — sign in as yourself with a real address. That is a
different job from this one, and it does not need a fixture.
