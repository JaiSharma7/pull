import { describe, expect, it } from 'vitest';
import { elementBodies, withoutHtmlComments } from './html-scanner.js';

describe('elementBodies', () => {
  it('recognises mixed-case tags and browser-tolerated closing whitespace', () => {
    expect(elementBodies('<ScRiPt type="module">safe()</sCrIpT >', 'script')).toEqual(['safe()']);
    expect(elementBodies('<STYLE>.safe { color: inherit }</style data-x>', 'style')).toEqual([
      '.safe { color: inherit }',
    ]);
  });

  it('preserves offsets when unrelated Unicode expands during lowercase conversion', () => {
    expect(elementBodies('İ<style>linear-gradient(red,blue)</style>', 'style')).toEqual([
      'linear-gradient(red,blue)',
    ]);
  });

  it('ignores greater-than signs and apparent closers inside quoted attributes', () => {
    const html =
      '<style title="> </style>">.bad { background: linear-gradient(red, blue) }</style>';
    expect(elementBodies(html, 'style')).toEqual([
      '.bad { background: linear-gradient(red, blue) }',
    ]);
  });

  it('requires a tag-name boundary and drops unterminated bodies', () => {
    expect(elementBodies('<scripture>prose</scripture>', 'script')).toEqual([]);
    expect(elementBodies('<script>never page content', 'script')).toEqual([]);
  });
});

describe('withoutHtmlComments', () => {
  it('removes comments again when one removal recombines comment fragments', () => {
    expect(withoutHtmlComments('<!<!-- discarded -->--hidden-->visible')).toBe('visible');
  });
});
