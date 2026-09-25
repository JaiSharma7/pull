/**
 * The study functions' exported schemas match their BAML classes, and carry the
 * bounds `scripts/export.mjs` layers on after lowering.
 *
 * Same method and same reasons as `schema.test.ts`: the generated file is read as
 * text, the class fields are read from the source at any indent, and each path is
 * spelled out by hand so a resolver that walks to the wrong node cannot agree with
 * itself here.
 *
 * The enum values are asserted because they are what the worker writes into CHECK
 * constraints in `20260925010000_study_evidence_generation.sql`. A member added in
 * BAML without the database following fails here rather than at the first insert
 * after a paid call.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const GENERATED = fileURLToPath(
  new URL('../../../supabase/functions/_shared/generated/prompts.ts', import.meta.url),
);
const BAML_SRC = fileURLToPath(new URL('../baml_src/study_course.baml', import.meta.url));
const SHARED_SRC = fileURLToPath(new URL('../baml_src/canonical_summary.baml', import.meta.url));

type JsonSchema = {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  enum?: string[];
  minItems?: number;
  maxItems?: number;
};

function exported(name: string): JsonSchema {
  const source = readFileSync(GENERATED, 'utf8');
  const block = /export const PROMPTS = (\{[\s\S]*\}) as const;/.exec(source);
  if (!block?.[1]) throw new Error(`PROMPTS not found in ${GENERATED}`);
  const prompts = JSON.parse(block[1]) as Record<string, { schema: JsonSchema; params: string[] }>;
  const schema = prompts[name]?.schema;
  if (!schema) throw new Error(`${name} is not in the exported prompts`);
  return schema;
}

function params(name: string): string[] {
  const source = readFileSync(GENERATED, 'utf8');
  const block = /export const PROMPTS = (\{[\s\S]*\}) as const;/.exec(source);
  const prompts = JSON.parse(block?.[1] ?? '{}') as Record<string, { params: string[] }>;
  return prompts[name]?.params ?? [];
}

function classFields(className: string): string[] {
  for (const file of [BAML_SRC, SHARED_SRC]) {
    const source = readFileSync(file, 'utf8');
    const block = new RegExp(`^class\\s+${className}\\s*\\{([\\s\\S]*?)^\\}`, 'm').exec(source);
    if (block?.[1]) {
      return [...block[1].matchAll(/^[ \t]+(\w+)[ \t]*:[ \t]*\S/gm)].map((m) => m[1] as string);
    }
  }
  throw new Error(`class ${className} not found`);
}

function enumValues(enumName: string): string[] {
  const source = readFileSync(BAML_SRC, 'utf8');
  const block = new RegExp(`^enum\\s+${enumName}\\s*\\{([\\s\\S]*?)^\\}`, 'm').exec(source);
  if (!block?.[1]) throw new Error(`enum ${enumName} not found`);
  return [...block[1].matchAll(/@alias\("([^"]+)"\)/g)].map((m) => m[1] as string);
}

const node = (n: JsonSchema | undefined, what: string): JsonSchema => {
  if (!n) throw new Error(`${what} is not in the exported schema`);
  return n;
};

const claimMap = () => exported('ExtractStudyClaims');
const claim = () => node(claimMap().properties?.claims?.items, 'claims[]');
const course = () => exported('AssembleStudyCourse');
const unit = () => node(course().properties?.units?.items, 'units[]');
const lesson = () => node(unit().properties?.lessons?.items, 'units[].lessons[]');
const question = () => node(course().properties?.questions?.items, 'questions[]');
const distractor = () =>
  node(question().properties?.distractors?.items, 'questions[].distractors[]');
const pair = () => node(question().properties?.pairs?.items, 'questions[].pairs[]');
const disagreement = () => node(course().properties?.disagreements?.items, 'disagreements[]');
const withheld = () => node(course().properties?.withheld?.items, 'withheld[]');

describe('study schemas', () => {
  it('take the arguments the worker renders', () => {
    // `buildStudyExtractionPrompt` and `buildStudyAssemblyPrompt` pass exactly these.
    expect(params('ExtractStudyClaims')).toEqual(['sourceTitle', 'passage']);
    expect(params('AssembleStudyCourse')).toEqual(['goal', 'claims']);
  });

  it.each([
    ['SourceClaimMap', claimMap],
    ['StudyClaim', claim],
    ['StudyCourse', course],
    ['StudyUnit', unit],
    ['StudyLesson', lesson],
    ['StudyQuestion', question],
    ['DistractorRationale', distractor],
    ['StudyMatchPair', pair],
    ['StudySourceDisagreement', disagreement],
    ['StudyWithheldQuestion', withheld],
  ] as const)('carries every field %s declares', (className, pick) => {
    const declared = classFields(className);
    const got = Object.keys(pick().properties ?? {});
    expect(declared.length).toBeGreaterThan(0);
    expect(got.length).toBeGreaterThan(0);
    expect(got.sort()).toEqual(declared.sort());
  });

  it('inlines every reference', () => {
    for (const s of [claimMap(), course()]) {
      const raw = JSON.stringify(s);
      expect(raw).not.toContain('$ref');
      expect(raw).not.toContain('$defs');
    }
  });

  it('keeps the bounds on the nodes they were meant for', () => {
    expect(claimMap().properties?.claims).toMatchObject({ maxItems: 25 });
    expect(claim().properties?.qualifications).toMatchObject({ maxItems: 6 });
    expect(claim().properties?.evidence).toMatchObject({ minItems: 1, maxItems: 3 });
    expect(claimMap().properties?.gaps).toMatchObject({ maxItems: 8 });

    expect(course().properties?.objectives).toMatchObject({ minItems: 1, maxItems: 6 });
    expect(course().properties?.units).toMatchObject({ minItems: 1, maxItems: 6 });
    expect(unit().properties?.lessons).toMatchObject({ minItems: 1, maxItems: 4 });
    expect(lesson().properties?.claimKeys).toMatchObject({ minItems: 1, maxItems: 8 });
    expect(course().properties?.questions).toMatchObject({ minItems: 1, maxItems: 48 });
    expect(question().properties?.claimKeys).toMatchObject({ minItems: 1, maxItems: 6 });
    expect(question().properties?.acceptedAnswers).toMatchObject({ maxItems: 6 });
    expect(question().properties?.sequence).toMatchObject({ maxItems: 6 });
    expect(question().properties?.pairs).toMatchObject({ maxItems: 6 });
    expect(course().properties?.disagreements).toMatchObject({ maxItems: 10 });
    expect(disagreement().properties?.claimKeys).toMatchObject({ minItems: 2, maxItems: 6 });
    expect(course().properties?.withheld).toMatchObject({ maxItems: 10 });

    // A ceiling and no floor, for the reason `schema.test.ts` gives about MCQs: one
    // schema covers every kind, so a floor would fail the call rather than the item.
    const distractors = question().properties?.distractors;
    expect(distractors).toMatchObject({ maxItems: 4 });
    expect(distractors?.minItems).toBeUndefined();
  });

  it('exports the aliased values the database constrains', () => {
    expect(claim().properties?.kind?.enum?.slice().sort()).toEqual(
      enumValues('StudyClaimKind').sort(),
    );
    expect(enumValues('StudyClaimKind').sort()).toEqual(
      ['argument', 'caveat', 'definition', 'example', 'finding', 'method'].sort(),
    );
    expect(question().properties?.kind?.enum?.slice().sort()).toEqual(
      [
        'application',
        'cloze',
        'comparison',
        'matching',
        'multiple_choice',
        'ordering',
        'short_recall',
      ].sort(),
    );
    expect(question().properties?.purpose?.enum?.slice().sort()).toEqual(
      ['placement', 'practice', 'review'].sort(),
    );
  });
});
