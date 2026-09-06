import type { RecallGrade } from './grades.js';

/**
 * A question that can be wrong, graded on the device.
 *
 * Every question in this product used to be free recall: the reader was shown a
 * prompt, remembered what they could, and graded themselves. That is honest but it
 * cannot be *wrong* — there is nothing to compare an answer against, so a confident
 * misremembering scores the same as a confident memory. Multiple choice, cloze and
 * ordering questions can be wrong, and that is the entire point of them: the
 * "confidently wrong" repair loop needs an answer the reader gave and an answer the
 * question holds.
 *
 * Everything here is pure and runs in the browser. Grading a multiple-choice
 * answer is a string comparison; grading a typed cloze is an edit distance. Neither
 * needs a model, and neither may ever call one — law 2 puts no model in the read
 * path, and a question answered a thousand times a day is the read path. The
 * questions themselves are written once at generation time (or by hand for the
 * seeded corpus) and served as rows.
 *
 * Nothing in this module touches the database. The question shape is declared here
 * because it is the shape the graders need; the migration that stores it mirrors
 * this, not the other way round.
 */

/**
 * The kinds a question can be.
 *
 * A mirror of a database constraint again, and this time it is one.
 * `quiz_questions.kind` was plain `text not null default 'recall'` with nothing but
 * the unique `(pull_id, kind)` index on it, and this comment said so — the set was
 * *intended* and unenforced, so a row could arrive carrying a kind that is not here.
 * `20260905120000_a_question_that_can_be_wrong.sql` closes that: the check on
 * `quiz_questions.kind` is these six values, in this order, and
 * `supabase/tests/questions.sql` refuses an unknown one.
 *
 * NOTHING MAKES THE TWO MOVE TOGETHER. `packages/db/src/enum-parity.ts` asserts
 * against Postgres ENUM types, and this is a text column with a check, which the
 * generated types render as plain `string`. So a seventh kind added to the migration
 * and not to this list typechecks and ships. Treating an unknown kind as ungraded is
 * therefore still the rule for every consumer — not because Postgres permits one, but
 * because this file and Postgres can still drift.
 *
 * `user_questions.kind` is deliberately the FIRST FOUR only. `ordering` needs its
 * steps in a canonical sequence and `scenario` needs a situation composed around the
 * idea; neither is something the "Remember this" box — a prompt and an answer — can
 * express, so a reader who wants either writes a `short_answer`.
 *
 * (The sibling claim about `confidence` mirroring `recall_events` is true:
 * 20260905100000 does check it.)
 *
 * Only three are graded here. `recall`, `short_answer` and `scenario` stay
 * self-graded: there is no deterministic way to mark a paragraph the reader
 * composed, and marking it with a model would be a model call per answer.
 */
export const QUESTION_KINDS = [
  'recall',
  'mcq',
  'cloze',
  'short_answer',
  'ordering',
  'scenario',
] as const;
export type QuestionKind = (typeof QUESTION_KINDS)[number];

/** Why a particular wrong answer is wrong — shown after the reader picks it. */
export interface DistractorRationale {
  distractor: string;
  why: string;
}

/**
 * What `whyWrong` found, and which question it answers.
 *
 * The two are not interchangeable and the screen has to head them differently.
 * `distractor` is an account of the reader's own choice — "Why that's wrong".
 * `answer` is the question's general explanation, which says why the ANSWER is
 * the answer whatever was picked; headed as an account of the error it tells a
 * reader a fact about an option they did not choose, and a screen that renders
 * `explanation` separately would print the same paragraph twice.
 */
export interface WhyWrong {
  why: string;
  source: 'distractor' | 'answer';
}

export interface Question {
  id: string;
  kind: QuestionKind;
  prompt: string;
  /**
   * The right answer. For `mcq` it is one option among `distractors`; for `cloze`
   * it is what fills the blank; for `ordering` it is the steps in their correct
   * order, one per line (see `orderingSteps`).
   *
   * NULLABLE, because the payload really carries nulls. `quiz_questions.answer` is
   * `not null`, but a reader's own question is not: `user_questions_graded_kinds_need_an_answer`
   * deliberately exempts `recall` and `short_answer`, which are self-graded and have
   * nothing to store, and `get_due_reviews` passes `uq.answer` straight through. This
   * said `string` while the RPC returned `{"kind":"recall","answer":null}` -- measured
   * against the local stack -- so every entry point below threw on it: `.trim()` in
   * `mcqOptions`, `gradeMcq` and `whyWrong`, `.split()` in `orderingSteps`. They are
   * narrowed rather than the type being widened alone, because each already refuses an
   * empty answer just below -- three by an explicit guard, `orderingSteps` by filtering
   * out the blank lines that are all an empty string can produce -- and `?? ''` feeds
   * that existing refusal rather than adding a second one.
   */
  answer: string | null;
  /** Wrong options, for `mcq`. Empty for every other kind. */
  distractors: string[];
  /**
   * Which table it came from. `get_due_reviews` sets it, and the card's `questionSource`
   * is this field of `questions[0]`. Optional because the graders never read it and the
   * fixtures in this file's tests do not carry one.
   */
  source?: 'user' | 'canonical';
  /** The sentence with a blank in it, for `cloze`. */
  cloze?: string | null;
  /** Why the answer is the answer — shown after grading, whatever was picked. */
  explanation?: string | null;
  rationale: DistractorRationale[];
}

/**
 * How sure the reader said they were before answering. Mirrors the
 * `confidence` check on `recall_events`.
 *
 * Declared here rather than in `grades.ts` so this module lands without touching
 * a file the review-path PRs are also editing; it can move once both are in.
 */
export const CONFIDENCES = ['sure', 'unsure'] as const;
export type Confidence = (typeof CONFIDENCES)[number];

