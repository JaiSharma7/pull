import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { geminiConfigFrom } from './config.ts';
import { createGeminiStructuredProvider } from './structured.ts';
import {
  answerKey,
  buildClaimIndex,
  CLAIM_KINDS,
  QUESTION_KINDS,
  QUESTION_PURPOSES,
  claimsDigest,
  cleanQuote,
  codePointIndexer,
  normalizeStudyCourse,
  pageIndexer,
  planWindows,
  promptVersion,
  resolveQuote,
  selectAssemblyClaims,
  stageCacheKey,
  STUDY_LIMITS,
  type ClaimRow,
  type ExtractionRecord,
  type StudySourceText,
} from './study.ts';

// A self-authored note about a published finding (law 4): the worked example in
// docs/study-generation.md.
const NOTE = [
  'Roediger and Karpicke (2006) had students read short prose passages.',
  'After reading, one group studied the passage again and another took a recall test on it without feedback.',
  'On a final test five minutes later, the group that restudied remembered more.',
  'On final tests two days and one week later, the group that had taken the recall test remembered more.',
  'These results come from the reported conditions with college students and prose passages.',
].join(' ');

const source = (over: Partial<StudySourceText> = {}): StudySourceText => ({
  versionId: '00000000-0000-4000-8000-000000000001',
  position: 1,
  title: 'My notes on the testing effect',
  format: 'paste',
  text: NOTE,
  ...over,
});

const provenance = {
  promptHash: 'a'.repeat(64),
  schemaHash: 'b'.repeat(64),
  model: 'm',
  providerCallId: null,
};

function extraction(src: StudySourceText, claims: unknown[]): ExtractionRecord {
  return {
    cacheId: 'cache-1',
    window: { versionId: src.versionId, position: src.position, start: 0, end: src.text.length },
    output: { claims, gaps: [] },
    provenance,
  };
}

describe('planWindows', () => {
  it('keeps a short version in one window', () => {
    expect(planWindows([source()])).toEqual([
      { versionId: source().versionId, position: 1, start: 0, end: NOTE.length },
    ]);
  });

  it('cuts a long version at paragraph breaks, covering every character once', () => {
    const paragraph = 'A sentence that is long enough to count. '.repeat(40);
    const text = Array.from({ length: 40 }, () => paragraph).join('\n\n');
    const windows = planWindows([source({ text })]);
    expect(windows.length).toBeGreaterThan(1);
    expect(windows[0]?.start).toBe(0);
    expect(windows.at(-1)?.end).toBe(text.length);
    for (let i = 1; i < windows.length; i++) {
      expect(windows[i]?.start).toBe(windows[i - 1]?.end);
    }
    for (const w of windows.slice(0, -1)) {
      expect(w.end - w.start).toBeLessThanOrEqual(STUDY_LIMITS.windowChars);
      expect(w.end - w.start).toBeGreaterThanOrEqual(
        STUDY_LIMITS.windowChars * STUDY_LIMITS.minWindowShare,
      );
      expect(text.slice(w.end - 2, w.end)).toBe('\n\n');
    }
  });

  it('never splits a surrogate pair on a hard cut', () => {
    const text = '\u{1F600}'.repeat(40_000);
    for (const w of planWindows([source({ text })])) {
      expect(text.charCodeAt(w.start)).toBe(0xd83d);
    }
  });

  it('stays within the window ceiling at the source limits', () => {
    const text = 'x'.repeat(40_000);
    const five = [1, 2, 3, 4, 5].map((position) =>
      source({ versionId: `v${position}`, position, text }),
    );
    expect(planWindows(five).length).toBeLessThanOrEqual(STUDY_LIMITS.maxWindows);
  });
});

