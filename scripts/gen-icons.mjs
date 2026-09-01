#!/usr/bin/env node
/**
 * Generate the app icons into apps/web/public/.
 *
 * There is no rasteriser on a plain CI box and no image dependency in this repo, so the
 * PNGs are encoded here from a pixel buffer with nothing but `zlib`. Shapes are defined
 * analytically — two ellipses, a rectangle and a dome — and sampled per pixel, which is
 * all a mark this flat needs: no gradient, no shadow, one accent (design law 1).
 *
 * The mark: a magician's top hat in bone on an ink ground, with the band in oxblood.
 * The product is named for the thing pulled out of it, so the hat is the half you can
 * draw.
 *
 * The brim is the recognition cue and it is a *curve*, not a bar. A top hat is the one
 * common hat whose brim is dramatically wider than its crown and sweeps up at the ends,
 * and both halves of that read matter: the earlier mark drew the brim as a flat
 * rectangle and looked like a plinth. It is built here as the crescent left when one
 * ellipse is subtracted from the same ellipse lifted above it — which gives the deep
 * sweep at the centre and the two raised tips for free, and is exactly one expression
 * in both the raster and the vector path.
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
 * The hat's geometry, shared by the raster and vector paths so they cannot drift.
 *
 * Mirrored in `packages/ui/src/components/Mark.tsx`, which draws the same hat in the
 * masthead, and pinned against the generated `favicon.svg` by `Mark.test.ts`: the tab
 * and the top bar showing two different hats is the one failure worth a test here.
 *
 * @param size   canvas edge in pixels
 * @param inset  fraction of the canvas the mark shrinks into. 1 fills the canvas; a
 *               maskable icon uses 0.6 so nothing lands outside the safe zone a
 *               launcher may crop to a circle.
 */
function hat(size, inset) {
  const c = size / 2;
  const s = size * inset;

  /*
   * Proportioned for 16px first, because that is where this mark is actually read.
   *
   * Three numbers carry the silhouette:
   *
   * - **The lit crown is 1.35:1 tall.** The band sits at the base of the crown, so the
   *   lit part is what the eye measures; at 1:1 it reads as a pale box with a red
   *   underline rather than as a hat.
   * - **The brim is over three times the crown's width**, which is the contrast that
   *   says *top* hat rather than any other hat.
   * - **The brim's sweep (`brimLift`) is three quarters of its depth (`brimRy`)**, which is
   *   what raises the tips clear of the crown's foot. Flatten that ratio and the
   *   crescent closes back into the bar this replaced.
   *
   * Anything changed here wants re-rendering at 16px and looking at, not reasoning
   * about; this script is fast to re-run.
   */
  const crownW = s * 0.3;
  const capRy = s * 0.048; // the dome on the crown, barely there at 16px and right at 512
  const bandH = s * 0.09;
  const brimRx = s * 0.46;
  const brimRy = s * 0.175;
  const brimLift = s * 0.132;
  const litH = crownW * 1.35;

  /*
   * Vertical placement is solved, not nudged: the silhouette's top (the crown's dome)
   * and its bottom (the brim's lowest point) are placed symmetrically about the centre,
   * so the mark is optically centred at every inset without a fudge factor.
   */
  const brimCy = c - brimRy + (brimLift + bandH + litH) / 2;
  const bandBottom = brimCy + brimRy - brimLift; // the brim's top edge at the centre
  const bandTop = bandBottom - bandH;
  const crownTop = bandTop - litH;

  /*
   * Where the two ellipse edges cross: the crescent's tips, raised `brimLift / 2` above
   * the brim's centre line. Derived rather than chosen, so the vector path lands on the
   * same two points the pixel test does.
   */
  const m = brimLift / (2 * brimRy);
  const tipX = brimRx * Math.sqrt(1 - m * m);
  const tipY = brimCy - brimRy * m;

  /*
   * The crown's foot, which nobody sees: it stops just inside the brim's lower edge
   * measured at the crown's own width, so the two shapes join into one silhouette with
   * neither a seam between them nor a spill below.
   */
  const kCrown = Math.sqrt(1 - (crownW / 2 / brimRx) ** 2);
  const crownBottom = brimCy + brimRy * kCrown * 0.9;

  return {
    c,
    crownW,
    capRy,
    crownTop,
    crownBottom,
    bandTop,
    bandH,
    brimCy,
    brimRx,
    brimRy,
    brimLift,
    tipX,
    tipY,
  };
}

