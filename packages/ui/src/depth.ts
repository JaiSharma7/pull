/**
 * The Depth Dial, as arithmetic.
 *
 * `docs/product.md` specifies depth as a dial over *one canonical summary* —
 * "not separate generations… different subsets of the same record". That is what
 * makes it free, and it is law 2 in `CLAUDE.md`: the deeper stops must cost
 * nothing at read time. So every number here is derived from text the feed has
 * already fetched. Nothing in this file calls anything.
 *
 * The shape — five stops, ticks that grow, labels that are clock times computed
 * from word counts, `Source` as the terminus — is the design session's, and the
 * constants below are carried across from it unchanged.
 *
 * Kept apart from `PullCard.tsx` for the reason `lib/routes.ts` and
 * `packages/ranking` are: the placement rules are worth testing over many inputs,
 * and a pure function is the only shape that can be.
 */

/**
 * Words a minute.
 *
 * 210, from the design session, which raised it to a law: *every duration shown
 * to a reader is computed from a word count at 210wpm*. The reasoning is worth
 * keeping attached to the constant — "a depth dial that says '8 min' over 300
 * words is a lie the design tells on the product's behalf, and time saved is the
 * one number the business model rests on".
 *
 * Which is also why `pulls.estimated_read_seconds` is not consulted here. A
 * stored estimate that disagreed with the words on screen would be exactly the
 * lie the law names, and the reader can count the words.
 */
export const WORDS_PER_MINUTE = 210;

export type DepthKey = 'headline' | 'claim' | 'why' | 'full' | 'source';

export interface DepthLevel {
  key: DepthKey;
  /** The dial's own label: a clock time, or `Source` at the terminus. */
  label: string;
  /**
   * What the stop is called to a screen reader.
   *
   * The visible label is a duration, and "35 sec" read out of context says
   * nothing about which way the dial is being turned.
   */
  aria: string;
  /**
   * Tick length for this stop, longest at the deepest.
   *
   * The dial has to read without colour — `docs/design.md`'s "colour is never the
   * only signal", which for this control means tick length carries the position
   * and the accent only confirms it.
   */
  tick: string;
  /** Words to the END of this stop — cumulative, not marginal. */
  words: number;
  /** Reading time for those words, in seconds. */
  seconds: number;
}

/**
 * The five stops, in order, with the geometry the design session fixed.
 *
 * A card offers a prefix of this list filtered to the parts it actually has, so
 * the tick a stop gets is its position on the *card's* dial rather than its
 * position here. A short card gets a short dial: the control is not identical
 * everywhere, which is the honest cost of driving it from real content.
 */
const STOPS: { key: DepthKey; aria: string }[] = [
  { key: 'headline', aria: 'Shortest' },
  { key: 'claim', aria: 'Short' },
  { key: 'why', aria: 'Medium' },
  { key: 'full', aria: 'Long' },
  { key: 'source', aria: 'Go to the source' },
];

const TICKS = ['6px', '10px', '14px', '18px', '22px'];

/**
 * How far the headline outsizes the body at each stop, as a multiple of
 * `--step-0`.
 *
 * At the shortest stop the idea *is* the card and is set at display size; each
 * turn of the dial trades that scale for the prose arriving underneath it. The
 * headline shrinking is what makes the card read as one object changing rather
 * than as a page with things appended to it.
 */
export const HEADLINE_SCALE = [2.95, 2.25, 1.85, 1.6, 1.45];

/** The text a card can reveal, in the order it is revealed. */
export interface DepthContent {
  headline: string;
  body: string;
  whyItMatters?: string | null;
  example?: string | null;
  explanation?: string | null;
  /**
   * Whether the card has somewhere to send the reader.
   *
   * The last stop is an offer, not a wall — every source in the corpus is public
   * domain and readable in full without an account — but a card whose work is not
   * resolvable (the specimen, an offline row) must not draw a stop that goes
   * nowhere.
   */
  hasSource?: boolean;
}

export function countWords(text: string | null | undefined): number {
  const trimmed = (text ?? '').trim();
  return trimmed === '' ? 0 : trimmed.split(/\s+/).length;
}

