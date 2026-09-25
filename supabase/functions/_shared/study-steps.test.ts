import { describe, expect, it } from 'vitest';
import { BilledStepError, BudgetExhaustedError, type JobRow, type StepResult } from './pipeline.ts';
import type { JournalOpen, ProviderJournal } from './provider-journal.ts';
import {
  createGeminiStructuredProvider,
  stubStructuredProvider,
  type ProviderCallRecord,
  type StructuredProvider,
} from './structured.ts';
import { STUDY_STEPS, type StudyStep } from './study-graph.ts';
import {
  runStudyStep,
  type CachedStage,
  type StudyDb,
  type StudyGeneration,
  type StudyStagePayload,
} from './study-steps.ts';

// A self-authored note about a published finding (law 4).
const NOTE = [
  'Roediger and Karpicke (2006) had students read short prose passages.',
  'After reading, one group studied the passage again and another took a recall test on it without feedback.',
  'On a final test five minutes later, the group that restudied remembered more.',
  'On final tests two days and one week later, the group that had taken the recall test remembered more.',
  'These results come from the reported conditions with college students and prose passages.',
].join(' ');

const OWNER = '00000000-0000-4000-8000-00000000000a';
const VERSION = '00000000-0000-4000-8000-000000000001';

/** An in-memory StudyDb, honest about owner scoping and about what it was asked. */
function memoryDb(
  generation: StudyGeneration | null,
  opts: { refuseBudget?: boolean; failRecord?: number } = {},
) {
  const cache: (CachedStage & { ownerId: string; cacheKey: string })[] = [];
  const recorded: {
    step: string;
    calls: readonly ProviderCallRecord[];
    cache: StudyStagePayload | null;
  }[] = [];
  const reserved: { step: string; cents: number }[] = [];
  const journalled: JournalOpen[] = [];
  let persisted: unknown = null;
  let recordFailures = opts.failRecord ?? 0;
  const journal: ProviderJournal = {
    async open(call) {
      journalled.push(call);
    },
    async close() {},
  };
  const db: StudyDb = {
    async loadGeneration() {
      return generation;
    },
    async findCachedStage(ownerId, stage, cacheKey) {
      return (
        cache.find((c) => c.ownerId === ownerId && c.stage === stage && c.cacheKey === cacheKey) ??
        null
      );
    },
    async loadCachedStages(ownerId, ids) {
      return cache.filter((c) => c.ownerId === ownerId && ids.includes(c.id));
    },
    async reserveBudget(_jobId, step, cents) {
      if (opts.refuseBudget) throw new BudgetExhaustedError(step);
      reserved.push({ step, cents });
    },
    async recordStage(jobId, step, calls, entry) {
      if (recordFailures > 0) {
        recordFailures -= 1;
        throw new Error('database unavailable');
      }
      recorded.push({ step, calls, cache: entry });
      if (!entry) return null;
      // As `record_study_stage` does: the owner is the job's generation's, never an argument.
      const owner = (await db.loadGeneration(jobId))?.ownerId ?? '';
      const existing = cache.find(
        (c) => c.ownerId === owner && c.stage === entry.stage && c.cacheKey === entry.cacheKey,
      );
      if (existing) return existing.id;
      const id = `cache-${cache.length + 1}`;
      cache.push({
        id,
        ownerId: owner,
        cacheKey: entry.cacheKey,
        stage: entry.stage,
        output: entry.output,
        model: entry.model,
        promptHash: entry.promptHash,
        schemaHash: entry.schemaHash,
        providerCallId: entry.providerCallId,
      });
      return id;
    },
    async persistCourse(_jobId, payload) {
      persisted = payload;
      return { replayed: false };
    },
    journal,
  };
  return { db, cache, recorded, reserved, journalled, persisted: () => persisted };
}

const job = (over: Partial<JobRow> = {}): JobRow => ({
  id: 'job-1',
  kind: 'study_course',
  target: { generationId: 'gen-1' },
  work_id: null,
  summary_id: null,
  visibility: 'private',
  requester_id: OWNER,
  ...over,
});