export interface GradeResult {
  grade: RecallGrade;
  correct: boolean;
  /**
   * Wrong, and sure of it. The one signal the free-recall questions could never
   * produce, and the one the memory model most needs: a hesitant miss is a lapse,
   * a confident miss is a false belief, and the second needs a different repair.
   */
  confidentlyWrong: boolean;
}

/* --------------------------------------------------------------------------
 * Determinism
 * -------------------------------------------------------------------------- */

/**
 * A 32-bit hash of a string, so a seed can be anything the caller has to hand —
 * a question id, a session seed, a date. FNV-1a: tiny, well-distributed enough
 * for shuffling four options, and not for anything else.
 */
function hashSeed(seed: string | number): number {
  const text = String(seed);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * A small deterministic generator (mulberry32) seeded from `hashSeed`. Not
 * `packages/ranking`'s `seededUnit`, which is bit-compatible with the SQL planner
 * and needs `node:crypto` for it; this only has to agree with itself.
 */
function generator(seed: string | number): () => number {
  let state = hashSeed(seed);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Fisher–Yates, seeded, and pure: the input is not touched.
 *
 * The order of a question's options must not change between a render and a
 * re-render, or the reader's click lands on a different option than the one they
 * read. Seeding on the question id (see `mcqOptions`) also means the same reader
 * sees the same order across sessions, so the answer never becomes "the one that
 * moved".
 */
export function seededShuffle<T>(items: readonly T[], seed: string | number): T[] {
  const out = [...items];
  const next = generator(seed);
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    const a = out[i] as T;
    out[i] = out[j] as T;
    out[j] = a;
  }
  return out;
}

/**
 * The options to show for a multiple-choice question, in a stable order.
 *
 * The answer is always among them. A distractor identical to the answer is
 * dropped rather than shown twice, and so is a duplicate distractor — an authored
 * question should never contain either, but a question that does must not present
 * two right answers or two identical wrong ones.
 */
export function mcqOptions(q: Pick<Question, 'answer' | 'distractors'>, seed: string | number) {
  const answer = (q.answer ?? '').trim();
  // A blank answer is a malformed row, and it used to be pushed anyway — so the
  // reader was shown an empty option, and picking it graded `forgot` with
  // `confidentlyWrong: true` while `whyWrong` returned null for the same reason.
  // Judged and then given no reason, on a question that should not have rendered.
  // `gradeMcq` already guards `answer.length > 0`; this is the same guard one step
  // earlier, where it can stop the option existing at all.
  if (!answer) return [];
  const seen = new Set<string>([answer]);
  const options = [answer];
  // NARROWED LIKE `whyWrong` NARROWS ITS OWN `rationale`, at the bottom of this file,
  // and for the reason the next paragraph gives: `distractors` is `string[]` in
  // TypeScript and jsonb in Postgres, and
  // it arrives through `supabase.rpc('get_due_reviews')` under an unchecked cast. The
  // constraints on both sides check the CONTAINER -- an array, at most eight, under a
  // size cap -- and say nothing about the members. `user_questions.options` is the one
  // a reader writes directly through PostgREST, so `[1, null]` is a storable 201, and
  // `get_due_reviews` surfaces it here as `distractors`. Calling `.trim()` on that
  // throws, and will do it inside the render once 3d is the thing calling this --
  // stated as what it would do rather than what it did, because nothing imports this
  // module yet except its own test, so no reader has seen it.
  //
  // Filtered rather than coerced: a number where an option should be is a malformed
  // question, and `String(1)` would render "1" as a choice.
  for (const raw of Array.isArray(q.distractors) ? q.distractors : []) {
    if (typeof raw !== 'string') continue;
    const d = raw.trim();
    if (!d || seen.has(d)) continue;
    seen.add(d);
    options.push(d);
  }
  /*
   * FEWER THAN TWO OPTIONS IS NOT A MULTIPLE CHOICE, and returning one is worse than
   * returning none.
   *
   * `quiz_questions_mcq_has_distractors` counts array ELEMENTS -- so `distractors:
   * [1, 2]` satisfies it, the filter above drops both as non-strings, and one option
   * is left. `user_questions.options` has no such rule at all, deliberately: the
   * migration declines it because `remember_pull` cannot write the column, so a reader
   * can store `kind = 'mcq'` with `options = '[]'`. Both are storable; both were
   * measured.
   *
   * What the reader would then get is a card headed as multiple choice with a single
   * button on it -- the right answer -- and tapping the only thing on screen is scored
   * `correct` with `confidentlyWrong: false`: `good`, or `easy` if they were quick and
   * sure, since `gradeFrom` requires both. Either way the memory model records a PASS
   * for a question that could not be got wrong, which is the exact failure this whole
   * schema exists to make representable.
   *
   * Empty is the honest answer, and the caller already has to handle it: the
   * `if (!answer) return []` at the top of this function returns the same thing for the
   * same reason. A question with no options is one 3d will have to degrade to free
   * recall -- stated as what it will need to do, since 3d does not exist yet and nothing
   * imports this module but its own test.
   */
  if (options.length < 2) return [];
  return seededShuffle(options, seed);
}

/* --------------------------------------------------------------------------
 * Grading
 * -------------------------------------------------------------------------- */

/**
 * How quickly a right answer has to come to count as effortless, per kind.
 *
 * FSRS's `easy` means the memory was there before the question finished being
 * read, and it multiplies the next interval hard — so it is the grade a wrong
 * heuristic does the most damage with. The thresholds are generous for reading
 * time: four options take a few seconds to scan, a cloze has to be typed, and an
 * ordering has to be dragged into place. Under these, a right answer is `good`,
 * which is the safe default for the model.
 */
export const FAST_ANSWER_MS: Record<'mcq' | 'cloze' | 'ordering', number> = {
  mcq: 8_000,
  cloze: 12_000,
  ordering: 15_000,
};

/**
 * Correctness, confidence and latency, mapped onto the four grades the memory
 * model understands.
 *
 *   wrong                       → forgot   (sure or not — the answer was not there)
 *   right, sure, and fast       → easy
 *   right, otherwise            → good
 *
 * `hard` is never produced here. A grader cannot see effort, and guessing at it
 * from latency alone would call a slow connection a struggling memory. It stays
 * available to the reader — see `selfReportedHard`.
 *
 * Latency that was not measured (`null`), or is not a finite non-negative number,
 * is simply "not fast": a missing clock must never promote a grade.
 */
function gradeFrom(
  correct: boolean,
  confidence: Confidence,
  latencyMs: number | null | undefined,
  fastMs: number,
): GradeResult {
  if (!correct) return { grade: 'forgot', correct: false, confidentlyWrong: confidence === 'sure' };
  const fast =
    typeof latencyMs === 'number' &&
    Number.isFinite(latencyMs) &&
    latencyMs >= 0 &&
    latencyMs <= fastMs;
  return {
    grade: confidence === 'sure' && fast ? 'easy' : 'good',
    correct: true,
    confidentlyWrong: false,
  };
}

/**
 * The reader says a right answer cost them something.
 *
 * The one grade the graders never assign, offered back to the reader as a
 * downgrade. It applies only to a right answer: a wrong one is `forgot` whatever
 * the reader felt about it, and letting "hard" soften a miss would put a false
 * belief back on a normal schedule.
 */
export function selfReportedHard<T extends GradeResult>(result: T): T {
  if (!result.correct) return result;
  // Generic, so the caller keeps whatever the grader added — `similarity` from a
  // cloze, `positionsWrong` and `inSequence` from an ordering.
  // Typed as `GradeResult` it erased fields the runtime was still carrying, and
  // a screen asking for them after this call would not compile.
  return { ...result, grade: 'hard' };
}

/**
 * Grade a multiple-choice pick.
 *
 * The comparison is exact after trimming, not normalised: the options were handed
 * out by `mcqOptions` verbatim, so what comes back is one of those strings, and a
 * looser match could only ever make a distractor that differs from the answer by
 * punctuation count as right.
 */
export function gradeMcq(
  picked: string,
  q: Pick<Question, 'answer'>,
  confidence: Confidence,
  latencyMs: number | null | undefined,
): GradeResult {
  // An empty answer matched by an empty pick is not a right answer, it is two
  // absences agreeing. A question with no answer is malformed and nothing the
  // reader did should be graded `easy` on the strength of it. Null included: a
  // self-graded kind stores none, and `get_due_reviews` returns it as it is.
  const answer = (q.answer ?? '').trim();
  /*
   * AND IT CANNOT MAKE THEM CONFIDENTLY WRONG EITHER, which widening `answer` to
   * `string | null` is what made reachable. `confidentlyWrong` is the one signal this
   * whole schema exists to record -- a reader who was sure and mistaken -- and it feeds
   * the repair list on the progress screen. Reporting it for a question that had nothing
   * to be wrong ABOUT would put a false belief in front of a reader who never held one,
   * with no reason shown beside it, because `whyWrong` correctly returns null for the
   * same input.
   *
   * A reader's own `recall` or `short_answer` stores no answer -- the constraint exempts
   * both, deliberately, because they are self-graded -- so this is a valid row reaching
   * a grader that cannot score it, not a malformed one. Wrong, but not damning.
   */
  if (!answer) return { grade: 'forgot', correct: false, confidentlyWrong: false };
  const correct = picked.trim() === answer;
  return gradeFrom(correct, confidence, latencyMs, FAST_ANSWER_MS.mcq);
}

/**
 * Text as a marker would read it: case, punctuation, diacritics and spacing
 * dropped, a leading article dropped.
 *
 * A cloze is typed, and typing is where the small differences live. "Mitochondria"
 * and "the mitochondria." are the same answer, and a grader that says otherwise
 * teaches the reader to game the box rather than remember the idea.
 */

/**
 * The spellings that are one word written two ways, as a LIST rather than a rule.
 *
 * Round 4 wrote these as two suffix regexes and the `-re` one was not a suffix rule at
 * all: `(?<=[a-z]{3})re(s?)(?![a-z])` rewrites the trailing `re` of every word with
 * three stem letters. `timbre` became `timber` — two different words, one string, which
 * graded a wrong answer `easy` at similarity 1 because the fold made it EXACT and the
 * inexact cap was skipped. That is verbatim what the reverted `/z/g` fold is recorded
 * above as doing, one axis along, and it defeats `answerSimilarity`'s stated invariant
 * that a similarity of 1 cannot accompany a wrong answer.
 *
 * A sweep of a 370k-word list found 453 collisions, ten of them between real English
 * words: `timbre`/`timber`, `shire`/`shier`, `stere`/`steer`, `spire`/`spier`,
 * `shore`/`shoer`, `spare`/`spaer`, `eagre`/`eager`, `livre`/`liver`, `outré`/`outer`,
 * `compère`/`compeer`. It also made every final-pair transposition a free exact match:
 * `natuer` for `nature` graded `easy`, bypassing the seven-letter transposition floor
 * entirely.
 *
 * No stem guard fixes that, because the axis is not a suffix — it is a vocabulary. So
 * this is the variant list the module has been saying it needed since the `-ize` fold
 * went in ("closing it needs a variant list, which is a different change"). A list
 * cannot merge a pair nobody put in it.
 *
 * Substrings on purpose: `colour` folds inside `colourful` and `discolour`, `metre`
 * inside `kilometre`, `centre` inside `epicentre`. Longest first so a longer entry is
 * never pre-empted by a shorter one it contains.
 *
 * The costs, named the way the `-ize` fold names `prize`/`prise`: `metre` and `meter`
 * become one word, so a cloze turning on the length against the instrument cannot tell
 * them apart, and the same for `mitre`/`miter` and `titre`/`titer`. Rarer than a reader
 * spelling the way they were taught. `louvre` is deliberately absent — the museum is
 * not a slat.
 */
const SPELLING_VARIANTS: readonly (readonly [string, string])[] = [
  ['misdemeanour', 'misdemeanor'],
  ['manoeuvre', 'maneuver'],
  ['sepulchre', 'sepulcher'],
  ['neighbour', 'neighbor'],
  ['behaviour', 'behavior'],
  ['endeavour', 'endeavor'],
  ['splendour', 'splendor'],
  ['catalogue', 'catalog'],
  ['demeanour', 'demeanor'],
  ['flavour', 'flavor'],
  ['harbour', 'harbor'],
  ['parlour', 'parlor'],
  ['clamour', 'clamor'],
  ['glamour', 'glamor'],
  ['candour', 'candor'],
  ['fervour', 'fervor'],
  ['saviour', 'savior'],
  ['calibre', 'caliber'],
  ['spectre', 'specter'],
  ['sceptre', 'scepter'],
  ['sceptic', 'skeptic'],
  ['theatre', 'theater'],
  ['colour', 'color'],
  ['honour', 'honor'],
  ['favour', 'favor'],
  ['labour', 'labor'],
  ['humour', 'humor'],
  ['rumour', 'rumor'],
  ['vapour', 'vapor'],
  ['armour', 'armor'],
  ['savour', 'savor'],
  ['ardour', 'ardor'],
  ['valour', 'valor'],
  ['rigour', 'rigor'],
  ['vigour', 'vigor'],
  ['tumour', 'tumor'],
  ['sombre', 'somber'],
  ['lustre', 'luster'],
  ['meagre', 'meager'],
  ['goitre', 'goiter'],
  ['centre', 'center'],
  ['odour', 'odor'],
  ['metre', 'meter'],
  ['litre', 'liter'],
  ['fibre', 'fiber'],
  ['mitre', 'miter'],
  ['sabre', 'saber'],
  ['titre', 'titer'],
  ['ochre', 'ocher'],
  ['grey', 'gray'],
];

/** Apply the list, longest entry first. */
function foldVariants(text: string): string {
  let out = text;
  for (const [british, american] of SPELLING_VARIANTS) out = out.split(british).join(american);
  return out;
}

/**
 * THE FOLD IS NOT OPTIONAL, and the parameter that said it was is gone.
 *
 * It was `normaliseAnswer(text, foldSpelling = true)`, justified by a sentence saying
 * the flag "exists for `answerSimilarity`, which reports how close two answers came and
 * should not be told they are the same word". No caller ever passed `false` --
 * `answerSimilarity`, `wordsAreClose` and `gradeCloze` all take the default -- and the
 * sentence is false of the code it describes: `answerSimilarity('centre', 'center')` is
 * 1, measured. A dead exported flag argued for with a false fact is the failure
 * `CLAUDE.md` records commit 4507a7f for.
 */
export function normaliseAnswer(text: string): string {
  return foldVariants(
    text
      .normalize('NFKD')
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      // `&` is a word before it is punctuation. Dropping it made `supply and
      // demand` a two-word answer against a three-word one, so a reader who wrote
      // the ampersand out was graded as having written something else.
      .replace(/&/gu, ' and ')
      // AND `z` FOLDS TO `s`, which is the one orthographic split worth naming.
      //
      // `-ise`/`-ize`, `-isation`/`-ization` and `-yse`/`-yze` are substitutions,
      // so the slip rule below refuses them — and review reproduced the result: a
      // British reader typing `organisation`, `analyse`, `emphasise` or
      // `sceptical` was graded `forgot` AND flagged `confidentlyWrong`, told they
      // held a false belief for spelling their own language. No ratio separates
      // that case from a wrong answer either: `grey`/`gray` and
      // `increase`/`decrease` are both 0.75 per word.
      //
      // Folding the axis makes the whole family an exact match instead, so those
      // readers are graded on what they knew. The cost is `prize`/`prise`, two
      // words this now treats as one; a cloze whose answer turns on that
      // distinction is rarer than a reader who spells the way they were taught.
      //
      // The remaining variants — `sceptic`/`skeptic`, `grey`/`gray`,
      // `catalogue`/`catalog` — are still
      // refused and still flagged. That is a real residual, and no threshold fixes
      // it; closing it needs a variant list, which is a different change.
      //
      // SCOPED TO THE SUFFIX, because the first version of this was `/z/g` and folded
      // every `z` in the language. Two different answers then normalised to one string,
      // which made them an EXACT match — so they skipped the inexact cap below and were
      // graded `easy` at similarity 1 with `confidentlyWrong: false`. Measured: `Zn`
      // answered `Sn`, `Hz` answered `Hs`, `zeal` answered `seal`, `fuzz` answered
      // `fuss` — zinc answered as tin, recorded as a perfect recall. That is verbatim
      // what `semanticMarks` calls the one outcome a grader must never produce, and it
      // broke `answerSimilarity`'s stated invariant that a similarity of 1 cannot
      // accompany a wrong answer. A whole-alphabet substitution cannot be bounded by a
      // threshold; only by being the rule it claimed to be.
      //
      // Lookaheads rather than `\b`, because this runs before punctuation is stripped
      // and the inflections matter: organize/organizing/organization, analyse/analyze.
      // Three letters of stem before it, because `-ize` is a suffix and a suffix
      // attaches to something. Without the lookbehind `prize` folded to `prise` and
      // `size` to `sise` — the very collision the first version was measured on.
      // `organise`, `realise`, `criticise` and `analyse` all have stems and still fold.
      .replace(/(?<=[a-z]{3})iz(?=e|ing|ed|er|ation|abl)/gu, 'is')
      .replace(/(?<=[a-z]{3})yz(?=e|ing|ed|er)/gu, 'ys')
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^(?:a|an|the) /, ''),
  );
}

