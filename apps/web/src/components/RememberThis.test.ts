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

  it('says nothing about having kept anything before anything is kept', () => {
    const html = renderToStaticMarkup(createElement(RememberThis, { pullId: PULL }));
    expect(html).not.toContain('Kept.');
  });
});
