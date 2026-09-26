import { describe, expect, it } from 'vitest';
import {
  applyProgress,
  asSentence,
  correctionRefusal,
  lessonDraftProblem,
  lessonRevision,
  reportRefusal,
  type LessonDraft,
  awaitingPreparation,
  courseProgressLabel,
  courseSelectionProblem,
  courseStatus,
  courseTitle,
  knownUnread,
  lessonLabel,
  lessonStateLabel,
  newerPreparationComing,
  newerPreparationFailed,
  lessonsLeft,
  nextLesson,
  readSince,
  passageWindow,
  planSession,
  planSkipped,
  preparationRefusal,
  shapeCourseSummaries,
  shapeCourseSummary,
  shapeLessonContent,
  shapeOutline,
  shapeProgressResult,
  skippedLessons,
  type CourseSummary,
  type LessonContent,
  type OutlineLesson,
  type OutlineUnit,
  planLessons,
  planAfterCorrection,
  draftUnsaved,
  lessonDraft,
  allLessons,
} from './study-course.js';

const overviewRow = {
  course_id: 'c1',
  goal: 'Explain the argument',
  created_at: '2026-09-25T10:00:00Z',
  source_count: 2,
  generation_id: 'g1',
  title: 'Immediate versus delayed',
  overview: 'What the notes say about timing.',
  objectives: ['Explain the contrast.'],
  recap: 'Timing matters.',
  disagreements: [{ claimKeys: ['s1c1', 's2c1'], description: 'They differ on timing.' }],
  withheld: [{ prompt: 'Does it work for everyone?', reason: 'The notes do not say.' }],
  latest_generation_id: 'g1',
  latest_job_status: 'succeeded',
  preparing: false,
  newer_generation_held_back: false,
  held_back: false,
  awaiting_validation: false,
  latest_settled: false,
  update_available: true,
  lesson_count: 3,
  lessons_read_count: 1,
  question_count: 4,
  claim_count: 3,
  claims_demonstrated_count: 0,
};

function course(overrides: Partial<CourseSummary> = {}): CourseSummary {
  return { ...(shapeCourseSummary(overviewRow) as CourseSummary), ...overrides };
}

function outline(): OutlineUnit[] {
  return shapeOutline([
    lessonRow('l3', 3, 2, 'Spacing', 'not_seen', 3),
    lessonRow('l1', 1, 1, 'Timing', 'read', 3),
    lessonRow('l2', 2, 1, 'Timing', 'not_seen', 4),
    lessonRow('l4', 4, 2, 'Spacing', 'not_seen', 3),
    lessonRow('l5', 5, 3, 'Review', 'not_seen', 2),
  ]);
}

function lessonRow(
  key: string,
  position: number,
  unit: number,
  unitTitle: string,
  state: string,
  minutes: number,
) {
  return {
    generation_id: 'g1',
    unit_no: unit,
    unit_title: unitTitle,
    lesson_id: `id-${key}`,
    lesson_key: key,
    lesson_position: position,
    title: `Lesson ${key}`,
    objective: 'Explain it.',
    minutes,
    question_count: 1,
    state,
    first_shown_at: state === 'not_seen' ? null : '2026-09-25T10:00:00Z',
    read_at: state === 'read' ? '2026-09-25T10:05:00Z' : null,
  };
}

describe('shapeCourseSummary', () => {
  it('reads every column of the overview', () => {
    const c = shapeCourseSummary(overviewRow);
    expect(c).toMatchObject({
      courseId: 'c1',
      generationId: 'g1',
      title: 'Immediate versus delayed',
      objectives: ['Explain the contrast.'],
      disagreements: [{ claimKeys: ['s1c1', 's2c1'], description: 'They differ on timing.' }],
      withheld: [{ prompt: 'Does it work for everyone?', reason: 'The notes do not say.' }],
      updateAvailable: true,
      lessonCount: 3,
      lessonsReadCount: 1,
    });
  });

  it('treats absent text as absent, and drops a row with no course id', () => {
    const c = shapeCourseSummary({
      ...overviewRow,
      title: null,
      objectives: null,
      generation_id: null,
    });
    expect(c?.title).toBeNull();
    expect(c?.objectives).toEqual([]);
    expect(c?.generationId).toBeNull();
    expect(shapeCourseSummaries([{ goal: 'no id' }, overviewRow, 'junk'])).toHaveLength(1);
  });
});