const generation = (text = NOTE, over: Partial<StudyGeneration> = {}): StudyGeneration => ({
  id: 'gen-1',
  ownerId: OWNER,
  goal: 'Explain the argument from memory',
  sources: [
    {
      versionId: VERSION,
      position: 1,
      title: 'My notes on the testing effect',
      format: 'paste',
      text,
    },
  ],
  ...over,
});

/** Counts `generate` calls on any provider. */
function counting(provider: StructuredProvider) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    provider: {
      ...provider,
      async generate(...a: Parameters<StructuredProvider['generate']>) {
        calls += 1;
        return provider.generate(...a);
      },
    } as StructuredProvider,
  };
}

/** Walk a job through every step the way the worker does, honouring `continue`. */
async function walk(
  db: StudyDb,
  provider: StructuredProvider,
  fetchImpl?: typeof fetch,
  theJob = job(),
) {
  const outputs: Record<string, unknown> = {};
  const invocations: Record<string, number> = {};
  for (const step of STUDY_STEPS) {
    let result: StepResult;
    do {
      invocations[step] = (invocations[step] ?? 0) + 1;
      result = await runStudyStep(step, {
        job: theJob,
        priorOutputs: { ...outputs },
        provider,
        db,
        fetchImpl,
      });
    } while (result.continue);
    outputs[step] = result.output;
  }
  return { outputs, invocations };
}

describe('the study pipeline with the stub provider', () => {
  it('runs every step and persists claims whose evidence resolves exactly', async () => {
    const mem = memoryDb(generation());
    const { outputs } = await walk(mem.db, stubStructuredProvider);
    const payload = mem.persisted() as {
      claims: { key: string; status: string; evidence: { match: string; spanText: string }[] }[];
      lessons: unknown[];
      items: { status: string; claimKeys: string[] }[];
    };
    expect(payload.claims.length).toBeGreaterThan(0);
    for (const claim of payload.claims) {
      expect(claim.status).toBe('draft');
      expect(claim.evidence[0]?.match).toBe('exact');
      expect(NOTE).toContain(claim.evidence[0]?.spanText);
    }
    expect(payload.lessons.length).toBeGreaterThan(0);
    expect(payload.items.every((i) => i.claimKeys.length > 0)).toBe(true);
    expect(outputs.study_ground).toMatchObject({ withheld: 1 });
  });

  it("writes ids and counts to step outputs, never the reader's text", async () => {
    const mem = memoryDb(generation());
    const { outputs } = await walk(mem.db, stubStructuredProvider);
    const text = JSON.stringify(outputs);
    expect(text).not.toContain('restudied');
    expect(text).not.toContain('Explain the argument');
  });

  it('makes no provider call and no reservation the second time the same material is used', async () => {
    const mem = memoryDb(generation());
    const first = counting(stubStructuredProvider);
    await walk(mem.db, first.provider);
    const reservedAfterFirst = mem.reserved.length;

    const second = counting(stubStructuredProvider);
    await walk(mem.db, second.provider, undefined, job({ id: 'job-2' }));
    expect(first.calls).toBe(2);
    expect(second.calls).toBe(0);
    expect(mem.reserved.length).toBe(reservedAfterFirst);
  });

  it('reuses the extraction but assembles again for a different goal', async () => {
    const mem = memoryDb(generation());
    await walk(mem.db, stubStructuredProvider);
    const again = counting(stubStructuredProvider);
    mem.db.loadGeneration = async () => generation(NOTE, { goal: 'Prepare for a discussion' });
    await walk(mem.db, again.provider, undefined, job({ id: 'job-3' }));
    expect(again.calls).toBe(1);
  });

  it("never answers one reader from another reader's cache", async () => {
    const mem = memoryDb(generation());
    await walk(mem.db, stubStructuredProvider);
    const other = counting(stubStructuredProvider);
    mem.db.loadGeneration = async () =>
      generation(NOTE, { ownerId: '00000000-0000-4000-8000-00000000000b' });
    await walk(mem.db, other.provider, undefined, job({ id: 'job-4' }));
    expect(other.calls).toBe(2);
  });
});

