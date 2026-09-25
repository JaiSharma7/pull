import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { HeldBackList, LessonCorrectionForm, ReportForm } from './CourseFixes.js';

const noop = () => undefined;

describe('ReportForm', () => {
  it('offers a lesson the lesson reasons, and says what reporting does', () => {
    const html = renderToStaticMarkup(
      createElement(ReportForm, {
        kind: 'lesson',
        working: false,
        error: null,
        onSubmit: noop,
        onCancel: noop,
      }),
    );
    expect(html).toContain('What is wrong with this lesson?');
    expect(html.match(/type="radio"/g)).toHaveLength(4);
    expect(html).not.toContain('unanswerable');
    expect(html).toContain('holds the lesson back from this course at once');
    expect(html).toContain('maxLength="1000"');
  });

  it('says a claim report holds back the lessons resting on it', () => {
    const html = renderToStaticMarkup(
      createElement(ReportForm, {
        kind: 'claim',
        working: false,
        error: 'That is as many reports as can be filed today.',
        onSubmit: noop,
        onCancel: noop,
      }),
    );
    expect(html).toContain('This is not what my source says');
    expect(html).toContain('every lesson that rests on it');
    expect(html).toMatch(/role="alert"[^>]*>That is as many reports/);
  });
});

describe('LessonCorrectionForm', () => {
  const lesson = {
    unitTitle: 'Timing',
    title: 'Five minutes later',
    objective: 'Explain it.',
    explanation: 'Restudying won.',
    example: '',
    recap: 'Restudying won early.',
  };

  it('opens on the lesson as it reads, each field labelled and limited', () => {
    const html = renderToStaticMarkup(
      createElement(LessonCorrectionForm, {
        initial: lesson,
        draft: lesson,
        working: false,
        error: null,
        onDraft: noop,
        onSave: noop,
        onCancel: noop,
      }),
    );
    expect(html).toContain('value="Five minutes later"');
    expect(html).toContain('Restudying won.</textarea>');
    expect(html).toContain('maxLength="6000"');
    expect(html).toContain('never proof of what you remember');
    expect(html.match(/<label/g)).toHaveLength(6);
  });

  it('shows the draft the screen holds, and says when it renames the unit', () => {
    const html = renderToStaticMarkup(
      createElement(LessonCorrectionForm, {
        initial: lesson,
        draft: { ...lesson, title: 'Ten minutes later', unitTitle: 'When to test' },
        working: false,
        error: null,
        onDraft: noop,
        onSave: noop,
        onCancel: noop,
      }),
    );
    expect(html).toContain('value="Ten minutes later"');
    expect(html).toContain('renames the whole unit');
  });
});

describe('HeldBackList', () => {
  it('lists what the reader reported, each with a way back, and nothing when empty', () => {
    expect(
      renderToStaticMarkup(
        createElement(HeldBackList, { items: [], working: false, onRestore: noop }),
      ),
    ).toBe('');
    const html = renderToStaticMarkup(
      createElement(HeldBackList, {
        items: [
          { kind: 'lesson', id: 'l1', label: 'Five minutes later' },
          { kind: 'claim', id: 'c1', label: 'Restudying won at five minutes.' },
        ],
        working: false,
        onRestore: noop,
      }),
    );
    expect(html).toContain('Held back by your reports');
    expect(html.match(/>Restore</g)).toHaveLength(2);
    expect(html).toContain('Lesson</span> Five minutes later');
    expect(html).toContain('Claim</span> Restudying won at five minutes.');
  });
});
