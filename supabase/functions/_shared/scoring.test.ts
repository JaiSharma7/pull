import { describe, expect, it } from 'vitest';
import { qualityFromDraft, questionsToWrite, trustFromProvenance } from './pipeline.ts';

/**
 * The two numbers that were never written.
 *
 * `works.quality_score` and `works.trust_score` are 0.24 of `get_feed`'s score
 * combined, and no pipeline step ever set either — so every generated work sat
 * at the 0.5 default while the six hand-seeded ones carried real values. A
 * quarter of the ranking was a constant.
 *
 * Both are deterministic on purpose. This runs at generation time, where law 2
 * would permit a model — but a provenance judgement that varies between two runs
 * over the same URL is not a judgement, it is noise with a decimal point. That
 * property is what these tests are really pinning down.
 */

describe('trustFromProvenance', () => {
  it('trusts a known public-domain archive most', () => {
    expect(trustFromProvenance('public_domain', 'https://www.gutenberg.org/files/1/1.txt')).toBe(
      0.9,
    );
    expect(trustFromProvenance('public_domain', 'https://en.wikisource.org/wiki/X')).toBe(0.9);
    expect(trustFromProvenance('public_domain', 'http://classics.mit.edu/Plato/x.html')).toBe(0.9);
  });

  it('trusts the same rights claim less from an arbitrary host', () => {
    expect(trustFromProvenance('public_domain', 'https://some-blog.example/x')).toBe(0.7);
  });

  it('matches a subdomain but not a lookalike', () => {
    expect(trustFromProvenance('public_domain', 'https://mirror.gutenberg.org/a')).toBe(0.9);
    // The check must not be a substring test: this host is not Gutenberg.
    expect(trustFromProvenance('public_domain', 'https://gutenberg.org.evil.test/a')).toBe(0.7);
  });

  it('does not extend archive.org trust to the Wayback Machine', () => {
    /*
     * `web.archive.org` serves an archived copy of *any* site under an
     * archive.org hostname, so the suffix rule handed the maximum score to a URL
     * whose host says nothing about the text behind it. archive.org's own
     * collections still earn it.
     */
    expect(trustFromProvenance('public_domain', 'https://archive.org/details/x')).toBe(0.9);
    expect(trustFromProvenance('public_domain', 'https://ia801504.us.archive.org/x.txt')).toBe(0.9);
    expect(
      trustFromProvenance('public_domain', 'https://web.archive.org/web/2020/https://any.example/'),
    ).toBe(0.7);
  });

  it('puts anything awaiting a rights decision at the bottom', () => {
    expect(trustFromProvenance('review_required', 'https://www.gutenberg.org/x')).toBe(0.3);
  });

  it('survives a missing or unparseable url instead of throwing', () => {
    expect(trustFromProvenance('public_domain', null)).toBe(0.7);
    expect(trustFromProvenance('public_domain', 'not a url')).toBe(0.7);
  });

  it('is a pure function of its inputs', () => {
    const a = trustFromProvenance('public_domain', 'https://www.gutenberg.org/x');
    const b = trustFromProvenance('public_domain', 'https://www.gutenberg.org/x');
    expect(a).toBe(b);
  });
});

