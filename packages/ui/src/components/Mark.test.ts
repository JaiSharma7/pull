import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Mark, brimPath, hatGeometry } from './Mark.js';

/**
 * One hat, two renderers.
 *
 * The tab icon is produced by `scripts/gen-icons.mjs` — a build script, because this
 * repo has no rasteriser and encodes its PNGs from a pixel buffer — and the masthead
 * mark is this component. Neither can import the other, so the geometry is written
 * twice and this is what stops the two copies drifting into two different hats.
 *
 * It compares the *generated* `favicon.svg` rather than the script's source, so a change
 * to the script that has not been re-run also fails here: a stale icon in `public/` is
 * the same bug as a mismatched one.
 *
 * Reading `apps/web` from a `packages/ui` test crosses a package boundary, as
 * `design-laws.test.ts` already does for the same reason: the invariant is repo-wide
 * and the two halves of it live on opposite sides of the line.
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

/** Attributes of the nth element of a kind, as numbers where they parse as numbers. */
function shape(tag: string, index: number): Record<string, string> {
  const all = [...favicon.matchAll(new RegExp(`<${tag}\\s([^>]*)/>`, 'g'))];
  const el = all[index];
  if (!el) throw new Error(`favicon.svg has no <${tag}> at index ${index}`);
  return Object.fromEntries(
    [...el[1]!.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, k, v]) => [k!, v!]),
  );
}

/** The icons are drawn at 512 on a full-bleed square; the component uses its own units. */
const h = hatGeometry(512);
const at = (v: number) => String(Number(v.toFixed(2)));

describe('the house mark', () => {
  it('draws the same crown as the generated favicon', () => {
    // The ground is <rect> 0; the crown is 1 and the band is 2.
    const crown = shape('rect', 1);
    expect(crown.x).toBe(at(h.c - h.crownW / 2));
    expect(crown.y).toBe(at(h.crownTop + h.capRy));
    expect(crown.width).toBe(at(h.crownW));
    expect(crown.height).toBe(at(h.crownBottom - h.crownTop - h.capRy));

    const dome = shape('ellipse', 0);
    expect(dome.cx).toBe(at(h.c));
    expect(dome.cy).toBe(at(h.crownTop + h.capRy));
    expect(dome.rx).toBe(at(h.crownW / 2));
    expect(dome.ry).toBe(at(h.capRy));
  });

  it('draws the same band as the generated favicon', () => {
    const band = shape('rect', 2);
    expect(band.x).toBe(at(h.c - h.crownW / 2));
    expect(band.y).toBe(at(h.bandTop));
    expect(band.width).toBe(at(h.crownW));
    expect(band.height).toBe(at(h.bandH));
  });

  it('draws the same brim as the generated favicon', () => {
    // The whole point of the mark: a swept crescent, not the flat bar it replaced.
    expect(shape('path', 0).d).toBe(brimPath(h));
  });

  it('keeps the brim wider than the crown and lifted at the tips', () => {
    // The two cues that say *top* hat. Pinned as relationships, so a future tuning pass
    // can move the numbers and still be caught if it flattens the silhouette.
    expect(h.brimRx * 2).toBeGreaterThan(h.crownW * 2.5);
    expect(h.tipY).toBeLessThan(h.brimCy);
    expect(h.tipX * 2).toBeGreaterThan(h.brimRx * 1.8);
  });
});

describe('Mark', () => {
  const html = renderToStaticMarkup(createElement(Mark));

  it('takes its colour from the text around it, so it works on paper and at night', () => {
    // No ink ground and no bone fill: the icon files are drawn on a square of their own,
    // a mark in the masthead sits on whatever surface the reader has chosen.
    expect(html).toContain('currentColor');
    expect(html).not.toMatch(/fill="#/);
  });

  it('paints the band with the one accent, not a second colour', () => {
    expect(html).toContain('fill="var(--accent)"');
  });

  it('renders the shared geometry rather than numbers of its own', () => {
    expect(html).toContain(brimPath(hatGeometry(32)));
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
