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
 */
export const PROGRESS_COPY = {
  /** Under the title. Says where each kind of number comes from. */
  provenance:
    'What you have read, and how well you are still holding on to it. Every count here comes ' +
    'from your own recall history. How well you are holding on to something is an estimate: it ' +
    'is read off a decay curve from when you last recalled it and how firmly, not measured by ' +
    'asking you today.',
} as const;
