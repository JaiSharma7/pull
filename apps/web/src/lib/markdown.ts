/**
 * A deliberately small Markdown parser, for one job: rendering the two legal
 * documents in `docs/` inside the app.
 *
 * Why parse at all rather than keep a second copy of the text in JSX: a privacy
 * policy with two sources of truth is a policy nobody can answer a question
 * about, because the honest answer is "which one?". The committed Markdown is
 * the document; this turns it into blocks the app can render.
 *
 * Why not a Markdown library: every one of them ultimately hands you HTML, and
 * HTML reaches React through `dangerouslySetInnerHTML`. That is a sanitiser
 * dependency and an XSS review for text we wrote ourselves and commit under
 * review. Parsing to a data structure that only ever becomes React elements
 * removes the injection path entirely rather than defending it.
 *
 * The subset is exactly what the two documents use. Anything outside it is
 * reported through `unsupported` rather than silently mangled, and
 * `markdown.test.ts` fails the build if a committed document drifts out of the
 * subset — so the failure lands on whoever edits the policy, not on a reader.
 */

export type Span =
  | { kind: 'text'; text: string }
  | { kind: 'strong'; text: string }
  | { kind: 'em'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'link'; text: string; href: string };

export type Block =
  | { kind: 'heading'; level: 1 | 2 | 3; id: string; spans: Span[] }
  | { kind: 'paragraph'; spans: Span[] }
  | { kind: 'list'; ordered: boolean; items: Span[][] }
  | { kind: 'quote'; spans: Span[] }
  | { kind: 'table'; head: Span[][]; rows: Span[][][] }
  | { kind: 'rule' };

export interface Document {
  blocks: Block[];
  /** Constructs found but not supported. Empty for every committed document. */
  unsupported: string[];
}

/** GitHub-style heading anchors, so `[…](#a-heading)` resolves in-app too. */
export function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

