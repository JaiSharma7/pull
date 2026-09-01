# First run — the first sixty seconds

The four screens a stranger meets before the product has proved anything: sign in, an
empty feed, a card, and the end of a session. `docs/design.md` holds the system; this
holds what is built from it, and why.

Scoped deliberately. These four are settled in structure — none of them changes when
`refresh_knowledge_vector` gets a caller or the Delta learns about negation — so they can
be designed now without buying rework. The Library and the Review screens are not here
for the opposite reason.

## The competitive read

Blinkist and Imprint are the comparison, and they are beaten in different places.

**Imprint wins on visual delight** — illustration, colour, motion. We cannot compete
there without breaking law 1, and we would lose anyway: they have illustrators and we
have a design token file. Attacking that flank is how this ends up as a worse Imprint.

**Blinkist is visually inert.** Competent, generic, forgettable — a product that looks
like a list of things you have not read yet. That is the flank.

So the strategy is: **look like an object, not an app.** The one thing neither of them
is, is _considered_. Imprint is fun and disposable; Blinkist is efficient and grey. A
serif title page, a real baseline, generous air and hairline rules read as something made
on purpose, which is the only impression available to us that neither can buy quickly.

Which resolves the tension in "fun, but book-like". The delight budget is spent on
**motion, typography and interaction** — never on colour or ornament:

| Spend it on                                     | Never on                      |
| ----------------------------------------------- | ----------------------------- |
| Type that changes size and weight with intent   | A second accent colour        |
| Transitions that explain where a thing went     | Gradients, glows, elevation   |
| Inputs that feel precise (segmented code boxes) | Illustration or mascots       |
| Numbers that count rather than appear           | Rounded, candy-coloured cards |

## What was taken from 21st.dev, and what was left

Structure was ported; not one line of styling was. Their catalogue is Tailwind, and the
prevailing look — cards on gradients with elevation — is the thing law 1 exists to
prevent. Ported:

- **Segmented one-time-code input.** Six boxes rather than one field, auto-advance on
  entry, backspace steps back, and a paste of the whole code fills every box. This is
  the single best idea in their sign-in collection and it is ergonomics, not decoration:
  a six-digit code in one text input gives no feedback about how many digits are left.
- **Empty-state anatomy** — mark, title, one line of orientation, one action, in that
  order.
- **Stepper semantics** — step two is the same screen advanced, not a different screen.

Rejected: cards, split-screen layouts with artwork, social-provider rows (we have one
method), glass and gradient treatments, and every shadow.

**On the licence, since the repository is public.** What was taken is interaction
behaviour — that six boxes beat one field, that an empty state reads mark, title, line,
action — which is an idea rather than an expression, and ideas are not what copyright
covers. No markup, no classes and no stylesheet were copied; `CodeInput.tsx` and the
empty states in this app were written against these descriptions, not against their
source. That is a deliberate line and this paragraph exists so a reader can check it
rather than take the heading at face value. Credit where it is due: the segmented-input
pattern is theirs, and it is better than what was here before.

## 1 · Sign in — the title page

The current screen is a 544px column pinned to `left: 0` on a 1440px window, with 900px
of dead space beside it. `.measure` caps width and never centred it. It is the first
thing anyone sees, and it reads as a broken layout rather than a spare one.

```
┌────────────────────────────────────────────────────┐
│                                                    │
│                                                    │
│                  WHAT A PULL          ← --step--1  │
│                                         letterspaced│
│                                         --text-faint│
│                                                    │
│              Pull something               Fraunces │
│                worth keeping.             --step-4 │
│                                                    │
│         Ideas from books, films, papers            │
│         and talks — anchored to real               │
│         sources, argued with, and                  │
│         actually remembered.                       │
│                                                    │
│         ──────────────────────────────    hairline │
│                                                    │
│         EMAIL                                      │
│         ┌──────────────────────────────┐           │
│         │                              │           │
│         └──────────────────────────────┘           │
│                                                    │
│         ┌──────────────────────────────┐           │
│         │    Send a sign-in code       │  oxblood  │
│         └──────────────────────────────┘           │
│                                                    │
│         No subscription, and nothing               │
│         worth having behind one.       --text-muted│
│                                                    │
└────────────────────────────────────────────────────┘
        one axis · centred · serif leads
```

Decisions, and the reasoning that is not obvious:

- **Centred on both axes, capped at `--measure`.** One axis means nothing competes for
  attention. `place-content: center` on a `min-height: 100svh` grid — `svh`, not `vh`,
  because mobile browser chrome makes `vh` overflow and the button ends up under the
  address bar.
- **The pitch moves below the form.** "No subscription, and nothing worth having behind
  one" is the strongest sentence on the screen and it was buried in the middle of a
  paragraph. Last position is emphatic; it is also the objection a reader has at exactly
  that moment.
- **A hairline between promise and action.** The rule is the only ornament, per law 1.
- **The masthead is small, not large.** A large logo is what an app does when it has
  nothing to say. The sentence is the brand.

