import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { Enough } from './Enough';

/**
 * The Enough screen has shipped a copy bug in two consecutive review rounds,
 * because its only real claim is one sentence about one number and nothing
 * asserted the sentence. The distinctions below are the product's honesty
 * rather than formatting: a saving the reader did not get must not be
 * announced, and a number that was never computed must not be reported as a
 * measured zero.
 *
 * Written with `createElement` rather than JSX so it matches the shared Vitest
 * preset's `src/**\/*.test.ts` include, which no package needs widened for one
 * component.
 */
const render = (minutesSaved: number | null) =>
  renderToStaticMarkup(createElement(Enough, { ideasRead: 8, recalled: 3, minutesSaved }));

describe('Enough', () => {
  it('does not claim a saving when nothing was saved', () => {
    const html = render(0);
    expect(html).toContain('Nothing skipped this time');
    expect(html).not.toContain('saved');
    // The subtitle qualifies a saving, so it has no business appearing here.
    expect(html).not.toContain('against reading the sources in full');
  });

  it('says nothing at all when the Delta never ran', () => {
    const html = render(null);
    expect(html).not.toContain('saved');
    expect(html).not.toContain('Nothing skipped');
    expect(html).not.toContain('against reading the sources in full');
    // The rest of the screen still stands.
    expect(html).toContain('Mind fed.');
  });

  it('rounds down to "under a minute" rather than claiming a whole one', () => {
    expect(render(0.4)).toContain('Under a minute saved');
  });

  it('agrees with itself about plurals', () => {
    expect(render(1)).toContain('1 minute saved');
    expect(render(6.2)).toContain('6.2 minutes saved');
  });

  it('qualifies the saving whenever it reports one', () => {
    expect(render(6.2)).toContain('against reading the sources in full');
  });
});