describe('courseStatus and courseTitle', () => {
  it('is ready with a current generation, even while a newer one is prepared', () => {
    expect(courseStatus(course({ preparing: true }))).toBe('ready');
  });
  it('is preparing before the first generation finishes, including validation', () => {
    expect(courseStatus(course({ generationId: null, preparing: true }))).toBe('preparing');
    expect(
      courseStatus(
        course({ generationId: null, latestJobStatus: 'succeeded', awaitingValidation: true }),
      ),
    ).toBe('preparing');
    // Past its day, a course validation never settled is not polled for ever.
    expect(courseStatus(course({ generationId: null, latestJobStatus: 'succeeded' }))).toBe(
      'failed',
    );
  });
  it('failed when the only generation failed or was cancelled; empty when there is none', () => {
    expect(courseStatus(course({ generationId: null, latestJobStatus: 'failed' }))).toBe('failed');
    expect(courseStatus(course({ generationId: null, latestJobStatus: 'cancelled' }))).toBe(
      'failed',
    );
    expect(courseStatus(course({ generationId: null, latestJobStatus: null }))).toBe('empty');
  });
  it('is preparing, not failed, when a failed job left a course the sweep will validate', () => {
    // The job's validation step gave up after the course was saved; the sweep finishes it.
    const saved = course({
      generationId: null,
      latestJobStatus: 'failed',
      awaitingValidation: true,
    });
    expect(courseStatus(saved)).toBe('preparing');
    expect(awaitingPreparation(saved)).toBe(true);
  });
  it('knows a newer preparation is coming, and did not fail, while it awaits validation', () => {
    const newer = course({
      latestGenerationId: 'g2',
      latestJobStatus: 'failed',
      awaitingValidation: true,
    });
    expect(newerPreparationComing(newer)).toBe(true);
    expect(newerPreparationFailed(newer)).toBe(false);
    expect(awaitingPreparation(newer)).toBe(true);
    const failed = { ...newer, awaitingValidation: false };
    expect(newerPreparationComing(failed)).toBe(false);
    expect(newerPreparationFailed(failed)).toBe(true);
    // Saved and settled -- held back by validation -- is said as that, not as a failure.
    expect(newerPreparationFailed({ ...failed, latestSettled: true })).toBe(false);
    expect(newerPreparationComing(course({ preparing: true, latestGenerationId: 'g2' }))).toBe(
      true,
    );
    expect(newerPreparationComing(course({ preparing: true }))).toBe(false);
  });
  it('is called by its validated title, else by the goal', () => {
    expect(courseTitle(course())).toBe('Immediate versus delayed');
    expect(courseTitle(course({ title: null }))).toBe('Explain the argument');
    expect(courseTitle(course({ title: '  ', goal: '' }))).toBe('Untitled course');
  });
  it('counts lessons read, never "0 of 0"', () => {
    expect(courseProgressLabel(course())).toBe('1 of 3 lessons read');
    expect(courseProgressLabel(course({ lessonCount: 0, lessonsReadCount: 0 }))).toBe(
      'Nothing to read',
    );
    expect(
      courseProgressLabel(course({ lessonCount: 0, lessonsReadCount: 0, heldBack: true })),
    ).toBe('Held back by its checks');
    expect(courseProgressLabel(course({ lessonsReadCount: 3 }))).toBe('Every lesson read');
  });
});

describe('what is on its way', () => {
  it('looks again while a job runs, or while a finished one awaits validation', () => {
    expect(awaitingPreparation(course({ preparing: true }))).toBe(true);
    expect(
      awaitingPreparation(
        course({ generationId: null, latestJobStatus: 'succeeded', awaitingValidation: true }),
      ),
    ).toBe(true);
    // A finished job whose course was never settled, past its day, is not looked for again.
    expect(awaitingPreparation(course({ generationId: null, latestJobStatus: 'succeeded' }))).toBe(
      false,
    );
    expect(awaitingPreparation(course())).toBe(false);
    expect(awaitingPreparation(course({ generationId: null, latestJobStatus: 'failed' }))).toBe(
      false,
    );
  });

  it('says a newer preparation failed only when an older one is still being read', () => {
    const failedAgain = { latestGenerationId: 'g2', latestJobStatus: 'failed' };
    expect(newerPreparationFailed(course(failedAgain))).toBe(true);
    expect(newerPreparationFailed(course({ ...failedAgain, latestJobStatus: 'cancelled' }))).toBe(
      true,
    );
    // The failed one is the one on screen, there is none on screen, or another is running.
    expect(newerPreparationFailed(course({ latestJobStatus: 'failed' }))).toBe(false);
    expect(newerPreparationFailed(course({ ...failedAgain, generationId: null }))).toBe(false);
    expect(newerPreparationFailed(course({ ...failedAgain, preparing: true }))).toBe(false);
    expect(
      newerPreparationFailed(course({ latestGenerationId: 'g2', latestJobStatus: 'succeeded' })),
    ).toBe(false);
  });
});

