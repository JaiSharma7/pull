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

/**
 * Refuse a toolchain CI does not use.
 *
 * `baml generate` embeds compiled bytecode, and `_inlinedbaml.ts` does not even
 * reproduce across machines on one build -- so a *different* build is worse than
 * useless here. v0 got this for free: `generators.baml` carried a `version` field
 * and BAML itself refused a mismatched CLI. `baml.toml` has no equivalent, so the
 * check lives here, against the same `.baml-version` the CI installer reads.
 */
function assertPinnedToolchain() {
  const want = readFileSync(resolve(PROMPTS_DIR, '.baml-version'), 'utf8').trim();
  const reported = execFileSync(bamlBin, ['--version'], { encoding: 'utf8' });
  const got = /baml toolchain\s+(\S+)/.exec(reported);
  if (!got) {
    throw new Error(`could not read a toolchain version from \`baml --version\`:\n${reported}`);
  }
  if (got[1] !== want) {
    throw new Error(
      `BAML toolchain ${got[1]} is installed but this project pins ${want} ` +
        `(packages/prompts/.baml-version). Install it with:\n` +
        `  curl -fsSL https://pkg.boundaryml.com/install.sh | sh -s -- --version ${want}`,
    );
  }
}
assertPinnedToolchain();

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

// --- running the BAML CLI -------------------------------------------------------
/** Run the BAML CLI with the toolchain's own directory on PATH, and return stdout. */
function runBamlText(args) {
  const bamlPath = dirname(bamlBin);
  const pathSep = process.platform === 'win32' ? ';' : ':';
  return execFileSync(bamlBin, args, {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bamlPath}${pathSep}${process.env.PATH || ''}` },
  });
}

/** Evaluate one BAML expression against this project and parse its JSON result. */
function runBaml(expr) {
  return JSON.parse(
    runBamlText(['run', '--project', PROMPTS_DIR, '-e', expr, '--output-format', 'json']),
  );
}

// --- prompt rendering via BAML CLI ----------------------------------------------
const SENTINEL = (name) => `__WAP_ARG_${name}__`;

/** Render one function's prompt with `valueOf(param)` substituted for each argument. */
function renderWith(fnName, paramNames, valueOf) {
  const argExprs = paramNames.map((n) => `\"${valueOf(n)}\"`).join(', ');
  const expr = `${fnName}$render_prompt(${argExprs}).messages().map((m) -> { { \"role\": m.role, \"text\": m.content } })`;
  return runBaml(expr).map((m, i) => {
    if (typeof m.text !== 'string') {
      throw new Error(
        `${fnName}: message ${i} did not render to text (media, a tool block, or a nested ` +
          'content shape); only text prompts can be exported as templates',
      );
    }
    return { role: m.role ? m.role : 'user', text: m.text };
  });
}

/**
 * The prompt as a template, with `{{name}}` where each argument went.
 *
 * Two things have to hold for that to be honest, and both are checked rather than
 * assumed. Each argument must survive rendering verbatim, or there is nothing to
 * put a placeholder around. And rendering must *commute* with substitution: the
 * prompt a reader gets by filling in the template has to be the prompt BAML would
 * have rendered from the same values. A conditional on an argument's value breaks
 * the second without breaking the first -- `if (context != "")` keeps the sentinel
 * intact on the branch it happens to take, and quietly drops the other branch from
 * the export. So the prompt is rendered a second time with empty arguments and
 * compared against the template with its placeholders emptied.
 */
function renderPromptWithCli(fnName, paramNames) {
  const messages = renderWith(fnName, paramNames, SENTINEL);

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

  const fill = (text, value) =>
    paramNames.reduce((acc, n) => acc.split(`{{${n}}}`).join(value), text);
  const emptied = renderWith(fnName, paramNames, () => '');
  if (emptied.length !== messages.length) {
    throw new Error(
      `${fnName}: the prompt changes shape with its arguments (${messages.length} message(s) ` +
        `rendered, ${emptied.length} with empty arguments); it cannot be exported as a template`,
    );
  }
  emptied.forEach((m, i) => {
    if (m.text !== fill(messages[i].text, '')) {
      throw new Error(
        `${fnName}: the prompt branches on an argument's value, so the exported template ` +
          'would carry only the branch the export happened to take. Move the conditional to ' +
          'the caller (see `buildSummaryPrompt` in _shared/providers.ts).',
      );
    }
  });

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
    // At most three per idea, and at most three distractors on any one of them.
    // The ceiling is what keeps a widened question model from widening the call:
    // 3g adds kinds to the SAME synthesis request, so law 2 is untouched only for
    // as long as nothing here is unbounded.
    'pulls[].questions': { maxItems: 3 },
    'pulls[].questions[].distractors': { minItems: 3, maxItems: 3 },
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
  const schema = inlineRefs(runBaml(`baml.json.schema(${fnName}$spec(${argExprs}).output_type())`));

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
/**
 * Every `function` declared anywhere in `baml_src`, with the client it pins.
 *
 * Every, not the first: the export is what the Edge Functions run, and a function
 * missing from it fails as a lookup error at the call site rather than here. The
 * body is cut at the next declaration so a function without a `client:` cannot
 * silently borrow the next one's.
 */
function declaredFunctions(sources) {
  const out = [];
  for (const [file, src] of Object.entries(sources)) {
    // The return type is `[\w.]+` with optional `[]`/`?`, not `\w+`: `-> Pull[]`,
    // `-> Summary?` and `-> ns.Thing` are all valid and a narrower pattern drops them
    // -- silently, which is the failure `assertCoversEveryFunction` below exists to
    // make impossible rather than to fix twice.
    const decl = /function\s+(\w+)\s*\(([^)]*)\)\s*->\s*([\w.]+(?:\[\])?\??)\s*\{/g;
    let m;
    while ((m = decl.exec(src)) !== null) {
      const [, name, params, returnType] = m;
      const rest = src.slice(m.index + m[0].length);
      const next = rest.search(/\nfunction\s+\w+\s*\(/);
      const body = next === -1 ? rest : rest.slice(0, next);
      const client = /(?:^|\n)\s*client:\s*(\w+)/.exec(body);
      if (!client) {
        throw new Error(`${name} (${file}): no \`client:\` before the next declaration.`);
      }
      out.push({
        file,
        name,
        returnType,
        client: client[1],
        params: params
          .split(',')
          .map((p) => p.split(':')[0].trim())
          .filter(Boolean),
      });
    }
  }
  if (out.length === 0) {
    throw new Error(`no BAML function declarations found in ${SRC_DIR}`);
  }
  assertCoversEveryFunction(out.map((f) => f.name));
  return out;
}

/**
 * The regex above found every function the compiler did.
 *
 * Reading `.baml` with a regex is a compromise -- the metadata this script needs
 * (parameter names, the pinned client) is not on offer from the CLI in one call.
 * The compromise is only acceptable if failing to match is loud, because the
 * consequence otherwise is a function missing from the export with an exit code of
 * 0 and a green CI, which is how `WriteCanonicalSummary` came to be the only entry
 * for a while. `baml describe` is the compiler's own list; `$`-suffixed entries are
 * the generated `$spec`/`$parse`/`$render_prompt` companions, not declarations.
 */
function assertCoversEveryFunction(found) {
  const raw = runBamlText(['describe', '--project', PROMPTS_DIR]);
  const listed = raw
    .split('\n')
    .map((line) => /^function\s+(\S+)/.exec(line)?.[1])
    .filter((name) => name && !name.includes('$'));

  // A short listing would make this check pass by knowing less, which is the one way
  // a completeness guard fails worse than no guard. `baml describe` truncates its
  // *stdlib* output with an "N more lines" marker (see the baml-core skill); the
  // project listing does not appear to -- `--budget 3` and no budget both return every
  // symbol here. Both are cheap to refuse anyway, and the count comparison does not
  // depend on the marker's wording surviving a CLI release: a listing that reports
  // fewer functions than the source obviously declares is not a listing to trust.
  if (/\bmore lines?\b/i.test(raw)) {
    throw new Error(
      '`baml describe` truncated its output, so it cannot be used to check coverage. ' +
        'Re-run the export with a larger --budget in assertCoversEveryFunction().',
    );
  }
  if (listed.length < found.length) {
    throw new Error(
      `\`baml describe\` reported ${listed.length} function(s) but the source declares ` +
        `at least ${found.length} (${found.join(', ')}). The listing is incomplete, so it ` +
        'cannot confirm the export covers every contract.',
    );
  }

  const missed = listed.filter((name) => !found.includes(name));
  if (missed.length > 0) {
    throw new Error(
      `the exporter did not match ${missed.join(', ')}, which \`baml describe\` reports as ` +
        `declared. The declaration pattern in declaredFunctions() needs to cover it -- ` +
        'exporting the rest would drop it silently.',
    );
  }
}

const declared = declaredFunctions(files);

// A `BOUNDS` key that names no function applies to nothing, and says nothing while it
// does so: rename `WriteCanonicalSummary`, or mistype the key for a new function, and
// the export still succeeds with every bound quietly absent from the schema the model
// is given. The paths inside an entry are already checked; this checks the entry.
const orphanedBounds = Object.keys(BOUNDS).filter((name) => !declared.some((f) => f.name === name));
if (orphanedBounds.length > 0) {
  throw new Error(
    `BOUNDS names ${orphanedBounds.join(', ')}, which is not a declared BAML function. ` +
      `Declared: ${declared.map((f) => f.name).join(', ') || '(none)'}. A renamed function ` +
      'needs its BOUNDS key renamed with it, or its bounds stop reaching the schema.',
  );
}

const exported = declared.map(({ file, name, params, returnType, client }) => {
  const model = models[client];
  if (!model) {
    throw new Error(
      `${name} (${file}): client ${JSON.stringify(client)} is not a single pinned model in clients.baml. ` +
        'Each function names one client with a model; retry and fallback live in the worker, where the ledger is.',
    );
  }
  return {
    name,
    params,
    client,
    model,
    returnType,
    messages: renderPromptWithCli(name, params),
    schema: deriveSchemaWithCli(name, params, BOUNDS[name]),
  };
});

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
