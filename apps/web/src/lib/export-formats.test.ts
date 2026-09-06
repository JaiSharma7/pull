import { describe, expect, it } from 'vitest';
import {
  ANKI_HEADER,
  type AnkiQuestion,
  ankiTag,
  CSV_COLUMNS,
  flattenHighlights,
  type ReviewEvent,
  summariseHistory,
  toAnkiTsv,
  toCsvHighlights,
  toStashMarkdown,
} from './export-formats.js';

/**
 * An export is the reader's data leaving the product, so the assertions are
 * about the two ways an export betrays them: losing something, and carrying
 * something that runs when the file is opened.
 */

describe('toCsvHighlights', () => {
  it('writes a header and one CRLF-terminated line per row', () => {
    const out = toCsvHighlights([
      { source: 'Walden', idea: 'The cost', highlight: 'a life', note: null },
    ]);
    expect(out).toBe('source,idea,highlight,note\r\nWalden,The cost,a life,\r\n');
    expect(CSV_COLUMNS).toEqual(['source', 'idea', 'highlight', 'note']);
  });

  it('quotes a field with a comma, a quote or a line break, and doubles the quote', () => {
    const out = toCsvHighlights([
      {
        source: 'Walden, or Life in the Woods',
        idea: 'He said "simplify"',
        highlight: 'line one\nline two',
        note: 'plain',
      },
    ]);
    expect(out.split('\r\n')[1]).toBe(
      '"Walden, or Life in the Woods","He said ""simplify""","line one\nline two",plain',
    );
  });

  it('leaves a bare field bare', () => {
    // A file of short fields should still read as text in a terminal.
    const out = toCsvHighlights([{ source: 'A', idea: 'B', highlight: 'C D', note: 'E' }]);
    expect(out).toContain('A,B,C D,E');
  });

  it('defuses a cell a spreadsheet would run as a formula', () => {
    // A highlight is text somebody else wrote. "=HYPERLINK(...)" in a saved
    // quotation would execute on the reader's own machine when they opened it.
    const out = toCsvHighlights([
      { source: '=1+1', idea: '+2', highlight: '-3', note: '@SUM(A1)' },
      { source: '\tTab', idea: 'safe', highlight: 'x - y', note: null },
    ]);
    const lines = out.split('\r\n');
    expect(lines[1]).toBe("'=1+1,'+2,'-3,'@SUM(A1)");
    // A leading tab is defused; a dash inside a field is just a dash.
    expect(lines[2]).toBe("'\tTab,safe,x - y,");
  });

  it('writes a null note as an empty field, not the word null', () => {
    expect(toCsvHighlights([{ source: 's', idea: 'i', highlight: 'h', note: null }])).toContain(
      's,i,h,\r\n',
    );
  });

  it('is only the header when there is nothing', () => {
    expect(toCsvHighlights([])).toBe('source,idea,highlight,note\r\n');
  });
});

describe('flattenHighlights', () => {
  it('makes one row per highlight and repeats the idea note on each', () => {
    const rows = flattenHighlights([
      {
        title: 'Walden',
        ideas: [{ headline: 'The cost', highlights: ['a life', 'exchanged'], note: 'mine' }],
      },
    ]);
    expect(rows).toEqual([
      { source: 'Walden', idea: 'The cost', highlight: 'a life', note: 'mine' },
      { source: 'Walden', idea: 'The cost', highlight: 'exchanged', note: 'mine' },
    ]);
  });

  it('keeps a note that has no highlight beside it', () => {
    // Otherwise the note would be the one thing the export lost.
    const rows = flattenHighlights([
      { title: 'Walden', ideas: [{ headline: 'Alone', highlights: [], note: 'a thought' }] },
    ]);
    expect(rows).toEqual([{ source: 'Walden', idea: 'Alone', highlight: '', note: 'a thought' }]);
  });

  it('skips an idea with nothing at all', () => {
    expect(
      flattenHighlights([
        { title: 'Empty', ideas: [{ headline: 'x', highlights: [], note: null }] },
      ]),
    ).toEqual([]);
  });
});

const question = (over: Partial<AnkiQuestion> = {}): AnkiQuestion => ({
  id: 'q1',
  pullId: 'p1',
  kind: 'recall',
  prompt: 'What does an obstacle become?',
  answer: 'The material of the work',
  distractors: [],
  work: 'Meditations',
  ...over,
});

