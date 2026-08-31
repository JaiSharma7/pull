import { int, nonNull, rows, str } from './shape.js';

/**
 * Highlights, minus the DOM.
 *
 * `highlights(user_id, pull_id, field, start_offset, end_offset, text)` has
 * existed since round 1 with nothing writing it. Blinkist's highlight-and-export
 * loop is the one competitor feature this product had no equivalent of at all.
 *
 * THE PROBLEM WITH OFFSETS. They describe a string that can change underneath
 * them. A summary can be regenerated, and `20260830...` shows the pipeline
 * adopting an existing summary by content hash rather than rewriting — but
 * nothing guarantees a body is byte-identical forever. Stored offsets that no
 * longer point at the stored text would silently underline the wrong words,
 * which is worse than losing the highlight.
 *
 * So the column that survives is `text`. On load a highlight is re-anchored by
 * searching for its own text, and the offsets are used only as a hint about
 * which occurrence was meant. A highlight whose text is gone is dropped rather
 * than drawn somewhere plausible.
 */

/** The fields of a Pull a reader can highlight. Mirrors what the source page renders. */
export const HIGHLIGHTABLE_FIELDS = ['body', 'explanation', 'why_it_matters'] as const;
export type HighlightField = (typeof HIGHLIGHTABLE_FIELDS)[number];

export function isHighlightField(v: unknown): v is HighlightField {
  return typeof v === 'string' && (HIGHLIGHTABLE_FIELDS as readonly string[]).includes(v);
}

export interface Highlight {
  id: string;
  pullId: string;
  field: HighlightField;
  start: number;
  end: number;
  text: string;
}

export interface Range {
  start: number;
  end: number;
}

export function shapeHighlights(raw: unknown): Highlight[] {
  return rows(raw)
    .map((r): Highlight | null => {
      const id = str(r.id);
      const field = r.field;
      if (!id || !isHighlightField(field)) return null;
      const start = int(r.start);
      const end = int(r.end);
      if (end <= start) return null;
      return { id, pullId: str(r.pullId), field, start, end, text: str(r.text) };
    })
    .filter(nonNull);
}

/**
 * Where this highlight actually sits in the text as it is now.
 *
 * Returns null when the text is gone, which is the honest answer: a highlight
 * that cannot be located is not a highlight at a guessed position.
 *
 * The stored offsets pick between occurrences rather than being trusted
 * outright. A reader who highlights the second "attention" in a paragraph
 * should keep the second one even if a word was inserted before it.
 */
export function anchor(fullText: string, highlight: Highlight): Range | null {
  const needle = highlight.text;
  if (!needle) return null;

  // The offsets still point at their own text: nothing moved.
  if (fullText.slice(highlight.start, highlight.end) === needle) {
    return { start: highlight.start, end: highlight.end };
  }

  const occurrences: number[] = [];
  for (let i = fullText.indexOf(needle); i !== -1; i = fullText.indexOf(needle, i + 1)) {
    occurrences.push(i);
  }
  if (occurrences.length === 0) return null;

  // The occurrence nearest to where it used to be.
  let best = occurrences[0]!;
  for (const at of occurrences) {
    if (Math.abs(at - highlight.start) < Math.abs(best - highlight.start)) best = at;
  }
  return { start: best, end: best + needle.length };
}

/**
 * Overlapping highlights become one.
 *
 * Two ranges that touch or overlap must not render as two nested marks: the
 * markup nests wrongly, and the reader sees a darker band where they happened
 * to highlight twice. Merging is also what makes "highlight the same sentence
 * again" idempotent on screen.
 */
export function mergeRanges(ranges: readonly Range[]): Range[] {
  const sorted = [...ranges]
    .filter((r) => r.end > r.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const out: Range[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out;
}

export interface Segment {
  text: string;
  marked: boolean;
}

/**
 * Split a string into marked and unmarked runs, in order.
 *
 * The renderer walks this rather than building HTML, so nothing is ever
 * interpolated into markup — the same reason `lib/markdown.ts` returns blocks
 * instead of a string.
 */
export function splitByRanges(text: string, ranges: readonly Range[]): Segment[] {
  const merged = mergeRanges(ranges).filter((r) => r.start < text.length);
  if (merged.length === 0) return text ? [{ text, marked: false }] : [];

  const out: Segment[] = [];
  let cursor = 0;
  for (const r of merged) {
    const start = Math.max(0, Math.min(r.start, text.length));
    const end = Math.max(start, Math.min(r.end, text.length));
    if (start > cursor) out.push({ text: text.slice(cursor, start), marked: false });
    if (end > start) out.push({ text: text.slice(start, end), marked: true });
    cursor = Math.max(cursor, end);
  }
  if (cursor < text.length) out.push({ text: text.slice(cursor), marked: false });
  return out;
}

/* --------------------------------------------------------------------------
 * Export
 * -------------------------------------------------------------------------- */

export interface ExportSource {
  title: string;
  ideas: {
    headline: string;
    highlights: string[];
    note: string | null;
  }[];
}

/**
 * A reader's highlights and notes as Markdown they can keep.
 *
 * Readwise's whole business is getting highlights back out to Obsidian, Notion
 * and the rest. Rather than build integrations for each, this produces a plain
 * file: it works with every one of those tools, needs no account anywhere, and
 * cannot rot when somebody's API changes. An open export is also more on-brand
 * than an integration — the reader's own words should not be locked in a
 * product whose pitch is that nothing worth having is behind a wall.
 */
export function toMarkdown(sources: readonly ExportSource[], generatedAt: Date): string {
  const lines: string[] = ['# What a Pull — my highlights', ''];
  lines.push(`Exported ${generatedAt.toISOString().slice(0, 10)}.`, '');

  const withContent = sources.filter((s) => s.ideas.some((i) => i.highlights.length > 0 || i.note));
  if (withContent.length === 0) {
    lines.push('Nothing highlighted yet.', '');
    return lines.join('\n');
  }

  for (const source of withContent) {
    lines.push(`## ${source.title}`, '');
    for (const idea of source.ideas) {
      if (idea.highlights.length === 0 && !idea.note) continue;
      lines.push(`### ${idea.headline}`, '');
      // Blockquotes, so a highlight is visibly the source's words and a note is
      // visibly the reader's. Losing that distinction in an export is how a
      // quotation ends up attributed to whoever saved it.
      for (const h of idea.highlights) lines.push(`> ${h}`, '');
      if (idea.note) lines.push(`**Note:** ${idea.note}`, '');
    }
  }
  return lines.join('\n');
}
