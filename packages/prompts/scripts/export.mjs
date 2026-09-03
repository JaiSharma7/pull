/**
 * Export every BAML function's prompt and output schema as plain TypeScript the
 * Edge Functions can import.
 *
 * BAML's TypeScript runtime is a native Node addon and Edge Functions are Deno
 * isolates that cannot load one. This script is the other way across: it runs the
 * BAML v1 CLI to render prompts with placeholders and to lower each function's
 * declared return type to JSON Schema, writing into
 * `supabase/functions/_shared/generated/`.
 * Nothing BAML crosses the boundary at run time; the providers keep making the
 * calls they already make, with the prompt and schema they used to hand-write.
 *
 * Run by `pnpm baml:export`; CI check 2 regenerates and diffs the output.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = resolve(here, '..');
const SRC_DIR = resolve(PROMPTS_DIR, 'baml_src');
const OUT_FILE = resolve(here, '../../../supabase/functions/_shared/generated/prompts.ts');

function findBaml() {
  const ext = process.platform === 'win32' ? '.exe' : '';
  const homeBaml = join(homedir(), '.baml', 'bin', `baml${ext}`);
  if (existsSync(homeBaml)) return homeBaml;
  return 'baml';
}

const bamlBin = findBaml();

// --- the sources ----------------------------------------------------------------
const files = {};
for (const name of readdirSync(SRC_DIR)) {
  if (name.endsWith('.baml')) files[`baml_src/${name}`] = readFileSync(join(SRC_DIR, name), 'utf8');
}

/** Models pinned by client declarations in clients.baml. */
function pinnedModels(source) {
  const out = {};
  for (const m of source.matchAll(
    /client\s+(\w+)\s*=\s*[\w.]+\.new\([^)]*model\s*=\s*"([^"]+)"/gs,
  )) {
    out[m[1]] = m[2];
  }
  return out;
}
const models = pinnedModels(files['baml_src/clients.baml'] ?? '');

// --- prompt rendering via BAML CLI ----------------------------------------------
const SENTINEL = (name) => `__WAP_ARG_${name}__`;