const event = (over: Partial<ReviewEvent> = {}): ReviewEvent => ({
  pullId: 'p1',
  questionId: 'q1',
  grade: 'good',
  appliedAt: '2026-09-01T10:00:00Z',
  ...over,
});

describe('summariseHistory', () => {
  it('counts reps and lapses, and reports the latest grade by time not by order', () => {
    const summary = summariseHistory(question(), [
      event({ grade: 'easy', appliedAt: '2026-09-03T10:00:00Z' }),
      event({ grade: 'forgot', appliedAt: '2026-09-01T10:00:00Z' }),
      event({ grade: 'good', appliedAt: '2026-09-02T10:00:00Z' }),
    ]);
    expect(summary).toEqual({ reps: 3, lapses: 1, last: 'easy' });
  });

  it("ignores another question's events and another pull's", () => {
    const summary = summariseHistory(question(), [
      event({ questionId: 'q2' }),
      event({ pullId: 'p2', questionId: null }),
    ]);
    expect(summary).toEqual({ reps: 0, lapses: 0, last: null });
  });

  it('counts a free-recall grade on the pull towards the question', () => {
    // Before questions had ids, a grade measured memory of the idea, and that is
    // what the reader is carrying over.
    const summary = summariseHistory(question(), [event({ questionId: null, grade: 'forgot' })]);
    expect(summary).toEqual({ reps: 1, lapses: 1, last: 'forgot' });
  });
});

describe('summariseHistory across mixed timestamps', () => {
  it('reads the latest by instant, not by string', () => {
    // `2026-09-06T00:30:00+02:00` is 22:30 UTC and sorts after
    // `2026-09-05T23:00:00+00:00`, which is 23:00.
    const summary = summariseHistory({ id: 'q1', pullId: 'p1' }, [
      { pullId: 'p1', questionId: 'q1', grade: 'good', appliedAt: '2026-09-06T00:30:00+02:00' },
      { pullId: 'p1', questionId: 'q1', grade: 'forgot', appliedAt: '2026-09-05T23:00:00+00:00' },
    ]);
    expect(summary.last).toBe('forgot');
    expect(summary.reps).toBe(2);
  });
});

describe('ankiTag', () => {
  it('has no whitespace, no case and no punctuation', () => {
    expect(ankiTag('Walden, or Life in the Woods')).toBe('walden-or-life-in-the-woods');
    expect(ankiTag('  Émile  ')).toBe('emile');
    expect(ankiTag('!!!')).toBe('');
  });
});

/**
 * The one record after the header. Not "the last line": a quoted field holds
 * line breaks, so a record is everything after the header lines, joined back.
 */
const record = (out: string): string =>
  out.split('\n').slice(ANKI_HEADER.length).join('\n').trimEnd();

