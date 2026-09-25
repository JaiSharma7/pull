#!/usr/bin/env node
/**
 * The two character classes `study_contains_phrase` needs in SQL, generated from the same
 * Unicode properties `containsPhrase` in `supabase/functions/_shared/study.ts` uses:
 *
 *   word      \p{L}, \p{N} and \p{M} -- what continues a word in a spaced script
 *   unspaced  the scripts written without spaces (`UNSPACED_SCRIPT`)
 *   boundary  word and not unspaced: `continuesWord`, as one class a lookaround can use
 *   format    \p{Cf}: the invisible format characters the heuristics strip
 *
 * Postgres's own `[:alnum:]` and hand-written block ranges disagreed with JavaScript on
 * nearly a thousand code points -- whole Indic blocks, danda included, counted as letters.
 * Run `node scripts/study-unicode-classes.mjs` and paste the output into a migration when
 * either definition changes; `scripts/test-study-fold-parity.mjs` fails until it matches.
 */

const UNSPACED =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
const WORD = /[\p{L}\p{N}\p{M}]/u;

function ranges(test) {
  const out = [];
  let start = -1;
  for (let cp = 0; cp <= 0x10ffff; cp++) {
    const inside = !(cp >= 0xd800 && cp <= 0xdfff) && test(String.fromCodePoint(cp));
    if (inside && start < 0) start = cp;
    if (!inside && start >= 0) {
      out.push([start, cp - 1]);
      start = -1;
    }
  }
  if (start >= 0) out.push([start, 0x10ffff]);
  return out;
}

const esc = (cp) =>
  cp <= 0xffff
    ? `\\u${cp.toString(16).padStart(4, '0')}`
    : `\\U${cp.toString(16).padStart(8, '0')}`;

function sqlClass(list) {
  const body = list.map(([a, b]) => (a === b ? esc(a) : `${esc(a)}-${esc(b)}`)).join('');
  // Postgres literals, split so no line runs past a hundred characters.
  const chunks = body.match(/.{1,88}(?=\\|$)/g) ?? [];
  return chunks
    .map((c, i) => `  '${i === 0 ? '[' : ''}${c}${i === chunks.length - 1 ? ']' : ''}'`)
    .join('\n');
}

console.log('-- boundary');
console.log(sqlClass(ranges((c) => WORD.test(c) && !UNSPACED.test(c))));
console.log('-- format');
console.log(sqlClass(ranges((c) => /\p{Cf}/u.test(c))));
console.log('-- word');
console.log(sqlClass(ranges((c) => WORD.test(c))));
console.log('-- unspaced');
console.log(sqlClass(ranges((c) => UNSPACED.test(c))));
