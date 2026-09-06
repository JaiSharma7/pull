import type { AnkiQuestion, ReviewEvent, StashExportItem } from './export-formats.js';
import { RECALL_GRADES, type RecallGrade } from './grades.js';
import { HIGHLIGHTABLE_FIELDS, type ExportSource, type Highlight } from './highlights.js';
import type { LibraryItem } from './types.js';

/**
 * The rows a screen already has, turned into what `export-formats.ts` takes.
 *
 * 7c wrote the file builders — `toCsvHighlights`, `toAnkiTsv`, `toStashMarkdown` —
 * and deliberately stopped at the point where a caller has to fetch something.
 * This is the other half: the mapping from what `saved_items`, `quiz_questions`,
 * `user_questions`, `recall_events` and `highlights` actually return into those
 * shapes. It is where the mistakes live — a nullable column read as present, a
 * `jsonb` array assumed to hold strings, an empty id treated as an id — so it is
 * separate from `export-api.ts` and imports nothing that reaches the network.
 *
 * That split is not stylistic. `lib/supabase.ts` builds its client at import
 * scope and throws when the environment is not configured, so a test importing a
 * module that reaches it fails to *collect* rather than failing an assertion:
 * the run reports a file it could not load, and a suite that never ran looks
 * indistinguishable from a suite with nothing to say. `lib/shape.ts` says the
 * same thing about itself, and `lib/stashes.ts`, `lib/library.ts` and
 * `lib/export-formats.ts` are all on this side of the line for the same reason.
 */

/* --------------------------------------------------------------------------
 * A stash
 * -------------------------------------------------------------------------- */

/**
 * The saved Pulls of one collection, as the Markdown builder wants them.
 *
 * The one conversion that matters is `work.id`. `fetchLibrary` fills in
 * `{ id: '', title: 'Unknown source' }` when the join through `summaries` finds
 * no work row — a takedown, or a summary detached from its source — and
 * `toStashMarkdown` groups by `item.work.id ?? …`, which an empty string
 * satisfies. Passed through as-is, every orphaned save in a collection would
 * collapse into one heading called "Unknown source", which is precisely the
 * misattribution that function's own comment says it exists to avoid. An id that
 * is not an id becomes null here, and each of them gets its own group.
 */
export function stashExportItems(items: readonly LibraryItem[]): StashExportItem[] {
  return items.map((item) => ({
    headline: item.headline,
    body: item.body,
    whyItMatters: item.whyItMatters,
    note: item.note,
    work: { id: item.work.id || null, title: item.work.title },
  }));
}

/**
 * Where a highlight sits, as a number that orders the whole set.
 *
 * `fetchHighlights` orders by `id` because that is what partitions a paged walk,
 * and `id` is `gen_random_uuid()` — so the texts arrive in an order that is
 * stable for nobody and meaningful to no one. A file exported twice should be
 * the same file, and a passage marked at the top of a Pull should appear above
 * one marked at the bottom, so they are ordered here: by field in the order a
 * Pull renders them, then by where in that field the passage starts.
 */
