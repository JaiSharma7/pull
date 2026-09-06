/**
 * The BAML enum and the database check constraint have to agree, in one direction.
 *
 * `quiz_questions_kind_known` decides what is storable and `kind` reaches Postgres as
 * a plain string, so a generated kind the column refuses fails the synthesis step
 * AFTER the model call has been paid for. That is the expensive direction, and it is
 * the one asserted here.
 *
 * The other direction is deliberately NOT asserted, which is where this differs from
 * `topics.test.ts`. The column also allows `short_answer`, `ordering` and `scenario`;
 * those are authored rather than generated and offering them to a model would invite a
 * generation the pipeline has no writer for. So: everything BAML can emit is storable,
 * and not everything storable can be emitted.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { QUESTION_KIND_BY_MEMBER } from './question-kinds.js';

const MIGRATION = fileURLToPath(
  new URL(
    '../../../supabase/migrations/20260905120000_a_question_that_can_be_wrong.sql',
    import.meta.url,
  ),
);

/** The kinds `quiz_questions_kind_known` actually admits. */
function storableKinds(): string[] {
  const source = readFileSync(MIGRATION, 'utf8');
  const block = /constraint quiz_questions_kind_known\s*\n\s*check \(kind in \(([^)]*)\)\)/.exec(
    source,
  );
  if (!block?.[1]) throw new Error(`quiz_questions_kind_known not found in ${MIGRATION}`);
  return [...block[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1] as string);
}

describe('question kind parity', () => {
  it('extracts a non-empty list from the migration', () => {
    // Guards the regex: a reformat of the constraint must fail here rather than make
    // the assertion below vacuously true.
    expect(storableKinds().length).toBeGreaterThan(3);
  });

  it('maps every BAML member to a kind the column accepts', () => {
    const storable = new Set(storableKinds());
    for (const kind of Object.values(QUESTION_KIND_BY_MEMBER)) {
      expect(storable.has(kind), `${kind} is not in quiz_questions_kind_known`).toBe(true);
    }
  });

  it('maps each member to a distinct kind', () => {
    const kinds = Object.values(QUESTION_KIND_BY_MEMBER);
    expect(new Set(kinds).size).toBe(kinds.length);
  });

  it('never maps a member to its own name, which is the trap this file exists for', () => {
    // `QuestionKind.Mcq` is `"Mcq"`. A map that passed the member through unchanged
    // would satisfy every assertion above the moment somebody added a lowercase
    // member, and would fail at the database.
    for (const [member, kind] of Object.entries(QUESTION_KIND_BY_MEMBER)) {
      expect(kind, `${member} maps to its own member name`).not.toBe(member);
    }
  });
});
