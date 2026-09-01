# Open brief — a redesign of What a Pull

A prompt for Claude Design. Paste it whole; it is written to be read without the
repository open, and every path it cites is there if you want the detail.

`docs/design.md` is the system as built and `docs/design-first-run.md` is the argument
behind four of its screens. **This brief is deliberately not either of those.** Those two
say what was decided; this one says which of those decisions are still open, and the
answer is: most of them. Read this first, then read them as evidence rather than as law.

---

## 0 · What is being asked for

Redesign this product. Not a polish pass over the current screens — a considered take on
what it should look and behave like, from someone who was not in the room when the first
one was drawn.

You have unusual latitude here, so it is worth being exact about it. The palette, the
typefaces, the card, the navigation model, the shell, the motion language, the density,
the mobile layout and the shape of a session are **all on the table**. So is the design
system itself: if the right answer is a different set of tokens under a different thesis,
propose it and make the argument. What is closed is a short list in §3, and everything on
it is closed for a reason that is legal, ethical, financial or accessibility-related —
never because someone liked it.

The one thing that would waste the exercise is a redesign that is only a re-skin. The
interesting failures in this product are structural: a Depth Dial that is specified and
has never been drawn, six knowledge mechanics with no visual language between them, a
session whose "end" is a screen most readers never reach, and five destinations that were
each designed alone.

---

## 1 · The product, in one page

**What a Pull** is an open-source knowledge feed. One idea at a time, drawn from a real
source — books, films, documentaries, podcasts, papers, essays, talks — anchored to where
in that source it came from, arguable, keepable, and engineered so you actually remember
it later.

The loop is **Discover → Pull → Understand → Save → Recall → Go deeper**, deliberately
against **scroll → like → forget → scroll**.

The unit is a **Pull**: one idea with a headline, a body, a source trail (chapter,
timestamp, section), and a reverse side carrying _why this matters_, an example, and a
counterpoint.

Six mechanics make it a knowledge system rather than a feed. Only the first two have any
visual expression today, and that is a large part of what this brief is about:

| Mechanic               | What it does                                                                        | Designed? |
| ---------------------- | ----------------------------------------------------------------------------------- | --------- |
| **The Delta**          | Models what you already know and refuses to re-teach it. Reports **time saved**.    | Barely    |
| **Interleaved Recall** | Questions arrive inside the feed. Max 3 a session, ≥4 cards apart, never first two. | Partly    |
| **Conviction Ledger**  | Append-only stance history, so your changes of mind are queryable.                  | No        |
| **Idea Lineage**       | Ancestor/descendant edges between ideas across sources and centuries.               | No        |
| **Say It Back**        | You explain it back; the model grades the gap, not the prose.                       | No        |
| **Half-Life**          | Knowledge decays instead of streaks accumulating. Sessions end on **Enough**.       | Partly    |

The positioning, which every screen is downstream of:

> **What other learning apps call premium, we call learning.**
> Unlimited saves. Offline reading. Audio. Full history. Daily curated knowledge. $0.

The competitor is Deepstash: pastel gradients, candy-rounded cards, playful illustration,
a soft rounded sans. Blinkist and Imprint are the near neighbours — Imprint wins on
illustrated delight, Blinkist is competent and visually inert. The current answer to all
three was to look like **a printed object rather than an app**. You may keep that answer,
sharpen it, or replace it with a better one. You may not arrive at any of theirs.

---

## 2 · Who is reading, and on what

A curious adult with more sources bookmarked than they will ever get through. They are not
a student with a syllabus and not a professional with a certification to earn. They open
this in a gap — a commute, a lunch break, twenty minutes before bed — and the product's
whole promise is that the gap was **enough**, and that in six weeks they will still have
what they read.

Sessions are short and the return rhythm is daily-ish. A meaningful share of reading
happens on a phone, one-handed, possibly offline (the app is a PWA with a service worker
and IndexedDB), and possibly listened to rather than read (audio is client-side Web
Speech, so it is a voice reading the text — there is no produced audio to design around).

