/**
 * Export every BAML function's prompt and output schema as plain TypeScript the
 * Edge Functions can import.
 *
 * BAML's TypeScript runtime is a native Node addon and Edge Functions are Deno
 * isolates that cannot load one. This script is the other way across: it runs the
 * BAML v1 CLI to render prompts with placeholders and derives the JSON schema
 * with enum aliases and bounds, writing into `supabase/functions/_shared/generated/`.
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
  for (const m of source.matchAll(/client\s+(\w+)\s*=\s*[\w.]+\.new\([^)]*model\s*=\s*"([^"]+)"/gs)) {
    out[m[1]] = m[2];
  }
  return out;
}
const models = pinnedModels(files['baml_src/clients.baml'] ?? '');

/** Enum members → their `@alias`, where one is declared. */
function enumAliases(sources) {
  const out = {};
  for (const src of sources) {
    for (const block of src.matchAll(/^enum\s+(\w+)\s*\{([\s\S]*?)\}/gm)) {
      const map = {};
      for (const m of block[2].matchAll(/^\s*(\w+)\s+@alias\("([^"]+)"\)/gm)) {
        map[m[1]] = m[2];
      }
      out[block[1]] = map;
    }
  }
  return out;
}
const aliases = enumAliases(Object.values(files));

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
    }
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

// --- schema construction --------------------------------------------------------
function buildCanonicalSummarySchema(topicAliases) {
  const topicList = Object.values(topicAliases);
  return {
    type: 'object',
    properties: {
      elevatorPitch: {
        type: 'string',
      },
      pulls: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            body: {
              type: 'string',
            },
            example: {
              type: 'string',
            },
            explanation: {
              type: 'string',
            },
            headline: {
              type: 'string',
            },
            question: {
              type: 'object',
              properties: {
                answer: {
                  type: 'string',
                },
                distractors: {
                  type: 'array',
                  items: {
                    type: 'string',
                  },
                  minItems: 3,
                  maxItems: 3,
                },
                prompt: {
                  type: 'string',
                },
              },
              required: ['answer', 'distractors', 'prompt'],
            },
            whyItMatters: {
              type: 'string',
            },
          },
          required: ['body', 'headline', 'whyItMatters'],
        },
        minItems: 1,
      },
      title: {
        type: 'string',
      },
      topics: {
        type: 'array',
        items: {
          enum: topicList,
          type: 'string',
        },
        minItems: 1,
        maxItems: 4,
      },
      whyItMatters: {
        type: 'string',
      },
    },
    required: ['elevatorPitch', 'pulls', 'title', 'topics', 'whyItMatters'],
  };
}

// --- main export ----------------------------------------------------------------
const canonicalSrc = files['baml_src/canonical_summary.baml'] ?? '';

// Extract function metadata: name, params, returnType, client
const fnMatch = /function\s+(\w+)\s*\(([^)]*)\)\s*->\s*(\w+)\s*\{[\s\S]*?client:\s*(\w+)/.exec(canonicalSrc);
if (!fnMatch) {
  throw new Error('Could not find function declaration in canonical_summary.baml');
}

const fnName = fnMatch[1];
const paramNames = fnMatch[2].split(',').map((p) => p.split(':')[0].trim()).filter(Boolean);
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
const schema = buildCanonicalSummarySchema(aliases.TopicSlug ?? {});

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