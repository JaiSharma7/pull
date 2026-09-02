/**
 * Export every BAML function's prompt and output schema as plain TypeScript the
 * Edge Functions can import.
 *
 * BAML's TypeScript runtime is a native Node addon and Edge Functions are Deno
 * isolates that cannot load one. This script is the other way across: it runs the
 * BAML runtime's WASM build HERE, at build time, and writes what the Deno providers
 * need -- the rendered prompt as a template, the client and model, and a JSON
 * schema for the return type -- into `supabase/functions/_shared/generated/`.
 * Nothing BAML crosses the boundary at run time; the providers keep making the
 * calls they already make, with the prompt and schema they used to hand-write.
 *
 * Two facts established on 2026-09-02, so the next reader does not re-derive them:
 * `@gloo-ai/baml-schema-wasm-web` is the playground runtime, not a formatter, and
 * its 0.89 parser accepts this repository's 0.226 sources with zero diagnostics.
 *
 * How the template is made. `render_prompt_for_test` renders for a TEST CASE's
 * arguments, so a synthetic test is injected in memory with a sentinel string per
 * argument, the prompt is rendered, and the sentinels are turned back into
 * `{{name}}` placeholders. The Deno side substitutes with `renderPrompt`. A prompt
 * that transforms an argument (a filter, a conditional on its value) would not
 * survive this, which is why `canonical_summary.baml`'s `context` conditional moved
 * into the provider and this script refuses a template whose sentinel did not
 * survive intact.
 *
 * How the schema is made. BAML's `rest/openapi` generator emits the return types as
 * OpenAPI components; `$ref`s are inlined and the OpenAPI-only keys dropped so the
 * result is ordinary JSON Schema. The Gemini dialect (`OBJECT`, `STRING`) is derived
 * from that at load time in `gemini.ts`, so there is one schema here and not two.
 *
 * Run by `pnpm baml:export`; CI check 2 regenerates and diffs the output.
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const SRC_DIR = resolve(here, '../baml_src');
const OUT_FILE = resolve(here, '../../../supabase/functions/_shared/generated/prompts.ts');

// --- the runtime ----------------------------------------------------------------
// wasm-bindgen's "web" target expects fetch(); instantiate from bytes instead.
const distDir = dirname(require.resolve('@gloo-ai/baml-schema-wasm-web'));
const bg = await import(join(distDir, 'baml_schema_build_bg.js'));
const wasm = readFileSync(join(distDir, 'baml_schema_build_bg.wasm'));
const { instance } = await WebAssembly.instantiate(wasm, { './baml_schema_build_bg.js': bg });
bg.__wbg_set_wasm(instance.exports);
bg.on_wasm_init?.();

// --- the sources ----------------------------------------------------------------
const files = {};
for (const name of readdirSync(SRC_DIR)) {
  if (name.endsWith('.baml')) files[`baml_src/${name}`] = readFileSync(join(SRC_DIR, name), 'utf8');
}

/** Models pinned by `client<llm>` blocks, so the export names a model and not a label. */
function pinnedModels(source) {
  const out = {};
  for (const m of source.matchAll(/client<llm>\s+(\w+)\s*\{[^}]*?model\s+"([^"]+)"/gs))
    out[m[1]] = m[2];
  return out;
}
const models = pinnedModels(files['baml_src/clients.baml'] ?? '');

/**
 * Enum members → their `@alias`, where one is declared.
 *
 * The OpenAPI generator emits member NAMES (`Philosophy`); the prompt's output-format
 * block and BAML's own parser use the ALIASES (`philosophy`), and so does every
 * `topics.slug` in the database. A schema that made a JSON-mode model answer with
 * the name would have `narrowTopics` drop every topic, silently.
 */