Design for four viewports, and the second is the one that gets skipped:

```
 375 ×  667   phone
1128 ×  752   Surface 3:2 at 200% OS scaling — the tight one
1504 × 1002   Surface at 150%
1920 × 1080   laptop
2560 × 1440   external monitor — the one where the current design wastes the most
```

Height matters as much as width here, and OS-level scaling means two machines with the
same panel can differ by 33% in CSS pixels. A layout keyed on width alone silently
assumes 16:9.

---

## 3 · The floor — six things that cannot move

Everything not on this list is yours. These are on it because breaking one costs money,
breaks the law, or excludes a reader.

1. **Accessibility ships in round one, not later.** Full keyboard operation with a
   visible focus state that is not only a colour change; an accessible name on every
   control; body contrast ≥ 4.5:1 and ≥ 3:1 for large text and UI boundaries; colour is
   never the only signal; `prefers-reduced-motion` respected by every animation you
   propose. Large-text and high-contrast modes are first-class settings, not a
   browser-zoom shrug. A design that needs an exemption here is not the design.

2. **No model call in the read path — ever.** Ranking, search, the Delta and the
   interleave planner are SQL and vector maths. One canonical generation costs ~$0.056
   and serves thousands of readers; per-user regeneration costs ~$56 per thousand. So an
   interaction that implies "generate something new for me, now, per impression" is
   unbuildable no matter how good it looks. Depth, flips, counterpoints and explanations
   are all **renderings of one stored structure** — design them as reveals, not requests.

3. **The five stay free, and must not look like upsells.** Audio, offline, unlimited
   history, unlimited stashing and curated Daily Pulls. No lock icons, no "Pro" chips, no
   greyed rows with a padlock. The product is ad-supported; if you want to design where an
   ad could sit without contradicting everything above, that is genuinely useful work and
   nobody has done it.

4. **Analysis, not reproduction.** No copyrighted source text, no screenplays, no ripped
   media, no cover art in the repository. Every source carries a rights status. Practically:
   **you cannot design around book covers, film stills or artwork.** The image provider
   returns null by design. Whatever visual identity a source gets has to be built from
   type, rule, colour and layout — this is the single hardest constraint in the brief and
   the most interesting one.

5. **Open-source-licensable assets only.** Any typeface you propose must be OFL or
   similarly free. No proprietary faces, no licensed illustration, no stock photography.

6. **A session has visible edges.** This is the law that separates the product from a
   feed, and it constrains layout as hard as the others constrain colour. Never full-bleed
   infinite scroll; never slide the next item into frame before the reader asks; the end of
   a session is a screen, not a running out of content. A useful test: _if a screenshot of
   this app could be mistaken for a video feed with the sound off, the layout is wrong._

   You may reinvent **how** the edges are shown — the current answer is two side rails and
   a tally, and it is not obviously right, least of all on a phone where the rails
   disappear entirely and the edges disappear with them. You may not remove the edges.

---

## 4 · What exists today

Enough to design against, and worth knowing before you replace it. Nothing here is
protected by anything except the six above.

### The system, as built

```css
--bone      #F4F1EA   page ground, light
--ink       #14120E   text; also the dark-mode ground
--oxblood   #8C2F26   the accent — there is exactly one
--warm      #6B6459   secondary text
--rule      rgba(20,18,14,0.12)
--radius    3px
--measure   34rem     the reading column, pinned at every screen size
```

Display is **Fraunces** (variable serif, optical sizing), body is **Inter**, metadata is
**JetBrains Mono** in small tracked uppercase. Type is a fluid `clamp(rem + vw, …)` scale
in seven steps, never fixed jumps at breakpoints — the `rem` term is deliberate so a
reader's own font-size preference still counts. Dark mode swaps ground and text and keeps
the accent. The ground carries a tiled SVG paper grain at 3.5% opacity instead of any
gradient. Radii are 2–3px. Elevation is a hairline rule, never a shadow — the sole shadow
in the product is the focus ring.

