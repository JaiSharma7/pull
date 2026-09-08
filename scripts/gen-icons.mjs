#!/usr/bin/env node
/**
 * Generate the app icons into apps/web/public/.
 *
 * No rasteriser or image dependency is required: the PNGs are encoded from a sampled
 * pixel buffer with Node's zlib. The geometry mirrors packages/ui/src/components/Mark.tsx
 * so the masthead and browser/PWA icons stay the same mark.
 *
 * The official mark is an upside-down magician's top hat: open brim at the top, crown
 * tapering downward, oxblood band, and three restrained warm-grey sparks. It is tuned
 * for 16px first and remains flat: no gradients, shadows or texture.
 *
 * Run: node scripts/gen-icons.mjs
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'web', 'public');

// Build-script colours are intentionally literal: an icon is loaded without the app's
// stylesheet, so it cannot inherit a token. The exemption in design-laws.test.ts is by
// VALUE rather than by file, though — favicon.svg may spell a colour tokens.css already
// defines and nothing else — so every constant below is a palette hex, not a free hue.
const INK = [0x14, 0x12, 0x0e];
const BONE = [0xf4, 0xf1, 0xea];
const OXBLOOD = [0x8c, 0x2f, 0x26];
const WARM = [0x6b, 0x64, 0x59];

const CRC_TABLE = Int32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2; // opaque truecolour: PWA launchers want a deliberate ground
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) {
    const row = y * (size * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b] = pixels(x, y);
      raw[row + 1 + x * 3] = r;
      raw[row + 2 + x * 3] = g;
      raw[row + 3 + x * 3] = b;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const BRIM_RX = 0.46;
const BRIM_RY = 0.11;
const OPEN_RX = 0.28;
const OPEN_RY = 0.055;
const CROWN_TOP_W = 0.34;
const CROWN_BOTTOM_W = 0.24;
const CROWN_H = 0.34;
const BAND_H = 0.075;
const BOTTOM_CAP_RY = 0.035;

function hat(size, inset) {
  const c = size / 2;
  const s = size * inset;
  const brimCy = c - s * 0.08;
  const bodyTop = brimCy + s * OPEN_RY * 1.02;
  const bodyBottom = bodyTop + s * CROWN_H;
  const bandTop = bodyTop + s * 0.02;
  const bandBottom = bandTop + s * BAND_H;
  return {
    c,
    size: s,
    brimCy,
    brimRx: s * BRIM_RX,
    brimRy: s * BRIM_RY,
    openRx: s * OPEN_RX,
    openRy: s * OPEN_RY,
    bodyTop,
    bodyBottom,
    crownTopW: s * CROWN_TOP_W,
    crownBottomW: s * CROWN_BOTTOM_W,
    bandTop,
    bandBottom,
    bottomCapRy: s * BOTTOM_CAP_RY,
    sparkles: [
      { x: c, y: c - s * 0.315, rx: s * 0.075, ry: s * 0.09 },
      { x: c - s * 0.165, y: c - s * 0.225, rx: s * 0.044, ry: s * 0.054 },
      { x: c + s * 0.165, y: c - s * 0.225, rx: s * 0.044, ry: s * 0.054 },
    ],
  };
}

const inEllipse = (px, py, cx, cy, rx, ry) => ((px - cx) / rx) ** 2 + ((py - cy) / ry) ** 2 <= 1;

function widthAt(h, y) {
  const t = Math.max(0, Math.min(1, (y - h.bodyTop) / (h.bodyBottom - h.bodyTop)));
  return h.crownTopW + (h.crownBottomW - h.crownTopW) * t;
}

function polygon(points) {
  return (px, py) => {
    let inside = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const [xi, yi] = points[i];
      const [xj, yj] = points[j];
      const crosses = yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
      if (crosses) inside = !inside;
    }
    return inside;
  };
}

function bodyPolygon(h) {
  return polygon([
    [h.c - h.crownTopW / 2, h.bodyTop],
    [h.c + h.crownTopW / 2, h.bodyTop],
    [h.c + h.crownBottomW / 2, h.bodyBottom],
    [h.c - h.crownBottomW / 2, h.bodyBottom],
  ]);
}

function bandPolygon(h) {
  const topW = widthAt(h, h.bandTop);
  const bottomW = widthAt(h, h.bandBottom);
  return polygon([
    [h.c - topW / 2, h.bandTop],
    [h.c + topW / 2, h.bandTop],
    [h.c + bottomW / 2, h.bandBottom],
    [h.c - bottomW / 2, h.bandBottom],
  ]);
}

function sparklePoints(s) {
  const ix = s.rx * 0.22;
  const iy = s.ry * 0.22;
  return [
    [s.x, s.y - s.ry],
    [s.x + ix, s.y - iy],
    [s.x + s.rx, s.y],
    [s.x + ix, s.y + iy],
    [s.x, s.y + s.ry],
    [s.x - ix, s.y + iy],
    [s.x - s.rx, s.y],
    [s.x - ix, s.y - iy],
  ];
}

function shade(h) {
  const inBody = bodyPolygon(h);
  const inBand = bandPolygon(h);
  const inSparkles = h.sparkles.map((s) => polygon(sparklePoints(s)));
  return (px, py) => {
    if (inSparkles.some((inside) => inside(px, py))) return WARM;
    if (
      inEllipse(px, py, h.c, h.brimCy, h.brimRx, h.brimRy) &&
      !inEllipse(px, py, h.c, h.brimCy, h.openRx, h.openRy)
    )
      return INK;
    if (inBand(px, py)) return OXBLOOD;
    if (inBody(px, py)) return INK;
    if (inEllipse(px, py, h.c, h.bodyBottom, h.crownBottomW / 2, h.bottomCapRy)) return INK;
    return BONE;
  };
}

function mark(size, inset) {
  const at = shade(hat(size, inset));
  const STEPS = 4;
  return (x, y) => {
    let r = 0,
      g = 0,
      b = 0;
    for (let sy = 0; sy < STEPS; sy++) {
      for (let sx = 0; sx < STEPS; sx++) {
        const [pr, pg, pb] = at(x + (sx + 0.5) / STEPS, y + (sy + 0.5) / STEPS);
        r += pr;
        g += pg;
        b += pb;
      }
    }
    const count = STEPS * STEPS;
    return [Math.round(r / count), Math.round(g / count), Math.round(b / count)];
  };
}

const hex = ([r, g, b]) => `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
const n = (v) => Number(v.toFixed(2));

function widthAtSvg(h, y) {
  return widthAt(h, y);
}

function bodyPath(h) {
  return `M ${n(h.c - h.crownTopW / 2)} ${n(h.bodyTop)} L ${n(h.c + h.crownTopW / 2)} ${n(h.bodyTop)} L ${n(h.c + h.crownBottomW / 2)} ${n(h.bodyBottom)} L ${n(h.c - h.crownBottomW / 2)} ${n(h.bodyBottom)} Z`;
}

function bandPath(h) {
  const topW = widthAtSvg(h, h.bandTop);
  const bottomW = widthAtSvg(h, h.bandBottom);
  return `M ${n(h.c - topW / 2)} ${n(h.bandTop)} L ${n(h.c + topW / 2)} ${n(h.bandTop)} L ${n(h.c + bottomW / 2)} ${n(h.bandBottom)} L ${n(h.c - bottomW / 2)} ${n(h.bandBottom)} Z`;
}

function ellipsePath(cx, cy, rx, ry) {
  return `M ${n(cx - rx)} ${n(cy)} A ${n(rx)} ${n(ry)} 0 1 0 ${n(cx + rx)} ${n(cy)} A ${n(rx)} ${n(ry)} 0 1 0 ${n(cx - rx)} ${n(cy)} Z`;
}

function brimRingPath(h) {
  return `${ellipsePath(h.c, h.brimCy, h.brimRx, h.brimRy)} ${ellipsePath(h.c, h.brimCy, h.openRx, h.openRy)}`;
}

function sparklePath(s) {
  return `M ${sparklePoints(s)
    .map(([x, y]) => `${n(x)} ${n(y)}`)
    .join(' L ')} Z`;
}

function svg(size = 512, inset = 1) {
  const h = hat(size, inset);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="What a Pull">
  <rect width="${size}" height="${size}" fill="${hex(BONE)}"/>
  <path d="${bodyPath(h)}" fill="${hex(INK)}"/>
  <ellipse cx="${n(h.c)}" cy="${n(h.bodyBottom)}" rx="${n(h.crownBottomW / 2)}" ry="${n(h.bottomCapRy)}" fill="${hex(INK)}"/>
  <path d="${bandPath(h)}" fill="${hex(OXBLOOD)}"/>
  <path d="${brimRingPath(h)}" fill="${hex(INK)}" fill-rule="evenodd" clip-rule="evenodd"/>
  ${h.sparkles.map((s) => `<path d="${sparklePath(s)}" fill="${hex(WARM)}"/>`).join('\n  ')}
</svg>
`;
}

mkdirSync(OUT, { recursive: true });
const outputs = [
  ['favicon.svg', Buffer.from(svg())],
  ['icon-192.png', png(192, mark(192, 1))],
  ['icon-512.png', png(512, mark(512, 1))],
  ['icon-maskable-512.png', png(512, mark(512, 0.6))],
  ['apple-touch-icon.png', png(180, mark(180, 1))],
];
for (const [name, data] of outputs) {
  writeFileSync(join(OUT, name), data);
  console.log(`wrote apps/web/public/${name} (${data.length} bytes)`);
}
