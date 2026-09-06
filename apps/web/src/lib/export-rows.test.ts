import { describe, expect, it } from 'vitest';
import {
  ankiDeck,
  exportFilename,
  exportSlug,
  reviewEvents,
  stashExportItems,
  stashExportSources,
  type QuizQuestionRow,
  type RecallEventRow,
  type UserQuestionRow,
} from './export-rows.js';
import {
  flattenHighlights,
  toAnkiTsv,
  toCsvHighlights,
  toStashMarkdown,
} from './export-formats.js';
import type { Highlight } from './highlights.js';
import type { LibraryItem } from './types.js';

/**
 * The mapping between what the database returns and what the file builders take.
 *
 * `export-formats.test.ts` proves the files are well formed given the right
 * shapes; these prove the shapes are right — which is the half where an export
 * loses something, misattributes it, or carries a value no importer can read.
 */

const item = (over: Partial<LibraryItem> = {}): LibraryItem => ({
  id: 'pull-1',
  headline: 'The cost of a thing',
  body: 'The amount of life exchanged for it.',
  whyItMatters: null,
  explanation: null,
  example: null,
  savedAt: '2026-09-01T00:00:00Z',
  work: { id: 'work-1', title: 'Walden', kind: 'book' },
  saveId: 'save-1',
  stashId: null,
  note: null,
  archived: false,
  readLater: false,
  ...over,
});

const highlight = (over: Partial<Highlight> = {}): Highlight => ({
  id: 'h-1',
  pullId: 'pull-1',
  field: 'body',
  start: 0,
  end: 4,
  text: 'The',
  ...over,
});

