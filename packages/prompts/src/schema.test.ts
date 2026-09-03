/**
 * The exported schema and the BAML class are the same shape.
 *
 * `scripts/export.mjs` derives the schema by asking the compiler to lower
 * `WriteCanonicalSummary`'s declared return type (`baml.json.schema`), so
 * `baml_src` is the only place the shape is written down. What is *not*
 * derivable is the array bounds: BAML v1 has no constraint syntax, so the three
 * below live in `BOUNDS` in that script and are layered on after lowering.
 *
 * That overlay is the drift risk this file exists for. A field renamed in the
 * class silently stops receiving its bound — the export still succeeds, the
 * schema still validates, and the model is simply no longer told that `topics`
 * has an upper bound. So the bounds are asserted here against the committed
 * artifact, and the property names are asserted against the class they came
 * from, which fails if the export was not regenerated after a `.baml` edit.
 *
 * Read as text, for the reason `topics.test.ts` gives: the generated file is
 * Deno source outside this package's `rootDir`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const GENERATED = fileURLToPath(
  new URL('../../../supabase/functions/_shared/generated/prompts.ts', import.meta.url),
);
const BAML_SRC = fileURLToPath(new URL('../baml_src/canonical_summary.baml', import.meta.url));

type JsonSchema = {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  required?: string[];
  enum?: string[];
  anyOf?: JsonSchema[];
  minItems?: number;
  maxItems?: number;
};

function exportedSchema(): JsonSchema {
  const source = readFileSync(GENERATED, 'utf8');
  const block = /export const PROMPTS = (\{[\s\S]*\}) as const;/.exec(source);
  if (!block?.[1]) throw new Error(`PROMPTS not found in ${GENERATED}`);
  const prompts = JSON.parse(block[1]) as Record<string, { schema: JsonSchema }>;
  const schema = prompts.WriteCanonicalSummary?.schema;
  if (!schema) throw new Error('WriteCanonicalSummary is not in the exported prompts');
  return schema;
}

/**
 * Deliberately not a shared resolver.
 *
 * An earlier draft copied `throughNull`/`resolvePath` out of `scripts/export.mjs`,
 * which made this file unable to catch the thing it exists to catch: a resolver
 * that walks to the wrong node puts the bound somewhere unintended, and a copy of
 * the same resolver walks there too and agrees. Sharing the implementation has the
 * same defect. So the paths below are spelled out by hand -- if the exporter's
 * resolver drifts, these stop finding the bounds and fail.
 */
function pullItems(schema: JsonSchema): JsonSchema {
  const node = schema.properties?.pulls?.items;
  if (!node) throw new Error('pulls[] is not in the exported schema');
  return node;
}

function recallQuestion(schema: JsonSchema): JsonSchema {
  const q = pullItems(schema).properties?.question;
  const inner = q?.anyOf?.find((b) => b.type !== 'null');
  if (!inner) throw new Error('pulls[].question is not a `T | null` in the exported schema');
  return inner;
}

/** Field names declared on a `class` in the BAML source, in declaration order. */
function classFields(className: string): string[] {
  const source = readFileSync(BAML_SRC, 'utf8');
  const block = new RegExp(`^class\\s+${className}\\s*\\{([\\s\\S]*?)^\\}`, 'm').exec(source);
  if (!block?.[1]) throw new Error(`class ${className} not found in ${BAML_SRC}`);
  return [...block[1].matchAll(/^\s{2}(\w+)\s*:/gm)].map((m) => m[1] as string);
}

describe('exported schema shape', () => {
  it('extracts a schema and a class to compare', () => {
    // Guards both extractions: a reformat that breaks either regex must fail
    // here rather than make every assertion below vacuously true.
    expect(Object.keys(exportedSchema().properties ?? {}).length).toBeGreaterThan(0);
    expect(classFields('CanonicalSummary').length).toBeGreaterThan(0);
  });

  it.each([
    ['CanonicalSummary', (s: JsonSchema) => s],
    ['Pull', pullItems],
    ['RecallQuestion', recallQuestion],
  ] as const)('carries every field %s declares', (className, pick) => {
    const node = pick(exportedSchema());
    expect(Object.keys(node.properties ?? {}).sort()).toEqual(classFields(className).sort());
  });

  it('inlines every reference, because Gemini has no $ref', () => {
    const raw = JSON.stringify(exportedSchema());
    expect(raw).not.toContain('$ref');
    expect(raw).not.toContain('$defs');
  });

  it('keeps the bounds BAML cannot state', () => {
    // Spelled out rather than resolved, per the note above. These numbers are a
    // declaration, not a derivation -- BAML v1 has no constraint syntax, so nothing
    // in baml_src can be compared against them. What this pins is that the exporter
    // put each one on the node it was meant for.
    const schema = exportedSchema();
    expect(schema.properties?.pulls).toMatchObject({ minItems: 1 });
    expect(schema.properties?.topics).toMatchObject({ minItems: 1, maxItems: 4 });
    expect(recallQuestion(schema).properties?.distractors).toMatchObject({
      minItems: 3,
      maxItems: 3,
    });
  });
});
