#!/usr/bin/env node
/**
 * The browser grades a study answer so feedback does not wait on the network, and the
 * server grades it again to decide what is recorded. They must agree, or a reader is told
 * one thing and credited with another. This holds `gradeStudyResponse`
 * (apps/web/src/lib/study-grade.ts) to `public.study_grade_response` over every kind, a set
 * of responses built to reach every branch -- case and punctuation, width, length in code
 * points, positions that are and are not a permutation, a self-grade given and missing --
 * and the web's `studyFold` to the functions' `answerKey`, which test-study-fold-parity.mjs
 * holds to `study_fold`.
 *
 * Read-only: `study_grade_response` is IMMUTABLE. Runs as part of `pnpm db:test`.
 */
import { execFileSync } from 'node:child_process';

const { answerKey } = await import('../supabase/functions/_shared/study.ts');
const { gradeStudyResponse, studyFold } = await import('../apps/web/src/lib/study-grade.ts');

const DB_URL =
  process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
// Loopback only. psql is handed the parsed parts, never the URL, and no PG* variable but the
// password, so nothing libpq would read on its own -- a query parameter, a fragment, a
// second host, PGHOSTADDR or PGSERVICE -- can point it elsewhere; and no command line or
// error it prints carries the password.
const target = (() => {
  try {
    return new URL(DB_URL);
  } catch {
    return null;
  }
})();
const simple = /^[A-Za-z0-9_]+$/;
const database = target ? decodeURIComponent(target.pathname.slice(1)) : '';
const user = target ? decodeURIComponent(target.username) : '';
if (
  !target ||
  !/^postgres(ql)?:$/.test(target.protocol) ||
  !['127.0.0.1', 'localhost'].includes(target.hostname) ||
  !simple.test(database) ||
  !simple.test(user)
) {
  const shown = target ? `${target.protocol}//${target.host}${target.pathname}` : 'that URL';
  throw new Error(`refusing to run against ${shown}: this test belongs on the local stack`);
}
const connection = ['-h', target.hostname, '-p', target.port || '5432', '-U', user, '-d', database];
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('PG')));
env.PGPASSWORD = decodeURIComponent(target.password);

// The query goes in on stdin: the responses include kilobyte strings, too long for argv.
function psql(sql) {
  return execFileSync('psql', [...connection, '-v', 'ON_ERROR_STOP=1', '-Atq', '-F', '|'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env,
    input: sql,
  }).trim();
}

const failures = [];

// ------------------------------------------------------------ the web's fold
// `answerKey` is held to `study_fold` over every assigned code point by
// test-study-fold-parity.mjs; the web's copy is held to `answerKey` over the same range,
// so all three fold alike.
for (let cp = 1; cp <= 0x2ffff; cp += cp < 0x10000 ? 1 : 7) {
  if (cp >= 0xd800 && cp <= 0xdfff) continue;
  const text = `a${String.fromCodePoint(cp)}b`;
  if (studyFold(text) !== answerKey(text)) {
    failures.push(`U+${cp.toString(16).toUpperCase().padStart(4, '0')} web fold`);
  }
}
for (const text of ['', ';', '...', ' C++ ', '1.5', '1,000', "don't", 'ΣΊΣΥΦΟΣ', 'İstanbul']) {
  if (studyFold(text) !== answerKey(text)) failures.push(`web fold ${JSON.stringify(text)}`);
}

// ------------------------------------------------------------ the grading rule
const choice = {
  answer: 'The recall test group',
  acceptedAnswers: [],
  distractors: [
    { text: 'The restudy group', why: 'Only at five minutes.' },
    { text: 'Neither group', why: 'The note reports a difference.' },
  ],
  sequence: [],
  pairs: [],
};
const typed = {
  answer: 'restudying',
  acceptedAnswers: ['restudy', 'rereading'],
  distractors: [],
  sequence: [],
  pairs: [],
};
const ordering = { ...typed, sequence: ['read', 'practise', 'test'], acceptedAnswers: [] };
const matching = {
  ...typed,
  acceptedAnswers: [],
  pairs: [
    { left: 'Five minutes', right: 'Restudy' },
    { left: 'One week', right: 'Recall test' },
    { left: 'One month', right: 'Recall test, still' },
  ],
};

const texts = [
  'The recall test group',
  'the RECALL test group.',
  'The restudy group',
  'Neither group',
  'Paris',
  '',
  ' ',
  'restudying',
  'Restudying!',
  'restudy',
  'Rereading',
  're-reading',
  'ｒｅｓｔｕｄｙｉｎｇ',
  'restudying'.repeat(101),
  'x'.repeat(1000),
  'x'.repeat(1001),
  '😀'.repeat(1000),
  '😀'.repeat(1001),
  ';',
];
const positions = [
  [0, 1, 2],
  [1, 0, 2],
  [2, 1, 0],
  [0, 0, 1],
  [0, 1],
  [0, 1, 3],
  [-1, 0, 1],
  [0, 1, 2, 3],
  [],
];

const cases = [];
for (const kind of ['multiple_choice', 'comparison', 'application']) {
  for (const r of [...texts, [0, 1, 2]]) cases.push({ q: { kind, ...choice }, r, self: null });
}
for (const kind of ['cloze', 'short_recall']) {
  for (const r of [...texts, [0, 1, 2]]) {
    for (const self of [null, 'correct', 'incorrect'])
      cases.push({ q: { kind, ...typed }, r, self });
  }
}
for (const r of [...positions, 'read'])
  cases.push({ q: { kind: 'ordering', ...ordering }, r, self: null });
for (const r of [...positions, 'Restudy'])
  cases.push({ q: { kind: 'matching', ...matching }, r, self: null });

const payload = JSON.stringify(
  cases.map(({ q, r, self }) => ({
    kind: q.kind,
    answer: q.answer,
    accepted: q.acceptedAnswers,
    distractors: q.distractors,
    sequence: q.sequence,
    pairs: q.pairs,
    response: r,
    self,
  })),
);
const sqlResults = JSON.parse(
  psql(`
    select coalesce(jsonb_agg(public.study_grade_response(
             c ->> 'kind', c ->> 'answer',
             array(select jsonb_array_elements_text(c -> 'accepted')),
             c -> 'distractors',
             array(select jsonb_array_elements_text(c -> 'sequence')),
             c -> 'pairs', c -> 'response', c ->> 'self') order by ord), '[]')
    from jsonb_array_elements($json$${payload}$json$::jsonb) with ordinality as x(c, ord);`),
);

cases.forEach(({ q, r, self }, i) => {
  const mine = gradeStudyResponse(q, r, self);
  const theirs = sqlResults[i];
  if (JSON.stringify(mine) !== JSON.stringify(theirs)) {
    failures.push(
      `${q.kind} ${JSON.stringify(r).slice(0, 40)} self=${self}: web ${JSON.stringify(mine)} sql ${JSON.stringify(theirs)}`,
    );
  }
});

if (failures.length > 0) {
  console.error(`study grade parity: ${failures.length} differences`);
  for (const f of failures.slice(0, 40)) console.error(`  ${f}`);
  process.exit(1);
}
console.log(`study grade parity: ok (${cases.length} responses)`);