describe('stashExportItems', () => {
  it('carries the Pull, the reader’s note and the work through', () => {
    expect(
      stashExportItems([item({ whyItMatters: 'It is the whole argument.', note: 'Reread this.' })]),
    ).toEqual([
      {
        headline: 'The cost of a thing',
        body: 'The amount of life exchanged for it.',
        whyItMatters: 'It is the whole argument.',
        note: 'Reread this.',
        work: { id: 'work-1', title: 'Walden' },
      },
    ]);
  });

  /*
   * The one that would be silent. `fetchLibrary` fills an absent work with
   * `{ id: '', title: 'Unknown source' }`, and `toStashMarkdown` groups by
   * `work.id ?? …` — which an empty string satisfies. Passed straight through,
   * two saves from two different removed sources land under one heading.
   */
  it('turns an empty work id into null, so two orphans stay two sources', () => {
    const orphans = stashExportItems([
      item({ id: 'a', headline: 'One', work: { id: '', title: 'Unknown source', kind: null } }),
      item({ id: 'b', headline: 'Two', work: { id: '', title: 'Unknown source', kind: null } }),
    ]);
    expect(orphans.map((o) => o.work.id)).toEqual([null, null]);

    const md = toStashMarkdown(
      { name: 'Gone', description: null },
      orphans,
      new Date('2026-09-06'),
    );
    expect(md.match(/^## /gm)).toHaveLength(2);
  });

  it('keeps a real work id, so two saves from one book share a heading', () => {
    const md = toStashMarkdown(
      { name: 'Walden', description: null },
      stashExportItems([item({ id: 'a', headline: 'One' }), item({ id: 'b', headline: 'Two' })]),
      new Date('2026-09-06'),
    );
    expect(md.match(/^## /gm)).toHaveLength(1);
    expect(md.match(/^### /gm)).toHaveLength(2);
  });
});

describe('stashExportSources', () => {
  it('groups by work identity rather than by title', () => {
    const sources = stashExportSources(
      [
        item({ id: 'a', work: { id: 'w1', title: 'Essays', kind: 'book' } }),
        item({ id: 'b', work: { id: 'w2', title: 'Essays', kind: 'book' } }),
      ],
      new Map(),
    );
    expect(sources).toHaveLength(2);
  });

  it('orders a Pull’s highlights by field and offset, not by the id they arrived in', () => {
    const sources = stashExportSources(
      [item()],
      new Map([
        [
          'pull-1',
          [
            highlight({ id: 'zzz', field: 'why_it_matters', start: 0, end: 3, text: 'why' }),
            highlight({ id: 'mmm', field: 'body', start: 90, end: 94, text: 'late' }),
            highlight({ id: 'aaa', field: 'body', start: 10, end: 15, text: 'early' }),
          ],
        ],
      ]),
    );
    expect(sources[0]?.ideas[0]?.highlights).toEqual(['early', 'late', 'why']);
  });

  it('gives a saved Pull with no highlight and no note no CSV row, and one with a note a row', () => {
    const rows = flattenHighlights(
      stashExportSources(
        [item({ id: 'a', headline: 'Bare' }), item({ id: 'b', headline: 'Noted', note: 'mine' })],
        new Map(),
      ),
    );
    expect(rows).toEqual([{ source: 'Walden', idea: 'Noted', highlight: '', note: 'mine' }]);
  });

  it('names a work with no title, so a CSV cell is never blank where a source belongs', () => {
    const sources = stashExportSources(
      [item({ work: { id: '', title: '   ', kind: null } })],
      new Map(),
    );
    expect(sources[0]?.title).toBe('Unknown source');
  });
});

describe('exportSlug', () => {
  it('reduces a reader’s name to something a filename can hold', () => {
    expect(exportSlug('Books I Keep Meaning To Reread')).toBe('books-i-keep-meaning-to-reread');
    expect(exportSlug('Économie / Politique')).toBe('economie-politique');
  });

  it('never returns a slash, a dot segment or an empty string', () => {
    expect(exportSlug('../../etc/passwd')).toBe('etc-passwd');
    expect(exportSlug('   ')).toBe('collection');
    expect(exportSlug('🙂')).toBe('collection');
  });

  it('bounds the length and leaves no trailing hyphen behind', () => {
    // 59 a's, a hyphen at 60, then more — so the slice lands exactly on the
    // hyphen and the trailing-hyphen trim is the thing under test.
    const slug = exportSlug(`${'a'.repeat(59)} bbbb`);
    expect(slug).toBe('a'.repeat(59));
    expect(exportSlug('a'.repeat(80))).toHaveLength(60);
  });
});

describe('exportFilename', () => {
  it('names the product, the thing and the day', () => {
    expect(exportFilename(['walden'], 'md', new Date('2026-09-06T12:00:00Z'))).toBe(
      'what-a-pull-walden-2026-09-06.md',
    );
  });

  /* `toISOString` throws a RangeError on an Invalid Date, and the throw would
     take the download with it rather than the date. */
  it('survives an invalid date rather than throwing the download away', () => {
    expect(exportFilename(['anki'], 'tsv', new Date(Number.NaN))).toBe(
      'what-a-pull-anki-undated.tsv',
    );
  });
});

describe('ankiDeck', () => {
  const canonical = (over: Partial<QuizQuestionRow> = {}): QuizQuestionRow => ({
    id: 'q-1',
    pull_id: 'pull-1',
    kind: 'recall',
    prompt: 'What did he count?',
    answer: 'The cost in life.',
    distractors: [],
    ...over,
  });

  const own = (over: Partial<UserQuestionRow> = {}): UserQuestionRow => ({
    id: 'u-1',
    pull_id: 'pull-1',
    kind: 'recall',
    prompt: 'Why does this stay with me?',
    answer: 'Because it is a ledger.',
    options: [],
    ...over,
  });

  it('puts the reader’s own questions first and carries the work title as a tag', () => {
    const deck = ankiDeck(
      [{ pullId: 'pull-1', workTitle: 'Walden', questions: [canonical()] }],
      [own()],
      new Map([['pull-1', 'Walden']]),
    );
    expect(deck.map((q) => q.id)).toEqual(['u-1', 'q-1']);
    expect(toAnkiTsv(deck, [])).toContain('work:walden');
  });

  it('drops one of the reader’s questions that has no answer', () => {
    const deck = ankiDeck([], [own({ answer: null }), own({ id: 'u-2' })], new Map());
    expect(deck.map((q) => q.id)).toEqual(['u-2']);
  });

  /*
   * `distractors` and `options` are `jsonb` with `jsonb_typeof(...) = 'array'`
   * and no element type, so a number or an object is a legal row. Anki would
   * have printed `[object Object]` onto the face of a card.
   */
  it('keeps only the strings of a jsonb array', () => {
    const deck = ankiDeck(
      [
        {
          pullId: 'pull-1',
          workTitle: null,
          questions: [
            canonical({ kind: 'mcq', distractors: ['a real one', 7, null, { nested: true }] }),
          ],
        },
      ],
      [own({ kind: 'mcq', options: 'not an array' })],
      new Map(),
    );
    expect(deck.find((q) => q.id === 'q-1')?.distractors).toEqual(['a real one']);
    expect(deck.find((q) => q.id === 'u-1')?.distractors).toEqual([]);
  });

  it('lists a reader’s own MCQ once even though `options` repeats the answer', () => {
    const deck = ankiDeck(
      [],
      [own({ kind: 'mcq', answer: 'Ledger', options: ['Ledger', 'Diary'] })],
      new Map(),
    );
    // The front carries newlines, so `tsvField` quotes it and the record spans
    // more than one physical line — it is everything after the four header lines.
    const record = toAnkiTsv(deck, []).split('\n').slice(4, -1).join('\n');
    expect(record.split('\t')[0]).toBe('"Why does this stay with me?\nA. Diary\nB. Ledger"');
  });

  it('falls back to no work tag rather than inventing one', () => {
    const deck = ankiDeck([], [own()], new Map());
    expect(deck[0]?.work).toBeNull();
    expect(toAnkiTsv(deck, [])).not.toContain('work:');
  });
});

describe('reviewEvents', () => {
  const event = (over: Partial<RecallEventRow> = {}): RecallEventRow => ({
    pull_id: 'pull-1',
    quiz_question_id: null,
    user_question_id: null,
    kind: 'review',
    grade: 'good',
    applied_at: '2026-09-01T00:00:00Z',
    submitted_at: null,
    ...over,
  });

  it('names whichever question column is set', () => {
    expect(
      reviewEvents([
        event({ quiz_question_id: 'q-1' }),
        event({ user_question_id: 'u-1' }),
        event(),
      ]).map((e) => e.questionId),
    ).toEqual(['q-1', 'u-1', null]);
  });

  it('drops a grade this build cannot name', () => {
    expect(reviewEvents([event({ grade: 'brilliant' })])).toEqual([]);
    expect(reviewEvents([event({ grade: 'forgot' })])).toHaveLength(1);
  });

  /*
   * ONLY THE KINDS THAT ARE AN ATTEMPT TO REMEMBER SOMETHING.
   *
   * Review finding. `recall_events_kind_known` permits seven and four of them are not
   * retrieval: `conviction` and `counterpull` record a belief, `delta_probe` asks whether
   * the reader already knows an idea, and `calibration` is the census asking them to
   * declare it. Every one carries a null question id, which is the shape
   * `summariseHistory` spreads across EVERY question on the Pull -- so a reader who used
   * the census once exported `reps` and `lapses` claiming study they never did, and a
   * `last:` tag from an answer to a different question entirely.
   */
  it('counts only retrieval, not what a reader declared', () => {
    expect(
      reviewEvents([
        event({ kind: 'review' }),
        event({ kind: 'recall' }),
        event({ kind: 'say_it_back' }),
      ]),
    ).toHaveLength(3);
    for (const kind of ['calibration', 'conviction', 'counterpull', 'delta_probe']) {
      expect(reviewEvents([event({ kind })])).toEqual([]);
    }
  });

  /*
   * WHEN THE READER ANSWERED, NOT WHEN THE ROW WAS WRITTEN.
   *
   * Review finding. `applied_at` defaults to `now()` at insert, and a grade taken offline
   * is inserted whenever the device next reaches the server -- which `lib/offline.ts`
   * makes routine. Reading it makes a queued answer that lands after a newer one the
   * `last:` tag, so the deck says a reader is failing a card they have since got right.
   */
  it('prefers submitted_at, and falls back for rows written before the column existed', () => {
    expect(
      reviewEvents([
        event({ submitted_at: '2026-09-01T09:00:00Z', applied_at: '2026-09-03T00:00:00Z' }),
      ])[0]?.appliedAt,
    ).toBe('2026-09-01T09:00:00Z');
    expect(reviewEvents([event({ submitted_at: null })])[0]?.appliedAt).toBe(
      '2026-09-01T00:00:00Z',
    );
  });

  /*
   * The whole point of carrying the history: a free-recall grade names no
   * question and counts towards every question on its Pull, so a reader who was
   * reviewing before they wrote a question gets a deck that knows it.
   */
  it('feeds `toAnkiTsv` counts that reach the card', () => {
    const deck = ankiDeck(
      [
        {
          pullId: 'pull-1',
          workTitle: 'Walden',
          questions: [
            {
              id: 'q-1',
              pull_id: 'pull-1',
              kind: 'recall',
              prompt: 'What did he count?',
              answer: 'The cost in life.',
              distractors: [],
            },
          ],
        },
      ],
      [],
      new Map(),
    );
    const tags = toAnkiTsv(
      deck,
      reviewEvents([
        event(),
        event({ grade: 'forgot', applied_at: '2026-09-02T00:00:00Z' }),
        event({ pull_id: 'other', grade: 'easy', applied_at: '2026-09-03T00:00:00Z' }),
      ]),
    )
      .split('\n')
      .at(-2)
      ?.split('\t')[2];
    expect(tags).toBe('wap kind:recall reps:2 lapses:1 last:forgot work:walden');
  });
});

describe('the file an importer actually sees', () => {
  /*
   * An Anki TSV that Anki will not import is the failure this export exists to
   * avoid, so the header and the record shape are asserted rather than assumed:
   * four `#` metadata lines, then one three-column record per card, and no bare
   * tab or newline inside a field to end it early.
   */
  it('is four header lines and three tab-separated columns per card', () => {
    const deck = ankiDeck(
      [],
      [
        {
          id: 'u-1',
          pull_id: 'pull-1',
          kind: 'recall',
          prompt: 'A prompt\twith a tab',
          answer: 'An answer\nover two lines',
          options: [],
        },
      ],
      new Map(),
    );
    const lines = toAnkiTsv(deck, []).split('\n');
    expect(lines.slice(0, 4)).toEqual([
      '#separator:tab',
      '#html:false',
      '#deck:What a Pull',
      '#tags column:3',
    ]);
    // The answer's newline is inside a quoted field, so the record spans two
    // physical lines and still has three columns.
    const record = lines.slice(4, -1).join('\n');
    expect(record.split('\t')).toHaveLength(3);
    expect(record.split('\t')[0]).toBe('A prompt with a tab');
    expect(record.split('\t')[1]).toBe('"An answer\nover two lines"');
  });

  it('writes a CSV a spreadsheet opens as text rather than as a formula', () => {
    const csv = toCsvHighlights(
      flattenHighlights(
        stashExportSources(
          [item()],
          new Map([['pull-1', [highlight({ text: '=HYPERLINK("http://x","click")' })]]]),
        ),
      ),
    );
    expect(csv).toContain(`"'=HYPERLINK(""http://x"",""click"")"`);
  });
});
