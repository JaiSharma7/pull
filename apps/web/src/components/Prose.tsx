import type { JSX } from 'react';
import { type Block, type Span, resolveHref } from '../lib/markdown.js';

/**
 * Renders parsed Markdown as React elements.
 *
 * Every branch returns an element, never a string of HTML, so there is no
 * `dangerouslySetInnerHTML` anywhere in this path and nothing in a document can
 * become markup by accident. See the note at the top of `lib/markdown.ts`.
 */

/** Span text, flattened — for an accessible name, never for rendering. */
function textOf(spans: Span[]): string {
  return spans.map((s) => s.text).join('');
}

function Inline({ spans }: { spans: Span[] }) {
  return (
    <>
      {spans.map((span, i) => {
        switch (span.kind) {
          case 'strong':
            return <strong key={i}>{span.text}</strong>;
          case 'em':
            return <em key={i}>{span.text}</em>;
          case 'code':
            return <code key={i}>{span.text}</code>;
          case 'link': {
            const href = resolveHref(span.href);
            // An outbound link opens away from the app; an in-app one must not,
            // or the reader loses the page they were reading.
            const external = href.startsWith('http');
            return (
              <a
                key={i}
                href={href}
                {...(external ? { target: '_blank', rel: 'noreferrer noopener' } : {})}
              >
                {span.text}
              </a>
            );
          }
          default:
            return <span key={i}>{span.text}</span>;
        }
      })}
    </>
  );
}

function render(block: Block, key: number): JSX.Element {
  switch (block.kind) {
    case 'heading': {
      // The document's own h1 is the page title; everything under it steps down
      // by one so the page has a single top-level heading in the outline.
      const Tag = (['h1', 'h2', 'h3'] as const)[block.level - 1]!;
      return (
        <Tag key={key} id={block.id} className="prose__heading">
          <Inline spans={block.spans} />
        </Tag>
      );
    }
    case 'paragraph':
      return (
        <p key={key}>
          <Inline spans={block.spans} />
        </p>
      );
    case 'quote':
      return (
        <blockquote key={key} className="prose__quote">
          <Inline spans={block.spans} />
        </blockquote>
      );
    case 'rule':
      return <hr key={key} className="rule" />;
    case 'list': {
      const items = block.items.map((spans, i) => (
        <li key={i}>
          <Inline spans={spans} />
        </li>
      ));
      return block.ordered ? (
        <ol key={key} className="prose__list">
          {items}
        </ol>
      ) : (
        <ul key={key} className="prose__list">
          {items}
        </ul>
      );
    }
    case 'table':
      // The wrapper scrolls, not the page: a three-column table of processors
      // must not make the whole document pan sideways on a phone.
      //
      // A container that scrolls has to be reachable by keyboard, or the content
      // past its right edge is unreachable without a mouse (WCAG 2.1.1). That is
      // what the `tabIndex` is for, and why it carries a named `region` role
      // rather than being a bare focusable div. The name is built from the
      // headers so two tables on one page are told apart when tabbing.
      return (
        <div
          key={key}
          className="prose__scroll"
          tabIndex={0}
          role="region"
          aria-label={`Table: ${block.head.map(textOf).join(', ')}`}
        >
          <table className="prose__table">
            <thead>
              <tr>
                {block.head.map((cell, i) => (
                  <th key={i} scope="col">
                    <Inline spans={cell} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, c) => (
                    <td key={c}>
                      <Inline spans={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

export function Prose({ blocks }: { blocks: Block[] }) {
  return <div className="prose">{blocks.map(render)}</div>;
}
