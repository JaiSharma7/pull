import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  Mark,
  bandPath,
  bodyPath,
  brimRingPath,
  hatGeometry,
  sparklePath,
} from './Mark.js';

/**
 * One mark, two renderers.
 *
 * The browser/PWA icon is produced by `scripts/gen-icons.mjs`; the masthead mark is the
 * React component. The geometry is written twice because the build script cannot import
 * TSX, so this test compares both against the generated favicon and makes drift visible.
 */
const FAVICON = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  '..',
  'apps',
  'web',
  'public',
  'favicon.svg',
);
const favicon = readFileSync(FAVICON, 'utf8');

function shape(tag: string, index: number): Record<string, string> {
  const all = [...favicon.matchAll(new RegExp(`<${tag}\\s([^>]*)/>`, 'g'))];
  const el = all[index];
  if (!el) throw new Error(`favicon.svg has no <${tag}> at index ${index}`);
  return Object.fromEntries(
    [...el[1]!.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, k, v]) => [k!, v!]),
  );
}

const h = hatGeometry(512);
const at = (v: number) => String(Number(v.toFixed(2)));

describe('the house mark', () => {
  it('keeps the brim opening above a crown that tapers downward', () => {
    expect(h.bodyTop).toBeGreaterThan(h.brimCy);
    expect(h.crownTopW).toBeGreaterThan(h.crownBottomW);
    expect(h.bodyBottom).toBeGreaterThan(h.bandBottom);
  });

  it('draws the same body, band and open brim as the generated favicon', () => {
    expect(shape('path', 0).d).toBe(bodyPath(h));
    expect(shape('path', 1).d).toBe(bandPath(h));
    expect(shape('path', 2).d).toBe(brimRingPath(h));
    expect(shape('path', 2)['fill-rule']).toBe('evenodd');

    const cap = shape('ellipse', 0);
    expect(cap.cx).toBe(at(h.c));
    expect(cap.cy).toBe(at(h.bodyBottom));
    expect(cap.rx).toBe(at(h.crownBottomW / 2));
    expect(cap.ry).toBe(at(h.bottomCapRy));
  });

  it('keeps all three sparks in step with the generated favicon', () => {
    h.sparkles.forEach((sparkle, index) => {
      expect(shape('path', index + 3).d).toBe(sparklePath(sparkle));
      expect(shape('path', index + 3).fill).toBe('#d5b45b');
    });
  });

  it('keeps the brim dramatically wider than the crown', () => {
    expect(h.brimRx * 2).toBeGreaterThan(h.crownTopW * 2.5);
    expect(h.openRx).toBeGreaterThan(h.crownBottomW / 2);
  });
});

describe('Mark', () => {
  const html = renderToStaticMarkup(createElement(Mark));

  it('takes the hat colour from the text around it, so it works on paper and at night', () => {
    expect(html).toContain('currentColor');
    expect(html).not.toMatch(/fill="#/);
  });

  it('keeps oxblood on the band and champagne only on decorative sparks', () => {
    expect(html).toContain('fill="var(--accent)"');
    expect(html.match(/color-mix\(in srgb, var\(--warm\) 62%, var\(--bone\)\)/g)).toHaveLength(3);
  });

  it('renders the shared paths rather than numbers of its own', () => {
    const small = hatGeometry(32);
    expect(html).toContain(bodyPath(small));
    expect(html).toContain(bandPath(small));
    expect(html).toContain(brimRingPath(small));
    small.sparkles.forEach((sparkle) => expect(html).toContain(sparklePath(sparkle)));
  });

  it('is decorative beside the wordmark, and nameable where it is not', () => {
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain('<title>');

    const named = renderToStaticMarkup(createElement(Mark, { title: 'What a Pull' }));
    expect(named).toContain('<title>What a Pull</title>');
    expect(named).toContain('role="img"');
    expect(named).not.toContain('aria-hidden');
  });
});