describe('study_extract', () => {
  const long = Array.from({ length: 3 }, (_, i) =>
    `Paragraph ${i} states a claim that is long enough to extract. `.repeat(600),
  ).join('\n\n');

  it('makes one paid call per invocation and continues until every window is cached', async () => {
    const mem = memoryDb(generation(long));
    const provider = counting(stubStructuredProvider);
    const { invocations, outputs } = await walk(mem.db, provider.provider);
    const windows = (outputs.study_prepare as { windows: unknown[] }).windows.length;
    expect(windows).toBeGreaterThan(1);
    expect(invocations.study_extract).toBe(windows);
    expect((outputs.study_extract as { extractions: unknown[] }).extractions).toHaveLength(windows);
    expect(mem.reserved.filter((r) => r.step === 'study_extract')).toHaveLength(windows);
  });

  it('waits on the budget without calling anyone or recording anything', async () => {
    const mem = memoryDb(generation(), { refuseBudget: true });
    const provider = counting(stubStructuredProvider);
    const prepared = await runStudyStep('study_prepare', {
      job: job(),
      priorOutputs: {},
      provider: provider.provider,
      db: mem.db,
    });
    await expect(
      runStudyStep('study_extract', {
        job: job(),
        priorOutputs: { study_prepare: prepared.output },
        provider: provider.provider,
        db: mem.db,
      }),
    ).rejects.toBeInstanceOf(BudgetExhaustedError);
    expect(provider.calls).toBe(0);
    expect(mem.recorded).toEqual([]);
  });

  it('records a failed provider outcome before failing, and caches nothing', async () => {
    const mem = memoryDb(generation());
    const failing: StructuredProvider = {
      ...stubStructuredProvider,
      async generate() {
        return {
          ok: false,
          error: 'Gemini returned no text',
          unavailable: false,
          model: 'm',
          calls: [
            {
              providerCallId: 'c1',
              provider: 'gemini',
              model: 'm',
              httpStatus: 200,
              outcome: 'responded',
              inputTokens: 10,
              outputTokens: 5,
              costCents: 0.2,
              usageKnown: true,
            },
          ],
        };
      },
    };
    const prepared = await runStudyStep('study_prepare', {
      job: job(),
      priorOutputs: {},
      provider: failing,
      db: mem.db,
    });
    await expect(
      runStudyStep('study_extract', {
        job: job(),
        priorOutputs: { study_prepare: prepared.output },
        provider: failing,
        db: mem.db,
      }),
    ).rejects.toThrow(/no text/);
    expect(mem.recorded).toHaveLength(1);
    expect(mem.recorded[0]).toMatchObject({ step: 'study_extract', cache: null });
    expect(mem.cache).toEqual([]);
  });

  it('carries the summed usage when the attempts cannot be recorded twice over', async () => {
    const mem = memoryDb(generation(), { failRecord: 2 });
    const billed: StructuredProvider = {
      ...stubStructuredProvider,
      async generate() {
        return {
          ok: true,
          value: { claims: [], gaps: [] },
          model: 'm',
          calls: [
            {
              providerCallId: 'c1',
              provider: 'gemini',
              model: 'm',
              httpStatus: 503,
              outcome: 'responded',
              inputTokens: 0,
              outputTokens: 0,
              costCents: 0,
              usageKnown: true,
            },
            {
              providerCallId: 'c2',
              provider: 'gemini',
              model: 'm',
              httpStatus: 200,
              outcome: 'responded',
              inputTokens: 100,
              outputTokens: 50,
              costCents: 0.3,
              usageKnown: true,
            },
          ],
        };
      },
    };
    const prepared = await runStudyStep('study_prepare', {
      job: job(),
      priorOutputs: {},
      provider: billed,
      db: mem.db,
    });
    const err = await runStudyStep('study_extract', {
      job: job(),
      priorOutputs: { study_prepare: prepared.output },
      provider: billed,
      db: mem.db,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BilledStepError);
    expect((err as BilledStepError).usage).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      costCents: 0.3,
    });
  });

  it('charges an attempt of unknown cost at the ceiling it reserved, not at zero', async () => {
    const mem = memoryDb(generation());
    const dropped: StructuredProvider = {
      ...stubStructuredProvider,
      worstCaseCentsFor: () => 16,
      async generate() {
        return {
          ok: false,
          error: 'socket hang up',
          unavailable: false,
          model: 'm',
          calls: [
            {
              providerCallId: 'c1',
              provider: 'gemini',
              model: 'm',
              httpStatus: null,
              outcome: 'aborted',
              inputTokens: 0,
              outputTokens: 0,
              costCents: 0,
              usageKnown: false,
            },
            {
              providerCallId: 'c2',
              provider: 'gemini',
              model: 'm',
              httpStatus: 503,
              outcome: 'responded',
              inputTokens: 0,
              outputTokens: 0,
              costCents: 0,
              usageKnown: true,
            },
          ],
        };
      },
    };
    const prepared = await runStudyStep('study_prepare', {
      job: job(),
      priorOutputs: {},
      provider: dropped,
      db: mem.db,
    });
    await expect(
      runStudyStep('study_extract', {
        job: job(),
        priorOutputs: { study_prepare: prepared.output },
        provider: dropped,
        db: mem.db,
      }),
    ).rejects.toThrow(/socket hang up/);
    expect(mem.reserved).toEqual([{ step: 'study_extract', cents: 16 }]);
    expect(
      mem.recorded[0]?.calls.map((c) => [c.providerCallId, c.costCents, c.usageKnown]),
    ).toEqual([
      ['c1', 16, false],
      ['c2', 0, true],
    ]);
  });

  it("links a course's cached assembly to every source, not only those it was shown", async () => {
    const two = generation(NOTE, {
      sources: [
        { versionId: VERSION, position: 1, title: 'Notes', format: 'paste', text: NOTE },
        {
          versionId: '00000000-0000-4000-8000-000000000002',
          position: 2,
          title: 'Empty',
          format: 'paste',
          text: 'Too short.',
        },
      ],
    });
    const mem = memoryDb(two);
    await walk(mem.db, stubStructuredProvider);
    const assembled = mem.recorded.find((r) => r.cache?.stage === 'assemble');
    expect(assembled?.cache?.sourceVersionIds).toEqual([
      VERSION,
      '00000000-0000-4000-8000-000000000002',
    ]);
  });

  it('retries a recording that failed once, and succeeds', async () => {
    const mem = memoryDb(generation(), { failRecord: 1 });
    const prepared = await runStudyStep('study_prepare', {
      job: job(),
      priorOutputs: {},
      provider: stubStructuredProvider,
      db: mem.db,
    });
    const result = await runStudyStep('study_extract', {
      job: job(),
      priorOutputs: { study_prepare: prepared.output },
      provider: stubStructuredProvider,
      db: mem.db,
    });
    expect(result.continue).toBeUndefined();
    expect(mem.cache).toHaveLength(1);
  });
});