/** Constructs the renderer has no element for. Listed so drift is loud. */
const UNSUPPORTED: [RegExp, string][] = [
  [/^\s*```/, 'fenced code block'],
  [/^#{4,}\s/, 'heading below level 3'],
  [/^\s+[-*+]\s/, 'nested list'],
  [/^\s*!\[/, 'image'],
  [/<\/?[a-z][^>]*>/i, 'inline HTML'],
  [/~~/, 'strikethrough'],
];

const INLINE = /(\[[^\]]+\]\([^)\s]+\))|(\*\*[^*]+\*\*)|(`[^`]+`)|(\*(?!\*)[^*]+\*)/g;

/**
 * Inline spans, matched left to right so the longest constructs win before the
 * single-asterisk emphasis rule sees a `**`.
 */
export function parseInline(text: string): Span[] {
  const spans: Span[] = [];
  let at = 0;

  for (const match of text.matchAll(INLINE)) {
    const token = match[0];
    const start = match.index;
    if (start > at) spans.push({ kind: 'text', text: text.slice(at, start) });
    at = start + token.length;

    if (token.startsWith('[')) {
      const split = token.indexOf('](');
      spans.push({
        kind: 'link',
        text: token.slice(1, split),
        href: token.slice(split + 2, -1),
      });
    } else if (token.startsWith('**')) {
      spans.push({ kind: 'strong', text: token.slice(2, -2) });
    } else if (token.startsWith('`')) {
      spans.push({ kind: 'code', text: token.slice(1, -1) });
    } else {
      spans.push({ kind: 'em', text: token.slice(1, -1) });
    }
  }

  if (at < text.length) spans.push({ kind: 'text', text: text.slice(at) });
  return spans;
}

/** A `| a | b |` row, split on unescaped pipes and trimmed. */
function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
}

const isDivider = (line: string) => /^\|[\s:|-]+\|$/.test(line.trim());
const isRow = (line: string) => line.trim().startsWith('|');

export function parseMarkdown(source: string): Document {
  // Normalise line endings so a CRLF checkout parses identically.
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;

  /*
   * Every line, before any of them is consumed — not just the line that opens a
   * block.
   *
   * Scanning inside the loop only ever saw first lines, because `gather` eats a
   * block's continuation lines before the loop comes round again. Strikethrough
   * or an HTML tag on the *second* line of a paragraph therefore passed the
   * drift guard silently and reached a reader as literal punctuation in a
   * privacy policy. Found by Codex on the opening diff.
   */
  const unsupported = new Set<string>();
  for (const line of lines) {
    for (const [pattern, name] of UNSUPPORTED) {
      if (pattern.test(line)) unsupported.add(name);
    }
  }

  /** Consecutive lines belonging to one block, joined as a soft-wrapped paragraph. */
  const gather = (keep: (line: string) => boolean, strip: (line: string) => string) => {
    const parts: string[] = [];
    while (i < lines.length && keep(lines[i]!)) {
      parts.push(strip(lines[i]!).trim());
      i += 1;
    }
    return parts;
  };

  while (i < lines.length) {
    const line = lines[i]!;

    if (!line.trim()) {
      i += 1;
      continue;
    }

    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1]!.length as 1 | 2 | 3;
      const text = heading[2]!.trim();
      blocks.push({ kind: 'heading', level, id: slug(text), spans: parseInline(text) });
      i += 1;
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push({ kind: 'rule' });
      i += 1;
      continue;
    }

    // A table needs its divider row; without one the pipes are just text.
    if (isRow(line) && i + 1 < lines.length && isDivider(lines[i + 1]!)) {
      const head = cells(line).map(parseInline);
      i += 2;
      const rows: Span[][][] = [];
      while (i < lines.length && isRow(lines[i]!)) {
        rows.push(cells(lines[i]!).map(parseInline));
        i += 1;
      }
      blocks.push({ kind: 'table', head, rows });
      continue;
    }

    if (/^>\s?/.test(line)) {
      const parts = gather(
        (l) => /^>\s?/.test(l),
        (l) => l.replace(/^>\s?/, ''),
      );
      blocks.push({ kind: 'quote', spans: parseInline(parts.join(' ')) });
      continue;
    }

    const bullet = /^\s*([-*+]|\d+\.)\s+/.exec(line);
    if (bullet) {
      const ordered = /\d/.test(bullet[1]!);
      const items: Span[][] = [];
      while (i < lines.length) {
        const item = /^\s*(?:[-*+]|\d+\.)\s+(.*)$/.exec(lines[i]!);
        if (!item) break;
        i += 1;
        // Continuation lines: a wrapped item is indented and carries no marker.
        const rest = gather(
          (l) => /^\s+\S/.test(l) && !/^\s*(?:[-*+]|\d+\.)\s/.test(l),
          (l) => l,
        );
        items.push(parseInline([item[1]!, ...rest].join(' ')));
      }
      blocks.push({ kind: 'list', ordered, items });
      continue;
    }

    // The fallthrough, so it must consume its own first line unconditionally: a
    // `|` row with no divider under it lands here, and a predicate that rejects
    // it would leave the cursor where it was and spin forever.
    const paragraph = [line.trim()];
    i += 1;
    paragraph.push(
      ...gather(
        (l) =>
          l.trim() !== '' && !/^(#{1,3}\s|>|\||-{3,})/.test(l) && !/^\s*(?:[-*+]|\d+\.)\s/.test(l),
        (l) => l,
      ),
    );
    blocks.push({ kind: 'paragraph', spans: parseInline(paragraph.join(' ')) });
  }

  return { blocks, unsupported: [...unsupported] };
}

/**
 * Where a link in a committed document should point once it is in the app.
 *
 * The documents cross-reference each other as sibling files because they are
 * also read on GitHub, where `./privacy.md` is correct. In the app the same
 * link has to become a route, and a reference to a doc with no screen has to
 * become a URL that exists rather than a 404.
 */
const REPO = 'https://github.com/JaiSharma7/pull/blob/main/docs';

export function resolveHref(href: string): string {
  if (href.startsWith('#') || /^(https?:|mailto:)/.test(href)) return href;
  const file = href.replace(/^\.\//, '');
  if (file === 'privacy.md') return '/privacy';
  if (file === 'terms.md') return '/terms';
  return `${REPO}/${file}`;
}