function renderPromptWithCli(fnName, paramNames) {
  const argExprs = paramNames.map((n) => `\"${SENTINEL(n)}\"`).join(', ');
  const expr = `${fnName}$render_prompt(${argExprs}).messages().map((m) -> { { \"role\": m.role, \"text\": m.content } })`;

  const bamlPath = dirname(bamlBin);
  const pathSep = process.platform === 'win32' ? ';' : ':';
  const out = execFileSync(
    bamlBin,
    ['run', '--project', PROMPTS_DIR, '-e', expr, '--output-format', 'json'],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bamlPath}${pathSep}${process.env.PATH || ''}`,
      },
    },
  );

  const parsed = JSON.parse(out);
  const messages = parsed.map((m) => ({
    role: m.role ? m.role : 'user',
    text: m.text,
  }));

  for (const n of paramNames) {
    const sentinel = SENTINEL(n);
    const total = messages.reduce((sum, m) => sum + (m.text.split(sentinel).length - 1), 0);
    if (total === 0) {
      throw new Error(
        `${fnName}: argument ${n} does not appear verbatim in the rendered prompt; a transformed argument cannot be exported as a template`,
      );
    }
    for (const m of messages) {
      m.text = m.text.split(sentinel).join(`{{${n}}}`);
    }
  }

  return messages;
}

// --- schema derivation ---------------------------------------------------------
/**
 * Bounds BAML cannot state, per function, keyed by a path into the schema.
 *
 * Everything else about the shape is derived from `baml_src` below. These three
 * are here because BAML v1 has no constraint syntax, so they cannot be lowered
 * from the class -- they are documented in the `///` docstrings on
 * `CanonicalSummary` and `RecallQuestion` and enforced here. `pnpm --filter
 * @wap/prompts test` fails if any path stops resolving, so a renamed or removed
 * field breaks the build instead of silently dropping its bound.
 *
 * A path segment is a property name; `[]` descends into an array's items, and a
 * `T | null` property is followed through to `T`.
 */
const BOUNDS = {
  WriteCanonicalSummary: {
    pulls: { minItems: 1 },
    topics: { minItems: 1, maxItems: 4 },
    'pulls[].question.distractors': { minItems: 3, maxItems: 3 },
  },
};

/** Follow a `T | null` union to `T`; leave anything else alone. */
function throughNull(node) {
  if (!node || !Array.isArray(node.anyOf)) return node;
  return node.anyOf.find((b) => b && b.type !== 'null') ?? node;
}

function resolvePath(schema, path) {
  let node = schema;
  for (const raw of path.split('.')) {
    const intoItems = raw.endsWith('[]');
    const key = intoItems ? raw.slice(0, -2) : raw;
    node = throughNull(node)?.properties?.[key];
    if (intoItems) node = throughNull(node)?.items;
    if (!node) return undefined;
  }
  // A nullable node is followed through here too, so a bound may target one.
  return throughNull(node);
}

/**
 * Inline `$ref`/`$defs` away.
 *
 * `baml.json.schema` emits provider-neutral JSON Schema, which uses `$defs` for
 * every class it reaches. Gemini's `responseSchema` dialect has no `$ref`, and
 * `toGeminiSchema` is total over what this file emits, so the references are
 * resolved here rather than at the first paid call. A recursive class graph has
 * no inlined form and no Gemini form either, so it throws instead of looping.
 */
function inlineRefs(root) {
  const defs = root.$defs ?? {};
  const walk = (node, stack) => {
    if (Array.isArray(node)) return node.map((n) => walk(n, stack));
    if (!node || typeof node !== 'object') return node;
    if (typeof node.$ref === 'string') {
      const name = node.$ref.replace('#/$defs/', '');
      if (!(name in defs)) throw new Error(`export: unresolved $ref ${node.$ref}`);
      if (stack.includes(name)) {
        throw new Error(
          `export: ${name} is recursive; JSON Schema references cannot be inlined for a ` +
            'dialect without $ref, and Gemini has no form for it either',
        );
      }
      return walk(defs[name], [...stack, name]);
    }
    return Object.fromEntries(
      Object.entries(node)
        .filter(([k]) => k !== '$defs')
        .map(([k, v]) => [k, walk(v, stack)]),
    );
  };
  return walk(root, []);
}

/**
 * The output schema of one BAML function, derived from the function itself.
 *
 * `$spec(...).output_type()` is the declared return type and `baml.json.schema`
 * lowers it, so `baml_src` stays the only place the shape is written down --
 * adding a field to the class is enough, here and in the Edge Functions both.
 * The arguments are the same sentinels the prompt render uses; `$spec` needs
 * values, not their contents.
 */
function deriveSchemaWithCli(fnName, paramNames, bounds) {
  const argExprs = paramNames.map((n) => `\"${SENTINEL(n)}\"`).join(', ');
  const expr = `baml.json.schema(${fnName}$spec(${argExprs}).output_type())`;

  const bamlPath = dirname(bamlBin);
  const pathSep = process.platform === 'win32' ? ';' : ':';
  const out = execFileSync(
    bamlBin,
    ['run', '--project', PROMPTS_DIR, '-e', expr, '--output-format', 'json'],
    {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bamlPath}${pathSep}${process.env.PATH || ''}` },
    },
  );

  const schema = inlineRefs(JSON.parse(out));

  for (const [path, bound] of Object.entries(bounds ?? {})) {
    const node = resolvePath(schema, path);
    if (!node) {
      throw new Error(
        `${fnName}: bound path ${JSON.stringify(path)} does not resolve in the derived schema; ` +
          'update BOUNDS in scripts/export.mjs to match baml_src',
      );
    }
    Object.assign(node, bound);
  }
  return schema;
}

// --- main export ----------------------------------------------------------------
const canonicalSrc = files['baml_src/canonical_summary.baml'] ?? '';

// Extract function metadata: name, params, returnType, client
const fnMatch = /function\s+(\w+)\s*\(([^)]*)\)\s*->\s*(\w+)\s*\{[\s\S]*?client:\s*(\w+)/.exec(
  canonicalSrc,
);
if (!fnMatch) {
  throw new Error('Could not find function declaration in canonical_summary.baml');
}

const fnName = fnMatch[1];
const paramNames = fnMatch[2]
  .split(',')
  .map((p) => p.split(':')[0].trim())
  .filter(Boolean);
const returnType = fnMatch[3];
const client = fnMatch[4];
const model = models[client];

if (!model) {
  throw new Error(
    `${fnName}: client ${JSON.stringify(client)} is not a single pinned model in clients.baml. ` +
      'Each function names one client with a model; retry and fallback live in the worker, where the ledger is.',
  );
}

const messages = renderPromptWithCli(fnName, paramNames);
const schema = deriveSchemaWithCli(fnName, paramNames, BOUNDS[fnName]);

const exported = [
  {
    name: fnName,
    params: paramNames,
    client,
    model,
    returnType,
    messages,
    schema,
  },
];

const header = `/**
 * GENERATED by \`pnpm baml:export\` from packages/prompts/baml_src -- do not edit.
 *
 * Each entry is one BAML function: the prompt as a template with {{name}}
 * placeholders (substitute with \`renderPrompt\`), the client and the model it pins,
 * and the return type as plain JSON Schema with every reference inlined. The Deno
 * providers read these instead of carrying their own copies; CI check 2 regenerates
 * this file and fails on any difference.
 *
 * Source of truth: packages/prompts/baml_src.
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