describe('resolveQuote', () => {
  it('finds an exact quote', () => {
    const quote = 'the group that restudied remembered more';
    const span = resolveQuote(NOTE, quote);
    expect(span?.match).toBe('exact');
    expect(NOTE.slice(span?.start, span?.end)).toBe(quote);
  });

  it('folds whitespace, curly quotes, dashes and case, and maps back to the original span', () => {
    const text = 'He said “retrieval practice   helps” — at one week.';
    const span = resolveQuote(text, '"Retrieval practice helps" - at one week');
    expect(span?.match).toBe('normalized');
    // The model's wrapping quotation mark is stripped before the search, so the span
    // starts at the first word; the closing mark inside the quote is kept.
    expect(text.slice(span?.start, span?.end)).toBe('retrieval practice   helps” — at one week');
  });

  it('strips wrapping quotation marks and ellipses a model adds', () => {
    expect(cleanQuote('  "…the group that restudied..."  ')).toBe('the group that restudied');
  });

  it('refuses a quote too short to prove anything, and one that is not there', () => {
    expect(resolveQuote(NOTE, 'the')).toBeNull();
    expect(resolveQuote(NOTE, 'retrieval works better for everyone')).toBeNull();
  });

  it('prefers the window the claim came from', () => {
    const text = 'repeated phrase here. ' + 'x'.repeat(100) + ' repeated phrase here.';
    const second = text.lastIndexOf('repeated');
    const span = resolveQuote(text, 'repeated phrase here', { start: second, end: text.length });
    expect(span?.start).toBe(second);
  });
});

describe('offsets and pages', () => {
  it('counts code points, the unit Postgres substr uses', () => {
    const text = 'a\u{1F600}b';
    const at = codePointIndexer(text);
    expect(at(0)).toBe(0);
    expect(at(1)).toBe(1);
    expect(at(3)).toBe(2); // after the pair
    expect(at(4)).toBe(3);
    expect(codePointIndexer('plain')(3)).toBe(3);
  });

  it('reads PDF page markers, and only for PDF formats', () => {
    const text = 'Page 1\nFirst page text.\n\nPage 2\nSecond page text here.';
    const pageOf = pageIndexer('pdf', text);
    expect(pageOf(text.indexOf('First'))).toBe(1);
    expect(pageOf(text.indexOf('Second'))).toBe(2);
    expect(pageIndexer('paste', text)(text.indexOf('Second'))).toBeNull();
  });
});

describe('buildClaimIndex', () => {
  it('keys claims by source, resolves evidence, and rejects claims whose evidence is not in the text', () => {
    const src = source();
    const claims = buildClaimIndex(
      [src],
      [
        extraction(src, [
          {
            key: 'c1',
            statement: 'At five minutes, restudying produced better recall.',
            kind: 'finding',
            qualifications: ['final test five minutes later'],
            evidence: [
              'On a final test five minutes later, the group that restudied remembered more.',
            ],
            attribution: 'Roediger and Karpicke (2006)',
          },
          {
            key: 'c2',
            statement: 'Retrieval practice works for every learner.',
            kind: 'finding',
            qualifications: [],
            evidence: ['retrieval practice works for every learner'],
            attribution: null,
          },
        ]),
      ],
    );
    expect(claims.map((c) => c.key)).toEqual(['s1c1', 's1c2']);
    const [grounded, invented] = claims as [ClaimRow, ClaimRow];
    expect(grounded.status).toBe('draft');
    expect(grounded.evidence[0]?.match).toBe('exact');
    expect(grounded.evidence[0]?.spanText).toBe(
      'On a final test five minutes later, the group that restudied remembered more.',
    );
    expect(grounded.qualifications).toEqual(['final test five minutes later']);
    expect(invented.status).toBe('rejected');
    expect(invented.rejectionReasons).toEqual(['evidence_missing']);
    expect(invented.evidence[0]).toMatchObject({
      match: 'unresolved',
      start: null,
      spanText: null,
    });
  });

  it('persists code-point offsets that slice the stored text back to the span', () => {
    const text = '\u{1F4D6} Notes. The spaced group remembered more after a week.';
    const src = source({ text });
    const [claim] = buildClaimIndex(
      [src],
      [
        extraction(src, [
          {
            key: 'c1',
            statement: 'Spacing helped at a week.',
            kind: 'finding',
            qualifications: [],
            evidence: ['The spaced group remembered more after a week.'],
            attribution: null,
          },
        ]),
      ],
    );
    const ev = claim?.evidence[0];
    // What `persist_study_course` checks: substr(text, start + 1, end - start).
    expect([...text].slice(ev?.start ?? 0, ev?.end ?? 0).join('')).toBe(ev?.spanText);
    expect(ev?.start).toBe(text.indexOf('The') - 1);
  });

  it('keeps an unknown kind as a finding rather than failing the insert', () => {
    const src = source();
    const [claim] = buildClaimIndex(
      [src],
      [
        extraction(src, [
          {
            key: 'c1',
            statement: 'x'.repeat(30),
            kind: 'opinion',
            qualifications: [],
            evidence: ['the group that restudied remembered more'],
            attribution: null,
          },
        ]),
      ],
    );
    expect(claim?.kind).toBe('finding');
  });
});