export function readingSeconds(words: number): number {
  return Math.round((words / WORDS_PER_MINUTE) * 60);
}

/**
 * A stop's clock label.
 *
 * Rounded to five seconds with a floor of ten, then to whole minutes past the
 * minute — never "1 min 20 sec". The reader is deciding whether to keep going,
 * not scheduling, and a duration precise to the second would claim an accuracy
 * that reading speed does not have.
 */
export function clock(words: number): string {
  const secs = readingSeconds(words);
  if (secs < 60) return `${Math.max(10, Math.round(secs / 5) * 5)} sec`;
  return `${Math.round(secs / 60)} min`;
}

/**
 * The stops this particular Pull can offer.
 *
 * Driven by the content that exists, never by a fixed list. Most of the corpus
 * has `why_it_matters` and only some has `explanation`, so a card that always
 * showed five stops would offer some that lead to an empty panel — which is the
 * failure the old two-sided card had in miniature, where "Why" was always there
 * and sometimes turned over to nothing.
 *
 * The headline counts from the first stop, so every label includes the words the
 * reader can already see.
 */
export function depthLevels(content: DepthContent): DepthLevel[] {
  const added: Record<DepthKey, number> = {
    headline: countWords(content.headline),
    claim: countWords(content.body),
    why: countWords(content.whyItMatters) + countWords(content.example),
    full: countWords(content.explanation),
    // The source adds no words to the card; it is where the card stops being the
    // thing you are reading.
    source: 0,
  };

  const levels: DepthLevel[] = [];
  let words = 0;

  for (const stop of STOPS) {
    // A stop with nothing behind it is not a stop. `headline` is exempt because a
    // Pull always has one, and `source` because its content is elsewhere.
    if (stop.key === 'source') {
      if (!content.hasSource) continue;
    } else if (stop.key !== 'headline' && added[stop.key] === 0) {
      continue;
    }

    words += added[stop.key];
    levels.push({
      key: stop.key,
      label: stop.key === 'source' ? 'Source' : clock(words),
      aria: stop.aria,
      tick: TICKS[levels.length] ?? TICKS[TICKS.length - 1]!,
      words,
      seconds: readingSeconds(words),
    });
  }

  return levels;
}

/**
 * Clamp a remembered depth to what a card can actually show.
 *
 * The feed keeps one depth across cards — a reader who opened one Pull to its
 * full argument is saying something about how they want to read, not about that
 * card — and cards differ in how many stops they have. Without this, landing on a
 * card with no `explanation` while holding depth 3 would index past the end.
 */
export function clampDepth(depth: number, levels: DepthLevel[]): number {
  if (levels.length === 0) return 0;
  return Math.min(Math.max(0, Math.trunc(depth)), levels.length - 1);
}

/**
 * The depth a card opens at.
 *
 * One turn in from the shortest: the claim, which is what the card has always
 * shown. The shortest stop is an option the reader can choose, not the state they
 * are dropped into — a feed of bare headlines would be a table of contents.
 */
export function defaultDepth(levels: DepthLevel[]): number {
  return clampDepth(1, levels);
}

/**
 * What the card is showing at a given depth, as continuous prose.
 *
 * Listen exists because law 3 makes audio free forever, and a Listen fixed to one
 * stop would make it free only at the depth the reader did not choose: open a
 * card to its full argument, press Listen, and hear the headline. The dial and
 * the voice have to agree about what is on the card.
 *
 * Sentence-terminated so a speech synthesiser pauses between parts instead of
 * running the headline into the claim.
 */
export function textAtDepth(content: DepthContent, depth: number): string {
  const levels = depthLevels(content);
  const shown = new Set(levels.slice(0, clampDepth(depth, levels) + 1).map((l) => l.key));

  const parts = [content.headline];
  if (shown.has('claim')) parts.push(content.body);
  if (shown.has('why')) parts.push(content.whyItMatters ?? '', content.example ?? '');
  if (shown.has('full')) parts.push(content.explanation ?? '');

  return parts
    .map((p) => p.trim())
    .filter((p) => p !== '')
    .map((p) => (/[.!?]$/.test(p) ? p : `${p}.`))
    .join(' ');
}
