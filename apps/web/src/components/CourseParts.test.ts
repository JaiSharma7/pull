import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  CourseOutline,
  CourseRecap,
  LessonBody,
  LessonSources,
  Paragraphs,
  PassageInContext,
  StoppingPoint,
} from './CourseParts.js';
import { shapeCourseSummary, shapeOutline, type CourseSummary } from '../lib/study-course.js';

const units = shapeOutline([
  {
    unit_no: 1,
    unit_title: 'Timing',
    lesson_id: 'a',
    lesson_key: 'l1',
    lesson_position: 1,
    title: 'Five minutes later',
    objective: 'Explain the early result.',
    minutes: 3,
    question_count: 2,
    state: 'read',
  },
  {
    unit_no: 1,
    unit_title: 'Timing',
    lesson_id: 'b',
    lesson_key: 'l2',
    lesson_position: 2,
    title: 'A week later',
    objective: 'Explain the late result.',
    minutes: 4,
    question_count: 1,
    state: 'not_seen',
  },
]);

const noop = () => undefined;

describe('CourseOutline', () => {
  it('says each lesson’s state in words and marks the next one', () => {
    const html = renderToStaticMarkup(
      createElement(CourseOutline, { units, currentLessonId: 'b', onOpen: noop }),
    );
    expect(html).toContain('Unit 1');
    expect(html).toContain('Timing');
    expect(html).toContain('Read · 3 min');
    expect(html).toContain('Not started · 4 min');
    expect(html).toMatch(/aria-current="step"[^>]*>A week later/);
    expect(html.match(/aria-current/g)).toHaveLength(1);
  });
});

describe('LessonBody and Paragraphs', () => {
  it('reads the explanation in paragraphs and ends on the recap to say from memory', () => {
    const html = renderToStaticMarkup(
      createElement(LessonBody, {
        lesson: {
          lessonId: 'a',
          title: 'Five minutes later',
          objective: 'Explain the early result.',
          explanation: 'First paragraph.\n\nSecond paragraph.',
          example: null,
          recap: 'Restudying won at five minutes.',
          minutes: 3,
          claims: [],
        },
        unitTitle: 'Timing',
      }),
    );
    expect(html).toContain('Timing · 3 min');
    expect(html.match(/<p>First paragraph\.<\/p><p>Second paragraph\.<\/p>/)).not.toBeNull();
    expect(html).toContain('Say it from memory');
    expect(html).not.toContain('Example');
    expect(html).toContain('tabindex="-1"');
  });

  it('drops empty paragraphs', () => {
    const html = renderToStaticMarkup(createElement(Paragraphs, { text: '\n\nOne.\n\n\n\n' }));
    expect(html).toBe('<p>One.</p>');
  });
});

describe('where a lesson comes from', () => {
  it('shows each claim with the exact passage and its source', () => {
    const html = renderToStaticMarkup(
      createElement(LessonSources, {
        claims: [
          {
            claimId: 'c1',
            statement: 'Restudying won at five minutes.',
            qualifications: ['under the reported conditions'],
            attribution: null,
            versionId: 'v1',
            sourceTitle: 'Prose memory',
            evidence: [
              {
                ordinal: 1,
                spanText: 'the group that restudied remembered more',
                start: 0,
                end: 5,
                page: 4,
              },
            ],
          },
        ],
      }),
    );
    expect(html).toContain('the group that restudied remembered more');
    expect(html).toContain('Prose memory · page 4');
    expect(html).toContain('Qualified: under the reported conditions');
  });

  it('marks the span in its context with words either side', () => {
    const html = renderToStaticMarkup(
      createElement(PassageInContext, {
        passage: {
          before: 'later, ',
          span: 'the group',
          after: ' remembered',
          clippedStart: true,
          clippedEnd: false,
        },
      }),
    );
    expect(html).toBe(
      '<blockquote class="course__passage">… later, <mark class="course__span">the group</mark> remembered</blockquote>',
    );
  });
});

describe('the end of a session', () => {
  it('is a screen that offers to stop first', () => {
    const html = renderToStaticMarkup(
      createElement(StoppingPoint, {
        covered: [{ title: 'Five minutes later', recap: 'Restudying won early.' }],
        remaining: 3,
        onDone: noop,
        onContinue: noop,
      }),
    );
    expect(html).toContain('That is a good place to stop.');
    expect(html).toContain('You read one lesson');
    expect(html).toContain('Restudying won early.');
    expect(html).toContain('3 lessons are left for another sitting.');
    expect(html.indexOf('Done for now')).toBeLessThan(html.indexOf('Keep going'));
    expect(html).toMatch(/id="course-stop-title"[^>]*tabindex="-1"/);
  });

  it('says so when the course is finished, and offers no more', () => {
    const html = renderToStaticMarkup(
      createElement(StoppingPoint, { covered: [], remaining: 0, onDone: noop, onContinue: null }),
    );
    expect(html).toContain('That was the last lesson of the course.');
    expect(html).not.toContain('Keep going');
  });

  it('does not call the course finished when lessons were skipped', () => {
    const html = renderToStaticMarkup(
      createElement(StoppingPoint, {
        covered: [],
        remaining: 0,
        skipped: 2,
        onDone: noop,
        onContinue: null,
      }),
    );
    expect(html).not.toContain('last lesson of the course');
    expect(html).toContain('The 2 you skipped are on the course page');
  });
});

describe('CourseRecap', () => {
  it('names what the sources disagree on and cannot answer', () => {
    const course = shapeCourseSummary({
      course_id: 'c1',
      goal: 'Explain it',
      recap: 'Timing matters.',
      disagreements: [{ claimKeys: ['s1c1', 's2c1'], description: 'The notes differ on timing.' }],
      withheld: [
        { prompt: 'Does retrieval work better for everyone?', reason: 'The note does not say.' },
      ],
    }) as CourseSummary;
    const html = renderToStaticMarkup(createElement(CourseRecap, { course, allRead: true }));
    expect(html).toContain('Every lesson read');
    expect(html).toContain('Timing matters.');
    expect(html).toContain('Where your sources disagree');
    expect(html).toContain('The notes differ on timing.');
    expect(html).toContain('What your sources cannot answer');
    expect(html).toContain('Does retrieval work better for everyone?');
    // Skipped lessons are not read ones.
    expect(
      renderToStaticMarkup(createElement(CourseRecap, { course, allRead: false })),
    ).not.toContain('Every lesson read');
  });
});
