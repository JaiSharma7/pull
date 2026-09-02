import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DesignPreview } from './DesignPreview.js';

describe('DesignPreview', () => {
  it('opens on a public, bounded sitting gate', () => {
    const html = renderToStaticMarkup(createElement(DesignPreview));

    expect(html).toContain('How long have you got?');
    expect(html).toContain('The sitting is cut to fit, and then it is finished.');
    expect(html).toContain('2 ideas');
    expect(html).toContain('3 ideas');
    expect(html).toContain('No account needed. Nothing saved.');
    expect(html.match(/<button/g)).toHaveLength(2);
  });
});