Several of these are enforced by a test (`packages/ui/src/design-laws.test.ts`) and an
audit skill, not just documented: no gradients, no decorative `box-shadow`, no hex outside
the token file, radii ≤ 4px. That is a fact about the repo rather than an argument at you
— but it means **if your design changes those rules, it also has to hand back the amended
rules**, because the current ones are executable and will fail your build otherwise. See
§8.

### The shell

```
┌───────────────────────────────────────────────────────────────┐
│ WHAT A PULL          [nav …]              Focus   Sign out    │  masthead
├──────────────┬──────────────────────────────┬─────────────────┤
│ READING      │                              │ THIS SESSION    │
│ For You      │      ┌────────────────┐      │ Ideas met    5  │
│ Daily Pull   │      │                │      │ Saved        2  │
│ Review       │      │   the reading  │      │ Recalled     3  │
│ Library      │      │   column       │      │                 │
│ History      │      │   34rem, fixed │      │ THE DELTA       │
│ Preferences  │      │                │      │ Already knew 4  │
│              │      └────────────────┘      │ Time saved 12m  │  ← accent
│ BROWSE       │                              │                 │
│ Explore      │                              │                 │
│ Search       │                              │                 │
│ Appearance   │                              │                 │
└──────────────┴──────────────────────────────┴─────────────────┘
```

Two navigation classes, and the split is real rather than cosmetic: **sections** are the
reader's own material and are tab state with no URL (a Pull is not a page); **destinations**
have real addresses because they are things you could send someone — `/explore`, `/search`,
`/appearance`, `/source/:id`, `/pull/:id`, `/topic/:slug`, `/privacy`, `/terms`. A
signed-out visitor sees only destinations, because every section is keyed to a person.

Below 60rem both rails vanish into the masthead and the tally is simply gone. **On a
phone, the product currently has no visible evidence that a session is finite.** That is a
bug in the design, not in the code.

### The card

```
┌─────────────────────────────────┐
│ ATOMIC HABITS · JAMES CLEAR     │  mono chip, warm grey, opens the source
│ ─────────────────────────────── │  hairline
│                                 │
│ Your environment often          │  Fraunces display
│ beats your motivation.          │
│                                 │
│ The easier a behaviour is to    │  Inter body
│ begin, the less motivation it   │
│ requires each time.             │
│                                 │
│ ── ch.3 ──── Save  Ask  Share  Listen  Why │
└─────────────────────────────────┘
```

"Why" flips it. The back carries _why this matters_, an example, the source trail, and
room for a counterpoint and the conviction controls. Both faces stay mounted so the back
is reachable by screen reader and keyboard; the hidden face is `inert`. Under
`prefers-reduced-motion` the flip becomes a cross-fade.

Five actions plus a flip affordance in one footer row is a lot, and they are all the same
weight. Nobody has ever been happy with it.

### The screens that exist

| Screen          | State                                                                                           |
| --------------- | ----------------------------------------------------------------------------------------------- |
| **Sign in**     | Centred title page, email → six-box segmented code. The most finished screen.                   |
| **For You**     | The ranked feed, with recall questions interleaved and `Enough` at the end.                     |
| **Daily Pull**  | The one curated, finite, free-forever thing. Visually indistinguishable from For You.           |
| **Review**      | Deliberate recall. Thin.                                                                        |
| **Library**     | Saved Pulls, nested collections, highlights, notes. The densest screen, and the least designed. |
| **History**     | Everything read, ever.                                                                          |
| **Search**      | Keyword and semantic in one box, with no visual distinction between the two kinds of result.    |
| **Explore**     | Topics, media, creators, collections. A list of lists.                                          |
| **Source**      | A whole work: its ideas, and _"4 of 18 are new to you"_ from the Delta.                         |
| **Appearance**  | Theme, contrast, text size, motion. Device-local, no account needed.                            |
| **Preferences** | Topic weights. Doubles as the onboarding gate.                                                  |
| **Enough**      | The end of a session. Counts, then time saved in the accent.                                    |

### The screens that do not exist and should

