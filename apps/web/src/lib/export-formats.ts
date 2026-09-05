import type { RecallGrade } from './grades.js';
import type { ExportSource } from './highlights.js';

/**
 * Three more ways out.
 *
 * `toMarkdown` in `highlights.ts` set the rule: rather than integrate with
 * Obsidian, Notion and Readwise one API at a time, produce a plain file every
 * one of them opens, and that cannot rot when somebody's API changes. This
 * module keeps that rule and adds the three files the market report found
 * readers actually ask for — a CSV for a spreadsheet, an Anki deck for the
 * reader who already has a review habit somewhere else, and a Markdown file
 * for one stash rather than for everything.
 *
 * All three are pure string builders. They take rows a screen has already
 * fetched and give back text; nothing here reads the network or the database,
 * which is what makes them testable to the byte and what keeps them working
 * offline, where an export is exactly the thing a reader on a plane wants.
 *
 * An export is the reader's own data leaving the product. That cuts both
 * ways: it must be complete, and it must be *theirs* — a stash's Pulls are
 * this product's commentary and the notes are the reader's, and the Markdown
 * keeps those visibly apart for the same reason `toMarkdown` does.
 */

/* --------------------------------------------------------------------------
 * CSV
 * -------------------------------------------------------------------------- */

/** One highlight as a spreadsheet row. */
export interface HighlightRow {
  source: string;
  idea: string;
  highlight: string;
  note: string | null;
}

/**
 * The shape `toMarkdown` takes, flattened to one row per highlight.
 *
 * A note belongs to an idea rather than to a highlight, so it repeats on every
 * row of that idea — and an idea with a note but no highlights still gets a
 * row, or the note would be the one thing the export lost.
 */
export function flattenHighlights(sources: readonly ExportSource[]): HighlightRow[] {
  const out: HighlightRow[] = [];
  for (const source of sources) {
    for (const idea of source.ideas) {
      if (idea.highlights.length === 0) {
        if (idea.note) {
          out.push({ source: source.title, idea: idea.headline, highlight: '', note: idea.note });
        }
        continue;
      }
      for (const highlight of idea.highlights) {
        out.push({ source: source.title, idea: idea.headline, highlight, note: idea.note });
      }
    }
  }
  return out;
}

/**
 * A field as a spreadsheet will open it, and not run it.
 *
 * A cell beginning with `=`, `+`, `-` or `@` is a formula to Excel and to
 * LibreOffice, and a highlight is text somebody else wrote. "=HYPERLINK(...)"
 * in a saved quotation would execute on the reader's machine the moment they
 * opened their own export, so those cells get a leading apostrophe, which every
 * spreadsheet reads as "this is text". The apostrophe is visible in a plain
 * text editor, and that is the honest trade: a stray character beats a payload.
 */
function defuse(field: string): string {
  return /^[=+\-@\t\r]/.test(field) ? `'${field}` : field;
}

/**
 * RFC 4180 quoting: a field is wrapped in double quotes when it contains a
 * comma, a quote or a line break, and any quote inside is doubled. Everything
 * else is written bare, so a file of short fields stays readable as text.
 */