function enumAliases(sources) {
  const out = {};
  for (const src of sources) {
    for (const block of src.matchAll(/^enum\s+(\w+)\s*\{\n([\s\S]*?)\n\}/gm)) {
      const map = {};
      for (const m of block[2].matchAll(/^\s*(\w+)\s+@alias\("([^"]+)"\)/gm)) map[m[1]] = m[2];
      out[block[1]] = map;
    }
  }
  return out;
}
const aliases = enumAliases(Object.values(files));

/**
 * Array bounds, read from the `@assert`s on class fields.
 *
 * `topics TopicSlug[] @assert(one_to_four, {{ this|length >= 1 and this|length <= 4 }})`
 * is the source of truth for "one to four topics". BAML enforces it in its own
 * runtime; the Deno providers run JSON mode against a schema, and a schema without
 * `minItems` accepts an empty array -- which is the exact silent failure the assert
 * was written against. So the bounds are lifted into the schema here, from the same
 * line, rather than kept as a second copy in the provider. Only the three shapes
 * used are recognised; anything else stays an assert BAML alone enforces.
 */
function fieldBounds(sources) {
  const out = {};
  for (const src of sources) {
    // A class body ends at the first line that is exactly `}` -- not at the first
    // `}` character, which is the one closing an assert's own `{{ … }}`.
    for (const cls of src.matchAll(/^class\s+(\w+)\s*\{\n([\s\S]*?)\n\}/gm)) {
      const fields = {};
      for (const line of cls[2].split('\n')) {
        const m = /^\s*(\w+)\s+[^@]+@assert\([^,]+,\s*\{\{(.*)\}\}\s*\)/.exec(line);
        if (!m) continue;
        const b = {};
        for (const ge of m[2].matchAll(/this\|length\s*>=\s*(\d+)/g)) b.minItems = Number(ge[1]);
        for (const le of m[2].matchAll(/this\|length\s*<=\s*(\d+)/g)) b.maxItems = Number(le[1]);
        for (const eq of m[2].matchAll(/this\|length\s*==\s*(\d+)/g)) {
          b.minItems = Number(eq[1]);
          b.maxItems = Number(eq[1]);
        }
        if (Object.keys(b).length > 0) fields[m[1]] = b;
      }
      if (Object.keys(fields).length > 0) out[cls[1]] = fields;
    }
  }
  return out;
}
const bounds = fieldBounds(Object.values(files));

function runtimeFor(extraFiles) {
  const project = bg.WasmProject.new('baml_src', { ...files, ...extraFiles });
  let rt;
  try {
    rt = project.runtime({});
  } catch (e) {
    const messages = [];
    try {
      for (const err of e.errors()) messages.push(err.message ?? String(err));
    } catch {
      messages.push(String(e));
    }
    throw new Error(`baml_src does not compile:\n${messages.join('\n')}`);
  }
  const diag = project.diagnostics(rt);
  const errors = diag.errors();
  if (errors.length > 0) {
    throw new Error(
      `baml_src has ${errors.length} diagnostic(s):\n${errors.map((e) => e.message).join('\n')}`,
    );
  }
  return { project, rt };
}

// --- prompts --------------------------------------------------------------------
const SENTINEL = (name) => `__WAP_ARG_${name}__`;

async function exportFunction(fn) {
  // `signature` is the playground's test snippet -- `(name #"hello world"#, …) -> T` --
  // so the parameter names are the identifiers in front of each placeholder value.
  const sig = String(fn.signature ?? '');
  const names = [...sig.matchAll(/(\w+)\s+#"/g)].map((m) => m[1]);
  if (names.length === 0) {
    throw new Error(
      `${fn.name}: could not read string parameters from signature ${JSON.stringify(sig)}`,
    );
  }
  const argLines = names.map((n) => `    ${n} ${JSON.stringify(SENTINEL(n))}`).join('\n');
  const testSrc = `test export_sentinels {\n  functions [${fn.name}]\n  args {\n${argLines}\n  }\n}\n`;
  const { rt } = runtimeFor({ 'baml_src/export_sentinels.baml': testSrc });
  const f = rt.list_functions().find((x) => x.name === fn.name);
  const ctx = bg.WasmCallContext.new ? bg.WasmCallContext.new() : new bg.WasmCallContext();
  const prompt = await f.render_prompt_for_test(rt, 'export_sentinels', ctx, () => files, {});
  const chat = prompt.as_chat();
  if (!chat) throw new Error(`${fn.name}: only chat prompts are exported`);
  const messages = chat.map((m) => ({
    role: m.role,
    text: m.parts
      .filter((p) => p.is_text())
      .map((p) => p.as_text())
      .join(''),
  }));
  // Sentinels back to placeholders, and a refusal if one did not survive intact.
  for (const m of messages) {
    for (const n of names) {
      const count = m.text.split(SENTINEL(n)).length - 1;
      if (count === 0 && messages.length === 1) {
        throw new Error(
          `${fn.name}: argument ${n} does not appear verbatim in the rendered prompt; a transformed argument cannot be exported as a template`,
        );
      }
      m.text = m.text.split(SENTINEL(n)).join(`{{${n}}}`);
    }
  }
  const client = prompt.client_name;
  if (!models[client]) {
    throw new Error(
      `${fn.name}: client ${JSON.stringify(client)} is not a single pinned model. ` +
        'Each function names one client<llm> with a model; retry and fallback live in the worker, where the ledger is.',
    );
  }
  return { name: fn.name, params: names, client, model: models[client], messages };
}

// --- schemas --------------------------------------------------------------------
function openApiComponents() {
  const gen =
    'generator openapi {\n  output_type "rest/openapi"\n  output_dir "../openapi"\n  version "0.89.0"\n}\n';
  const { project } = runtimeFor({ 'baml_src/generators.baml': gen });
  const outputs = project.run_generators(true);
  for (const o of outputs) {
    for (const f of o.files) {
      if (f.path_in_output_dir.endsWith('openapi.yaml'))
        return parseYaml(f.contents).components.schemas;
    }
  }
  throw new Error('the openapi generator produced no openapi.yaml');
}

/** OpenAPI component → plain JSON Schema with every $ref inlined, aliased and bounded. */
function toJsonSchema(node, components, seen = new Set(), owner = null) {
  if (Array.isArray(node)) return node.map((n) => toJsonSchema(n, components, seen, owner));
  if (!node || typeof node !== 'object') return node;
  if (node.$ref) {
    const name = node.$ref.replace('#/components/schemas/', '');
    if (seen.has(name)) throw new Error(`recursive schema ${name} cannot be inlined`);
    const target = components[name];
    let inner = toJsonSchema(target, components, new Set([...seen, name]), name);
    if (target?.enum && aliases[name])
      inner = { ...inner, enum: target.enum.map((v) => aliases[name][v] ?? v) };
    // `nullable` beside a $ref is OpenAPI's way of saying `T | null`.
    return node.nullable ? { anyOf: [inner, { type: 'null' }] } : inner;
  }
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === 'nullable' || k === 'title' || k === 'additionalProperties') continue;
    if (k === 'properties') {
      out.properties = {};
      for (const [field, schema] of Object.entries(v)) {
        const b = owner ? bounds[owner]?.[field] : undefined;
        out.properties[field] = { ...toJsonSchema(schema, components, seen, null), ...(b ?? {}) };
      }
      continue;
    }
    out[k] = toJsonSchema(v, components, seen, owner);
  }
  if (node.nullable && node.type) out.type = [node.type, 'null'];
  return out;
}

// --- main -----------------------------------------------------------------------
const { rt } = runtimeFor({});
const functions = rt.list_functions();
const components = openApiComponents();

const exported = [];
for (const fn of functions) {
  const p = await exportFunction(fn);
  const returnType = String(fn.signature ?? '')
    .split('->')
    .pop()
    ?.trim()
    .replace(/[^\w]/g, '');
  if (!returnType || !components[returnType]) {
    throw new Error(
      `${fn.name}: return type ${JSON.stringify(returnType)} is not an exported component`,
    );
  }
  exported.push({
    ...p,
    returnType,
    schema: toJsonSchema(components[returnType], components, new Set([returnType]), returnType),
  });
}

const header = `/**
 * GENERATED by \`pnpm baml:export\` from packages/prompts/baml_src -- do not edit.
 *
 * Each entry is one BAML function: the prompt as a template with {{name}}
 * placeholders (substitute with \`renderPrompt\`), the client and the model it pins,
 * and the return type as plain JSON Schema with every reference inlined. The Deno
 * providers read these instead of carrying their own copies; CI check 2 regenerates
 * this file and fails on any difference.
 *
 * Source of truth: packages/prompts/baml_src. Runtime that rendered it:
 * @gloo-ai/baml-schema-wasm-web ${bg.version()}.
 */
/* eslint-disable */
// deno-lint-ignore-file
// prettier-ignore
`;
const body = `export const PROMPTS = ${JSON.stringify(
  Object.fromEntries(
    exported.map((e) => [
      e.name,
      {
        params: e.params,
        client: e.client,
        model: e.model,
        returnType: e.returnType,
        messages: e.messages,
        schema: e.schema,
      },
    ]),
  ),
  null,
  2,
)} as const;\n`;

mkdirSync(dirname(OUT_FILE), { recursive: true });
writeFileSync(OUT_FILE, header + body);
console.log(
  `wrote ${OUT_FILE}: ${exported.map((e) => `${e.name} (${e.client} → ${e.model})`).join(', ')}`,
);
