#!/usr/bin/env node
/**
 * Generate the app icons into apps/web/public/.
 *
 * There is no rasteriser on a plain CI box and no image dependency in this repo, so the
 * PNGs are encoded here from a pixel buffer with nothing but `zlib`. That is only
 * tolerable because the mark is deliberately geometric — flat fills, one accent, no
 * gradient (design law 1) — which is exactly what The Archive calls for anyway.
 *
 * The mark: a magician's top hat in bone on an ink ground, with the band in oxblood.
 * The product is named for the thing pulled out of it, so the hat is the half you can
 * draw — three flat bars, no curves, which is what keeps it legible at 16px and what
 * lets it be encoded here without a rasteriser.
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
/**
 * The hat's geometry, shared by the raster and vector paths so they cannot drift.
 *
 * Extents are symmetric about the centre (-0.245s to +0.245s) so the mark is optically
 * centred without a fudge factor: the brim is the heavy end, and letting it sit lower
 * than the crown is what makes a hat read as standing rather than floating.
 */
function hat(size, inset) {
  const c = size / 2;
  const s = size * inset;
  /*
   * Proportioned for 16px first, because that is where this mark is actually read.
   *
   * The previous numbers were reasonable on paper and failed in the browser tab. The
   * band sits at the base of the crown, so the *lit* part of the crown is what the eye
   * measures — and at 0.38w × (0.46 − 0.085)h that part was 1.01:1. A square. Rendered
   * at 16, 24 and 32px it read as a pale box with a red underline; nobody looking at it
   * saw a hat, which is the only thing a mark has to do.
   *
   * Two numbers carry the silhouette, and both are pushed:
   *
   * - **The lit crown is 1.40:1 tall**, not square. Height came up and width went down,
   *   because narrowing does more for the read than heightening at the same pixel cost.
   * - **The brim is 2.5× the crown's width and half again as thick.** A top hat is the
   *   only common hat whose brim is dramatically wider than its crown, so that contrast
   *   is the whole recognition cue — and at 16px the old 0.09s brim landed on 1.4 device
   *   pixels and antialiased itself into nothing.
   *
   * Extents stay symmetric about the centre. Anything changed here wants re-rendering at
   * 16px and looking at, not reasoning about; `scripts/gen-icons.mjs` is fast to re-run.
   */
  const crownW = s * 0.33;
  const crownTop = c - s * 0.33;
  const crownH = s * 0.54;
  const bandH = s * 0.078;
  const bandTop = crownTop + crownH - bandH;
  const brimW = s * 0.83;
  const brimTop = crownTop + crownH;
  const brimH = s * 0.125;
  return { c, crownW, crownTop, crownH, bandH, bandTop, brimW, brimTop, brimH };
}

function mark(size, inset) {
  const h = hat(size, inset);

  const inBox = (x, y, w, top, height) =>
    x >= h.c - w / 2 && x < h.c + w / 2 && y >= top && y < top + height;

  return (x, y) => {
    // Sample at the pixel centre so the shapes meet cleanly at any size.
    const px = x + 0.5;
    const py = y + 0.5;
    // Band before crown: it is drawn over the crown's lower edge, so it has to win.
    if (inBox(px, py, h.crownW, h.bandTop, h.bandH)) return OXBLOOD;
    if (inBox(px, py, h.crownW, h.crownTop, h.crownH)) return BONE;
    if (inBox(px, py, h.brimW, h.brimTop, h.brimH)) return BONE;
    return INK;
  };
}

const hex = ([r, g, b]) => `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;

function svg(size = 512, inset = 1) {
  const h = hat(size, inset);
  // Same order as `mark`: crown, then brim, then the band over the crown's lower edge.
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="What a Pull">
  <rect width="${size}" height="${size}" fill="${hex(INK)}"/>
  <rect x="${h.c - h.crownW / 2}" y="${h.crownTop}" width="${h.crownW}" height="${h.crownH}" fill="${hex(BONE)}"/>
  <rect x="${h.c - h.brimW / 2}" y="${h.brimTop}" width="${h.brimW}" height="${h.brimH}" fill="${hex(BONE)}"/>
  <rect x="${h.c - h.crownW / 2}" y="${h.bandTop}" width="${h.crownW}" height="${h.bandH}" fill="${hex(OXBLOOD)}"/>
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