/**
 * The variant list, applied AFTER the lowercase and not before it.
 *
 * The first version folded the raw text. `SPELLING_VARIANTS` is all lower case and
 * `split`/`join` is case-sensitive, so one capital letter defeated the whole fold —
 * and a capital is the ordinary shape of an authored answer, where no keyboard is
 * involved at all. Measured against round 4, which applied its regexes after the
 * lowercase and did not have this: `Centre` for `center` went from correct at
 * similarity 1 to `forgot` at 0.83 AND `confidentlyWrong`, and so did `Fibre`,
 * `Litre` and `Manoeuvre`. Typed `centre` against an authored `Centre` — the identical
 * word — was accepted only as a typing slip and could never be `easy`.
 *
 * That is verbatim the outcome the paragraphs above call unacceptable, produced by the
 * change that exists to remove it, and reachable by capitalising one letter.
 */

/**
 * The punctuation in an answer that is part of the answer.
 *
 * `normaliseAnswer` drops every symbol, which is right for "mitochondria." and
 * catastrophic for `Na+`: stripped, it is the same string as `Na-`, and the
 * grader would mark the opposite ion correct. `C` would likewise pass for `C++`.
 * A chemistry or computing answer records a wrong answer as recalled, which is
 * the one outcome a grader must never produce.
 *
 * So the symbols are compared separately from the letters. `-` counts only when
 * it is not between two alphanumerics, because there it is a hyphen and
 * "well-known" and "well known" are the same answer; everything else in the set
 * is kept wherever it appears, since a reader does not type `+` or `^` into a
 * one-line answer by accident.
 */
