import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../lib/questions-api.js', () => ({ rememberPull: vi.fn() }));

const { RememberThis } = await import('./RememberThis.js');

const PULL = '77777777-7777-4777-8777-777777777777';

/**
 * The form a reader writes their own question in, on its first render.
 *
 * `renderToStaticMarkup` cannot press anything, so what this can assert is the
 * closed state and the wiring that has to be right before a press: the control
 * names itself, says what it controls, and is not silently expanded. The
 * reducer's behaviour under every action is `lib/questions.test.ts`'s subject and
 * is not restated here.
 */
describe('RememberThis', () => {
  it('offers the control closed, pointing at the form it would open', () => {
    const html = renderToStaticMarkup(createElement(RememberThis, { pullId: PULL }));
    expect(html).toContain('Remember this');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain(`aria-controls="ask-form-${PULL}"`);
  });

  it('draws no form until it is asked for', () => {
    const html = renderToStaticMarkup(createElement(RememberThis, { pullId: PULL }));
    expect(html).not.toContain('What should this idea ask you?');
    expect(html).not.toContain('Keep this question');
  });

  it('scopes its ids to the prefix, so two instances on one page cannot collide', () => {
    const a = renderToStaticMarkup(createElement(RememberThis, { pullId: PULL }));
    const b = renderToStaticMarkup(
      createElement(RememberThis, { pullId: PULL, idPrefix: 'imported' }),
    );
    expect(a).toContain(`aria-controls="ask-form-${PULL}"`);
    expect(b).toContain(`aria-controls="imported-form-${PULL}"`);
  });

  /**
   * The row is the point of the `actions` prop, so the assertion is about the
   * row rather than about the two controls existing: a caller's control and the
   * toggle in ONE `remember__actions` paragraph, the caller's first. Rendered as
   * siblings in two paragraphs -- which is what the source page did before -- the
   * markup below would carry a `</p>` between them and this would fail.
   */
  it("puts the caller's controls in the same row as the toggle", () => {
    const html = renderToStaticMarkup(
      createElement(RememberThis, {
        pullId: PULL,
        actions: createElement('button', { type: 'button' }, 'Share'),
      }),
    );
    const row = html.slice(html.indexOf('<p class="remember__actions">'), html.indexOf('</p>'));
    expect(row).toContain('Share');
    expect(row).toContain('Remember this');
    expect(row.indexOf('Share')).toBeLessThan(row.indexOf('Remember this'));
  });

  it('draws the row with the toggle alone when nothing is passed', () => {
    const html = renderToStaticMarkup(createElement(RememberThis, { pullId: PULL }));
    const row = html.slice(html.indexOf('<p class="remember__actions">'), html.indexOf('</p>'));
    // The count, not the absence of a string: `not.toContain('<button type="button">')`
    // passed whatever the component did, because React never serialises a bare
    // `<button type="button">` -- the toggle carries a class and two aria attributes.
    expect(row.match(/<button/g)).toHaveLength(1);
    expect(row).toContain('Remember this');
  });

  /**
   * `status` is a separate slot from `actions` because its POSITION is the point:
   * `.meta` in an actions row takes the whole line, so a sentence anywhere but last
   * pushes what follows onto the next line at the moment it appears -- under the
   * finger of the reader who just pressed the control it is about. Last, nothing
   * follows it to move. This asserts the order that makes that true.
   */
  it('renders status after the toggle, and actions before it', () => {
    const html = renderToStaticMarkup(
      createElement(RememberThis, {
        pullId: PULL,
        actions: createElement('button', { type: 'button', className: 'btn' }, 'Share'),
        status: createElement('span', { className: 'meta', role: 'status' }, 'Pick some words'),
      }),
    );
    const row = html.slice(html.indexOf('<p class="remember__actions">'), html.indexOf('</p>'));
    expect(row.indexOf('Share')).toBeLessThan(row.indexOf('Remember this'));
    expect(row.indexOf('Remember this')).toBeLessThan(row.indexOf('Pick some words'));
  });

  it('says nothing about having kept anything before anything is kept', () => {
    const html = renderToStaticMarkup(createElement(RememberThis, { pullId: PULL }));
    expect(html).not.toContain('Kept.');
  });
});
