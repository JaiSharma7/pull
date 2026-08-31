import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PullCard } from './PullCard.js';

/**
 * The card's optional actions, and the one that is a promise rather than a feature.
 *
 * Rendered with `renderToStaticMarkup` rather than a DOM library: this repo has no
 * jsdom and no testing-library, and does not need them to answer "does this button
 * exist". `createElement` rather than JSX because the shared Vitest preset includes
 * `src/**‍/*.test.ts` only — a `.tsx` test would silently never run, which is a worse
 * outcome than slightly uglier test source.
 *
 * Listen is asserted specifically because law 3 makes audio free forever, and the
 * Library shipped without it while the Feed had it. That made the promise conditional
 * on which screen the reader happened to be standing on, and nothing caught it: the
 * prop is optional, so its absence is not a type error and not a runtime error — it
 * is just a button that quietly is not there.
 */

const base = {
  source: { title: 'On Liberty', kind: 'book' },
  headline: 'Silencing a dissenter deprives society',
  body: 'When an opinion is suppressed, the primary victim is the public.',
};

describe('PullCard', () => {
  it('renders the headline and body', () => {
    const html = renderToStaticMarkup(createElement(PullCard, base));
    expect(html).toContain('Silencing a dissenter deprives society');
    expect(html).toContain('the primary victim is the public');
  });

  it('offers Listen when a handler is given', () => {
    const html = renderToStaticMarkup(createElement(PullCard, { ...base, onListen: () => {} }));
    expect(html).toContain('Listen');
  });

  it('omits Listen when no handler is given', () => {
    // The other half of the assertion above. Without it, a test that only checks
    // for presence passes just as well against a card that always renders the
    // button — and would not have caught the Library's missing prop either.
    const html = renderToStaticMarkup(createElement(PullCard, base));
    expect(html).not.toContain('Listen');
  });

  it('labels Listen with the headline, so the control is unambiguous out of context', () => {
    // A screen reader moving by control hears "Listen" many times on one screen;
    // the headline is what tells them which idea they are about to hear.
    const html = renderToStaticMarkup(createElement(PullCard, { ...base, onListen: () => {} }));
    expect(html).toContain(`aria-label="Listen to: ${base.headline}"`);
  });

  it('keeps its actions independent of one another', () => {
    // Save and Listen are separate promises; passing one must not imply the other.
    const html = renderToStaticMarkup(createElement(PullCard, { ...base, onSave: () => {} }));
    expect(html).not.toContain('Listen');
  });
});
