import { describe, expect, it } from 'vitest';
import privacySource from '../../../../docs/privacy.md?raw';
import termsSource from '../../../../docs/terms.md?raw';
import { parseInline, parseMarkdown, resolveHref, slug } from './markdown.js';

// Imported exactly as the app imports them, so this exercises the real path:
// if the bundler stops resolving these, the test fails rather than the page.
const legal: [string, string][] = [
  ['privacy.md', privacySource],
  ['terms.md', termsSource],
];

describe('inline spans', () => {
  it('reads bold, emphasis, code and links', () => {
    expect(parseInline('a **b** *c* `d` [e](/f)')).toEqual([
      { kind: 'text', text: 'a ' },
      { kind: 'strong', text: 'b' },
      { kind: 'text', text: ' ' },
      { kind: 'em', text: 'c' },
      { kind: 'text', text: ' ' },
      { kind: 'code', text: 'd' },
      { kind: 'text', text: ' ' },
      { kind: 'link', text: 'e', href: '/f' },
    ]);
  });

  it('does not let the emphasis rule split a bold run', () => {
    expect(parseInline('**we do not sell**')).toEqual([{ kind: 'strong', text: 'we do not sell' }]);
  });

  it('leaves plain text alone', () => {
    expect(parseInline('nothing to see')).toEqual([{ kind: 'text', text: 'nothing to see' }]);
  });
});

describe('blocks', () => {
  it('reads headings with anchors that match the links pointing at them', () => {
    const { blocks } = parseMarkdown('## What never reaches a model');
    expect(blocks).toEqual([
      {
        kind: 'heading',
        level: 2,
        id: 'what-never-reaches-a-model',
        spans: [{ kind: 'text', text: 'What never reaches a model' }],
      },
    ]);
  });

  it('joins a soft-wrapped paragraph into one block', () => {
    const { blocks } = parseMarkdown('one\ntwo\n\nthree');
    expect(blocks).toEqual([
      { kind: 'paragraph', spans: [{ kind: 'text', text: 'one two' }] },
      { kind: 'paragraph', spans: [{ kind: 'text', text: 'three' }] },
    ]);
  });

  it('reads bulleted and numbered lists', () => {
    const { blocks } = parseMarkdown('- a\n- b\n\n1. c\n2. d');
    expect(blocks).toEqual([
      {
        kind: 'list',
        ordered: false,
        items: [[{ kind: 'text', text: 'a' }], [{ kind: 'text', text: 'b' }]],
      },
      {
        kind: 'list',
        ordered: true,
        items: [[{ kind: 'text', text: 'c' }], [{ kind: 'text', text: 'd' }]],
      },
    ]);
  });

  it('reads a table only when the divider row is there', () => {
    const table = parseMarkdown('| a | b |\n| --- | --- |\n| c | d |').blocks[0]!;
    expect(table.kind).toBe('table');
    expect(table).toMatchObject({ rows: [[[{ text: 'c' }], [{ text: 'd' }]]] });

    // Without the divider the pipes are ordinary characters, not a table.
    expect(parseMarkdown('| a | b |').blocks[0]!.kind).toBe('paragraph');
  });

  it('reads a blockquote and a rule', () => {
    const { blocks } = parseMarkdown('> quoted\n\n---');
    expect(blocks[0]).toEqual({ kind: 'quote', spans: [{ kind: 'text', text: 'quoted' }] });
    expect(blocks[1]).toEqual({ kind: 'rule' });
  });

  it('terminates on input that is only blank lines', () => {
    expect(parseMarkdown('\n\n   \n').blocks).toEqual([]);
  });
});

describe('link resolution', () => {
  it('routes a sibling document to its screen and anything else to the repository', () => {
    expect(resolveHref('./privacy.md')).toBe('/privacy');
    expect(resolveHref('./terms.md')).toBe('/terms');
    expect(resolveHref('./content-policy.md')).toContain('github.com');
  });

  it('leaves anchors and absolute links untouched', () => {
    expect(resolveHref('#section')).toBe('#section');
    expect(resolveHref('mailto:someone@example.com')).toBe('mailto:someone@example.com');
    expect(resolveHref('https://example.com')).toBe('https://example.com');
  });
});

/**
 * The renderer covers the subset the policies use, and no more. These are the
 * checks that keep that true: a future edit reaching for a code fence or an
 * image fails here rather than rendering as literal punctuation to a reader who
 * came to the page to find out what we do with their data.
 */
describe('the committed legal documents', () => {
  for (const [file, source] of legal) {
    const doc = parseMarkdown(source);

    it(`${file} uses only constructs the app can render`, () => {
      expect(doc.unsupported).toEqual([]);
    });

    it(`${file} opens with a single title`, () => {
      const titles = doc.blocks.filter((b) => b.kind === 'heading' && b.level === 1);
      expect(titles).toHaveLength(1);
      expect(doc.blocks[0]).toMatchObject({ kind: 'heading', level: 1 });
    });

    it(`${file} has no link that leads nowhere`, () => {
      const anchors = new Set(doc.blocks.flatMap((b) => (b.kind === 'heading' ? [b.id] : [])));
      const links = doc.blocks.flatMap(function spansOf(b): string[] {
        const from = (spans: { kind: string; href?: string }[]) =>
          spans.flatMap((s) => (s.kind === 'link' && s.href ? [s.href] : []));
        switch (b.kind) {
          case 'heading':
          case 'paragraph':
          case 'quote':
            return from(b.spans);
          case 'list':
            return b.items.flatMap(from);
          case 'table':
            return [...b.head, ...b.rows.flat()].flatMap(from);
          default:
            return [];
        }
      });

      for (const href of links) {
        if (href.startsWith('#')) expect(anchors).toContain(href.slice(1));
        else expect(resolveHref(href)).toMatch(/^(\/|https:|mailto:)/);
      }
    });

    it(`${file} states an effective date`, () => {
      expect(source).toMatch(/\*\*Effective \d{1,2} \w+ \d{4}\.\*\*/);
    });
  }
});

describe('slug', () => {
  it('matches the anchor form GitHub generates', () => {
    expect(slug('Cookies and what sits on your device')).toBe(
      'cookies-and-what-sits-on-your-device',
    );
    expect(slug('7. Copyright complaints (DMCA)')).toBe('7-copyright-complaints-dmca');
  });
});
