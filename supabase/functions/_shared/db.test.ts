import { describe, expect, it } from 'vitest';
import { createPipelineDb } from './db.ts';

/**
 * The row mapping, which is the last thing between `questionsToWrite` and Postgres.
 *
 * NOTHING TESTED IT, and the mutation sweep for this PR found out how much that cost:
 * hard-coding `kind: 'recall'` in the mapper left all 214 tests green, and against a
 * real database it turns three questions into one conflict target and Postgres refuses
 * the whole statement with "ON CONFLICT DO UPDATE command cannot affect row a second
 * time" -- every question on a summary already paid for, lost. Blanking `rationale`
 * was the same shape of miss: green suite, and `whyWrong` falls back to the general
 * explanation forever.
 *
 * `createPipelineDb` takes its client as an argument, so the mapping can be checked
 * without a network or a database: the fake below records what the upsert was handed.
 */
function fakeClient() {
  const calls: { table: string; rows: unknown[]; options: unknown }[] = [];
  const client = {
    from(table: string) {
      return {
        upsert(rows: unknown[], options: unknown) {
          calls.push({ table, rows, options });
          return { select: () => ({ data: [], error: null }) };
        },
      };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  return { calls, db: createPipelineDb(client) };
}

const row = (over: Record<string, unknown> = {}) => ({
  pullId: 'p0',
  kind: 'recall',
  prompt: 'Why?',
  answer: 'Because.',
  distractors: [],
  cloze: null,
  explanation: null,
  rationale: [],
  ...over,
});

describe('insertQuizQuestions', () => {
  it('sends each row its own kind, not a constant', () => {
    // The line the whole batch depends on. `(pull_id, kind)` is the conflict target, so
    // a constant kind makes three questions one row and Postgres refuses the statement.
    const { calls, db } = fakeClient();
    db.insertQuizQuestions([
      row({ kind: 'recall' }),
      row({ kind: 'mcq', distractors: ['a', 'b'] }),
      row({ kind: 'cloze', cloze: 'A ____ sentence.' }),
    ]);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.table).toBe('quiz_questions');
    expect((calls[0]?.rows as { kind: string }[]).map((r) => r.kind)).toEqual([
      'recall',
      'mcq',
      'cloze',
    ]);
  });

  it('carries every column 3g added, per row', () => {
    // `cloze`, `explanation` and `rationale` are all new here, and all three were
    // mapped without anything asserting they arrive distinct.
    const { calls, db } = fakeClient();
    db.insertQuizQuestions([
      row({
        kind: 'mcq',
        distractors: ['a', 'b'],
        explanation: 'why it matters',
        rationale: [{ distractor: 'a', why: 'not that' }],
      }),
      row({ kind: 'cloze', cloze: 'A ____ sentence.' }),
    ]);

    const sent = calls[0]?.rows as Record<string, unknown>[];
    expect(sent[0]).toMatchObject({
      pull_id: 'p0',
      kind: 'mcq',
      distractors: ['a', 'b'],
      explanation: 'why it matters',
      rationale: [{ distractor: 'a', why: 'not that' }],
      cloze: null,
    });
    expect(sent[1]).toMatchObject({ kind: 'cloze', cloze: 'A ____ sentence.', rationale: [] });
  });

  it('conflicts on the pair the unique index is actually on', () => {
    // `pull_id` alone raises 42P10 against the real schema, and a fake accepts anything
    // -- which is exactly why this is asserted rather than trusted.
    const { calls, db } = fakeClient();
    db.insertQuizQuestions([row()]);
    expect(calls[0]?.options).toEqual({ onConflict: 'pull_id,kind' });
  });

  it('sends nothing at all when there is nothing to send', () => {
    const { calls, db } = fakeClient();
    db.insertQuizQuestions([]);
    expect(calls).toHaveLength(0);
  });
});