export function semanticMarks(text: string): string {
  // Whitespace is removed BEFORE the scan, or the reader's spacebar decides
  // whether a hyphen is semantic: `well - known` kept the mark and `well known`
  // dropped it, so the first graded wrong against `well-known` and the second
  // graded right. `normaliseAnswer` collapses whitespace for the same reason;
  // this has to agree with it about what the reader wrote.
  const compact = text.replace(/\s+/gu, '');
  const kept: string[] = [];
  for (let i = 0; i < compact.length; i += 1) {
    const ch = compact[i];
    // `noUncheckedIndexedAccess`: an index into a string is `string | undefined`,
    // and only the `=== '-'` comparison narrows it. Guarded once, for both branches.
    if (ch === undefined) continue;
    if (ch === '-') {
      const before = compact[i - 1];
      const after = compact[i + 1];
      const joins =
        before !== undefined &&
        after !== undefined &&
        /[\p{L}\p{N}]/u.test(before) &&
        /[\p{L}\p{N}]/u.test(after);
      if (!joins) kept.push(ch);
    } else if ('+#*/=^<>'.includes(ch)) {
      kept.push(ch);
    }
  }
  return kept.join('');
}

/**
 * Edit distance with adjacent transpositions counted once (optimal string
 * alignment), on strings short enough that the plain table is fine.
 *
 * Plain Levenshtein charges two for "mitochondira", which is the single most
 * common thing fingers do to a word, and on a twelve-letter answer two edits is
 * the difference between accepted and not.
 */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let twoBack: number[] = [];
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = (previous[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1);
      let best = Math.min(
        substitution,
        (previous[j] as number) + 1,
        (current[j - 1] as number) + 1,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, (twoBack[j - 2] as number) + 1);
      }
      current[j] = best;
    }
    twoBack = previous;
    previous = current;
  }
  return previous[b.length] as number;
}