describe('preparationRefusal', () => {
  it('reads the DETAIL a code shares between refusals', () => {
    expect(preparationRefusal('55000', 'preparing')).toMatch(/already being prepared/);
    expect(preparationRefusal('55000', 'unchanged')).toMatch(/has changed since/);
    expect(preparationRefusal('42501', 'beta')).toMatch(/limited beta/);
    expect(preparationRefusal('42501', 'unavailable')).toMatch(/no longer in your account/);
    expect(preparationRefusal('22023', 'too_large')).toMatch(/200,000-character limit/);
    expect(preparationRefusal('22023', undefined)).toBeNull();
  });

  it('says nothing of a refusal it does not know, so the server’s own message is shown', () => {
    expect(preparationRefusal('55000', undefined)).toBeNull();
    expect(preparationRefusal('42501', 'something new')).toBeNull();
    expect(preparationRefusal('53400', undefined)).toBeNull();
    expect(preparationRefusal(undefined, undefined)).toBeNull();
    expect(preparationRefusal('P0002', undefined)).toBe('This course no longer exists.');
  });

  it('turns a server message into a sentence', () => {
    expect(asSentence('  the daily generation budget is spent.')).toBe(
      'The daily generation budget is spent.',
    );
    expect(asSentence('')).toBe('');
  });
});

describe('shapeOutline', () => {
  it('groups lessons into units in course order', () => {
    const units = outline();
    expect(
      units.map((u) => `${u.unitNo}:${u.title}:${u.lessons.map((l) => l.lessonKey).join('+')}`),
    ).toEqual(['1:Timing:l1+l2', '2:Spacing:l3+l4', '3:Review:l5']);
  });
  it('reads the study Delta’s word on each lesson', () => {
    const [unit] = shapeOutline([
      { ...lessonRow('l1', 1, 1, 'T', 'read', 3), known: false, revisit: true, faded: true },
      { ...lessonRow('l2', 2, 1, 'T', 'read', 3), known: 'yes', revisit: 1, faded: 'true' },
    ]);
    expect(unit?.lessons.map((l) => [l.known, l.revisit, l.faded])).toEqual([
      [false, true, true],
      [false, false, false],
    ]);
  });
  it('reads an unknown state as not seen and a missing minutes as one', () => {
    const [unit] = shapeOutline([{ ...lessonRow('l1', 1, 1, 'T', 'mystery', 0) }]);
    expect(unit?.lessons[0]?.state).toBe('not_seen');
    expect(unit?.lessons[0]?.minutes).toBe(1);
  });
  it('labels states in words, so colour is never the only signal', () => {
    expect(
      ['not_seen', 'shown', 'read', 'skipped'].map((s) => lessonStateLabel(s as never)),
    ).toEqual(['Not started', 'Started', 'Read', 'Skipped']);
  });
});

describe('what to read next', () => {
  it('is the first lesson not read or skipped', () => {
    expect(nextLesson(outline())?.lessonKey).toBe('l2');
    const done = applyProgress(outline(), [
      { kind: 'lesson_read', lessonId: 'id-l2' },
      { kind: 'lesson_skipped', lessonId: 'id-l3' },
    ]);
    expect(nextLesson(done)?.lessonKey).toBe('l4');
  });

  it('plans about ten minutes, stopping at a unit break once half is spent', () => {
    // l2 (4) is unit 1; l3 (3) starts unit 2 at 4 minutes, under half: continue.
    // l4 (3) brings it to 10: stop.
    expect(planSession(outline()).map((l) => l.lessonKey)).toEqual(['l2', 'l3', 'l4']);
    // From l3: l3 (3) + l4 (3) = 6, and l5 starts a new unit past half the budget: stop.
    expect(planSession(outline(), 'id-l3').map((l) => l.lessonKey)).toEqual(['l3', 'l4']);
  });

  it('starts from a finished lesson the reader chose, and skips finished ones after it', () => {
    expect(planSession(outline(), 'id-l1', 4).map((l) => l.lessonKey)).toEqual(['l1', 'l2']);
  });

  it('always has at least one lesson when any is unfinished, and none when all are', () => {
    expect(planSession(outline(), null, 1)).toHaveLength(1);
    const all = applyProgress(outline(), [
      { kind: 'lesson_read', lessonId: 'id-l2' },
      { kind: 'lesson_read', lessonId: 'id-l3' },
      { kind: 'lesson_read', lessonId: 'id-l4' },
      { kind: 'lesson_read', lessonId: 'id-l5' },
    ]);
    expect(planSession(all)).toEqual([]);
    expect(nextLesson(all)).toBeNull();
  });
});