- **The Depth Dial.** Specified since day one, never drawn: `⚡30 sec · 3 min · 8 min ·
15 min · Source`. One stored structure rendered at five depths — which is exactly why
  depth is free, and exactly why it must feel like a dial rather than a fetch.
- **Onboarding.** There is none. A new reader gets default weights and an unweighted feed.
- **Studio** — write or request a Pull.
- **My Feeds** — reader-defined channels.
- **Counterpull** — the disagreement view: the strongest argument against the idea you
  just read. The data model already carries `opposes` edges.
- **The Conviction Ledger, Idea Lineage and Say It Back** — three mechanics with a schema,
  a test suite, and no pixels.

---

## 5 · Nine problems worth your attention

Not a specification. These are the places where the current design is known to be wrong or
absent, and where a good idea would be worth the most. Take the ones you find interesting;
ignore any that your take makes irrelevant.

1. **How does a source have an identity with no cover?** Every competitor leans on cover
   art and stills. We cannot use any. Eighteen ideas from _Meditations_ and eighteen from a
   Herzog documentary currently look identical — same chip, same rule, same serif. Solve
   this from type, structure, rule and space and you have solved the hardest problem in the
   product.

2. **Make the Delta visible without making it a dashboard.** "Already knew 4 · Time saved
   12 min" in a rail is a statistic. The Delta is the actual thesis: the app knows what you
   know and declines to waste your time. What does an idea that was _skipped on your behalf_
   look like? Does the reader ever see the ghost of it? Is that reassuring or unnerving?

3. **Draw the Depth Dial.** Five depths of one idea, instant, free, and reversible. Is it a
   control, a gesture, a progressive disclosure, a zoom? The wrong answer makes the card
   feel like a document viewer; the right one makes depth feel like focusing a lens.

4. **Give recall a form that is not a quiz.** A question interleaved into a reading feed
   currently reads as an interruption, because it is one. Max three per session, at least
   four cards apart, never in the first two, and dismissing them makes the system back off
   rather than nag. Design the arrival, the answer, the reveal, and the graceful dismissal.

5. **Design decay honestly.** Half-Life replaces streaks: knowledge fades on a curve and the
   product refuses to punish a missed day. Streak widgets are a solved visual problem
   precisely because they are dishonest. What is the honest one? It must never read as guilt,
   never as a grade, and never as a number going down that the reader can do nothing about.

6. **Show the edges of a session on a 375px screen.** The rails are the edges, and phones do
   not have rails. Solve law 6 for the viewport where most reading happens.

7. **Make the card footer a hierarchy.** Save, Ask, Share, Listen, Why — five equal buttons.
   Which of these is the primary act, which are secondary, which belong to a gesture, and
   which should not be on the front of the card at all?

8. **Differentiate the Daily Pull.** It is the one finite, curated, free-forever object in
   the product and it currently looks exactly like the infinite ranked feed. If it read as an
   edition — dated, bounded, complete — the free-forever promise would be visible instead of
   merely true.

9. **Spend the delight budget.** There is one, it is real, and the existing rule is that it
   is spent on **motion, typography and interaction** and never on colour or ornament: type
   that changes size and weight with intent, transitions that explain where a thing went,
   inputs that feel precise, numbers that count rather than appear. If you keep that rule,
   spend the budget harder than the current design does — it is under-spent. If you break it,
   show what you bought.

---

## 6 · What to hand back

Artboards on one canvas, in this order, with a short note under each explaining what
changed and why. Annotate the reasoning, not the obvious — "this is the headline" helps
nobody; "the source trail moved to the front because the anchor is the credibility claim"
is the whole value.

**Core, in order of usefulness:**

1. **The card**, front and back, at three depths of the dial. The product is this object.
2. **For You**, full screen, showing the shell and the session's edges — desktop and 375px.
3. **The end of a session** — whatever replaces or refines `Enough`.
4. **A source page**, with the Delta's _"4 of 18 are new to you"_ carrying real weight.
5. **A recall question**, arriving inside the feed.
6. **The Library**, which is dense, real, and currently the weakest screen.
7. **Sign in** — the first thing a stranger sees, and the current one is genuinely good, so
   it is a fair test of whether your system is better.