describe('qualityFromDraft', () => {
  const pull = (body = 'x'.repeat(400), whyItMatters = 'because') => ({ body, whyItMatters });

  it('scores a full, well-formed draft high', () => {
    const score = qualityFromDraft({
      pulls: Array.from({ length: 10 }, () => pull()),
      topics: ['philosophy'],
    });
    expect(score).toBeGreaterThan(0.9);
  });

  it('ranks a thin draft below the 0.5 default it replaces', () => {
    // The whole point: writing these scores has to be able to rank a weak
    // generated work BELOW the seeded corpus, or it changes nothing.
    const score = qualityFromDraft({ pulls: [pull('short')], topics: [] });
    expect(score).toBeLessThan(0.5);
  });

  it('penalises a draft nothing classified, because preferences cannot reach it', () => {
    const withTopics = qualityFromDraft({
      pulls: Array.from({ length: 10 }, () => pull()),
      topics: ['philosophy'],
    });
    const without = qualityFromDraft({
      pulls: Array.from({ length: 10 }, () => pull()),
      topics: [],
    });
    expect(without).toBeLessThan(withTopics);
  });

  it('penalises padding, not only thinness', () => {
    // The comment always said "more is usually the model padding"; the term
    // saturated at eight and could not say it. Forty ideas must rank below
    // ten, and ten must not be punished for being more than eight.
    const ten = qualityFromDraft({
      pulls: Array.from({ length: 10 }, () => pull()),
      topics: ['a'],
    });
    const fourteen = qualityFromDraft({
      pulls: Array.from({ length: 14 }, () => pull()),
      topics: ['a'],
    });
    const forty = qualityFromDraft({
      pulls: Array.from({ length: 40 }, () => pull()),
      topics: ['a'],
    });
    expect(fourteen).toBe(ten);
    expect(forty).toBeLessThan(ten);
    // Not so steep that a slightly long draft ranks with a thin one.
    const twenty = qualityFromDraft({
      pulls: Array.from({ length: 20 }, () => pull()),
      topics: ['a'],
    });
    const three = qualityFromDraft({
      pulls: Array.from({ length: 3 }, () => pull()),
      topics: ['a'],
    });
    expect(twenty).toBeGreaterThan(three);
  });

  it('penalises bodies outside a readable band in either direction', () => {
    const good = qualityFromDraft({ pulls: [pull('x'.repeat(400))], topics: ['a'] });
    const tooShort = qualityFromDraft({ pulls: [pull('x'.repeat(50))], topics: ['a'] });
    const tooLong = qualityFromDraft({ pulls: [pull('x'.repeat(5000))], topics: ['a'] });
    expect(tooShort).toBeLessThan(good);
    expect(tooLong).toBeLessThan(good);
  });

  it('penalises ideas that never say why they matter', () => {
    const explained = qualityFromDraft({
      pulls: [pull('x'.repeat(400), 'because')],
      topics: ['a'],
    });
    const bare = qualityFromDraft({ pulls: [pull('x'.repeat(400), '')], topics: ['a'] });
    expect(bare).toBeLessThan(explained);
  });

  it('never leaves the range the column accepts', () => {
    // `quality_score` is a `real not null`; a value outside [0,1] would rank
    // wrongly rather than fail, which is the harder kind of bug to see.
    const cases = [
      { pulls: [], topics: [] },
      { pulls: Array.from({ length: 400 }, () => pull()), topics: ['a', 'b', 'c', 'd'] },
      { pulls: [pull('')], topics: undefined },
    ];
    for (const c of cases) {
      const score = qualityFromDraft(c);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }
  });

  it('tolerates `topics` arriving as something other than an array', () => {
    // It is read off a stored step output, so it has been through JSON and back.
    expect(() =>
      qualityFromDraft({ pulls: [pull()], topics: 'philosophy' as unknown as string[] }),
    ).not.toThrow();
  });
});

/**
 * The recall questions, and what is allowed to reach Postgres.
 *
 * `quiz_questions` has been read by `get_due_reviews` since round 1 and written
 * by nothing: six seeded rows against 156 pulls, while `recall` is 45% of the
 * interrupt distribution. So Interleaved Recall — the mechanic this product is
 * built on — had nothing to ask about 96% of the library.
 */