function csvField(value: string): string {
  const field = defuse(value);
  return /[",\r\n]/.test(field) ? `"${field.replace(/"/g, '""')}"` : field;
}

export const CSV_COLUMNS = ['source', 'idea', 'highlight', 'note'] as const;

/**
 * Highlights as CSV, with a header row and CRLF line endings as RFC 4180 asks.
 *
 * Nothing is dropped and nothing is summarised: a spreadsheet is where a reader
 * goes to do their own counting.
 */
export function toCsvHighlights(rows: readonly HighlightRow[]): string {
  const lines = [CSV_COLUMNS.join(',')];
  for (const row of rows) {
    lines.push([row.source, row.idea, row.highlight, row.note ?? ''].map(csvField).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

/* --------------------------------------------------------------------------
 * Anki
 * -------------------------------------------------------------------------- */

/**
 * A question as Anki needs to see it: the question itself, plus enough of
 * where it came from to tag the card.
 *
 * Structurally a superset of the `Question` the activity graders take, so a
 * caller spreads one into this with the pull and work beside it. `kind` is a
 * plain string rather than the graders' union so a kind added to the database
 * before this module hears of it still exports as a plain front-and-back card.
 */
export interface AnkiQuestion {
  id: string;
  pullId: string;
  kind: string;
  prompt: string;
  answer: string;
  distractors: string[];
  cloze?: string | null;
  explanation?: string | null;
  /** The work's title, for a tag. */
  work?: string | null;
}

/** One graded recall, as `recall_events` records it. */
export interface ReviewEvent {
  pullId: string;
  /** Which question was asked, when one was; older events carry none. */
  questionId?: string | null;
  grade: RecallGrade;
  /** ISO timestamp, used only to find the latest. */
  appliedAt: string;
}

export interface ReviewSummary {
  reps: number;
  lapses: number;
  last: RecallGrade | null;
}

/**
 * A question's history, counted.
 *
 * Events name a question when one was asked; the ones that do are this
 * question's. The ones that name only the pull — every free-recall grade before
 * questions had ids — count towards each of the pull's questions, because a
 * memory of the idea is what they measured and that is what the reader is
 * carrying over.
 */
export function summariseHistory(
  question: Pick<AnkiQuestion, 'id' | 'pullId'>,
  history: readonly ReviewEvent[],
): ReviewSummary {
  let reps = 0;
  let lapses = 0;
  let last: ReviewEvent | null = null;
  for (const event of history) {
    if (event.pullId !== question.pullId) continue;
    if (event.questionId && event.questionId !== question.id) continue;
    reps += 1;
    if (event.grade === 'forgot') lapses += 1;
    if (!last || event.appliedAt > last.appliedAt) last = event;
  }
  return { reps, lapses, last: last?.grade ?? null };
}

/**
 * Text as an Anki tag: no whitespace, since a space separates tags, and
 * nothing a tag cannot hold. Lower-cased so "Walden" and "walden" are one tag.
 */
export function ankiTag(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
}

/** The tag column for one card. Always begins with `wap`, so a deck is filterable. */
function ankiTags(q: AnkiQuestion, summary: ReviewSummary): string {
  const tags = ['wap', `kind:${ankiTag(q.kind) || 'unknown'}`, `reps:${summary.reps}`];
  if (summary.lapses > 0) tags.push(`lapses:${summary.lapses}`);
  if (summary.last) tags.push(`last:${summary.last}`);
  const work = q.work ? ankiTag(q.work) : '';
  if (work) tags.push(`work:${work}`);
  return tags.join(' ');
}

/**
 * The options for a choice question, in an order that says nothing.
 *
 * Alphabetical rather than shuffled: a shuffle needs a seed, and an export must
 * be reproducible without one. Sorted, the right answer sits wherever its first
 * letter puts it, which is no clue at all.
 */
function listed(options: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of options) {
    const o = raw.trim();
    if (!o || seen.has(o)) continue;
    seen.add(o);
    out.push(o);
  }
  return out.sort((a, b) => a.localeCompare(b));
}

/**
 * An ordering's steps in a fixed order that is never the right one.
 *
 * Alphabetical alone gives the answer away whenever the authored order happens
 * to be alphabetical already — "Collect, Plan, Review" is a real sequence and a
 * sorted list of itself — and the reader would be shown the answer on the front
 * of the card. Sorting and then rotating by one keeps the export reproducible
 * with no seed while guaranteeing a different sequence for any two or more
 * steps. A single step cannot be given away by its order and is left alone.
 */
function scrambled(stepsInOrder: readonly string[]): string[] {
  const sorted = listed(stepsInOrder);
  if (sorted.length < 2) return sorted;
  const rotated = [...sorted.slice(1), sorted[0] as string];
  return rotated.join('\n') === stepsInOrder.join('\n') ? sorted : rotated;
}

/** An ordering's steps: its `answer`, one per line. Mirrors `orderingSteps`. */
function steps(answer: string): string[] {
  return answer
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * The two faces of one card.
 *
 * A multiple-choice front lists its options, lettered, so the card still tests
 * recognition; an ordering front lists the steps out of order and the back puts
 * them right. Everything else is the prompt and the answer, with the
 * explanation under the answer when there is one — on the back, where it can
 * teach, never on the front, where it would give the answer away.
 */
function faces(q: AnkiQuestion): { front: string; back: string } {
  const prompt = q.prompt.trim();
  const explanation = q.explanation?.trim();
  const withExplanation = (back: string) => (explanation ? `${back}\n\n${explanation}` : back);

  switch (q.kind) {
    case 'mcq': {
      const options = listed([q.answer, ...q.distractors]);
      const lettered = options.map((o, i) => `${String.fromCharCode(65 + i)}. ${o}`);
      return { front: [prompt, ...lettered].join('\n'), back: withExplanation(q.answer.trim()) };
    }
    case 'ordering': {
      const ordered = steps(q.answer);
      const shown = scrambled(ordered).map((s) => `• ${s}`);
      const answer = ordered.map((s, i) => `${i + 1}. ${s}`).join('\n');
      return { front: [prompt, ...shown].join('\n'), back: withExplanation(answer) };
    }
    case 'cloze': {
      const sentence = q.cloze?.trim();
      const front = sentence && sentence !== prompt ? `${prompt}\n${sentence}` : prompt;
      return { front, back: withExplanation(q.answer.trim()) };
    }
    default:
      return { front: prompt, back: withExplanation(q.answer.trim()) };
  }
}

/**
 * A field as Anki's importer reads it. A tab would end the field, so it becomes
 * a space; a field with a line break or a quote is wrapped in quotes with the
 * quotes inside doubled, which is the CSV convention Anki's importer honours
 * for tab-separated files too.
 */
function tsvField(value: string): string {
  const field = value.replace(/\t/g, ' ');
  return /["\r\n]/.test(field) ? `"${field.replace(/"/g, '""')}"` : field;
}

/**
 * The file header Anki reads. `#separator:tab` and `#html:false` tell a current
 * Anki what it is looking at, `#tags column:3` puts the third column into the
 * card's tags, and an older Anki treats every `#` line as a comment and asks.
 */
export const ANKI_HEADER = ['#separator:tab', '#html:false', '#deck:What a Pull', '#tags column:3'];

/**
 * Questions as an Anki deck: one line per question, front, back and tags.
 *
 * The review history travels as tags rather than as Anki's own scheduling
 * state, because there is no honest way to translate one memory model's
 * numbers into another's. `reps:3 lapses:1 last:good` tells the reader, and any
 * filter they write, what happened; Anki starts its own schedule from there.
 */
export function toAnkiTsv(
  questions: readonly AnkiQuestion[],
  history: readonly ReviewEvent[],
): string {
  const lines = [...ANKI_HEADER];
  for (const q of questions) {
    if (!q.prompt.trim() || !q.answer.trim()) continue;
    const { front, back } = faces(q);
    const tags = ankiTags(q, summariseHistory(q, history));
    lines.push([tsvField(front), tsvField(back), tsvField(tags)].join('\t'));
  }
  return lines.join('\n') + '\n';
}

/* --------------------------------------------------------------------------
 * A stash, as Markdown
 * -------------------------------------------------------------------------- */

/** What the Markdown needs from a stash. A `Stash` satisfies it. */
export interface StashHeader {
  name: string;
  description: string | null;
}

/** What the Markdown needs from a saved Pull. A `LibraryItem` satisfies it. */
export interface StashExportItem {
  headline: string;
  body: string;
  whyItMatters: string | null;
  note: string | null;
  work: { id: string | null; title: string };
}

/**
 * One stash as a Markdown file, in the shape and voice of `toMarkdown`.
 *
 * Grouped by source identity in the order the stash first mentions each, so a
 * stash arranged by hand exports in the order it was arranged. Identity is the
 * work's id and not its title: titles are not unique in the schema, so keying by
 * one merges two different books that share a name — and merges every source
 * whose work row is gone under a single "Unknown source". `groupByWork` in
 * `lib/library.ts` falls back to the pull's own identity for exactly this, and
 * this does the same. A Pull's body and
 * "why it matters" are this product's commentary and are written plain; the
 * reader's note is marked as theirs, because an export that blurred whose
 * words were whose would be the wrong kind of keepsake.
 */
export function toStashMarkdown(
  stash: StashHeader,
  items: readonly StashExportItem[],
  generatedAt: Date,
): string {
  const lines: string[] = [`# What a Pull — ${stash.name.trim() || 'a stash'}`, ''];
  lines.push(`Exported ${generatedAt.toISOString().slice(0, 10)}.`, '');
  const description = stash.description?.trim();
  if (description) lines.push(description, '');

  if (items.length === 0) {
    lines.push('Nothing in this stash yet.', '');
    return lines.join('\n');
  }

  const byWork = new Map<string, { title: string; items: StashExportItem[] }>();
  for (const [index, item] of items.entries()) {
    // A work with no id is its own group: two deleted sources are two sources,
    // and collapsing them under one heading would misattribute both.
    const key = item.work.id ?? `orphan:${index}`;
    const title = item.work.title.trim() || 'Unknown source';
    const group = byWork.get(key);
    if (group) group.items.push(item);
    else byWork.set(key, { title, items: [item] });
  }

  for (const { title, items: group } of byWork.values()) {
    lines.push(`## ${title}`, '');
    for (const item of group) {
      lines.push(`### ${item.headline.trim()}`, '');
      const body = item.body.trim();
      if (body) lines.push(body, '');
      const why = item.whyItMatters?.trim();
      if (why) lines.push(`**Why it matters:** ${why}`, '');
      const note = item.note?.trim();
      if (note) lines.push(`**Note:** ${note}`, '');
    }
  }
  return lines.join('\n');
}
