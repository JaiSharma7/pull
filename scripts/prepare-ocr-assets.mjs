import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const modules = join(root, 'apps/web/node_modules');
const output = join(root, 'apps/web/public/ocr');

for (const [name, expected] of [
  ['tesseract.js', '7.0.0'],
  ['tesseract.js-core', '7.0.0'],
  ['@tesseract.js-data/eng', '1.0.0'],
]) {
  const manifest = JSON.parse(readFileSync(join(modules, name, 'package.json'), 'utf8'));
  if (manifest.version !== expected) {
    throw new Error(
      `OCR asset version changed for ${name}; inspect and update the local asset list`,
    );
  }
}

// This app explicitly uses the LSTM-only engine. Keep all three CPU feature
// variants so Tesseract selects the best supported core without a CDN fallback.
for (const [source, destination] of [
  ['tesseract.js/dist/worker.min.js', 'worker.min.js'],
  ['tesseract.js/dist/worker.min.js.LICENSE.txt', 'licenses/worker.LICENSE.txt'],
  ['tesseract.js/LICENSE.md', 'licenses/tesseract.LICENSE.md'],
  ['tesseract.js-core/LICENSE', 'licenses/core.LICENSE'],
  ['tesseract.js-core/tesseract-core-lstm.wasm.js', 'core/tesseract-core-lstm.wasm.js'],
  ['tesseract.js-core/tesseract-core-simd-lstm.wasm.js', 'core/tesseract-core-simd-lstm.wasm.js'],
  [
    'tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm.js',
    'core/tesseract-core-relaxedsimd-lstm.wasm.js',
  ],
  ['@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz', 'lang/eng.traineddata.gz'],
]) {
  const target = join(output, destination);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(join(modules, source), target);
}

console.log('Prepared pinned, first-party OCR assets.');