describe('study_assemble', () => {
  it('refuses to pay for a course when no claim could be matched to the text', async () => {
    const mem = memoryDb(generation());
    const inventing: StructuredProvider = {
      ...stubStructuredProvider,
      async generate(name) {
        if (name === 'AssembleStudyCourse') throw new Error('must not be called');
        return {
          ok: true,
          model: 'stub',
          calls: [],
          value: {
            claims: [
              {
                key: 'c1',
                statement: 'Something invented.',
                kind: 'finding',
                qualifications: [],
                evidence: ['words that are not in the note at all'],
                attribution: null,
              },
            ],
            gaps: [],
          },
        };
      },
    };
    const prepared = await runStudyStep('study_prepare', {
      job: job(),
      priorOutputs: {},
      provider: inventing,
      db: mem.db,
    });
    const extracted = await runStudyStep('study_extract', {
      job: job(),
      priorOutputs: { study_prepare: prepared.output },
      provider: inventing,
      db: mem.db,
    });
    const reservedBefore = mem.reserved.length;
    await expect(
      runStudyStep('study_assemble', {
        job: job(),
        priorOutputs: { study_prepare: prepared.output, study_extract: extracted.output },
        provider: inventing,
        db: mem.db,
      }),
    ).rejects.toThrow(/no claim in the material could be matched/);
    expect(mem.reserved.length).toBe(reservedBefore);
  });
});