describe('applyProgress', () => {
  it('only ever moves forward', () => {
    const units = applyProgress(outline(), [
      { kind: 'lesson_shown', lessonId: 'id-l1' },
      { kind: 'lesson_read', lessonId: 'id-l2' },
      { kind: 'lesson_shown', lessonId: 'id-l2' },
    ]);
    const states = Object.fromEntries(
      units.flatMap((u) => u.lessons).map((l) => [l.lessonKey, l.state]),
    );
    expect(states.l1).toBe('read');
    expect(states.l2).toBe('read');
  });
});

describe('planLessons and planAfterCorrection', () => {
  it('keeps each planned lesson with its unit title', () => {
    const units = outline();
    const plan = planLessons(units, planSession(units));
    expect(plan[0]).toEqual({
      lessonId: 'id-l2',
      title: 'Lesson l2',
      unitNo: 1,
      unitTitle: 'Timing',
    });
  });

  it('puts a correction in its lesson\u2019s place, and renames its whole unit', () => {
    const plan = planLessons(outline(), allLessons(outline()));
    const after = planAfterCorrection(plan, 'id-l1', 'id-l1b', 1, {
      title: ' Five minutes later ',
      unitTitle: 'When to test',
    });
    expect(after.map((p) => p.lessonId)).toEqual(['id-l1b', 'id-l2', 'id-l3', 'id-l4', 'id-l5']);
    expect(after[0]?.title).toBe('Five minutes later');
    expect(after.filter((p) => p.unitNo === 1).map((p) => p.unitTitle)).toEqual([
      'When to test',
      'When to test',
    ]);
    expect(after[2]?.unitTitle).toBe('Spacing');
  });
});

describe('draftUnsaved', () => {
  const lesson = shapeLessonContent({
    lesson: {
      id: 'l1',
      title: 'Five minutes later',
      objective: 'Explain it.',
      explanation: 'Restudying won.',
      example: null,
      recap: 'Restudying won early.',
      minutes: 3,
    },
    claims: [],
    evidence: [],
    versions: [],
  }) as LessonContent;

  it('is true only for a changed draft of this lesson', () => {
    const same = lessonDraft(lesson, 'Timing');
    expect(draftUnsaved(lesson, 'Timing', null)).toBe(false);
    expect(draftUnsaved(lesson, 'Timing', { lessonId: 'l1', value: same })).toBe(false);
    expect(
      draftUnsaved(lesson, 'Timing', { lessonId: 'l1', value: { ...same, recap: 'Changed.' } }),
    ).toBe(true);
    expect(
      draftUnsaved(lesson, 'Timing', { lessonId: 'l9', value: { ...same, recap: 'Changed.' } }),
    ).toBe(false);
  });
});

describe('lessonsLeft', () => {
  it('counts what later sittings bring up: revisits and unknown unfinished lessons', () => {
    const units = shapeOutline([
      { ...lessonRow('l1', 1, 1, 'Timing', 'read', 3), revisit: true },
      { ...lessonRow('l2', 2, 1, 'Timing', 'not_seen', 4), known: true },
      lessonRow('l3', 3, 2, 'Spacing', 'not_seen', 3),
      lessonRow('l4', 4, 2, 'Spacing', 'skipped', 3),
    ]);
    expect(lessonsLeft(units).map((l) => l.lessonKey)).toEqual(['l1', 'l3']);
  });
});

