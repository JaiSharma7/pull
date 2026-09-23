import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { Enough } from './Enough';

const render = (minutesSaved: number | null) =>
  renderToStaticMarkup(createElement(Enough, { ideasRead: 8, recalled: 3, minutesSaved }));

describe('Enough', () => {
  it('does not claim a saving when no matched time was estimated', () => {
    const html = render(0);
    expect(html).toContain('No matched reading in the latest search');
    expect(html).not.toContain('saved');
  });

  it('says nothing at all when the Delta never ran', () => {
    const html = render(null);
    expect(html).not.toContain('saved');
    expect(html).not.toContain('latest search');
    // The rest of the screen still stands.
    expect(html).toContain('Mind fed.');
  });

  it('reports a sub-minute estimate without rounding it to a full minute', () => {
    expect(render(0.4)).toContain('under a minute of estimated reading in matched ideas');
  });

  it('agrees with itself about plurals', () => {
    expect(render(1)).toContain('1 minute of estimated reading in matched ideas');
    expect(render(6.2)).toContain('6.2 minutes of estimated reading in matched ideas');
  });

  it('labels the estimate as belonging to the latest search', () => {
    expect(render(6.2)).toContain('Latest search:');
  });
});