function claimRow(key: string, status: 'draft' | 'rejected' = 'draft'): ClaimRow {
  return {
    key,
    sourceVersionId: 'v',
    position: 1,
    sourceTitle: 'T',
    kind: 'finding',
    statement: `Statement ${key}`,
    qualifications: [],
    attribution: null,
    evidence: [
      { modelQuote: 'q', spanText: `span ${key}`, start: 0, end: 5, page: null, match: 'exact' },
    ],
    status,
    rejectionReasons: status === 'rejected' ? ['evidence_missing'] : [],
    provenance,
  };
}

describe('selectAssemblyClaims and the digest', () => {
  it('shows only grounded claims', () => {
    expect(
      selectAssemblyClaims([claimRow('s1c1'), claimRow('s1c2', 'rejected')]).map((c) => c.key),
    ).toEqual(['s1c1']);
  });

  it('spreads across the material when over the cap, deterministically', () => {
    const many = Array.from({ length: 300 }, (_, i) => claimRow(`s1c${i + 1}`));
    const picked = selectAssemblyClaims(many);
    expect(picked).toHaveLength(STUDY_LIMITS.maxAssemblyClaims);
    expect(picked[0]?.key).toBe('s1c1');
    expect(Number(picked.at(-1)?.key.slice(3))).toBeGreaterThan(290);
    expect(selectAssemblyClaims(many)).toEqual(picked);
  });

  it('carries keys, attribution, qualifications and the resolved span, not the model quote', () => {
    const digest = claimsDigest([
      { ...claimRow('s2c4'), qualifications: ['one week'], attribution: 'Memo B', position: 2 },
    ]);
    expect(digest).toBe(
      '[s2c4] (Source 2: T) Statement s2c4 Qualifications: one week. Attributed to: Memo B. Evidence: "span s2c4"',
    );
  });
});

