import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PreviewDepthDial } from './PreviewDepthDial.js';
import type { PreviewPull } from '../lib/design-preview.js';

const pull: PreviewPull = {
  headline: 'A claim with enough words to make a clock',
  source: {
    title: 'A source',
    creator: 'A writer',
    kind: 'essay',
    year: '1625',
    trail: 'section 1',
    url: 'https://example.test/source',
  },
  layers: [
    { text: 'First layer.' },
    { text: 'Second layer.' },
    { text: 'Third layer.' },
    { text: 'Fourth layer.' },
  ],
};

describe('PreviewDepthDial', () => {
  it('uses one native radio group with five keyboard-reachable stops', () => {
    const html = renderToStaticMarkup(
      createElement(PreviewDepthDial, {
        pull,
        cardIndex: 1,
        depth: 2,
        onDepth: () => {},
      }),
    );

    expect(html).toContain('<fieldset');
    expect(html).toContain('<legend');
    expect(html.match(/type="radio"/g)).toHaveLength(5);
    expect(html.match(/name="depth-1"/g)).toHaveLength(5);
    expect(html).toContain('Medium');
    expect(html).toContain('checked=""');
  });
});
