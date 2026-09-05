/**
 * What the progress screen promises about its own numbers.
 *
 * Here rather than inline in the route for the reason `APPEARANCE_COPY` and
 * `AUDIO_COPY` are: a sentence the product makes a claim in is a value, testable
 * without rendering a screen that needs a live session and a network call.
 *
 * The claim it replaces was "Every number here is computed from your own recall
 * history — nothing is estimated", and the second half was never true.
 * Retrievability is not measured, it is derived: `public.retrievability` reads it
 * off a decay curve from `stability` and `last_seen_at`, and "Solid",
 * "Refreshing" and "Fading" are bands of that curve — so the sentence disclaimed
 * the three headline numbers on the screen it headed. The counts ARE the
 * reader's own history, and saying so is worth keeping; the estimate is worth
 * admitting, because a reader deciding what to revise should know which of the
 * two kinds of number they are looking at.
 *
 * AND THE CURVE RESTARTS ON A READ, not only on a recall, which the first draft
 * of this sentence got wrong. `record_read` (20260829222803) opens a
 * `knowledge_states` row with `last_seen_at = now()` and stamps the same on every
 * later read, so a reader who merely reopens an idea moves the curve without
 * answering anything. Telling them the estimate comes from "when you last
 * recalled it" would explain a number that had just gone up for a reason the
 * explanation does not contain.
 */
export const PROGRESS_COPY = {
  /** Under the title. Says where each kind of number comes from. */
  provenance:
    'What you have read, and how well you are still holding on to it. Every count here comes ' +
    'from your own recall history. How well you are holding on to something is an estimate ' +
    'rather than a measurement: it is read off a curve that starts again each time you open or ' +
    'recall the idea, and stretches further the better you recalled it. Nothing here asks you ' +
    'today.',
} as const;