describe('normalizeStudyCourse', () => {
  const shown = ['s1c1', 's1c2', 's1c3'].map((k) => claimRow(k));
  const base = {
    title: 'Testing effect',
    overview: 'Overview.',
    objectives: ['Explain the timing contrast.'],
    recap: 'Recap.',
    disagreements: [],
    withheld: [
      { prompt: 'Does retrieval work better for everyone?', reason: 'The note tested one group.' },
    ],
  };
  const lesson = {
    key: 'intro',
    title: 'Immediate versus delayed',
    objective: 'Contrast the two results.',
    claimKeys: ['s1c1', 's1c2', 'nope'],
    explanation: 'Explanation.',
    example: null,
    recap: 'Restudy wins at five minutes; retrieval wins later.',
    minutes: 9,
  };
  const q = (over: Record<string, unknown>) => ({
    key: 'x',
    lessonKey: 'intro',
    purpose: 'practice',
    kind: 'multiple_choice',
    claimKeys: ['s1c1'],
    prompt: 'Which group remembered more at five minutes?',
    answer: 'The restudy group',
    acceptedAnswers: [],
    distractors: [
      { distractor: 'The recall-test group', why: 'Reverses the immediate result.' },
      { distractor: 'Neither group', why: 'The note reports a difference.' },
    ],
    cloze: null,
    sequence: [],
    pairs: [],
    explanation: 'The note says so.',
    difficulty: 2,
    ...over,
  });

  it('re-keys lessons and questions, maps lesson references, clamps numbers and drops unknown claims', () => {
    const out = normalizeStudyCourse(
      { ...base, units: [{ title: 'Unit', lessons: [lesson] }], questions: [q({})] },
      shown,
    );
    expect(out.lessons).toHaveLength(1);
    expect(out.lessons[0]).toMatchObject({
      key: 'l1',
      position: 1,
      unitNo: 1,
      minutes: 5,
      claimKeys: ['s1c1', 's1c2'],
      status: 'draft',
    });
    expect(out.items[0]).toMatchObject({ key: 'q1', lessonKey: 'l1', status: 'draft' });
    expect(out.items[0]?.distractors).toEqual([
      { text: 'The recall-test group', why: 'Reverses the immediate result.' },
      { text: 'Neither group', why: 'The note reports a difference.' },
    ]);
    expect(out.course.withheld).toEqual(base.withheld);
  });

  it.each([
    ['a question citing no claim it was shown', q({ claimKeys: ['s9c9'] }), 'no_known_claims'],
    [
      'a choice question with one wrong option',
      q({ distractors: [{ distractor: 'Neither', why: 'w' }] }),
      'too_few_distractors',
    ],
    [
      'a distractor that is the answer',
      q({
        distractors: [
          { distractor: 'the restudy group.', why: 'w' },
          { distractor: 'Neither', why: 'w' },
        ],
      }),
      'distractor_matches_answer',
    ],
    [
      'duplicate options',
      q({
        distractors: [
          { distractor: 'Neither', why: 'w' },
          { distractor: 'neither', why: 'w' },
        ],
      }),
      'duplicate_options',
    ],
    [
      'a cloze with no blank',
      q({ kind: 'cloze', cloze: 'No blank here.', answer: 'restudy', distractors: [] }),
      'cloze_malformed',
    ],
    [
      'a cloze that prints its answer',
      q({
        kind: 'cloze',
        cloze: 'The restudy group did ____ at five minutes, restudy.',
        answer: 'restudy',
        distractors: [],
      }),
      'answer_in_prompt',
    ],
    [
      'an ordering of two',
      q({ kind: 'ordering', sequence: ['a', 'b'], distractors: [] }),
      'ordering_malformed',
    ],
    [
      'a matching with a repeated side',
      q({
        kind: 'matching',
        pairs: [
          { left: 'a', right: 'x' },
          { left: 'a', right: 'y' },
        ],
        distractors: [],
      }),
      'matching_malformed',
    ],
    [
      'a prompt that gives away a short answer',
      q({
        kind: 'short_recall',
        prompt: 'Did the restudy group win?',
        answer: 'restudy group',
        distractors: [],
      }),
      'answer_in_prompt',
    ],
  ])('keeps %s as rejected, with the reason', (_label, question, reason) => {
    const out = normalizeStudyCourse(
      { ...base, units: [{ title: 'Unit', lessons: [lesson] }], questions: [question] },
      shown,
    );
    expect(out.items[0]?.status).toBe('rejected');
    expect(out.items[0]?.rejectionReasons).toContain(reason);
  });

  it('accepts well-formed ordering, matching, cloze and short recall', () => {
    const out = normalizeStudyCourse(
      {
        ...base,
        units: [{ title: 'Unit', lessons: [lesson] }],
        questions: [
          q({
            kind: 'ordering',
            sequence: ['read', 'restudy or test', 'final test'],
            distractors: [],
          }),
          q({
            kind: 'matching',
            pairs: [
              { left: '5 minutes', right: 'restudy' },
              { left: '1 week', right: 'retrieval' },
            ],
            distractors: [],
          }),
          q({
            kind: 'cloze',
            cloze: 'At one week, the ____ group remembered more.',
            answer: 'retrieval',
            acceptedAnswers: ['recall-test'],
            distractors: [],
          }),
          q({
            kind: 'short_recall',
            purpose: 'review',
            prompt: 'State the delayed-test result.',
            answer: 'Prior retrieval produced better recall at two days and one week.',
            distractors: [],
          }),
        ],
      },
      shown,
    );
    expect(out.items.map((i) => [i.kind, i.status])).toEqual([
      ['ordering', 'draft'],
      ['matching', 'draft'],
      ['cloze', 'draft'],
      ['short_recall', 'draft'],
    ]);
    // Fields that do not belong to a kind are cleared rather than stored.
    expect(out.items[0]?.distractors).toEqual([]);
    expect(out.items[2]?.acceptedAnswers).toEqual(['recall-test']);
  });

  it('drops what it cannot store at all, and counts it', () => {
    const out = normalizeStudyCourse(
      {
        ...base,
        units: [{ title: 'Unit', lessons: [lesson, { ...lesson, title: '' }] }],
        questions: [q({ prompt: '' }), q({ kind: 'essay' })],
      },
      shown,
    );
    expect(out.dropped).toEqual({ lessons: 1, items: 2 });
  });

  it('marks overlong text rejected rather than silently truncating it', () => {
    const out = normalizeStudyCourse(
      {
        ...base,
        units: [{ title: 'Unit', lessons: [lesson] }],
        questions: [q({ explanation: 'x'.repeat(2500) })],
      },
      shown,
    );
    expect(out.items[0]?.explanation).toHaveLength(2000);
    expect(out.items[0]?.rejectionReasons).toContain('too_long');
  });

  it('keeps only disagreements that cite two known claims', () => {
    const out = normalizeStudyCourse(
      {
        ...base,
        units: [],
        questions: [],
        disagreements: [
          { claimKeys: ['s1c1', 's1c2'], description: 'Memo A says 9:00; Memo B says 9:30.' },
          { claimKeys: ['s1c1', 'zzz'], description: 'Only one known.' },
        ],
      },
      shown,
    );
    expect(out.course.disagreements).toHaveLength(1);
  });
});

