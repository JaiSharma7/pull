#!/usr/bin/env node
/** Generate web artwork from the original, user-supplied PNGs. Run: node scripts/gen-icons.mjs */
import sharp from 'sharp';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const source = new URL('./assets/', import.meta.url);
const output = new URL('../apps/web/public/', import.meta.url);
await mkdir(new URL('brand/', output), { recursive: true });

// The supplied transparent canvases contain almost-invisible stray pixels. Crop by
// visible alpha bounds so that padding does not shrink the hat or wordmark on screen.
async function artwork(name) {
  const image = sharp(fileURLToPath(new URL(name, source))).ensureAlpha();
  const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
  let left = info.width,
    top = info.height,
    right = 0,
    bottom = 0;
  for (let y = 0; y < info.height; y++)
    for (let x = 0; x < info.width; x++) {
      if (data[(y * info.width + x) * 4 + 3] <= 8) continue;
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
  return image
    .extract({ left, top, width: right - left + 1, height: bottom - top + 1 })
    .png()
    .toBuffer();
}
const hat = await artwork('hat.png');
const wordmark = await artwork('wordmark.png');
await sharp(hat)
  .resize({ height: 512 })
  .toFile(fileURLToPath(new URL('brand/hat.png', output)));
const wordmarkInfo = await sharp(wordmark)
  .resize({ width: 1000 })
  .toFile(fileURLToPath(new URL('brand/wordmark.png', output)));
console.log(`Wordmark: ${wordmarkInfo.width} × ${wordmarkInfo.height}`);

async function icon(size, fraction = 0.84) {
  const mark = await sharp(hat)
    .resize({
      width: Math.round(size * fraction),
      height: Math.round(size * fraction),
      fit: 'inside',
    })
    .toBuffer();
  return sharp({ create: { width: size, height: size, channels: 4, background: '#f4f1ea' } })
    .composite([{ input: mark, gravity: 'centre' }])
    .png()
    .toBuffer();
}
for (const [name, size, fraction] of [
  ['icon-192.png', 192, 0.84],
  ['icon-512.png', 512, 0.84],
  ['icon-maskable-512.png', 512, 0.64],
  ['apple-touch-icon.png', 180, 0.84],
])
  await writeFile(new URL(name, output), await icon(size, fraction));
const favicon = Array.from(await icon(64), (byte) => '%' + byte.toString(16).padStart(2, '0')).join(
  '',
);
await writeFile(
  new URL('favicon.svg', output),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><image width="64" height="64" href="data:image/png,${favicon}"/></svg>\n`,
);
