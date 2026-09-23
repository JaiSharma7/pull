import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DeltaBanner } from './DeltaBanner.js';
import { SourceDeltaSummary } from './SourceDeltaSummary.js';

describe('Delta claims shown to readers', () => {
  it('labels the feed number as a latest-search candidate estimate', () => {
    const html = renderToStaticMarkup(
      createElement(DeltaBanner, { count: 2, estimatedMinutes: 1.1 }),
    );
    expect(html).toContain('Latest search set aside 2 matched ideas');
    expect(html).toContain('candidate pool');
    expect(html).toContain('about 1.1 min of estimated reading');
    expect(html).not.toContain('already know');
    expect(
      renderToStaticMarkup(createElement(DeltaBanner, { count: null, estimatedMinutes: null })),
    ).toBe('');
  });

  it('calls unmatched source ideas unverified rather than new', () => {
    const html = renderToStaticMarkup(
      createElement(SourceDeltaSummary, {
        delta: { total: 4, known: 2, new: 2, minutesSaved: 1.1 },
      }),
    );
    expect(html).toContain('of 4 ideas match');
    expect(html).toContain('remain unverified');
    expect(html).toContain('1.1 min');
    expect(html).not.toContain('new to you');
  });

  it('does not claim an unfamiliar source when knowledge is unmeasured', () => {
    const html = renderToStaticMarkup(
      createElement(SourceDeltaSummary, {
        delta: { total: 4, known: 0, new: 4, minutesSaved: 0 },
      }),
    );
    expect(html).toContain('No ideas in this version are confirmed as known yet');
    expect(html).not.toContain('new to you');
  });
});