describe('questionsToWrite', () => {
  const written = [
    { ordinal: 0, id: 'p0' },
    { ordinal: 1, id: 'p1' },
  ];

  /** A pull carrying ONE question in the singular shape a provider used to return. */
  const q = (over: Record<string, unknown> = {}) => ({
    question: { prompt: 'Why?', answer: 'Because.', distractors: ['a', 'b', 'c'], ...over },
  });

  /** What the singular shape now becomes: a `recall` row with the new columns empty. */
  const asRow = (over: Record<string, unknown> = {}) => ({
    pullId: 'p0',
    kind: 'recall',
    prompt: 'Why?',
    answer: 'Because.',
    distractors: ['a', 'b', 'c'],
    cloze: null,
    explanation: null,
    rationale: [],
    ...over,
  });

  it('pairs a question to the Pull that was actually written', () => {
    expect(questionsToWrite([q(), q()], written)).toEqual([asRow(), asRow({ pullId: 'p1' })]);
  });

  it('pairs by ordinal, not by array position', () => {
    // `insertPulls` returns ordinals for exactly this reason. A question attached
    // to the wrong idea is invisible and permanent.
    const shuffled = [
      { ordinal: 1, id: 'second' },
      { ordinal: 0, id: 'first' },
    ];
    expect(questionsToWrite([q({ prompt: 'A' }), q({ prompt: 'B' })], shuffled)).toEqual([
      asRow({ pullId: 'first', prompt: 'A' }),
      asRow({ pullId: 'second', prompt: 'B' }),
    ]);
  });

  it('skips a Pull with no question rather than writing an empty one', () => {
    expect(questionsToWrite([{}, q()], written)).toEqual([asRow({ pullId: 'p1' })]);
  });

  it('drops a question missing either half', () => {
    // The half-formed row is the dangerous one: `get_due_reviews` copes with a
    // Pull that has no question and cannot cope with one whose answer is "".
    expect(questionsToWrite([q({ prompt: '   ' })], written)).toEqual([]);
    expect(questionsToWrite([q({ answer: undefined })], written)).toEqual([]);
    expect(questionsToWrite([q({ prompt: 42 })], written)).toEqual([]);
  });

  it('trims, so whitespace never becomes a prompt', () => {
    expect(questionsToWrite([q({ prompt: '  Why?  ' })], written)[0]?.prompt).toBe('Why?');
  });

  it('keeps only string distractors, and tolerates a missing list', () => {
    expect(questionsToWrite([q({ distractors: ['a', 7, '', null, 'b'] })], written)[0]).toEqual(
      asRow({ distractors: ['a', 'b'] }),
    );
    expect(questionsToWrite([q({ distractors: undefined })], written)[0]?.distractors).toEqual([]);
  });

  // ----------------------------------------------------------------- the array

  /** A pull carrying the plural shape. */
  const qs = (...questions: Record<string, unknown>[]) => ({ questions });

  const recall = { kind: 'recall', prompt: 'Why?', answer: 'Because.' };
  const mcq = {
    kind: 'mcq',
    prompt: 'Which?',
    answer: 'This one.',
    distractors: ['wrong a', 'wrong b'],
    rationale: [{ distractor: 'wrong a', why: 'it reverses the direction' }],
  };
  const cloze = {
    kind: 'cloze',
    prompt: 'Fill the blank.',
    answer: 'material',
    cloze: 'The obstacle is the ____.',
  };

  it('writes every kind a Pull offers', () => {
    const out = questionsToWrite([qs(recall, mcq, cloze)], written);
    expect(out.map((r) => r.kind)).toEqual(['recall', 'mcq', 'cloze']);
    expect(out.every((r) => r.pullId === 'p0')).toBe(true);
  });

  it('keeps only the first question of each kind', () => {
    // `quiz_questions_pull_kind_key` is unique on `(pull_id, kind)` and the insert
    // upserts on that pair. Postgres refuses a statement whose conflict target is
    // hit twice -- "ON CONFLICT DO UPDATE command cannot affect row a second time"
    // -- which fails the whole batch, not the duplicate. So the duplicate must not
    // reach the insert at all.
    const out = questionsToWrite([qs(recall, { ...recall, prompt: 'Second try?' })], written);
    expect(out).toHaveLength(1);
    expect(out[0]?.prompt).toBe('Why?');
  });

  it('refuses an mcq that cannot be got wrong', () => {
    // `quiz_questions_mcq_has_distractors` wants two. Dropping it here rather than
    // letting the database refuse it is the difference between losing one question
    // and losing every question on a summary already paid for.
    expect(questionsToWrite([qs({ ...mcq, distractors: ['only one'] })], written)).toEqual([]);
    expect(questionsToWrite([qs({ ...mcq, distractors: [] })], written)).toEqual([]);
  });

  it('refuses a cloze with no blank to fill', () => {
    expect(questionsToWrite([qs({ ...cloze, cloze: '   ' })], written)).toEqual([]);
    expect(questionsToWrite([qs({ ...cloze, cloze: undefined })], written)).toEqual([]);
  });

  it('bounds the distractors by BYTES as well as by count', () => {
    // The count bound and the byte bound are separate constraints
    // (`quiz_questions_distractors_shape`: at most eight entries AND
    // `length(distractors::text) <= 20000`), and only the count was enforced. Four
    // entries of 6,000 characters is well under eight and 24,000 characters of jsonb --
    // a 23514 that `insertQuizQuestions` turns into the loss of every question on a
    // summary `synthesize` has already been paid for.
    const huge = Array.from({ length: 4 }, (_, i) => 'x'.repeat(6_000) + i);
    const out = questionsToWrite([qs({ ...mcq, distractors: huge })], written);
    expect(out).toHaveLength(1);
    expect(JSON.stringify(out[0]?.distractors).length).toBeLessThanOrEqual(20_000);
    // Trimmed from the END, so the model's best distractors are the ones kept.
    expect(out[0]?.distractors[0]).toBe(huge[0]);
  });

  it('drops an mcq that the byte bound leaves with one option', () => {
    // Trimming for size can take a question below the floor at which it can be got
    // wrong, and then it must go the same way as one that arrived that way -- rather
    // than being stored as a multiple choice with a single button on it.
    const two = Array.from({ length: 2 }, (_, i) => 'x'.repeat(15_000) + i);
    expect(questionsToWrite([qs({ ...mcq, distractors: two })], written)).toEqual([]);
  });

  it('bounds the rationale by bytes too, and only after the distractors are final', () => {
    // Same pair of constraints on `rationale`. The ordering matters as much as the
    // bound: the rationale is filtered against the distractors that survived, so
    // trimming the distractors afterwards would leave entries naming options the
    // question no longer offers.
    const ds = ['wrong a', 'wrong b'];
    const fat = ds.map((d) => ({ distractor: d, why: 'y'.repeat(12_000) }));
    const out = questionsToWrite([qs({ ...mcq, distractors: ds, rationale: fat })], written);
    expect(out).toHaveLength(1);
    expect(JSON.stringify(out[0]?.rationale).length).toBeLessThanOrEqual(20_000);
    for (const r of out[0]?.rationale ?? []) expect(ds).toContain(r.distractor);
  });

  it('never lets the answer sit among its own distractors', () => {
    // A model that lists every option rather than the wrong ones would otherwise
    // make `mcqOptions` render the right answer twice, one of them marked wrong.
    const out = questionsToWrite(
      [qs({ ...mcq, distractors: ['This one.', 'wrong a', 'wrong b'] })],
      written,
    );
    expect(out[0]?.distractors).toEqual(['wrong a', 'wrong b']);
  });

  it('drops a rationale for an option the question does not offer', () => {
    // `whyWrong` matches on `distractor`, so one naming an absent option could
    // never fire. Keeping it would be a row that promises an explanation the
    // screen cannot show.
    const out = questionsToWrite(
      [
        qs({
          ...mcq,
          rationale: [
            { distractor: 'wrong a', why: 'kept' },
            { distractor: 'not an option', why: 'dropped' },
            { distractor: 'wrong b', why: '' },
          ],
        }),
      ],
      written,
    );
    expect(out[0]?.rationale).toEqual([{ distractor: 'wrong a', why: 'kept' }]);
  });

  it('files an unknown kind as recall rather than dropping the question', () => {
    // `quiz_questions_kind_known` would refuse the row and take the batch with it.
    // The prompt and answer are usable; only the claim about the form is lost.
    const out = questionsToWrite([qs({ ...recall, kind: 'interpretive_dance' })], written);
    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe('recall');
  });

  it('clears a cloze sentence off a kind that is not a cloze', () => {
    const out = questionsToWrite([qs({ ...recall, cloze: 'The obstacle is the ____.' })], written);
    expect(out[0]?.cloze).toBeNull();
  });

  it('keeps a question the database bounds would refuse from killing the batch', () => {
    // `insertQuizQuestions` writes the batch in one statement, so a row that violates a
    // CHECK takes every good question on the summary with it -- at `cards`, after
    // synthesis has been paid for, and again on every `resume` from the persisted step
    // output. Each rule below is one `20260905120000` enforces.
    const wide = questionsToWrite(
      [
        qs({
          ...mcq,
          distractors: Array.from({ length: 12 }, (_, i) => `wrong ${i}`),
          rationale: Array.from({ length: 12 }, (_, i) => ({
            distractor: `wrong ${i}`,
            why: 'because',
          })),
          explanation: 'x'.repeat(2001),
        }),
      ],
      written,
    );
    expect(wide[0]?.distractors).toHaveLength(8);
    expect(wide[0]?.rationale).toHaveLength(8);
    // Supplementary, so the question survives without it.
    expect(wide[0]?.explanation).toBeNull();

    // A prompt or an answer past the bound is the question, not a decoration, so the
    // question goes rather than being asked in half.
    expect(questionsToWrite([qs({ ...recall, prompt: 'x'.repeat(2001) })], written)).toEqual([]);
    expect(questionsToWrite([qs({ ...recall, answer: 'x'.repeat(2001) })], written)).toEqual([]);

    // A cloze longer than the column takes cannot be cut safely -- the blank may be in
    // the part removed.
    expect(
      questionsToWrite([qs({ ...cloze, cloze: `${'x'.repeat(1001)} ____` })], written),
    ).toEqual([]);
  });

  it('reads the singular field only when the array is absent', () => {
    // A step output PERSISTED BY AN EARLIER BUILD comes back with `question` and no
    // `questions`; `resume` replays exactly that. When both are present the array
    // wins, because it is the shape the current provider returns.
    const both = { ...qs(mcq), question: { prompt: 'Old', answer: 'Older' } };
    expect(questionsToWrite([both], written).map((r) => r.kind)).toEqual(['mcq']);
    expect(
      questionsToWrite([{ questions: [], question: { prompt: 'Old', answer: 'Older' } }], written),
    ).toEqual([]);
  });

  it('drops a question whose Pull was never written', () => {
    expect(questionsToWrite([q(), q(), q()], [{ ordinal: 0, id: 'p0' }])).toHaveLength(1);
  });

  /*
   * THE THREE CODEX FOUND, each of which ends the same way: `insertQuizQuestions` upserts
   * the batch in ONE statement, so a single row Postgres refuses loses every question on
   * a summary `synthesize` has already been paid for, and `resume` replays from the
   * persisted step output so it fails identically on every retry.
   */
  it('measures a jsonb bound the way Postgres renders it, objects included', () => {
    /*
     * Third statement of this bound. `JSON.stringify` was short by the space after every
     * ARRAY separator; adding one per element was short by the spaces jsonb puts after
     * every colon and every member comma inside an OBJECT, which is what `rationale`
     * holds. Codex's example verbatim: a rationale whose compact JSON is exactly 20,000
     * renders as 20,003 and violates `quiz_questions_rationale_shape`.
     *
     * `jsonbTextLength` walks the value rather than adjusting for a shape, and was
     * checked against `length(x::jsonb::text)` on seven shapes -- arrays, objects,
     * embedded quotes and newlines -- rather than derived a third time.
     */
    const shell = JSON.stringify([{ distractor: 'a', why: '' }]).length;
    const why = 'w'.repeat(20_000 - shell);
    const atTheCompactBound = [{ distractor: 'a', why }];
    expect(JSON.stringify(atTheCompactBound)).toHaveLength(20_000);

    const kept = questionsToWrite(
      [
        {
          questions: [
            {
              kind: 'mcq',
              prompt: 'Which?',
              answer: 'this',
              distractors: ['a', 'b'],
              rationale: atTheCompactBound,
            },
          ],
        },
      ],
      written,
    );
    // Dropped: it fits `JSON.stringify` and does not fit the column.
    expect(kept[0]?.rationale).toEqual([]);
    // Three characters smaller and it fits both, so the bound is a bound and not a ban.
    const ok = questionsToWrite(
      [
        {
          questions: [
            {
              kind: 'mcq',
              prompt: 'Which?',
              answer: 'this',
              distractors: ['a', 'b'],
              rationale: [{ distractor: 'a', why: why.slice(0, -3) }],
            },
          ],
        },
      ],
      written,
    );
    expect(ok[0]?.rationale).toHaveLength(1);
  });

  it('trims and dedupes the options before it counts them', () => {
    // Round three of 3a at a different layer: `[1, 2]` satisfied an element count while
    // the client filter dropped both. Here it is whitespace and repeats -- two entries by
    // count, one option after `mcqOptions` trims and dedupes against the answer, and a
    // multiple choice stored that cannot render.
    expect(
      questionsToWrite(
        [
          {
            questions: [
              {
                kind: 'mcq',
                prompt: 'Which?',
                answer: 'right',
                distractors: [' right ', 'right '],
              },
            ],
          },
        ],
        written,
      ),
    ).toEqual([]);
    // Genuinely distinct options survive, trimmed.
    const ok = questionsToWrite(
      [
        {
          questions: [
            {
              kind: 'mcq',
              prompt: 'Which?',
              answer: 'right',
              distractors: [' wrong ', 'other', 'other'],
            },
          ],
        },
      ],
      written,
    );
    expect(ok[0]?.distractors).toEqual(['wrong', 'other']);
  });

  it('refuses a cloze that never had its blank taken out', () => {
    // `quiz_questions_cloze_has_text` can only check the string is non-blank; the marker
    // is a prose instruction in the prompt and a response schema cannot enforce it. An
    // intact sentence renders as a fill-the-blank with nothing to fill -- and since the
    // answer is the removed text, it shows the reader the answer.
    expect(
      questionsToWrite(
        [
          {
            questions: [
              {
                kind: 'cloze',
                prompt: 'Fill it',
                answer: 'material',
                cloze: 'The obstacle is the material.',
              },
            ],
          },
        ],
        written,
      ),
    ).toEqual([]);
    const ok = questionsToWrite(
      [
        {
          questions: [
            {
              kind: 'cloze',
              prompt: 'Fill it',
              answer: 'material',
              cloze: 'The obstacle is the ____.',
            },
          ],
        },
      ],
      written,
    );
    expect(ok[0]?.cloze).toBe('The obstacle is the ____.');
  });

  /*
   * THE BOUNDS THE TABLE CARRIES, MET HERE RATHER THAN HIT.
   *
   * `20260905120001` adds `quiz_questions_prompt_length`, `_answer_length` and
   * `_distractors_shape`, and this function is the only writer at runtime. Before the clamp, a model
   * returning a 2,100-character prompt raised 23514 in the `cards` step -- after
   * `insertPulls` had committed and after the synthesis had been paid for -- and, because
   * `synthesize` replays from `job_step_outputs`, failed identically on every retry.
   * Nothing upstream clamps it: `BOUNDS` in `packages/prompts/scripts/export.mjs` bounds
   * the distractor count and no length at all.
   */
  it('drops a question whose prompt or answer is over the column bound', () => {
    expect(questionsToWrite([q({ prompt: 'x'.repeat(2001) })], written)).toEqual([]);
    expect(questionsToWrite([q({ answer: 'y'.repeat(2001) })], written)).toEqual([]);
    // Exactly at the bound is a question, not a casualty.
    expect(questionsToWrite([q({ prompt: 'x'.repeat(2000) })], written)).toHaveLength(1);
    expect(questionsToWrite([q({ answer: 'y'.repeat(2000) })], written)).toHaveLength(1);
    // The pull keeps its place either way -- dropping the question is not dropping the
    // idea, and a pull with no question is an outcome the schema already allows.
    //
    // `toMatchObject` rather than `toEqual`: 3g widened the row with `kind`, `cloze`,
    // `explanation` and `rationale`, and what this case is about is WHICH pull survives,
    // not the shape of the row. Pinning the shape here would make this test fail again
    // the next time a column is added, for a reason it is not testing.
    const kept = questionsToWrite([q({ prompt: 'x'.repeat(2001) }), q()], written);
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({
      pullId: 'p1',
      prompt: 'Why?',
      answer: 'Because.',
      distractors: ['a', 'b', 'c'],
    });
  });

  it('measures the size the way Postgres will, spaces and all', () => {
    /*
     * Round six, found by two reviewers. `length(distractors::text)` is measured on the
     * JSONB rendering, which puts a space after every separator -- `["a", "b"]` -- while
     * `JSON.stringify` gives `["a","b"]`. For n elements the stored text is n-1 longer
     * than the clamp believed, so at the count cap of eight an array whose compact form
     * is exactly 20,000 stores as 20,007 and is refused with 23514, in the step that can
     * never converge.
     *
     * Eight strings whose `JSON.stringify` length is exactly the bound: 25 characters of
     * punctuation plus 19,975 of content.
     *
     * DISTINCT strings, and they have to be. This fixture used seven identical ones when
     * it came from 3a, where nothing deduped -- and 3g dedupes the options before it
     * counts them, so the seven collapsed to one and the case stopped being about the
     * byte bound at all. A fixture that is accidentally degenerate under a rule added
     * later still passes its assertion for the wrong reason, or fails it for one.
     */
    const exact = [
      ...Array.from({ length: 7 }, (_, i) => 'z'.repeat(2496) + String.fromCharCode(97 + i)),
      'z'.repeat(2496),
    ];
    expect(new Set(exact).size).toBe(8);
    expect(JSON.stringify(exact)).toHaveLength(20000);
    const kept = questionsToWrite([q({ distractors: exact })], written)[0]?.distractors ?? [];
    expect(kept).toHaveLength(7);
    // What Postgres will actually measure, spaces included, is now under the bound.
    expect(JSON.stringify(kept).length + kept.length - 1).toBeLessThanOrEqual(20000);
  });

  it('clamps distractors by count AND by size', () => {
    // Both halves, because this stack has twice shipped the count half of a bound with
    // the size half missing -- `quiz_questions_distractors_shape` checks
    // `jsonb_array_length(...) <= 8` and `length(distractors::text) <= 20000`.
    const nine = Array.from({ length: 9 }, (_, i) => `d${i}`);
    expect(questionsToWrite([q({ distractors: nine })], written)[0]?.distractors).toHaveLength(8);

    const huge = Array.from({ length: 8 }, () => 'z'.repeat(5000));
    const kept = questionsToWrite([q({ distractors: huge })], written)[0]?.distractors ?? [];
    expect(JSON.stringify(kept).length).toBeLessThanOrEqual(20000);
    // Some survive: the size clamp drops from the end rather than emptying the list.
    expect(kept.length).toBeGreaterThan(0);
  });
});