const inEllipse = (px, py, cx, cy, rx, ry) => ((px - cx) / rx) ** 2 + ((py - cy) / ry) ** 2 <= 1;

/** Flat colour at a point. Later shapes win, so this reads in reverse paint order. */
function shade(h) {
  return (px, py) => {
    // The brim last, over the crown's foot and the band's lower corners.
    if (
      inEllipse(px, py, h.c, h.brimCy, h.brimRx, h.brimRy) &&
      !inEllipse(px, py, h.c, h.brimCy - h.brimLift, h.brimRx, h.brimRy)
    )
      return BONE;
    const inCrownW = px >= h.c - h.crownW / 2 && px < h.c + h.crownW / 2;
    if (inCrownW && py >= h.bandTop && py < h.bandTop + h.bandH) return OXBLOOD;
    if (inCrownW && py >= h.crownTop + h.capRy && py < h.crownBottom) return BONE;
    if (inEllipse(px, py, h.c, h.crownTop + h.capRy, h.crownW / 2, h.capRy)) return BONE;
    return INK;
  };
}

/**
 * @param size   canvas edge in pixels
 * @param inset  see `hat`
 *
 * Sampled 4×4 per pixel and averaged. The mark is curved now, and a single sample at
 * the pixel centre gave the brim a staircase edge at 192px and dropped its tips
 * entirely at 32px. Averaging flat fills is antialiasing, not shading: no pixel here is
 * part of a gradient, it is part of an edge.
 */
function mark(size, inset) {
  const at = shade(hat(size, inset));
  const STEPS = 4;
  return (x, y) => {
    let r = 0;
    let g = 0;
    let b = 0;
    for (let sy = 0; sy < STEPS; sy++) {
      for (let sx = 0; sx < STEPS; sx++) {
        const [pr, pg, pb] = at(x + (sx + 0.5) / STEPS, y + (sy + 0.5) / STEPS);
        r += pr;
        g += pg;
        b += pb;
      }
    }
    const n = STEPS * STEPS;
    return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
  };
}

const hex = ([r, g, b]) => `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
const n = (v) => Number(v.toFixed(2));

/**
 * The brim, as one closed path: along the outer ellipse's lower edge from the left tip
 * to the right, then back along the lifted ellipse's lower edge.
 *
 * Both arcs sweep through the bottom of their ellipse, which is what the flags say: the
 * first runs against the angle (sweep 0) and spans more than half the ellipse
 * (large-arc 1); the return runs with it (sweep 1) and spans less (large-arc 0).
 */
function brimPath(h) {
  return (
    `M ${n(h.c - h.tipX)} ${n(h.tipY)} ` +
    `A ${n(h.brimRx)} ${n(h.brimRy)} 0 1 0 ${n(h.c + h.tipX)} ${n(h.tipY)} ` +
    `A ${n(h.brimRx)} ${n(h.brimRy)} 0 0 1 ${n(h.c - h.tipX)} ${n(h.tipY)} Z`
  );
}

function svg(size = 512, inset = 1) {
  const h = hat(size, inset);
  // Same order as `shade` reads in reverse: crown, dome, band, then the brim over both.
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="What a Pull">
  <rect width="${size}" height="${size}" fill="${hex(INK)}"/>
  <rect x="${n(h.c - h.crownW / 2)}" y="${n(h.crownTop + h.capRy)}" width="${n(h.crownW)}" height="${n(h.crownBottom - h.crownTop - h.capRy)}" fill="${hex(BONE)}"/>
  <ellipse cx="${n(h.c)}" cy="${n(h.crownTop + h.capRy)}" rx="${n(h.crownW / 2)}" ry="${n(h.capRy)}" fill="${hex(BONE)}"/>
  <rect x="${n(h.c - h.crownW / 2)}" y="${n(h.bandTop)}" width="${n(h.crownW)}" height="${n(h.bandH)}" fill="${hex(OXBLOOD)}"/>
  <path d="${brimPath(h)}" fill="${hex(BONE)}"/>
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
