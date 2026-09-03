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

/** Follow a `T | null` union to `T`; leave anything else alone. */
function throughNull(node: JsonSchema | undefined): JsonSchema | undefined {
  if (!node?.anyOf) return node;
  return node.anyOf.find((b) => b.type !== 'null') ?? node;
}

/** `a.b[].c` — a property name per segment, `[]` descending into array items. */
function resolve(schema: JsonSchema, path: string): JsonSchema | undefined {
  let node: JsonSchema | undefined = schema;
  for (const raw of path.split('.')) {
    const intoItems = raw.endsWith('[]');
    const key = intoItems ? raw.slice(0, -2) : raw;
    node = throughNull(node)?.properties?.[key];
    if (intoItems) node = throughNull(node)?.items;
    if (!node) return undefined;
  }
  // A nullable node is followed through here too, so a path may end on one.
  return throughNull(node);
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
    ['CanonicalSummary', ''],
    ['Pull', 'pulls[]'],
    ['RecallQuestion', 'pulls[].question'],
  ])('carries every field %s declares', (className, path) => {
    const node = path === '' ? exportedSchema() : resolve(exportedSchema(), path);
    expect(Object.keys(node?.properties ?? {}).sort()).toEqual(classFields(className).sort());
  });

  it('inlines every reference, because Gemini has no $ref', () => {
    const raw = JSON.stringify(exportedSchema());
    expect(raw).not.toContain('$ref');
    expect(raw).not.toContain('$defs');
  });

  it.each([
    ['pulls', { minItems: 1 }],
    ['topics', { minItems: 1, maxItems: 4 }],
    ['pulls[].question.distractors', { minItems: 3, maxItems: 3 }],
  ])('keeps the bound BAML cannot state on %s', (path, bound) => {
    const node = resolve(exportedSchema(), path);
    expect(node, `${path} no longer resolves; update BOUNDS in scripts/export.mjs`).toBeDefined();
    expect(node).toMatchObject(bound);
  });
});
