/**
 * The Conviction Ledger, as something a reader can read.
 *
 * `set_conviction` has been writing stances since the first week, and
 * `docs/contributing-map.md` has carried the consequence as an open item for as
 * long: "the Conviction Ledger has no read surface… the README feature — *you
 * agreed with this in March; here is the strongest case against it* — has data
 * and no screen." This module is the arithmetic half of that screen.
 *
 * Pure, and in its own file, for the reason `lib/library.ts` and
 * `packages/ranking` are: what makes this worth having is not the fetch, it is
 * the question of what counts as CHANGING YOUR MIND, and that question is worth
 * asserting over a few dozen shapes rather than eyeballing once.
 *
 * The answer this file gives: a change is a stance that differs from the one
 * before it. Recording the same stance twice — which the app does whenever a
 * reader re-answers a Counterpull the same way — is a reaffirmation, and
 * counting it would tell somebody who has held one position for a year that they
 * have changed their mind six times. Moving from `unsure` to `agree` IS a change,
 * because unsure is a position: it is what the reader said when asked.
 */

/** The three stances `public.stance` allows. */
export type Stance = 'agree' | 'disagree' | 'unsure';

export const STANCES: readonly Stance[] = ['agree', 'disagree', 'unsure'];

export function isStance(value: unknown): value is Stance {
  return typeof value === 'string' && (STANCES as readonly string[]).includes(value);
}

/** One row of `public.convictions`, with the idea it is about. */
export interface ConvictionRow {
  id: string;
  pullId: string;
  stance: Stance;
  /** ISO 8601, as Postgres returns it. */
  createdAt: string;
  headline: string;
  workId: string;
  workTitle: string;
}

/** What a reader currently holds about one idea, and how they got there. */
export interface Belief {
  pullId: string;
  headline: string;
  workId: string;
  workTitle: string;
  /** The most recent stance recorded. */
  stance: Stance;
  /** When it was taken — the date of the most recent row, not of the first. */
  since: string;
  /** The first stance recorded, when it differs from the current one; null when it does not. */
  from: Stance | null;
  /** How many times the stance actually differed from the one before it. */
  changes: number;
  /** Every row for this idea, oldest first, so a screen can show the whole chain. */
  chain: ConvictionRow[];
}

/**
 * Group a reader's convictions into one belief per idea, newest first.
 *
 * `superseded_by` is deliberately not consulted. It exists to keep the partial
 * unique index honest — one un-superseded row per pull — and it is transiently
 * self-referential inside `set_conviction`, which points a row at itself before
 * pointing it at its replacement. Ordering by time answers the same question
 * without depending on the state of a write that may be half done, and a chain
 * read by time is a chain a reader would recognise.
 *
 * Ties on `created_at` break on `id` so the order is total: two stances recorded
 * in the same millisecond must not swap places between two renders and turn a
 * reaffirmation into a change of mind.
 */
export function chainStances(rows: readonly ConvictionRow[]): Belief[] {
  const byPull = new Map<string, ConvictionRow[]>();
  for (const row of rows) {
    const list = byPull.get(row.pullId);
    if (list) list.push(row);
    else byPull.set(row.pullId, [row]);
  }

  const beliefs: Belief[] = [];
  for (const [pullId, unsorted] of byPull) {
    const chain = [...unsorted].sort(
      (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || compare(a.id, b.id),
    );
    const first = chain[0];
    const last = chain[chain.length - 1];
    if (!first || !last) continue;

    let changes = 0;
    for (let i = 1; i < chain.length; i += 1) {
      if (chain[i]!.stance !== chain[i - 1]!.stance) changes += 1;
    }

    beliefs.push({
      pullId,
      headline: last.headline,
      workId: last.workId,
      workTitle: last.workTitle,
      stance: last.stance,
      since: last.createdAt,
      from: first.stance === last.stance ? null : first.stance,
      changes,
      chain,
    });
  }

  // Newest first: what a reader decided most recently is what they are most
  // likely to be looking for, and it is the order every other history in this app
  // is read in.
  return beliefs.sort(
    (a, b) => Date.parse(b.since) - Date.parse(a.since) || compare(a.pullId, b.pullId),
  );
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * How many of a reader's beliefs they have changed their mind about at least
 * once. The headline number for the section, and the one that is worth knowing:
 * the total number of stances is a measure of how much somebody has used the
 * app, which is an engagement metric and an anti-goal (`docs/product.md`).
 */
export function mindsChanged(beliefs: readonly Belief[]): number {
  return beliefs.filter((b) => b.changes > 0).length;
}

/**
 * What to say about a stance, rather than only what to call it.
 *
 * Written in the first person because the screen is the reader's own record, and
 * in the past tense because that is what it is: a note of what they said when
 * they were asked, not an assertion about what they think now.
 */
export const BELIEF_COPY: Record<Stance, { label: string; note: string }> = {
  agree: { label: 'You agreed', note: 'You took this as true when it was put to you.' },
  disagree: { label: 'You disagreed', note: 'You rejected this when it was put to you.' },
  unsure: { label: 'You were unsure', note: 'You did not settle this when it was put to you.' },
};

/**
 * How a change of mind reads — the whole point of the section, so it is a
 * sentence rather than a number beside an icon.
 *
 * One change is named ("from disagreeing"), because a single reversal is a story
 * the reader can place. More than one is counted, because by then the interesting
 * fact is that the question is live for them rather than which way it went.
 */
export function changeLine(belief: Belief): string | null {
  if (belief.changes === 0) return null;
  if (belief.changes === 1 && belief.from !== null) {
    return `Changed once, from ${CHANGED_FROM[belief.from]}.`;
  }
  return `Changed ${belief.changes} times.`;
}

const CHANGED_FROM: Record<Stance, string> = {
  agree: 'agreeing',
  disagree: 'disagreeing',
  unsure: 'being unsure',
};

/** The empty state, which says what would fill it rather than only that it is empty. */
export const BELIEF_COPY_EMPTY =
  'Nothing recorded yet. When the feed puts a claim to you and asks whether you accept it, ' +
  'your answer is kept here — and so is every time you change it.';