/**
 * How alike two answers are, in [0, 1], after normalisation. 1 is identical;
 * an empty answer on either side is 0 rather than a division by nothing.
 */
export function answerSimilarity(typed: string, answer: string): number {
  // The marks are appended rather than compared separately, so the edit distance
  // sees them. Without this `normaliseAnswer` strips both symbols and `Na-` for
  // `Na+` scores 1 while grading wrong -- a screen using this to say "close"
  // would show a reader "100%" over the word "no". Comparing `na+` with `na-`
  // instead gives 0.67, and the useful property falls out of it: identical
  // normalised-and-marked strings are exactly the ones `gradeCloze` calls
  // correct, so a similarity of 1 can no longer accompany a wrong answer.
  const a = normaliseAnswer(typed) + semanticMarks(typed);
  const b = normaliseAnswer(answer) + semanticMarks(answer);
  if (!a || !b) return 0;
  const longest = Math.max(a.length, b.length);
  return 1 - editDistance(a, b) / longest;
}

/**
 * WHAT COUNTS AS A SLIP, and why it is no longer a ratio.
 *
 * Review also asked for the other half of this: a reader who types `color` for
 * `colour` should not be recorded as `confidentlyWrong`, because that field
 * means a false belief and routes them into the misconception loop. The first
 * draft added a near-miss band that suppressed the flag above a similarity
 * threshold, and it was wrong -- `increase marginal utility` against `decrease
 * marginal utility` is 0.92 similar across the string, so the band quietly
 * re-admitted the exact class this rule exists to catch, and the suite said so.
 * The answer is the rule below rather than a second threshold on top of it: a
 * typo IS the answer now, graded `good`, so it never reaches `confidentlyWrong`
 * at all, and what still fails really is a different answer.
 *
 *
 * The rule here was "within two edits, and at least 0.85 similar, per word". A
 * ratio cannot separate the two things it was being asked to: `color` for
 * `colour` is one edit in six letters and a typo, and `efferent` for `afferent`
 * is one edit in eight and a different structure of the nervous system. Review
 * reproduced four of that second kind grading `easy` at 0.875-0.900 --
 * `efferent`/`afferent`, `absorption`/`adsorption`, `intension`/`intention`,
 * `10000000`/`1000000` -- and `easy` is, by this module's own words, the grade a
 * wrong heuristic does the most damage with. It multiplies stability by more
 * than three and takes the idea out of review for a fortnight, and
 * `confidentlyWrong` is false, so nothing downstream ever looks at it again.
 *
 * The distinction that does hold is not how far apart two words are but WHAT
 * KIND of difference it is. A hand slips off a key and drops a letter, doubles
 * one, or swaps two; it does not substitute one letter for another and land on
 * a word that means something else. So an insertion, a deletion or a
 * transposition is forgiven, and a substitution is not:
 *
 *   colour / color          deletion       -> correct
 *   mitochondira            transposition  -> correct
 *   occurrence / ocurrence  deletion       -> correct
 *   efferent / afferent     substitution   -> not correct
 *   absorption / adsorption substitution   -> not correct
 *   intension / intention   substitution   -> not correct
 *
 * WHAT THIS COSTS, stated because it is a real regression for one class:
 * `ionised` for `ionized` is a substitution and is now graded `forgot`, where
 * the ratio rule accepted it. `similarity` still reports 0.857 so the screen can
 * say how close it came, and the reader sees the idea again tomorrow rather than
 * in three days. That is the cheap direction to be wrong in, and the alternative
 * was letting the opposite of the answer through as `easy`.
 *
 * DIGITS ARE EXACT. A slip in a number is not a spelling variant: `10000000`
 * for `1000000` is an order of magnitude and passed the old rule at 0.875. Any
 * word containing a digit has to match exactly.
 */