function byPosition(a: Highlight, b: Highlight): number {
  // Compared field-then-offset rather than folded into one number: an offset is a
  // character index into a column with no length bound this module can point at,
  // so any constant chosen to keep the two apart would be a guess that fails
  // silently on the one Pull long enough to break it.
  return (
    HIGHLIGHTABLE_FIELDS.indexOf(a.field) - HIGHLIGHTABLE_FIELDS.indexOf(b.field) ||
    a.start - b.start ||
    a.end - b.end ||
    // Two highlights over the same span of the same field is the tie a uuid has
    // to break, or the sort is not a total order and the file is not reproducible.
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/**
 * One collection as the `ExportSource[]` the CSV is flattened from.
 *
 * Grouped by work the way `toStashMarkdown` groups, and for the same reason: a
 * title is not an identity, so two books with one name stay two sources and two
 * orphaned saves stay two orphans. The group's title is the first non-empty one
 * seen for that work.
 *
 * A saved Pull with neither a highlight nor a note still becomes an idea here.
 * `flattenHighlights` is what decides it contributes no CSV row, and it already
 * does — this function's job is to describe the collection, not to pre-empt it.
 */
export function stashExportSources(
  items: readonly LibraryItem[],
  highlightsByPull: ReadonlyMap<string, readonly Highlight[]>,
): ExportSource[] {
  const byWork = new Map<string, ExportSource>();
  for (const [index, item] of items.entries()) {
    const key = item.work.id || `orphan:${index}`;
    let source = byWork.get(key);
    if (!source) {
      source = { title: item.work.title.trim() || 'Unknown source', ideas: [] };
      byWork.set(key, source);
    }
    const highlights = [...(highlightsByPull.get(item.id) ?? [])]
      .sort(byPosition)
      .map((h) => h.text);
    source.ideas.push({ headline: item.headline, highlights, note: item.note });
  }
  return [...byWork.values()];
}

/**
 * A name as a filename: lower case, no separators of its own, never empty.
 *
 * A collection is named by the reader, so it can contain a slash, a NUL, a
 * right-to-left override, or nothing but spaces. `a.download` takes whatever it
 * is given and a browser sanitises it silently and differently, which is how a
 * file lands somewhere the reader did not ask for. Reduced to ASCII-safe words
 * here, and bounded, so the name in the file picker is the one this code chose.
 */
export function exportSlug(name: string, fallback = 'collection'): string {
  const slug = name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    // A trailing hyphen can reappear after the slice.
    .replace(/-+$/g, '');
  return slug || fallback;
}

/**
 * The whole filename for one export.
 *
 * `toISOString` throws a RangeError on an Invalid Date — the same trap
 * `toStashMarkdown` guards against for the date it writes *inside* the file, and
 * the throw would take the download with it. A file called `undated` beats no
 * file, for the reason that function already gives.
 */
export function exportFilename(parts: readonly string[], extension: string, now: Date): string {
  const day = Number.isNaN(now.getTime()) ? 'undated' : now.toISOString().slice(0, 10);
  return `${['what-a-pull', ...parts, day].join('-')}.${extension}`;
}

/* --------------------------------------------------------------------------
 * A deck
 * -------------------------------------------------------------------------- */

/**
 * The strings of a `jsonb` array, and nothing else.
 *
 * `quiz_questions.distractors` and `user_questions.options` are `jsonb` with a
 * shape check and no element type — `jsonb_typeof(options) = 'array'` is the
 * whole of the constraint — so a number, a null or a nested object is a legal
 * row today. Anki's importer would have rendered `[object Object]` onto the face
 * of a card; anything that is not a string is dropped instead.
 */
function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** A canonical question, as `quiz_questions` returns it. */
export interface QuizQuestionRow {
  id: string;
  pull_id: string;
  kind: string;
  prompt: string;
  answer: string;
  distractors: unknown;
}

/** One of the reader's own, as `user_questions` returns it. */
export interface UserQuestionRow {
  id: string;
  pull_id: string;
  kind: string;
  prompt: string;
  answer: string | null;
  options: unknown;
}

/** A Pull the reader has kept, with the canonical questions written for it. */
export interface SavedPullRow {
  pullId: string;
  workTitle: string | null;
  questions: readonly QuizQuestionRow[];
}

/**
 * Everything the reader could revise, as one deck.
 *
 * THE READER'S OWN QUESTIONS COME FIRST, mirroring the only place in the product
 * that already ranks the two: the `chosen` lateral in `get_due_reviews`
 * (20260905110000) coalesces `mine` over `canon`, so Review asks a reader their
 * own question when they have written one. Both are exported, though — a card
 * the reader will never be shown here is still a card, and an export that
 * dropped the canonical question for every idea they had annotated would be
 * quietly lossy in exactly the way an export must not be.
 *
 * A question with no answer is dropped rather than left to `toAnkiTsv`.
 * `user_questions.answer` is nullable on purpose: a reader can write a prompt
 * they intend to answer from memory, with nothing to check it against. That is a
 * usable card in Review, where they grade themselves, and not a card at all in
 * Anki, whose whole model is a back. `toAnkiTsv` skips it too — this is where
 * the count the screen reports is made honest.
 *
 * No dedupe pass: `saved_items_unique_pull` (20260829124532) is unique on
 * `(user_id, pull_id) where pull_id is not null`, so a Pull appears at most once
 * in the saves walk and its `quiz_questions` rows are visited once each.
 */
export function ankiDeck(
  saved: readonly SavedPullRow[],
  own: readonly UserQuestionRow[],
  workTitleByPull: ReadonlyMap<string, string | null>,
): AnkiQuestion[] {
  const out: AnkiQuestion[] = [];

  for (const q of own) {
    if (!q.answer) continue;
    out.push({
      id: q.id,
      pullId: q.pull_id,
      kind: q.kind,
      prompt: q.prompt,
      answer: q.answer,
      // A reader's own MCQ keeps its choices in `options`, which — unlike
      // `distractors` — includes the right answer. `faces` builds the front from
      // `[answer, ...distractors]` through `listed`, which drops duplicates, so
      // the answer appearing in both is the same card either way.
      distractors: stringList(q.options),
      work: workTitleByPull.get(q.pull_id) ?? null,
    });
  }

  for (const pull of saved) {
    for (const q of pull.questions) {
      out.push({
        id: q.id,
        pullId: q.pull_id,
        kind: q.kind,
        prompt: q.prompt,
        answer: q.answer,
        distractors: stringList(q.distractors),
        work: pull.workTitle,
      });
    }
  }

  return out;
}

/** One row of `recall_events`, as the deck's history needs it. */
export interface RecallEventRow {
  pull_id: string;
  quiz_question_id: string | null;
  user_question_id: string | null;
  grade: string;
  applied_at: string;
}

function isGrade(value: string): value is RecallGrade {
  return (RECALL_GRADES as readonly string[]).includes(value);
}

/**
 * Graded attempts, as `summariseHistory` counts them.
 *
 * `recall_events_one_question` guarantees at most one of the two question
 * columns is set, so naming whichever is present cannot pick the wrong one; a
 * row with neither is a free-recall grade and keeps a null question id, which is
 * how `summariseHistory` knows to count it towards every question on that Pull.
 *
 * A grade this build does not recognise is dropped rather than tagged. `grade`
 * is the `recall_grade` enum and `RECALL_GRADES` in `lib/grades.ts` is a
 * hand-written mirror of it — and unlike `WorkKind` or `Stance` it is *not* in
 * `EnumParityChecks` (`packages/db/src/enum-parity.ts`), so nothing makes the
 * two fail typecheck when they diverge. A deployed bundle can therefore be a
 * member behind the database, and a card tagged `last:` with a value Anki cannot
 * mean is worse than a card with one fewer tag.
 */
export function reviewEvents(rows: readonly RecallEventRow[]): ReviewEvent[] {
  const out: ReviewEvent[] = [];
  for (const r of rows) {
    if (!isGrade(r.grade)) continue;
    out.push({
      pullId: r.pull_id,
      questionId: r.quiz_question_id ?? r.user_question_id ?? null,
      grade: r.grade,
      appliedAt: r.applied_at,
    });
  }
  return out;
}