**Then any of these you want:**

Daily Pull as an edition · Explore · Search with two kinds of result · Review · Counterpull ·
onboarding · Studio · the Conviction Ledger · Idea Lineage · the appearance settings under
your own system.

**And, for whatever you deliver:**

- **Dark mode**, if your system has one. The current one is ink-ground, not inverted candy.
- **The empty, the loading, the offline and the failed states.** They are the majority of
  first sessions and the current empty-feed screen is the only one anyone designed on
  purpose.
- **1128 × 752** at least once. It is where cards, rails and tally stop fitting together.
- **The tokens**: palette with hexes, type ramp with the actual faces and steps, spacing
  scale, radii, motion durations and easing. If you are replacing the system, replace it in
  full — a redesign that cannot be tokenised cannot be built.

---

## 7 · How this will be judged

- **Would a stranger call it considered?** Imprint is fun and disposable; Blinkist is
  efficient and grey. The one impression neither can buy quickly is _made on purpose_.
- **Does the design make the product's claim, or does copy have to make it?** _Enough for
  today_ should be evident from the layout before anyone reads the words.
- **Is it obviously not Deepstash, and also obviously not a reaction to Deepstash?** A
  design defined entirely by what it refuses is still being led by the thing it refuses.
- **Does it work at 375px and at 2560px?** The wide case is a real failure today: a 27-inch
  display currently shows a phone's line length in a 544px column with the rest spent on
  margin. Extra width should buy structure and context, never a longer line.
- **Does it survive the absence of images?** Every screen, with no artwork anywhere.
- **Could someone build it from what you handed over?** Tokens, states, breakpoints.

### How to fail

- A re-skin — same layout, new colours.
- Gradients, glass, glow, elevation stacks, or a second accent doing the work that weight,
  size and space should be doing.
- Illustration or a mascot. Both are what a product reaches for when it does not trust its
  own sentence.
- Card art. There is none and there never will be.
- A design that only works with a hero image, a cover, or a full-bleed photograph.
- Anything that reads as a streak, a grade, a badge or a nudge.
- A feed that could be mistaken for a video feed with the sound off.
- Beautiful screens with no empty, loading or error state — that is a portfolio piece, not a
  product.

---

## 8 · If you replace the system

Entirely permitted, and the most interesting version of this exercise. Two things come with
it, because the current system is enforced by machinery rather than by memory:

- **Hand back the amended rules.** The design laws live as executable checks (no gradients,
  no decorative `box-shadow`, no hex outside the token file, radii ≤ 4px) plus an audit
  skill and two documents. A new system needs its own laws written in the same form —
  short, absolute, and testable — or it will be enforced against by the old ones.
- **Say what you are buying and what you are spending.** Each current law exists against a
  specific failure: gradients and rounding are the competitor's signature; one accent is a
  discipline that forces hierarchy into weight and space; the pinned measure is what stops
  the reading column growing into a wall of text on a big display. Break any of them
  deliberately and say what you got for it. "It looks better" is an acceptable answer if it
  is true and argued.

## 9 · Reference, if you want the detail

| Path                                | What is in it                                      |
| ----------------------------------- | -------------------------------------------------- |
| `docs/design.md`                    | The system as built, and the viewport laws         |
| `docs/design-first-run.md`          | The first four screens, argued line by line        |
| `docs/product.md`                   | The unit, the six mechanics, the Depth Dial        |
| `docs/masterplan.md`                | Positioning, and what is taken from the competitor |
| `packages/ui/src/styles/tokens.css` | Every token, with the reasoning in comments        |
| `packages/ui/src/components/`       | `PullCard`, `Enough`, `Meter`                      |
| `apps/web/src/App.tsx`              | The shell, the two navigation classes, the tally   |
| `CLAUDE.md`                         | The seven laws the repository is held to           |
