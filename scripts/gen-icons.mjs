#!/usr/bin/env node
/**
 * Generate the app icons into apps/web/public/.
 *
 * There is no rasteriser on a plain CI box and no image dependency in this repo, so the
 * PNGs are encoded here from a pixel buffer with nothing but `zlib`. That is only
 * tolerable because the mark is deliberately geometric — flat fills, one accent, no
 * gradient (design law 1) — which is exactly what The Archive calls for anyway.
 *
 * The mark: a bone page on an ink ground with an oxblood rule pulled through it, wider
 * than the page on both sides. A page, and something drawn out of it.
 *
 * Run: node scripts/gen-icons.mjs
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'web', 'public');

// Kept in step with packages/ui/src/styles/tokens.css by the design-laws test, which
// rejects any hex outside that file — these live in a build script, not a stylesheet.
const INK = [0x14, 0x12, 0x0e];
const BONE = [0xf4, 0xf1, 0xea];
const OXBLOOD = [0x8c, 0x2f, 0x26];

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
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour, no alpha — the ground is opaque everywhere
  // Each scanline is prefixed with filter type 0 (None). Filtering would shrink the
  // file, but these are flat fills that deflate to nothing regardless.
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

/**
 * @param size   canvas edge in pixels
 * @param inset  fraction of the canvas the mark shrinks into. 1 fills the canvas; a
 *               maskable icon uses 0.6 so nothing lands outside the safe zone a
 *               launcher may crop to a circle.
 */
function mark(size, inset) {
  const c = size / 2;
  const s = size * inset;
  const pageW = s * 0.46;
  const pageH = s * 0.62;
  const ruleW = s * 0.66;
  const ruleH = s * 0.055;
  const ruleY = c + s * 0.02;

  const inPage = (x, y) =>
    x >= c - pageW / 2 && x < c + pageW / 2 && y >= c - pageH / 2 && y < c + pageH / 2;
  const inRule = (x, y) =>
    x >= c - ruleW / 2 && x < c + ruleW / 2 && y >= ruleY && y < ruleY + ruleH;

  return (x, y) => {
    // Sample at the pixel centre so the two shapes meet cleanly at any size.
    const px = x + 0.5;
    const py = y + 0.5;
    if (inRule(px, py)) return OXBLOOD;
    if (inPage(px, py)) return BONE;
    return INK;
  };
}

const hex = ([r, g, b]) => `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;

function svg(size = 512, inset = 1) {
  const c = size / 2;
  const s = size * inset;
  const pageW = s * 0.46;
  const pageH = s * 0.62;
  const ruleW = s * 0.66;
  const ruleH = s * 0.055;
  const ruleY = c + s * 0.02;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="What a Pull">
  <rect width="${size}" height="${size}" fill="${hex(INK)}"/>
  <rect x="${c - pageW / 2}" y="${c - pageH / 2}" width="${pageW}" height="${pageH}" fill="${hex(BONE)}"/>
  <rect x="${c - ruleW / 2}" y="${ruleY}" width="${ruleW}" height="${ruleH}" fill="${hex(OXBLOOD)}"/>
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