function isTypingSlip(a: string, b: string): boolean {
  return slipShape(a, b) && slipIsLongEnough(a, b);
}

/**
 * Are these words short enough that one character apart is probably two words?
 *
 * Split from `slipShape` so the two questions can be asked separately, because they
 * answer to different things. The shape decides whether one word could be a
 * mistyping of the other at all; this decides whether we are willing to believe it
 * of words this short. Refusing on length is right — `zeal` and `seal` are two
 * words — but it is not evidence about what the reader believes, and `gradeCloze`
 * has to tell those apart before it calls anybody confidently wrong.
 */
function slipIsLongEnough(a: string, b: string): boolean {
  if (a === b) return true;
  const longest = Math.max(a.length, b.length);
  if (Math.abs(a.length - b.length) === 1) return longest >= 6;
  if (a.length === b.length) return longest >= 7;
  return true;
}

/** Could one of these be a mistyping of the other, length aside? */
function slipShape(a: string, b: string): boolean {
  if (a === b) return true;
  if (/\p{N}/u.test(a) || /\p{N}/u.test(b)) return false;

  // AND A LENGTH FLOOR, because the kind-of-difference rule alone moved the
  // boundary rather than removing the class. Review reproduced twelve short
  // pairs that the ratio used to refuse and this rule accepted as `easy`:
  // `casual`/`causal`, `trail`/`trial`, `ion`/`iron`, `aid`/`acid`,
  // `cost`/`coast`, `sale`/`scale`, `form`/`from`, `untied`/`united`,
  // `hat`/`heat`, `at`/`art`, `rat`/`rate`. In a short word an inserted,
  // dropped or swapped letter lands on another real word about as often as on a
  // typo, so the shape of the difference stops carrying the meaning.
  //
  // Six for an indel and seven for a transposition, which is where the twelve
  // stop and where the cases worth forgiving begin: `colour`/`color` is six,
  // `ocurrence`/`occurrence` ten, `mitochondira`/`mitochondria` twelve. One of
  // the twelve survives — `train`/`strain`, six letters, one insertion — and it
  // is the honest residual of any rule drawn here rather than a case this
  // missed.

  // An insertion or a deletion: the longer word is the shorter one with one
  // character put back. Walked once from each end rather than spliced, so the
  // repeated-letter case (`ocurrence`/`occurrence`) needs no special handling.
  if (Math.abs(a.length - b.length) === 1) {
    const [short, long] = a.length < b.length ? [a, b] : [b, a];
    let i = 0;
    while (i < short.length && short[i] === long[i]) i += 1;
    let j = 0;
    while (j < short.length - i && short[short.length - 1 - j] === long[long.length - 1 - j]) {
      j += 1;
    }
    return i + j === short.length;
  }

  // A transposition: same length, two adjacent positions differ, and they are
  // each other's. Anything else of the same length is a substitution.
  if (a.length === b.length) {
    const differing: number[] = [];
    for (let i = 0; i < a.length; i += 1) {
      if (a[i] !== b[i]) differing.push(i);
      if (differing.length > 2) return false;
    }
    const [first, second] = differing;
    return (
      differing.length === 2 &&
      first !== undefined &&
      second !== undefined &&
      second === first + 1 &&
      a[first] === b[second] &&
      a[second] === b[first]
    );
  }

  return false;
}

/**
 * Every word close to its own counterpart, and the same number of words.
 *
 * A missing or extra word is a different answer to a cloze, which is one to
 * three words by construction — so word count is a real signal here rather than
 * the blunt instrument it would be on a sentence.
 */