describe('guards', () => {
  it('refuses to run a study step on a job that is not a study course', async () => {
    const mem = memoryDb(generation());
    await expect(
      runStudyStep('study_prepare', {
        job: job({ kind: 'private_summary' }),
        priorOutputs: {},
        provider: stubStructuredProvider,
        db: mem.db,
      }),
    ).rejects.toThrow(/not a study course/);
  });

  it('fails cleanly when the material was deleted', async () => {
    const mem = memoryDb(null);
    for (const step of ['study_prepare', 'study_extract'] as StudyStep[]) {
      await expect(
        runStudyStep(step, {
          job: job(),
          priorOutputs: { study_prepare: { windows: [] } },
          provider: stubStructuredProvider,
          db: mem.db,
        }),
      ).rejects.toThrow(/deleted/);
    }
  });
});

describe('the worked example, through Gemini and the journal', () => {
  /*
   * The note says repeated study helped more at five minutes and prior retrieval
   * helped more at two days and one week, under the reported conditions. The model
   * (scripted here) also asserts a claim the note does not make, and writes a
   * question that leans on it. What must come out:
   *
   *   - every grounded claim linked to its exact span;
   *   - the invented claim rejected for missing evidence, and never shown to assembly;
   *   - the question citing it rejected;
   *   - "Does retrieval work better for everyone?" withheld, not answered;
   *   - one ledger record for every journalled attempt, the retried 503 included.
   */
  const extraction = {
    claims: [
      {
        key: 'c1',
        statement:
          'After reading, one group restudied and another took a recall test without feedback.',
        kind: 'method',
        qualifications: [],
        evidence: [
          'one group studied the passage again and another took a recall test on it without feedback',
        ],
        attribution: 'Roediger and Karpicke (2006)',
      },
      {
        key: 'c2',
        statement: 'At five minutes, restudying produced better recall than the recall test.',
        kind: 'finding',
        qualifications: ['final test five minutes later'],
        evidence: ['On a final test five minutes later, the group that restudied remembered more.'],
        attribution: 'Roediger and Karpicke (2006)',
      },
      {
        key: 'c3',
        statement:
          'At two days and one week, prior retrieval produced better recall than restudying.',
        kind: 'finding',
        qualifications: ['final tests two days and one week later'],
        evidence: [
          'On final tests two days and one week later, the group that had taken the recall test remembered more.',
        ],
        attribution: 'Roediger and Karpicke (2006)',
      },
      {
        key: 'c4',
        statement: 'Retrieval practice works better for every learner.',
        kind: 'finding',
        qualifications: [],
        evidence: ['retrieval practice works better for every learner'],
        attribution: null,
      },
    ],
    gaps: ['Whether the result holds for other learners or materials.'],
  };
  const course = {
    title: 'Immediate versus delayed recall',
    overview: 'Why the better strategy depends on when you are tested.',
    objectives: ['Contrast the five-minute and one-week results.'],
    units: [
      {
        title: 'The timing contrast',
        lessons: [
          {
            key: 'L-a',
            title: 'Immediate versus delayed',
            objective: 'Explain which strategy won at each delay.',
            claimKeys: ['s1c1', 's1c2', 's1c3'],
            explanation:
              'Restudying won at five minutes; the recall test won at two days and one week.',
            example: null,
            recap: 'Restudy wins immediately; retrieval wins after a delay.',
            minutes: 3,
          },
        ],
      },
    ],
    questions: [
      {
        key: 'p1',
        lessonKey: 'L-a',
        purpose: 'placement',
        kind: 'multiple_choice',
        claimKeys: ['s1c3'],
        prompt: 'Which group remembered more on the one-week test?',
        answer: 'The group that took the recall test',
        acceptedAnswers: [],
        distractors: [
          { distractor: 'The group that restudied', why: 'True only of the five-minute test.' },
          { distractor: 'Neither group differed', why: 'The note reports a difference.' },
        ],
        cloze: null,
        sequence: [],
        pairs: [],
        explanation: 'The delayed tests favoured prior retrieval.',
        difficulty: 1,
      },
      {
        key: 'p2',
        lessonKey: 'L-a',
        purpose: 'practice',
        kind: 'cloze',
        claimKeys: ['s1c2'],
        prompt: 'Fill the blank.',
        answer: 'restudied',
        acceptedAnswers: ['studied again'],
        distractors: [],
        cloze: 'On the five-minute test, the group that ____ remembered more.',
        sequence: [],
        pairs: [],
        explanation: 'The immediate test is the exception.',
        difficulty: 2,
      },
      {
        key: 'p3',
        lessonKey: 'L-a',
        purpose: 'practice',
        kind: 'multiple_choice',
        claimKeys: ['s1c4'],
        prompt: 'Who benefits from retrieval practice?',
        answer: 'Every learner',
        acceptedAnswers: [],
        distractors: [
          { distractor: 'Only students', why: 'w' },
          { distractor: 'No one', why: 'w' },
        ],
        cloze: null,
        sequence: [],
        pairs: [],
        explanation: 'Invented.',
        difficulty: 1,
      },
      {
        key: 'r1',
        lessonKey: null,
        purpose: 'review',
        kind: 'short_recall',
        claimKeys: ['s1c2', 's1c3'],
        prompt: 'Without looking, state how the result depended on the delay.',
        answer:
          'Restudying was better at five minutes; prior retrieval was better at two days and one week.',
        acceptedAnswers: [],
        distractors: [],
        cloze: null,
        sequence: [],
        pairs: [],
        explanation: 'This is the contrast the lesson taught.',
        difficulty: 2,
      },
    ],
    recap: 'The better strategy depended on the delay, under the reported conditions.',
    disagreements: [],
    withheld: [
      {
        prompt: 'Does retrieval work better for everyone?',
        reason: 'The note describes one group under reported conditions.',
      },
    ],
  };

  const reply = (value: unknown) =>
    new Response(
      JSON.stringify({
        candidates: [{ content: { parts: [{ text: JSON.stringify(value) }] } }],
        usageMetadata: { promptTokenCount: 800, candidatesTokenCount: 400 },
      }),
      { status: 200 },
    );

  it('grounds, rejects, withholds, and accounts for every attempt', async () => {
    const answers = [new Response('busy', { status: 503 }), reply(extraction), reply(course)];
    const sentPrompts: string[] = [];
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      sentPrompts.push(JSON.parse(String(init?.body)).contents[0].parts[0].text);
      return answers.shift() as Response;
    }) as typeof fetch;
    const provider = createGeminiStructuredProvider({
      apiKey: 'k',
      summaryModels: ['gemini-test'],
      embeddingModel: 'e',
      inputUsdPerMTok: 0.75,
      outputUsdPerMTok: 3,
      embeddingUsdPerMTok: 0.15,
      maxOutputTokens: 2000,
    });
    const mem = memoryDb(generation());
    await walk(mem.db, provider, fetchImpl);

    // The assembly never saw the invented claim.
    expect(sentPrompts[2]).toContain('[s1c3]');
    expect(sentPrompts[2]).not.toContain('every learner');

    const payload = mem.persisted() as {
      claims: {
        key: string;
        status: string;
        rejectionReasons: string[];
        evidence: { spanText: string | null }[];
      }[];
      items: { key: string; status: string; purpose: string; rejectionReasons: string[] }[];
      course: { withheld: { prompt: string }[] };
    };
    const byKey = new Map(payload.claims.map((c) => [c.key, c]));
    expect(byKey.get('s1c2')?.evidence[0]?.spanText).toBe(
      'On a final test five minutes later, the group that restudied remembered more.',
    );
    expect(byKey.get('s1c4')).toMatchObject({
      status: 'rejected',
      rejectionReasons: ['evidence_missing'],
    });

    expect(payload.items.map((i) => [i.key, i.purpose, i.status])).toEqual([
      ['q1', 'placement', 'draft'],
      ['q2', 'practice', 'draft'],
      ['q3', 'practice', 'rejected'],
      ['q4', 'review', 'draft'],
    ]);
    expect(payload.items[2]?.rejectionReasons).toContain('no_known_claims');
    expect(payload.course.withheld[0]?.prompt).toBe('Does retrieval work better for everyone?');

    // Three HTTP attempts, three journal rows, three ledger records -- the 503 included.
    const ledgered = mem.recorded.flatMap((r) => r.calls.map((c) => c.providerCallId)).sort();
    expect(ledgered).toEqual(mem.journalled.map((j) => j.id).sort());
    expect(ledgered).toHaveLength(3);
    expect(mem.recorded.flatMap((r) => r.calls.map((c) => c.httpStatus))).toEqual([503, 200, 200]);
  });
});
