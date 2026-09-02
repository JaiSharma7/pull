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

/**
 * The Depth Dial — `docs/product.md`, and the reason the card stopped being a flip.
 *
 * The flip's back face was `position: absolute; inset: 0` with `overflow-y: auto`,
 * so it was sized by the front: any Pull whose "why it matters" ran longer than
 * its claim scrolled inside the card, and asking for more detail made the reading
 * area smaller. It also had exactly two states, so `explanation` — fetched by
 * `get_feed` since the first migration — had nowhere to go and was rendered by
 * nothing.
 *
 * These assert the two halves of the fix: the deeper text exists, and the card
 * never re-acquires a fixed height to overflow.
 */
describe('the depth dial', () => {
  const deep = {
    ...base,
    whyItMatters: 'Suppression costs the public more than it costs the suppressed.',
    explanation: 'The argument runs in two directions, and both are load-bearing.',
  };

  it('opens on the claim, showing the headline and body and no more', () => {
    const html = renderToStaticMarkup(createElement(PullCard, deep));
    expect(html).toContain(base.headline);
    expect(html).toContain(base.body);
    expect(html).not.toContain('costs the public more');
    expect(html).not.toContain('two directions');
  });

  it('shows the headline alone at the shortest stop', () => {
    const html = renderToStaticMarkup(createElement(PullCard, { ...deep, depth: 0 }));
    expect(html).toContain(base.headline);
    expect(html).not.toContain(base.body);
  });

  it('renders the deeper text once the reader has asked for it', () => {
    const html = renderToStaticMarkup(createElement(PullCard, { ...deep, depth: 3 }));
    expect(html).toContain('costs the public more');
    expect(html).toContain('two directions');
  });

  it('renders explanation, which the two-sided card had nowhere to put', () => {
    // The regression that matters most: this content is paid for on every feed
    // request and was invisible on every screen.
    const html = renderToStaticMarkup(
      createElement(PullCard, { ...base, explanation: 'The full argument.', depth: 2 }),
    );
    expect(html).toContain('The full argument.');
  });

  it('offers a stop for every level the content supports, and no more', () => {
    const html = renderToStaticMarkup(createElement(PullCard, deep));
    const stops = [...html.matchAll(/role="radio"/g)];
    // headline, claim, why, full — no source, since nothing can open one here.
    expect(stops.length).toBe(4);
  });

  it('adds the source stop only where there is a source to open', () => {
    const html = renderToStaticMarkup(createElement(PullCard, { ...deep, onOpenSource: () => {} }));
    expect([...html.matchAll(/role="radio"/g)].length).toBe(5);
    expect(html).toContain('>Source<');
  });

  it('hides the dial when a Pull has nowhere to go', () => {
    // A dial with one stop is furniture.
    const html = renderToStaticMarkup(createElement(PullCard, { ...base, body: '' }));
    expect(html).not.toContain('pull-card__dial');
  });

  it('grows the tick with the stop, so the dial reads without colour', () => {
    // docs/design.md: colour is never the only signal. For this control that
    // means tick length carries the position and the accent only confirms it.
    const html = renderToStaticMarkup(createElement(PullCard, deep));
    expect(html).toContain('width:6px');
    expect(html).toContain('width:18px');
  });

  it('checks the current stop, and only that one', () => {
    const html = renderToStaticMarkup(createElement(PullCard, { ...deep, depth: 2 }));
    expect([...html.matchAll(/aria-checked="true"/g)].length).toBe(1);
  });

  it('gives the group one tab stop, so the arrows do the moving', () => {
    const html = renderToStaticMarkup(createElement(PullCard, { ...deep, depth: 2 }));
    expect([...html.matchAll(/tabindex="0"/g)].length).toBe(1);
  });

  it('clamps a remembered depth to the stops this card has', () => {
    // The feed keeps one depth across cards. Landing on a card with no
    // explanation while holding depth 3 must not mark a stop that is not there.
    const html = renderToStaticMarkup(
      createElement(PullCard, { ...base, whyItMatters: 'Two stops in.', depth: 4 }),
    );
    expect(html).toContain('Two stops in.');
    expect([...html.matchAll(/aria-checked="true"/g)].length).toBe(1);
  });

  it('names each stop for a reader who cannot see the card change', () => {
    // The visible label is a duration, and "35 sec" announced on its own says
    // nothing about which way the dial is being turned.
    const html = renderToStaticMarkup(createElement(PullCard, deep));
    expect(html).toContain('aria-label="Shortest"');
    expect(html).toContain('aria-label="Long"');
  });

  it('shrinks the headline as the card grows', () => {
    // The card has to read as one object changing, not as a page with things
    // appended to it.
    const shortest = renderToStaticMarkup(createElement(PullCard, { ...deep, depth: 0 }));
    const longest = renderToStaticMarkup(createElement(PullCard, { ...deep, depth: 3 }));
    const scale = (html: string) => Number(html.match(/--headline-scale:([\d.]+)/)![1]);
    expect(scale(shortest)).toBeGreaterThan(scale(longest));
  });

  it('puts the idea before the dial, so a phone does not lead with the control', () => {
    /*
     * Source order is the narrow layout, and the narrow layout is the one that
     * cannot cheat: with no margin to hold the dial it goes wherever the flow puts
     * it. Above the headline it pushed the idea 212px down a 393px screen — a
     * reader scrolling past a control to reach the thing it controls. The grid puts
     * it back in the margin where there is room, so this order costs the wide
     * layout nothing and is also the honest tab and screen-reader sequence.
     */
    const html = renderToStaticMarkup(createElement(PullCard, deep));
    expect(html.indexOf('pull-card__reading')).toBeLessThan(html.indexOf('pull-card__dial'));
  });

  it('never renders a scroller inside the card', () => {
    /*
     * The bug in one assertion. The card grows into the page; the moment it is
     * given a height and an overflow again, more detail starts costing reading
     * area — which is the wrong direction for the control that asks for it.
     */
    const html = renderToStaticMarkup(createElement(PullCard, { ...deep, depth: 3 }));
    expect(html).not.toContain('flip');
    expect(html).not.toMatch(/overflow/);
    expect(html).not.toMatch(/style="[^"]*height/);
  });
});

describe('the source chip', () => {
  /**
   * The chip is how a reader reaches the source, and it has to stay plain text when
   * there is nowhere to send them.
   *
   * The same failure shape as Listen above: `onOpenSource` is optional, so a screen
   * that forgets it produces neither a type error nor a runtime error — just a card
   * whose only route into the source silently is not there. And rendering a control
   * unconditionally would be the mirror of that, offering a button that does nothing
   * on the specimen and on any row whose work is not resolvable.
   */
  it('renders the chip as plain text when there is no source to open', () => {
    const html = renderToStaticMarkup(createElement(PullCard, base));
    expect(html).toContain('On Liberty');
    expect(html).not.toContain('pull-card__chip--link');
  });

  it('renders the chip as a button when a source can be opened', () => {
    const html = renderToStaticMarkup(createElement(PullCard, { ...base, onOpenSource: () => {} }));
    expect(html).toContain('pull-card__chip--link');
    expect(html).toContain('<button');
    // The source is still legible as metadata, not replaced by a generic label.
    expect(html).toContain('On Liberty');
  });
});