/*
 * ON THE FOLDED FORMS ONLY, and the second chance on the raw ones is gone.
 *
 * It was added so `colur` for `colour` stayed a slip: the fold rewrites one side and
 * not the other, so a dropped letter inside a folded word turns from a deletion into a
 * substitution, which is never a slip. That is a real cost of folding at all.
 *
 * The raw retry cost more. An exhaustive sweep of a 370k-word list found 52 pairs it
 * newly accepts — `fires` for `fibres`, `amour` for `armour`, `tires` for `titres`,
 * `mires` for `mitres` — where the folded comparison correctly refuses and the raw one
 * sees an ordinary indel. `fires`/`fibres` is two common words and `fibre` is an
 * ordinary cloze answer, so that is a wrong answer recorded as recalled, which this
 * module calls the one outcome a grader must never produce. Refusing a mistyped
 * `colour` is the smaller harm, and it is the same class the cost paragraph in
 * `gradeCloze` already discloses.
 *
 * No shape separates the two cases — `colur` and `fires` are both one indel from the
 * unfolded answer, and only a dictionary knows that one of them is a word.
 *
 * AND THE COST IS ~7,969 SLIP/ANSWER PAIRS, which is the number this paragraph used to
 * avoid. It was written as "52 pairs the raw retry newly accepts" against a cost given
 * only as a class, and a trade stated one-sided is not a trade a reader can check.
 * Measured the same way as the 52: every single deletion, doubling and adjacent
 * transposition of all 8,099 words in a 370,105-word list that the fold rewrites,
 * graded before and after. 7,969 accepted before and refused now; 0 the other way.
 *
 * The direction is still right, and that is why this stands. A refused slip grades
 * `forgot` and the idea comes round again; an accepted wrong word grades up to `easy`
 * and takes the idea out of review for a fortnight, which this module calls the one
 * outcome a grader must never produce. 52 of the second is worse than 7,969 of the
 * first.
 *
 * The earlier account of WHICH slips was also wrong, and worth correcting because it
 * made the cost sound self-limiting. It said the cost bites "only where the fold is
 * itself an INDEL" -- `colour` -> `color` drops a letter, `theatre` -> `theater` keeps
 * its length -- so the `-re` family was safe. It is not: 2,581 of the regressions are on
 * same-length folds, and `sceptic` -> `skeptic` and `grey` -> `gray` are substitutions
 * that regress too. `theatr` survives by where the slip falls, not by the shape of the
 * fold -- past the folded region it is still an indel, and `teatre`, `thatre` and
 * `cntre` are all refused. What decides is whether the typo lands at or before the
 * folded region, not what the fold does.
 *
 * One consequence is worth naming because it is the one a reader feels: a doubled
 * keystroke in `centre`, answered `sure`, now grades `forgot` AND sets
 * `confidentlyWrong`. Withholding that flag on the SHAPE of a typo was tried and is
 * recorded in `gradeCloze` as worse -- it silenced eleven real confusions with exactly
 * that shape -- so it is disclosed here rather than patched.
 */
function wordsAreClose(typed: string, answer: string): boolean {
  const a = normaliseAnswer(typed).split(' ').filter(Boolean);
  const b = normaliseAnswer(answer).split(' ').filter(Boolean);
  // Both empty is the answer that IS a mark -- `+` for `+`, `=` for `=` -- and
  // `normaliseAnswer` strips it to nothing. The old bail on an empty typed
  // answer graded those wrong when they were exactly right, which is the one
  // class `semanticMarks` exists to protect. The caller has already compared the
  // marks, so agreeing here is the whole answer -- PROVIDED THERE IS A MARK.
  //
  // Without that condition this was the defect the same commit fixed one
  // function above, reintroduced: `gradeCloze('', '')` graded `easy`, and so did
  // an empty box against a malformed `answer: '.'`, because two absences were
  // taken to agree. `gradeMcq` says it plainly and this now says it too: two
  // absences agreeing is not a right answer.
  if (a.length === 0 && b.length === 0) return semanticMarks(answer).length > 0;
  if (a.length === 0 || a.length !== b.length) return false;
  return a.every((word, i) => isTypingSlip(word, b[i] as string));
}

/**
 * Grade a typed cloze answer.
 *
 * `confidence` and `latencyMs` are optional so `gradeCloze(typed, answer)` reads
 * as the yes-or-no it mostly is; left out, the result can be `good` or `forgot`
 * and never `easy`, because an unmeasured answer cannot be shown to have been
 * effortless.
 */
export function gradeCloze(
  typed: string,
  answer: string,
  confidence: Confidence = 'unsure',
  latencyMs: number | null | undefined = null,
): GradeResult & { similarity: number } {
  // Nothing to compare against is not a misconception. See `gradeMcq`: a reader's own
  // self-graded question stores no answer, and scoring them `confidentlyWrong` for one
  // would put a false belief on the repair list that they never held.
  if (!answer.trim()) {
    return { grade: 'forgot', correct: false, confidentlyWrong: false, similarity: 0 };
  }
  const similarity = answerSimilarity(typed, answer);
  const exact = normaliseAnswer(typed) === normaliseAnswer(answer);
  const correct = semanticMarks(typed) === semanticMarks(answer) && wordsAreClose(typed, answer);
  const result = gradeFrom(correct, confidence, latencyMs, FAST_ANSWER_MS.cloze);
  /*
   * REFUSING AN ANSWER AND DIAGNOSING A MISCONCEPTION ARE TWO DIFFERENT CLAIMS, and
   * the first answer to that was worse than the problem.
   *
   * The `-re`/`-er` family fell wholesale on the transposition floor, so a reader
   * spelling the way they were taught was graded `forgot` AND told they held a
   * misconception. The fix was to withhold the flag whenever the difference had the
   * SHAPE of a typo — and shape is not evidence. Eleven confusions the floor exists
   * to catch have exactly that shape: `casual`/`causal` and `trail`/`trial` are
   * transpositions, `ion`/`iron`, `aid`/`acid`, `cost`/`coast`, `sale`/`scale`,
   * `form`/`from`, `untied`/`united`, `hat`/`heat`, `at`/`art` and `rat`/`rate` are
   * single indels. Those are the reader believing one word is another, answered
   * `sure` — the exact case `confidentlyWrong` exists for — and every one of them
   * went silent.
   *
   * So the accusation is withheld on KNOWLEDGE rather than on shape: the spelling
   * axes are folded in `normaliseAnswer`, where the `-ize` family already is, which
   * makes them exact and CORRECT rather than merely unaccused. A reader who spells
   * `centre` is now marked right, which is the outcome that was wanted.
   *
   * What that costs, stated as the class rather than one example: EVERY transposition
   * under seven letters and every indel under its floor, answered `sure`, is now
   * flagged — `hte`/`the` and `adn`/`and`, but also `freind`/`friend`, which is six
   * letters and one of the commonest misspellings in the language. Each has the same
   * shape as `trail`/`trial`, and no rule here separates them without a dictionary.
   * Showing a reader an idea again is a smaller harm than silencing eleven real
   * confusions, but it is not nothing and the sentence should say what it is.
   */
  // AN ACCEPTED SLIP IS NEVER `easy`. That grade multiplies stability by more
  // than three and takes the idea out of review for a fortnight, and this rule
  // cannot promise an accepted one-character difference is the reader's word
  // rather than a different one — `train`/`strain` is the residual the length
  // floor leaves, and there will be others. Capping at `good` takes the
  // multiplier off every accepted-but-inexact answer, and costs a reader who
  // typed it correctly nothing, because they took the exact branch.
  return {
    ...result,
    grade: result.correct && !exact && result.grade === 'easy' ? 'good' : result.grade,
    similarity,
  };
}