## 2 · Sign in, step two — the code

Same screen, advanced. Not a new layout: the masthead and rule stay put so the page does
not appear to jump.

```
│         ──────────────────────────────            │
│                                                    │
│         We sent a code to                          │
│         jai@example.com                    --accent│
│                                                    │
│         SIGN-IN CODE                               │
│         ┌───┐┌───┐┌───┐┌───┐┌───┐┌───┐             │
│         │ 4 ││ 4 ││ 5 ││ 6 ││ 7 ││   │  ← focus:  │
│         └───┘└───┘└───┘└───┘└───┘└───┘    oxblood  │
│                                             rule   │
│         ┌──────────────────────────────┐           │
│         │         Sign in              │           │
│         └──────────────────────────────┘           │
│                                                    │
│         Send it again · Use another email          │
```

- **Six boxes, monospace, `--step-2`.** Progress is visible without counting.
- **Paste fills all six.** Every reader copies the code from an email; a paste that fills
  one box and drops five digits is the most likely single failure on this screen.
- **Auto-advance, and backspace steps back.** Correcting a typo must not require
  clicking.
- **`inputMode="numeric"` and `autoComplete="one-time-code"`** so iOS offers the code
  from the notification and phones show a number pad.
- **"Send it again" exists.** Previously the only exit was "use a different email", which
  discarded a correct address — the wrong affordance for the actual problem, which is a
  slow email.
- **No `maxLength` on the group.** Code length is a server detail; hard-coding six here
  is a display choice, and the value submitted is whatever was typed.

## 3 · Empty feed — nothing yet, not "well done"

This state shipped tonight and has never been seen. It exists because
`done || rows.length === 0` congratulated a reader for finishing a catalogue that had
nothing in it.

```
│         FOR YOU                                    │
│                                                    │
│         Nothing here yet.              Fraunces    │
│                                        --step-3    │
│         New Pulls are still being drawn            │
│         from their sources. This is a young        │
│         library — check back shortly.              │
│                                                    │
│         ──────────────────────────────             │
│                                                    │
│         WHAT ARRIVES HERE                --step--1 │
│         Ideas from books, films, papers,           │
│         talks and documentaries — one at           │
│         a time, argued with.                       │
```

- **It says what will be here, not just that nothing is.** An empty state that only
  reports emptiness gives a reader no reason to come back. This is the one screen where
  explaining the product is not filler.
- **No illustration and no icon.** Both are what a product reaches for when it does not
  trust its own sentence.
- **No retry button.** Nothing is broken, so a button that re-runs the same query and
  returns the same nothing is a dead end wearing an affordance — which is precisely the
  bug this state was split out of.

## 4 · Enough — the end of a session

Reached honestly now, after at least one card. The numbers are the product's whole claim,
so they are set like a result rather than a receipt.

```
│         ──────────────────────────────             │
│                                                    │
│         Enough for today.              Fraunces    │
│                                        --step-4    │
│           5        2         3                     │
│           ideas    kept      recalled   --step-5   │
│                                         tabular    │
│                                                    │
│         ──────────────────────────────             │
│                                                    │
│         12 minutes saved                  --accent │
│         against reading the sources in full        │
│                                                    │
│         Mind fed. Go and use some of it.           │
```

- **Numerals at `--step-5`, labels at `--step--1`.** The number is the message.
- **`font-variant-numeric: tabular-nums`.** Proportional digits make a row of numbers
  ragged, and these sit in a row.
- **Time saved carries the accent.** It is the one number that is the business model —
  time saved, not time spent, is what separates this from a feed.
- **Counting animation, `prefers-reduced-motion` respected.** The only motion on the
  screen, and it is the delight budget being spent where the meaning is.

## What is deliberately not here

- **Artwork on cards.** `disabledImageProvider` returns null by design; artwork is the
  first thing cut under cost pressure.
- **Artwork on cards**, above, is still true. The three below are not, and are kept with
  the correction rather than deleted, because what changed somebody's mind is usually
  more useful than the conclusion:

- ~~**A dark mode.** Ink on paper is the identity. Inverting it is a different product.~~
  Dark mode ships. `docs/design.md` had already resolved this — "dark mode is
  **ink-ground**", not an inversion — and the resolution is the reason: the same paper
  logic run the other way is the identity holding, not the identity leaving. It is one of
  three settings on `/appearance`, with an inline script in `index.html` applying the
  choice before first paint so nothing flashes.
- ~~**Onboarding.** The feed explains itself.~~ `OnboardingGate` ships. The feed does
  explain itself; what it cannot do is rank for a reader it knows nothing about, and the
  gate exists to collect the topic weights rather than to give a tour.
- ~~**The Library, Review and Counterpull screens** — their data is still moving.~~
  Library and Review ship. Counterpull does not: `pull_relations` carries the edges and a
  source page shows one hop, but nothing writes an edge for generated content, so at
  scale there is nothing to surface. That one is still true and now has a reason.