describe('planSkipped', () => {
  it('offers the skipped lessons again, in order, within a session', () => {
    const units = shapeOutline([
      lessonRow('l1', 1, 1, 'Timing', 'skipped', 3),
      lessonRow('l2', 2, 1, 'Timing', 'read', 4),
      lessonRow('l3', 3, 2, 'Spacing', 'skipped', 3),
    ]);
    expect(nextLesson(units)).toBeNull();
    expect(skippedLessons(units).map((l) => l.lessonKey)).toEqual(['l1', 'l3']);
    expect(planSkipped(units).map((l) => l.lessonKey)).toEqual(['l1', 'l3']);
    expect(planSkipped(outline())).toEqual([]);
  });
});

describe('passageWindow', () => {
  const text =
    'Before the passage. On a final test five minutes later, the group that restudied remembered more. After it.';
  const spanText = 'the group that restudied remembered more';
  const start = Array.from(text.slice(0, text.indexOf(spanText))).length;

  it('shows the span in its context, cut at word boundaries', () => {
    const w = passageWindow(
      text,
      { start, end: start + Array.from(spanText).length, spanText },
      20,
    );
    expect(w?.span).toBe(spanText);
    // Twenty back lands on the start of "five", which is a word boundary already.
    expect(w?.before).toBe('five minutes later, ');
    // Twenty-two back lands inside "test", and the window opens at the start of it.
    expect(
      passageWindow(text, { start, end: start + Array.from(spanText).length, spanText }, 22)
        ?.before,
    ).toBe('test five minutes later, ');
    expect(w?.after).toBe('. After it.');
    expect(w?.clippedStart).toBe(true);
    expect(w?.clippedEnd).toBe(false);
  });

  it('does not take in the whole text when it has no spaces to cut at', () => {
    // Japanese puts no spaces between words. Widening to the nearest one read the document.
    const long = 'あ'.repeat(30_000) + '記憶' + 'い'.repeat(30_000);
    const w = passageWindow(long, { start: 30_000, end: 30_002, spanText: '記憶' }, 50);
    expect(w?.span).toBe('記憶');
    expect(Array.from(w?.before ?? '').length).toBe(50);
    expect(Array.from(w?.after ?? '').length).toBe(50);
    expect(w?.clippedStart).toBe(true);
    expect(w?.clippedEnd).toBe(true);
  });

  it('counts code points, as the database does', () => {
    const astral = '𝟏𝟐 then the span here';
    // Two astral digits are two code points but four UTF-16 units.
    const w = passageWindow(astral, { start: 12, end: 16, spanText: 'span' });
    expect(w?.span).toBe('span');
    expect(w?.before).toBe('𝟏𝟐 then the ');
  });

  it('refuses offsets that do not hold the recorded span', () => {
    expect(passageWindow(text, { start: 0, end: 5, spanText: 'nope!' })).toBeNull();
    expect(passageWindow(text, { start: 5, end: 99999, spanText })).toBeNull();
    expect(passageWindow(text, { start: 9, end: 3, spanText })).toBeNull();
  });
});

describe('shapeLessonContent', () => {
  it('gathers a lesson, its claims, their resolved spans and source titles', () => {
    const content = shapeLessonContent({
      lesson: {
        id: 'l1',
        title: 'Timing',
        objective: 'Explain.',
        explanation: 'Text.',
        example: null,
        recap: 'R.',
        minutes: 3,
      },
      claims: [
        {
          id: 'c1',
          statement: 'Restudying won early.',
          qualifications: ['at five minutes'],
          attribution: null,
          source_version_id: 'v1',
        },
      ],
      evidence: [
        {
          claim_id: 'c1',
          ordinal: 2,
          span_text: 'second',
          start_offset: 10,
          end_offset: 16,
          page: null,
          match: 'exact',
        },
        {
          claim_id: 'c1',
          ordinal: 1,
          span_text: 'first',
          start_offset: 0,
          end_offset: 5,
          page: 3,
          match: 'normalized',
        },
        {
          claim_id: 'c1',
          ordinal: 3,
          span_text: null,
          start_offset: null,
          end_offset: null,
          match: 'unresolved',
        },
      ],
      versions: [{ id: 'v1', title: 'Prose memory' }],
    });
    expect(content?.claims[0]?.sourceTitle).toBe('Prose memory');
    expect(content?.claims[0]?.evidence.map((e) => e.spanText)).toEqual(['first', 'second']);
    expect(content?.claims[0]?.evidence[0]?.page).toBe(3);
  });

  it('is null without a lesson', () => {
    expect(shapeLessonContent({ lesson: null, claims: [], evidence: [], versions: [] })).toBeNull();
  });
});

