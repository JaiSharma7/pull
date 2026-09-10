/**
 * A strictly increasing stamp for ordering the reader's own decisions.
 *
 * `Date.now()` is only millisecond-resolution, so two submissions made inside
 * one millisecond share a value — and equal timestamps carry no information
 * about which came first, which is the one thing the server needs to order
 * them. Advancing by a millisecond whenever the clock has not moved makes that
 * impossible within a tab: every stamp this returns is greater than the last.
 *
 * It is deliberately per-tab. Making it monotonic across tabs would need an
 * origin-wide lock around a stored counter on every submission, and the race it
 * would close — two tabs answering the same card inside the same millisecond —
 * is not reachable by someone clicking. The remaining tie resolves to whichever
 * submission reaches the database second, which is no worse than arbitrary and
 * no longer discards a stance.
 *
 * It can run ahead of the wall clock, by at most one millisecond per submission
 * in a burst. That is the point: it is an ordering token, not a timestamp, and
 * the server compares it only against other stamps from the same reader.
 */
let last = 0;

/**
 * An identity for one submission, which must not be the thing that loses it.
 *
 * `crypto.randomUUID` is undefined in a non-secure context — `lib/offline.ts` names
 * that as live, and this whole mechanism exists because a grade applied twice is
 * invisible and wrong. Called bare, it throws where it is called, and the three sites
 * in `Feed.tsx` call it AFTER the slot is marked handled: the reader's stance and
 * explanation would go with no banner, no queue entry and no retry.
 *
 * So it falls back rather than throws. `getRandomValues` gives the same 122 bits of
 * entropy where the constructor is missing; the last resort is a timestamp and two
 * random suffixes, which is weaker and still unique enough for what the id is FOR — a
 * `(user_id, client_mutation_id)` unique index recognising one reader's retry of one
 * submission. It never needs to be unguessable.
 */
export function mutationId(): string {
  const c: Crypto | undefined = globalThis.crypto;
  if (typeof c?.randomUUID === 'function') return c.randomUUID();
  if (typeof c?.getRandomValues === 'function') {
    const b = c.getRandomValues(new Uint8Array(16));
    b[6] = ((b[6] as number) & 0x0f) | 0x40;
    b[8] = ((b[8] as number) & 0x3f) | 0x80;
    const hex = [...b].map((n) => n.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  /*
   * 32 hex characters, then sliced. The first version built the groups by hand and got
   * a 12-character first group — a string shaped roughly like a uuid, which
   * `recall_events.client_mutation_id` is typed `uuid` and would have refused outright.
   * The test below is what caught it; a fallback that produces an invalid id is worse
   * than the throw it replaced, because it fails at the server instead of the call.
   */
  const hex = (n: number) =>
    Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  const time = Date.now().toString(16).padStart(12, '0').slice(-12);
  const body = `${time}${hex(20)}`;
  return (
    `${body.slice(0, 8)}-${body.slice(8, 12)}-4${body.slice(13, 16)}-` +
    `8${body.slice(17, 20)}-${body.slice(20, 32)}`
  );
}

export function nextSubmissionStamp(): number {
  const now = Date.now();
  last = now > last ? now : last + 1;
  return last;
}

/**
 * The longest answer the database will accept as a measurement.
 *
 * `recall_events_latency_bounds` in `20260905100000_a_grade_is_recorded_once.sql`
 * is `latency_ms is null or latency_ms between 0 and 3600000`. Mirrored here as a
 * named constant rather than repeated as a number, because it is a database fact
 * and the check is the reason this function exists.
 */
export const MAX_LATENCY_MS = 3_600_000;

/**
 * How long since the answer was shown — or nothing, when that is not a measurement.
 *
 * Review sent `Date.now() - revealedAt` unbounded, so a reader who revealed an
 * answer and came back after lunch sent something over the hour the column allows.
 * Postgres refused it with `23514`, and because a check violation is permanent the
 * grade was then queued and dropped by the first drain — the whole grade lost over
 * a field that is only ever advisory.
 *
 * Omitted rather than clamped, and that is the substance of the fix. Clamping would
 * record exactly one hour, which is a measurement, and a false one: someone who
 * walked away did not take an hour to decide. `latency_ms` is nullable precisely so
 * that "no useful timing" can be said, and a grade with no latency is worth far more
 * than no grade at all.
 */
export function elapsedSince(revealedAt: number | null, now = Date.now()): number | undefined {
  if (revealedAt === null) return undefined;
  const elapsed = now - revealedAt;
  // A clock that has gone backwards — an NTP correction mid-session — is not a
  // negative answer time either; the column's floor is 0 and the honest value is none.
  if (elapsed < 0 || elapsed > MAX_LATENCY_MS) return undefined;
  return elapsed;
}

/**
 * One mutation id AND one submission stamp per DRAFT, decided in one place and never
 * cleared by hand.
 *
 * `Path.tsx` minted a fresh `mutationId()` inside its click handler, and its catch only
 * logged -- so a lost response followed by a second click wrote a second conviction,
 * explanation or note, each under an id the server had never seen. Every one of those
 * writes deduplicates on the id, which is only worth anything if a retry carries the
 * same one.
 *
 * THE STAMP TRAVELS WITH THE ID, and that is the second half of the same fix (review
 * finding). `set_conviction` orders a reader's stances by `submitted_at`, so a retry
 * that reused the id but minted a new stamp would tell the server the reader decided
 * LATER than they did -- and if the first request never reached the database while
 * another tab recorded a newer stance in between, the stale retry would supersede the
 * newer stance. That is the exact inversion `submitted_at` exists to prevent, so a
 * draft's stamp is fixed at the first attempt and every retry sends both provenance
 * values unchanged.
 *
 * Keyed by what is being submitted rather than held and cleared: `Source.tsx`'s
 * `askMutations` is deleted on success, on every edit and on dismissal, and that
 * discipline has been lost three times on one file. Here the caller names the draft --
 * the step and its content -- and the same name gets the same id and stamp however
 * many times it is sent, even with other drafts sent in between, while an edited draft
 * is a different name and gets fresh ones. That is what an edit has to mean: the
 * server would otherwise answer with the FIRST wording and silently discard the new
 * one.
 *
 * `mint` and `stamp` are parameters so the test can count how often each is called.
 */
export interface DraftSubmission {
  mutationId: string;
  submittedAt: number;
}

export function draftSubmissions(
  mint: () => string = mutationId,
  stamp: () => number = nextSubmissionStamp,
): (key: string) => DraftSubmission {
  // Every draft this screen has sent, not only the last one (review finding): a reader
  // who sends A, edits to B, and restores A is sending A again, and holding only B
  // would have minted A a second id. Bounded by the reader's own edits on one screen,
  // which is small; the keys carry the text, so a screen with many long drafts holds
  // many long keys, and that is the whole cost.
  const held = new Map<string, DraftSubmission>();
  return (key) => {
    let submission = held.get(key);
    if (submission === undefined) {
      submission = { mutationId: mint(), submittedAt: stamp() };
      held.set(key, submission);
    }
    return submission;
  };
}