describe('toAnkiTsv', () => {
  it('opens with the header lines Anki reads', () => {
    const lines = toAnkiTsv([], []).split('\n');
    expect(lines.slice(0, ANKI_HEADER.length)).toEqual(ANKI_HEADER);
    expect(ANKI_HEADER).toContain('#separator:tab');
    expect(ANKI_HEADER).toContain('#tags column:3');
  });

  it('writes one line per question: front, back, tags', () => {
    const out = toAnkiTsv([question()], [event(), event({ grade: 'forgot' })]);
    expect(record(out)).toBe(
      'What does an obstacle become?\tThe material of the work\twap kind:recall reps:2 lapses:1 last:good work:meditations',
    );
  });

  it('omits lapses and last when there is no history', () => {
    const line = toAnkiTsv([question({ work: null })], [])
      .trimEnd()
      .split('\n')
      .at(-1);
    expect(line?.split('\t')[2]).toBe('wap kind:recall reps:0');
  });

  it('tags the work', () => {
    expect(record(toAnkiTsv([question()], [])).split('\t')[2]).toContain('work:meditations');
  });

  it('lists the options of a choice question alphabetically, so the order says nothing', () => {
    const q = question({
      kind: 'mcq',
      distractors: ['A reason to stop', 'Someone else’s fault'],
    });
    const [front, back] = record(toAnkiTsv([q], [])).split('\t');
    // Three lines inside one field, so the field is quoted.
    expect(front).toBe(
      '"What does an obstacle become?\nA. A reason to stop\nB. Someone else’s fault\nC. The material of the work"',
    );
    expect(back).toBe('The material of the work');
  });

  it('never shows an ordering in its right order, even when that order sorts', () => {
    // "Collect, Plan, Review" is already alphabetical, so sorting alone would
    // have printed the answer on the front of the card.
    const q = question({ kind: 'ordering', answer: 'Collect\nPlan\nReview' });
    const [front, back] = record(toAnkiTsv([q], [])).split('\t');
    expect(front).not.toContain('• Collect\n• Plan\n• Review');
    expect(back).toContain('1. Collect\n2. Plan\n3. Review');
  });

  it('shows an ordering out of order on the front and in order on the back', () => {
    const q = question({ kind: 'ordering', answer: 'Observe\nHypothesise\nTest' });
    const [front, back] = record(toAnkiTsv([q], [])).split('\t');
    // Sorted, then rotated by one: reproducible with no seed, and never the
    // authored order.
    expect(front).toBe('"What does an obstacle become?\n• Observe\n• Test\n• Hypothesise"');
    expect(back).toBe('"1. Observe\n2. Hypothesise\n3. Test"');
  });

  it('puts the cloze sentence under the prompt and the explanation under the answer', () => {
    const q = question({
      kind: 'cloze',
      cloze: 'The impediment to action ____ action.',
      answer: 'advances',
      explanation: 'What stands in the way becomes the way.',
    });
    const [front, back] = record(toAnkiTsv([q], [])).split('\t');
    expect(front).toBe('"What does an obstacle become?\nThe impediment to action ____ action."');
    expect(back).toBe('"advances\n\nWhat stands in the way becomes the way."');
  });

  it('never lets a tab in the text break the columns', () => {
    const q = question({ prompt: 'Front\twith a tab', answer: 'Back "quoted"' });
    const fields = record(toAnkiTsv([q], [])).split('\t');
    expect(fields).toHaveLength(3);
    expect(fields[0]).toBe('Front with a tab');
    expect(fields[1]).toBe('"Back ""quoted"""');
  });

  it('skips a question with no prompt or no answer', () => {
    const out = toAnkiTsv([question({ prompt: ' ' }), question({ answer: '' })], []);
    expect(out.trimEnd().split('\n')).toHaveLength(ANKI_HEADER.length);
  });

  it('exports a kind it has never heard of as a plain card', () => {
    const line = toAnkiTsv([question({ kind: 'scenario' })], [])
      .trimEnd()
      .split('\n')
      .at(-1);
    expect(line?.split('\t')[0]).toBe('What does an obstacle become?');
    expect(line?.split('\t')[2]).toContain('kind:scenario');
  });
});

describe('toAnkiTsv: what a spreadsheet and an importer each do with a field', () => {
  it('quotes a field that begins with #, which Anki would otherwise read as metadata', () => {
    // The file stays valid and the card is silently dropped on import, which is
    // the worst shape of failure an export can have.
    const line = record(
      toAnkiTsv([question({ prompt: '#1 — what does an obstacle become?' })], []),
    );
    expect(line.startsWith('#')).toBe(false);
    expect(line.startsWith('"#1')).toBe(true);
  });

  it('does not defuse a formula field, because the card would show the apostrophe', () => {
    // Round 1 made this match the CSV, and consistency was the wrong goal: an
    // apostrophe a spreadsheet swallows is text that Anki renders, so the parity
    // fix put `'-40` and `'+1` on the face of a card a reader studies forever.
    const line = record(
      toAnkiTsv([question({ prompt: 'Celsius and Fahrenheit meet at ___', answer: '-40' })], []),
    );
    expect(line).toContain('\t-40\t');
    expect(line).not.toContain("'-40");

    // The CSV, whose consumer really is a spreadsheet, still defuses.
    expect(
      toCsvHighlights([{ source: 'A', idea: 'B', highlight: '=HYPERLINK("x")', note: null }]),
    ).toContain("'=HYPERLINK");
  });

  it('orders options the same way on every machine', () => {
    // `localeCompare` with no locale reads the runtime's, so the same deck came
    // out in two orders on two machines — and for an ordering card that changes
    // what is printed on the front. Codepoint order puts every capital before
    // every lowercase, on any runtime.
    const line = record(
      toAnkiTsv([question({ kind: 'mcq', answer: 'apple', distractors: ['Banana'] })], []),
    );
    expect(line.indexOf('Banana')).toBeLessThan(line.indexOf('apple'));
  });
});