describe('answerKey', () => {
  it('folds case, punctuation and spacing', () => {
    expect(answerKey('  The "Restudy"   group. ')).toBe('the restudy group');
  });
});

describe('prompt identity and cache keys', () => {
  it('hashes the exported prompt and schema, stably', async () => {
    const a = await promptVersion('ExtractStudyClaims');
    const b = await promptVersion('ExtractStudyClaims');
    const c = await promptVersion('AssembleStudyCourse');
    expect(a).toEqual(b);
    expect(a.promptHash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.promptHash).not.toBe(c.promptHash);
  });

  it('scopes a key to its owner, stage, provider and input', async () => {
    const version = await promptVersion('ExtractStudyClaims');
    const key = (over: Partial<Parameters<typeof stageCacheKey>[0]>) =>
      stageCacheKey({
        stage: 'extract',
        ownerId: 'reader-a',
        version,
        providerSignature: 'gemini:m',
        input: ['v', 0, 10],
        ...over,
      });
    const base = await key({});
    expect(await key({})).toBe(base);
    expect(await key({ ownerId: 'reader-b' })).not.toBe(base);
    expect(await key({ providerSignature: 'gemini:other' })).not.toBe(base);
    expect(await key({ input: ['v', 0, 11] })).not.toBe(base);
    expect(await key({ stage: 'assemble' })).not.toBe(base);
  });
});

describe('the door agrees with the providers', () => {
  it('study_min_job_cents is one minimal extraction plus one minimal assembly at default Gemini prices', () => {
    const provider = createGeminiStructuredProvider(
      geminiConfigFrom({ get: () => undefined }, 'k'),
    );
    const floor =
      provider.worstCaseCentsFor('ExtractStudyClaims', { sourceTitle: 'x', passage: 'x' }) +
      provider.worstCaseCentsFor('AssembleStudyCourse', { goal: 'x', claims: 'x' });
    const migration = readFileSync(
      fileURLToPath(
        new URL('../../migrations/20260925010000_study_evidence_generation.sql', import.meta.url),
      ),
      'utf8',
    );
    const pinned = /function public\.study_min_job_cents\(\)[\s\S]*?select (\d+)::numeric/.exec(
      migration,
    );
    expect(Number(pinned?.[1])).toBe(floor);
  });
});

describe('the database accepts every value the worker writes', () => {
  const migration = readFileSync(
    fileURLToPath(
      new URL('../../migrations/20260925010000_study_evidence_generation.sql', import.meta.url),
    ),
    'utf8',
  );
  const allowed = (column: string) => {
    const m = new RegExp(
      `\\b${column}\\s+text not null\\s+check \\(${column} in \\(([^)]*)\\)`,
    ).exec(migration);
    if (!m?.[1]) throw new Error(`no check constraint found for ${column}`);
    return [...m[1].matchAll(/'([^']+)'/g)].map((v) => v[1]).sort();
  };

  it.each([
    ['kind', [...CLAIM_KINDS]],
    ['purpose', [...QUESTION_PURPOSES]],
  ] as const)('%s', (column, values) => {
    expect(allowed(column)).toEqual([...values].sort());
  });

  it('question kinds', () => {
    const m = /kind\s+text not null\s+check \(kind in \('multiple_choice'[^)]*\)\)/.exec(migration);
    expect([...(m?.[0] ?? '').matchAll(/'([^']+)'/g)].map((v) => v[1]).sort()).toEqual(
      [...QUESTION_KINDS].sort(),
    );
  });
});