describe('shapeProgressResult', () => {
  it('reads counts and refusals, tolerating junk', () => {
    expect(
      shapeProgressResult({
        recorded: 2,
        duplicates: 1,
        refused: [{ index: 3, reason: 'limit', clientEventId: 'e' }, 'x'],
      }),
    ).toEqual({
      recorded: 2,
      duplicates: 1,
      refused: [{ index: 3, clientEventId: 'e', reason: 'limit' }],
    });
    expect(shapeProgressResult(null)).toEqual({ recorded: 0, duplicates: 0, refused: [] });
  });
});

describe('courseSelectionProblem', () => {
  it('holds a course to one to five sources and a goal', () => {
    expect(courseSelectionProblem(0, 'Explain it')).toMatch(/at least one/);
    expect(courseSelectionProblem(6, 'Explain it')).toMatch(/at most 5/);
    expect(courseSelectionProblem(1, '   ')).toMatch(/what the course is for/);
    expect(courseSelectionProblem(1, 'x'.repeat(301))).toMatch(/300/);
    expect(courseSelectionProblem(5, 'Explain it')).toBeNull();
  });
});

describe('correcting a lesson', () => {
  const before: LessonDraft = {
    unitTitle: 'Timing',
    title: 'Five minutes later',
    objective: 'Explain the early result.',
    explanation: 'Restudying won.',
    example: '',
    recap: 'Restudying won early.',
  };

  it('sends only what changed, and nothing when nothing did', () => {
    expect(lessonRevision(before, { ...before })).toBeNull();
    expect(lessonRevision(before, { ...before, title: '  Five minutes later ' })).toBeNull();
    expect(lessonRevision(before, { ...before, title: 'At five minutes' })).toEqual({
      title: 'At five minutes',
    });
    expect(lessonRevision(before, { ...before, unitTitle: 'When it was tested' })).toEqual({
      unitTitle: 'When it was tested',
    });
  });

  it('clears an emptied example rather than sending an empty one', () => {
    const withExample = { ...before, example: 'A quiz a week later.' };
    expect(lessonRevision(withExample, { ...withExample, example: '  ' })).toEqual({
      example: null,
    });
  });

  it('refuses an empty field or one over its limit before sending anything', () => {
    expect(lessonDraftProblem(before)).toBeNull();
    expect(lessonDraftProblem({ ...before, recap: ' ' })).toBe('The recap cannot be empty.');
    expect(lessonDraftProblem({ ...before, title: 'x'.repeat(201) })).toBe(
      'The title can be at most 200 characters.',
    );
    // Counted in code points, as the database counts them.
    expect(lessonDraftProblem({ ...before, title: '😀'.repeat(200) })).toBeNull();
  });

  it('says a failed check in words, one sentence per reason', () => {
    expect(correctionRefusal('22023', 'instruction_like,unsourced_link')).toBe(
      'Part of it reads like an instruction to a model rather than teaching. ' +
        'It links to a page none of your sources mention.',
    );
    expect(correctionRefusal('22023', 'new_check')).toBe('It did not pass a check (new_check).');
    expect(correctionRefusal('22023', undefined)).toBeNull();
    expect(correctionRefusal('55P03', undefined)).toMatch(/Try again in a moment/);
    expect(correctionRefusal('54000', undefined)).toMatch(/00:00 UTC/);
    expect(correctionRefusal('XX000', undefined)).toBeNull();
  });

  it('says why a report was refused', () => {
    expect(reportRefusal('54000')).toMatch(/as many reports/);
    expect(reportRefusal('P0002')).toBe('It is no longer in your course.');
    expect(reportRefusal(undefined)).toBeNull();
  });
});