describe('toStashMarkdown', () => {
  const when = new Date('2026-09-05T12:00:00Z');
  const stash = { name: 'Stoics', description: 'What I keep coming back to.' };
  const item = {
    headline: 'What blocks the way becomes the way',
    body: 'An obstruction is not only an interruption of the work.',
    whyItMatters: 'It reframes friction as material.',
    note: 'Re-read in winter.',
    work: { id: 'w-meditations', title: 'Meditations' },
  };

  it('is titled for the stash, dated, and carries the description', () => {
    const out = toStashMarkdown(stash, [item], when);
    expect(out.startsWith('# What a Pull — Stoics\n')).toBe(true);
    expect(out).toContain('Exported 2026-09-05.');
    expect(out).toContain('What I keep coming back to.');
  });

  /*
   * A setext underline is *a sequence of* `=` or `-`, and CommonMark says one is
   * enough. The escaper required two, so a lone marker on its own line survived —
   * and a public stash's description is written by whoever made the stash, not by
   * the reader downloading it. Left alone, `Read this first` followed by `=` renders
   * as an <h1> sibling of the document title and files the whole export under a
   * stranger's sentence.
   */
  it.each(['=', '-', '==', '--', '=  ', ' -'])(
    'escapes a %s underline so a description cannot become a heading',
    (underline) => {
      const out = toStashMarkdown(
        { name: 'Stoics', description: `Read this first\n${underline}\nrest` },
        [item],
        when,
      );
      // No line in the file is a bare run of `=` or `-`, which is what a setext
      // underline has to be to promote the line above it.
      const structural = out.split('\n').filter((l) => /^\s*[-=]+\s*$/u.test(l));
      expect(structural).toEqual([]);
      // The reader still sees both the sentence and the characters they typed.
      expect(out).toContain('Read this first');
      expect(out).toContain(`\\${underline.trim()[0]}`);
    },
  );

  it('still escapes the fences and leaves ordinary prose alone', () => {
    const out = toStashMarkdown(
      { name: 'Stoics', description: 'Fine prose — with an em dash, 2 - 3 items, a = b.' },
      [item],
      when,
    );
    expect(out).toContain('Fine prose — with an em dash, 2 - 3 items, a = b.');
  });

  it('says so plainly when the stash is empty', () => {
    expect(toStashMarkdown(stash, [], when)).toContain('Nothing in this stash yet.');
  });

  it('groups by source in first-seen order, one heading per Pull', () => {
    const out = toStashMarkdown(
      { name: 'Mixed', description: null },
      [
        { ...item, work: { id: 'w-walden', title: 'Walden' }, headline: 'Alone' },
        item,
        { ...item, work: { id: 'w-walden', title: 'Walden' }, headline: 'The cost' },
      ],
      when,
    );
    const headings = out.split('\n').filter((l) => l.startsWith('#'));
    expect(headings).toEqual([
      '# What a Pull — Mixed',
      '## Walden',
      '### Alone',
      '### The cost',
      '## Meditations',
      '### What blocks the way becomes the way',
    ]);
  });

  it('keeps two sources that share a title apart', () => {
    const out = toStashMarkdown(
      { name: 'Essays', description: null },
      [
        { ...item, work: { id: 'w-one', title: 'Selected Essays' }, headline: 'The first' },
        { ...item, work: { id: 'w-two', title: 'Selected Essays' }, headline: 'The second' },
      ],
      when,
    );
    const headings = out.split('\n').filter((l) => l.startsWith('#'));
    // Two works, two headings — titles are not unique in the schema.
    expect(headings).toEqual([
      '# What a Pull — Essays',
      '## Selected Essays',
      '### The first',
      '## Selected Essays',
      '### The second',
    ]);
  });

  it('does not collapse every deleted source into one', () => {
    const out = toStashMarkdown(
      { name: 'Orphans', description: null },
      [
        { ...item, work: { id: null, title: '' }, headline: 'One' },
        { ...item, work: { id: null, title: '' }, headline: 'Two' },
      ],
      when,
    );
    expect(out.split('## Unknown source').length - 1).toBe(2);
  });

  it("keeps the product's words plain and the reader's marked", () => {
    const out = toStashMarkdown(stash, [item], when);
    expect(out).toContain('\nAn obstruction is not only an interruption of the work.\n');
    expect(out).toContain('**Why it matters:** It reframes friction as material.');
    expect(out).toContain('**Note:**\n> Re-read in winter.');
  });

  it('says whose words are whose rather than leaving it to the absence of a marker', () => {
    const out = toStashMarkdown(stash, [item], when);
    expect(out).toContain('are What a Pull’s commentary on the source, not the source itself');
  });

  it('does not print a backslash in the reader’s own numbered list', () => {
    // CommonMark honours a backslash only before ASCII punctuation, so escaping the
    // DIGIT left `\1.` visible — in the one part of the file the export goes out of
    // its way to attribute to the reader. Escaping the period suppresses the list
    // and renders as `1.`.
    const out = toStashMarkdown(
      stash,
      [{ ...item, note: 'Three things:\n1. Name it.\n2. Ask what it is made of.' }],
      when,
    );
    expect(out).toContain('> 1\\. Name it.');
    expect(out).not.toContain('\\1.');
  });

  it('cannot be restructured by a setext underline, a fence, or any bullet', () => {
    // `---` and `===` make the PRECEDING line a heading, which is the same hijack
    // the `#` escape closes by a different character; a fence swallows every
    // section after it; and `*` and `+` are the other two bullet markers, missed
    // while `-` was escaped.
    const out = toStashMarkdown(
      stash,
      [{ ...item, note: 'A claim\n---\n```\nnot code\n```\n* star\n+ plus' }],
      when,
    );
    expect(out).not.toMatch(/^> ---$/m);
    expect(out).not.toMatch(/^> ```$/m);
    expect(out).toContain('> \\* star');
    expect(out).toContain('> \\+ plus');
  });

  it('escapes a description somebody else wrote', () => {
    // `stashes_read` is `visibility = 'public' or user_id = auth.uid()`, so a public
    // stash's description is not always the exporter's own words — and `## ` in it
    // opened a heading that is a sibling of every source heading in the file.
    const out = toStashMarkdown(
      { name: 'Shared', description: '## Injected heading' },
      [item],
      when,
    );
    expect(out).not.toMatch(/^## Injected heading$/m);
    expect(out).toContain('\\## Injected heading');
  });

  it('cannot be restructured by text the reader typed', () => {
    // A note containing a line of `## ` opened a peer of the source heading, so
    // everything after it in the file was filed under the reader's own words.
    const out = toStashMarkdown(
      stash,
      [{ ...item, note: 'First para.\n\n## A heading I typed\n\nSecond para.' }],
      when,
    );
    expect(out).not.toMatch(/^## A heading I typed$/m);
    expect(out).toContain('> \\## A heading I typed');

    // And a headline with a newline in it no longer breaks its own `###`.
    const broken = toStashMarkdown(stash, [{ ...item, headline: 'One line\n# Another' }], when);
    expect(broken).toContain('### One line \\# Another');
    expect(broken).not.toMatch(/^# Another$/m);
  });

  it('exports without a date rather than throwing on one it cannot read', () => {
    // `toISOString` raises RangeError on an Invalid Date, and it was the only
    // throw in a module of pure string builders.
    const out = toStashMarkdown(stash, [item], new Date(Number.NaN));
    expect(out).toContain('Exported.');
    expect(out).toContain('## Meditations');
  });

  it('leaves out an empty note or reason rather than printing a blank one', () => {
    const out = toStashMarkdown(stash, [{ ...item, note: '  ', whyItMatters: null }], when);
    expect(out).not.toContain('**Note:**');
    expect(out).not.toContain('**Why it matters:**');
  });

  it('accepts a stash with no description', () => {
    const out = toStashMarkdown({ name: 'Bare', description: null }, [item], when);
    expect(out).toContain('# What a Pull — Bare');
    expect(out).toContain('## Meditations');
  });
});
