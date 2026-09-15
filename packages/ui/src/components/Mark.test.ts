import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Mark } from './Mark.js';
const publicDir = join(import.meta.dirname, '../../../../apps/web/public');
describe('supplied brand artwork', () => {
  it('renders the shared hat and names it only when needed', () => {
    const decorative = renderToStaticMarkup(createElement(Mark));
    expect(decorative).toContain('src="/brand/hat.png"');
    expect(decorative).toContain('alt=""');
    expect(decorative).toContain('aria-hidden="true"');
    const named = renderToStaticMarkup(createElement(Mark, { title: 'What a Pull' }));
    expect(named).toContain('alt="What a Pull"');
    expect(named).not.toContain('aria-hidden');
  });
  it('ships correctly sized PNGs and a self-contained favicon', () => {
    for (const [file, size] of [
      ['icon-192.png', 192],
      ['icon-512.png', 512],
      ['icon-maskable-512.png', 512],
      ['apple-touch-icon.png', 180],
    ] as const) {
      const png = readFileSync(join(publicDir, file));
      expect(png.readUInt32BE(16)).toBe(size);
      expect(png.readUInt32BE(20)).toBe(size);
    }
    const svg = readFileSync(join(publicDir, 'favicon.svg'), 'utf8');
    expect(svg).toContain('data:image/png,');
    expect(svg).not.toMatch(/href="https?:/);
  });
});