describe('the study Delta in a session', () => {
  const lesson = (
    id: string,
    unitNo: number,
    extra: Partial<OutlineUnit['lessons'][number]> = {},
  ): OutlineUnit['lessons'][number] => ({
    lessonId: id,
    lessonKey: id,
    position: 1,
    unitNo,
    title: id,
    objective: '',
    minutes: 3,
    questionCount: 0,
    state: 'not_seen',
    firstShownAt: null,
    readAt: null,
    known: false,
    revisit: false,
    faded: false,
    ...extra,
  });
  const units: OutlineUnit[] = [
    {
      unitNo: 1,
      title: 'One',
      lessons: [lesson('a', 1, { state: 'read' }), lesson('b', 1, { known: true }), lesson('c', 1)],
    },
    { unitNo: 2, title: 'Two', lessons: [lesson('d', 2, { state: 'read', revisit: true })] },
  ];

  it('revisits first, leaves known lessons out, and keeps a lesson the reader opens', () => {
    expect(nextLesson(units)?.lessonId).toBe('d');
    // Start and Continue plan from no lesson: every lesson to revisit, then onward.
    expect(planSession(units).map((l) => l.lessonId)).toEqual(['d', 'c']);
    expect(planSession(units, null, 60).map((l) => l.lessonId)).toEqual(['d', 'c']);
    // Opened by the reader, a known lesson is read; the session still stops at the unit's end.
    expect(planSession(units, 'b').map((l) => l.lessonId)).toEqual(['b', 'c']);
    // Two to revisit in one unit, and room for all: each once.
    const twice: OutlineUnit[] = [
      {
        unitNo: 1,
        title: 'One',
        lessons: [
          lesson('a', 1, { state: 'read', revisit: true }),
          lesson('b', 1, { state: 'read', revisit: true }),
          lesson('c', 1),
        ],
      },
    ];
    expect(planSession(twice, null, 60).map((l) => l.lessonId)).toEqual(['a', 'b', 'c']);
  });

  it('never sends a reader back to a lesson they have not read', () => {
    // A wrong answer in the check, on a lesson in unit three: the course still starts at the
    // start, and that lesson comes in its turn.
    const early: OutlineUnit[] = [
      { unitNo: 1, title: 'One', lessons: [lesson('a', 1)] },
      { unitNo: 3, title: 'Three', lessons: [lesson('e', 3, { revisit: true })] },
    ];
    expect(nextLesson(early)?.lessonId).toBe('a');
    expect(planSession(early).map((l) => l.lessonId)[0]).toBe('a');
    expect(lessonLabel(early[1]!.lessons[0]!)).toBe('Not started');
  });

  it('says why in the outline', () => {
    const says = (over: Partial<OutlineLesson>) => lessonLabel(lesson('x', 1, over));
    expect(says({ state: 'read', revisit: true })).toBe('Worth rereading');
    expect(says({ state: 'not_seen', known: true })).toBe('You know this');
    expect(says({ state: 'skipped', known: true })).toBe('Skipped · you know this');
    expect(says({ state: 'read', known: true })).toBe('Read');
    expect(says({ state: 'not_seen', faded: true })).toBe('You knew this · time to refresh');
    expect(says({ state: 'read', faded: true })).toBe('Read · time to refresh');
    expect(says({ state: 'shown' })).toBe('Started');
  });

  it('answers "worth rereading" with a read on this page, until the course is read again', () => {
    const answered = readSince(units, new Set(['d']));
    expect(answered[1]!.lessons[0]!.revisit).toBe(false);
    expect(nextLesson(answered)?.lessonId).toBe('c');
    expect(readSince(units, new Set())).toEqual(units);
    // Only the lessons read here.
    const two: OutlineUnit[] = [
      {
        unitNo: 1,
        title: 'One',
        lessons: [
          lesson('a', 1, { state: 'read', revisit: true }),
          lesson('b', 1, { state: 'read', revisit: true }),
        ],
      },
    ];
    expect(readSince(two, new Set(['a']))[0]!.lessons.map((l) => l.revisit)).toEqual([false, true]);
  });

  it('counts the lessons left out as known, not those already finished', () => {
    const mixed: OutlineUnit[] = [
      {
        unitNo: 1,
        title: 'One',
        lessons: [
          lesson('a', 1, { known: true }),
          lesson('b', 1, { known: true, state: 'read' }),
          lesson('c', 1, { known: true, state: 'skipped' }),
          lesson('d', 1, { known: true, state: 'shown' }),
        ],
      },
    ];
    expect(knownUnread(mixed).map((l) => l.lessonId)).toEqual(['a', 'd']);
    expect(knownUnread(units).map((l) => l.lessonId)).toEqual(['b']);
  });

  it('has nothing to plan when everything is known or finished', () => {
    const done: OutlineUnit[] = [
      {
        unitNo: 1,
        title: 'One',
        lessons: [lesson('a', 1, { known: true }), lesson('b', 1, { state: 'read' })],
      },
    ];
    expect(nextLesson(done)).toBeNull();
    expect(planSession(done)).toEqual([]);
  });
});
