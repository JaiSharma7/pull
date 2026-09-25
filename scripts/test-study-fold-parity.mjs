#!/usr/bin/env node
/**
 * The SQL checks and the TypeScript normalizer must fold, match and count text alike.
 *
 * `normalizeStudyCourse` (supabase/functions/_shared/study.ts) decides at generation what
 * is malformed; `validate_study_course` and a reader's revision decide in SQL what may be
 * shown. When the two disagree, a question TypeScript kept is quarantined for no reason,
 * or a revision SQL accepts prints its own answer -- both happened. This compares
 *
 *   answerKey          with public.study_fold
 *   containsPhrase     with public.study_contains_phrase
 *   givesAwayIfPrinted with public.study_gives_away
 *
 * over every code point of the Basic Multilingual Plane that Postgres itself considers
 * assigned (so a newer Unicode in Node or Deno is not a difference), a sample of the astral
 * planes, and a curated set of cases the reviews found. `study_contains_phrase` reads more
 * loosely on purpose -- invisible format characters removed, look-alike letters folded --
 * and the curated cases that rely on that are marked.
 *
 * Read-only: every call is an IMMUTABLE function. Runs as part of `pnpm db:test`.
 */
import { execFileSync } from 'node:child_process';

const { answerKey, containsPhrase, givesAwayIfPrinted } =
  await import('../supabase/functions/_shared/study.ts');

const DB_URL =
  process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
if (!/@(127\.0\.0\.1|localhost):/.test(DB_URL) || /[?&]host=/.test(DB_URL)) {
  throw new Error(`refusing to run against ${DB_URL}: this test belongs on the local stack`);
}

function psql(sql) {
  return execFileSync('psql', [DB_URL, '-v', 'ON_ERROR_STOP=1', '-Atq', '-F', '|', '-c', sql], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
}

const hex = (s) => Buffer.from(s, 'utf8').toString('hex');
const failures = [];

// ------------------------------------------------------------ every assigned code point
const rows = psql(`
  select cp,
         encode(convert_to(public.study_fold('a' || chr(cp) || 'b'), 'UTF8'), 'hex'),
         public.study_contains_phrase('xyz' || chr(cp), 'xyz'),
         public.study_contains_phrase(chr(cp) || 'xyz', 'xyz'),
         public.study_gives_away(chr(cp) || chr(cp))
  from (select generate_series(1, 65535) as cp
        union all
        -- A sample of the astral planes: every seventh code point of planes 1 and 2
        -- (emoji, mathematical letters, Han extensions), and the Han Extension B start.
        select generate_series(65536, 196607, 7)
        union all select 134071) as points
  where cp not between 55296 and 57343 and unicode_assigned(chr(cp))`).split('\n');

for (const row of rows) {
  const [cpText, foldHex, after, before, givesAway] = row.split('|');
  const cp = Number(cpText);
  const c = String.fromCodePoint(cp);
  const label = `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
  if (hex(answerKey(`a${c}b`)) !== foldHex) failures.push(`${label} fold`);
  if (containsPhrase(`xyz${c}`, 'xyz') !== (after === 't')) failures.push(`${label} word end`);
  if (containsPhrase(`${c}xyz`, 'xyz') !== (before === 't')) failures.push(`${label} word start`);
  if (givesAwayIfPrinted(c + c) !== (givesAway === 't')) failures.push(`${label} give-away`);
}

// ------------------------------------------------------------ cases the reviews found
/** [text, phrase, expected in both, or `strict` when only SQL should find it] */
const phrases = [
  ['पदार्थ की तीन अवस्थाएँ हैं: ठोस, द्रव और गैस।', 'गैस', true],
  ['पौधों को क्या चाहिए? पानी।', 'पानी', true],
  ['তিনটি অবস্থা: কঠিন, তরল ও গ্যাস।', 'গ্যাস', true],
  ['वह अनुभवी शिक्षक है।', 'अनुभव', false],
  ['كتابٰ هنا', 'كتاب', false],
  ['mRNA的作用是什么', 'mrna', true],
  ['DNA𠮷野家', 'dna', true],
  ['DNAー', 'dna', false],
  ["the rest's role", 'rest', true],
  ['interesting', 'rest', false],
  ['what is C++ here', 'c++', true],
  ['In C every statement ends with a semicolon (;).', ';', true],
  ['Use ... to spread an array.', '...', true],
  ['No punctuation here', ';', false],
  ['The value is 1.5 exactly.', '1.5', true],
  ['The value is 15 exactly.', '1.5', false],
  ['Did rеstudying win?', 'restudying', 'strict'],
  ['Did re​studying win?', 'restudying', 'strict'],
];
const sqlPhrases = psql(
  `select public.study_contains_phrase(t, p) from (values ${phrases
    .map(([t, p], i) => `(${lit(t)}, ${lit(p)}, ${i})`)
    .join(', ')}) as v(t, p, i) order by i`,
).split('\n');
phrases.forEach(([text, phrase, expected], i) => {
  const ts = containsPhrase(text, phrase);
  const sql = sqlPhrases[i] === 't';
  if (expected === 'strict') {
    if (!sql) failures.push(`SQL does not find "${phrase}" in "${text}"`);
  } else if (ts !== expected || sql !== expected) {
    failures.push(`"${phrase}" in "${text}": TypeScript ${ts}, SQL ${sql}, expected ${expected}`);
  }
});

/** Answers that are punctuation, or look alike, must stay distinct and non-empty. */
const keys = [
  ';',
  '!',
  '...',
  '()',
  '~',
  '#',
  'ν',
  'v',
  'ρ',
  'p',
  'α',
  'a',
  '🧬🧪',
  '々々',
  '1.5',
  '15',
  '3.14',
  '31.4',
  'ΟΔΟΣ',
  'aΣ',
  'İ',
];
const sqlKeys = psql(
  `select encode(convert_to(public.study_fold(k), 'UTF8'), 'hex'), public.study_gives_away(k)
   from (values ${keys.map((k, i) => `(${lit(k)}, ${i})`).join(', ')}) as v(k, i) order by i`,
).split('\n');
keys.forEach((k, i) => {
  const [foldHex, givesAway] = sqlKeys[i].split('|');
  if (hex(answerKey(k)) !== foldHex) failures.push(`fold of "${k}"`);
  if (answerKey(k) === '') failures.push(`"${k}" folds to nothing`);
  if (givesAwayIfPrinted(k) !== (givesAway === 't')) failures.push(`give-away of "${k}"`);
});
// Folding must not depend on the collation the text arrives in: "C" does not lower-case.
const inC = psql(
  `select encode(convert_to(public.study_fold('ΟΔΟΣ İ' collate "C"), 'UTF8'), 'hex')`,
);
if (inC !== hex(answerKey('ΟΔΟΣ İ'))) failures.push('fold of text in collation "C"');

if (new Set(keys.map(answerKey)).size !== keys.length) {
  failures.push('two distinct answers fold to the same key');
}

function lit(s) {
  return `'${s.replaceAll("'", "''")}'`;
}

if (failures.length > 0) {
  console.error(`study fold parity: ${failures.length} differences`);
  for (const f of failures.slice(0, 40)) console.error(`  ${f}`);
  process.exit(1);
}
console.log(`study fold parity: ok (${rows.length} code points)`);