/**
 * The steps of an ordering question, in their right order.
 *
 * Stored as the question's `answer`, one step per line, because that is the one
 * column every kind has and an ordering has no separate answer to put there.
 * Blank lines are ignored so a trailing newline in an authored answer is not a
 * phantom step.
 */
export function orderingSteps(q: Pick<Question, 'answer'>): string[] {
  return (q.answer ?? '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * How many steps are in the right order relative to one another.
 *
 * The length of the longest common subsequence, which is the standard reading of
 * "how much of this order is already right": the largest set of steps that could
 * stay put while the rest moved. O(n·m) over sequences of a handful of steps.
 */
function longestOrderedRun(steps: readonly string[], given: readonly string[]): number {
  // One row of the table, rebuilt per step: only the previous row is ever read.
  let previous = new Array<number>(given.length + 1).fill(0);
  for (const step of steps) {
    const row = new Array<number>(given.length + 1).fill(0);
    for (let j = 0; j < given.length; j += 1) {
      row[j + 1] =
        step === given[j] ? (previous[j] ?? 0) + 1 : Math.max(row[j] ?? 0, previous[j + 1] ?? 0);
    }
    previous = row;
  }
  return previous[given.length] ?? 0;
}

/**
 * Grade a sequence the reader arranged.
 *
 * All or nothing for the grade: an ordering with one pair swapped is not
 * remembered, it is nearly remembered, and the model has no grade for "nearly".
 *
 * TWO NUMBERS, because one of them was being asked to mean something it does not.
 * `positionsWrong` counts positions that differ — it was called `misplaced` and
 * read as nearness, which it is not: rotating a four-step sequence by one is the
 * commonest drag error and puts every position wrong, so a screen showing "how
 * near" told a reader who made one mistake that all four steps were out of place.
 * `inSequence` is the honest companion — how many steps are already in the right
 * order relative to each other — and on that rotation it is 3 of 4.
 *
 * A sequence with a step missing or added is wrong at every position past the
 * fault, and `positionsWrong` reports that; `inSequence` still says how much of
 * the order survived.
 */
export function gradeOrdering(
  order: readonly string[],
  q: Pick<Question, 'answer'>,
  confidence: Confidence = 'unsure',
  latencyMs: number | null | undefined = null,
): GradeResult & { positionsWrong: number; inSequence: number } {
  const steps = orderingSteps(q);
  const given = order.map((s) => s.trim());
  let positionsWrong = 0;
  const length = Math.max(steps.length, given.length);
  for (let i = 0; i < length; i += 1) {
    if (steps[i] !== given[i]) positionsWrong += 1;
  }
  const correct = steps.length > 0 && positionsWrong === 0;
  return {
    ...gradeFrom(correct, confidence, latencyMs, FAST_ANSWER_MS.ordering),
    positionsWrong,
    inSequence: longestOrderedRun(steps, given),
  };
}

/* --------------------------------------------------------------------------
 * Feedback
 * -------------------------------------------------------------------------- */

/**
 * Why the option the reader picked is wrong, in the question's own words.
 *
 * Each distractor can carry a rationale, and that is what makes a wrong answer
 * worth more than a right one: the reader learns which specific confusion they
 * hold. Without one for this distractor, the general explanation stands in.
 * Picking the answer is not wrong, so there is nothing to say and this is null.
 */
export function whyWrong(
  q: Pick<Question, 'answer' | 'explanation' | 'rationale'>,
  picked: string,
): WhyWrong | null {
  const chosen = picked.trim();
  // Both empty is not agreement, and a null answer is the same absence. See `mcqOptions`.
  const expected = (q.answer ?? '').trim();
  if (!expected || chosen === expected) return null;

  // `rationale` is jsonb, and `quiz_questions_rationale_shape` checks that it is an
  // array of at most eight entries and nothing about what is IN it -- so the
  // elements are as unvalidated as the array was. Guarding only the array left
  // `[null]`, `[{why}]`, `[{distractor}]` and `['B']` all throwing in the feedback
  // path after a reader answered -- which will be inside the render once 3d calls
  // this, and is today a throw with no caller, since nothing imports this module but
  // its own test. Both halves are narrowed here so nothing below can.
  const rationale = (Array.isArray(q.rationale) ? q.rationale : []).filter(
    (r): r is DistractorRationale =>
      typeof (r as DistractorRationale | null)?.distractor === 'string' &&
      typeof (r as DistractorRationale | null)?.why === 'string',
  );
  const match = rationale.find((r) => r.distractor.trim() === chosen);
  if (match?.why.trim()) return { why: match.why.trim(), source: 'distractor' };

  // THERE IS NO LOOSE PASS ANY MORE, and removing it is the fix rather than a
  // simplification. It existed for drift -- a client that trimmed differently, a
  // stored option that lost its case -- which is speculative; what it actually
  // did was attribute one option's reason to another. Round 1 narrowed it to
  // require the semantic marks to agree AND exactly one match, and round 2
  // showed the residual: options `the market` and `market`, a rationale on only
  // one of them, and a reader who picks the other is still told a true sentence
  // about an option they did not choose. This function is given the pick and the
  // rationales, never the option list, so it cannot tell a near-miss from a
  // sibling option -- and a wrong explanation of your own mistake is worse than
  // none. The options come from `mcqOptions` verbatim, so an exact match after
  // trimming already covers every real pick.

  const explanation = q.explanation?.trim();
  return explanation ? { why: explanation, source: 'answer' } : null;
}
