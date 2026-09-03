/**
 * The prompts and schemas the providers use, as exported from BAML.
 *
 * `generated/prompts.ts` is written by `pnpm baml:export` from
 * `packages/prompts/baml_src` and diffed by CI; this file is the hand-written
 * surface over it -- substitution into a template, and the one dialect conversion
 * Gemini needs. Nothing BAML runs here: the runtime is a native Node addon and this
 * is Deno. What crossed the boundary is text and a schema, at build time.
 */
import { PROMPTS } from './generated/prompts.ts';

export type PromptName = keyof typeof PROMPTS;

/**
 * Substitute `{{name}}` placeholders. Plain replacement, no escaping: the
 * exporter refuses any template in which an argument is transformed, so the
 * placeholder is always the argument verbatim, and a source text containing the
 * literal `{{kind}}` is substituted first-come rather than re-expanded.
 */
export function renderPrompt(template: string, args: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (whole, name: string) =>
    name in args ? (args[name] as string) : whole,
  );
}

/** The rendered user turn for one exported function. Every parameter must be given. */
export function promptFor(name: PromptName, args: Record<string, string>): string {
  const p = PROMPTS[name];
  for (const param of p.params) {
    if (!(param in args)) throw new Error(`${name}: missing argument ${param}`);
  }
  return p.messages.map((m) => renderPrompt(m.text, args)).join('\n\n');
}

/** Gemini's `responseSchema` dialect, or as much of it as the exported schema needs. */
export interface GeminiSchema {
  type: 'OBJECT' | 'ARRAY' | 'STRING' | 'NUMBER' | 'INTEGER' | 'BOOLEAN';
  properties?: Record<string, GeminiSchema>;
  items?: GeminiSchema;
  required?: string[];
  enum?: string[];
  nullable?: boolean;
  minItems?: number;
  maxItems?: number;
}

type JsonSchema = {
  // `readonly`, like the fields below it: the exported `PROMPTS` is `as const`, so a
  // nullable field arrives as the readonly tuple `['string', 'null']`.
  type?: string | readonly string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  required?: readonly string[];
  enum?: readonly string[];
  anyOf?: readonly JsonSchema[];
  minItems?: number;
  maxItems?: number;
};

/**
 * Plain JSON Schema → Gemini's dialect: uppercase type names, `nullable` instead
 * of a `null` union. The conversion is total over what the exporter emits and
 * throws on anything else, so a new BAML construct fails at module load rather
 * than at the first paid call.
 */
export function toGeminiSchema(schema: JsonSchema): GeminiSchema {
  // `T | null` arrives as anyOf [T, {type:'null'}] or as type ['T','null'].
  if (schema.anyOf) {
    const [inner, nul] = schema.anyOf;
    if (schema.anyOf.length !== 2 || !inner || nul?.type !== 'null') {
      throw new Error('toGeminiSchema: only `T | null` unions are supported');
    }
    return { ...toGeminiSchema(inner), nullable: true };
  }
  let type = schema.type;
  let nullable = false;
  if (Array.isArray(type)) {
    nullable = type.includes('null');
    type = type.find((t) => t !== 'null');
  }
  if (typeof type !== 'string') throw new Error('toGeminiSchema: schema has no type');
  const upper = type.toUpperCase();
  if (!['OBJECT', 'ARRAY', 'STRING', 'NUMBER', 'INTEGER', 'BOOLEAN'].includes(upper)) {
    throw new Error(`toGeminiSchema: unsupported type ${type}`);
  }
  const out: GeminiSchema = { type: upper as GeminiSchema['type'] };
  if (nullable) out.nullable = true;
  if (schema.enum) out.enum = [...schema.enum];
  if (schema.minItems !== undefined) out.minItems = schema.minItems;
  if (schema.maxItems !== undefined) out.maxItems = schema.maxItems;
  if (schema.items) out.items = toGeminiSchema(schema.items);
  if (schema.properties) {
    out.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([k, v]) => [k, toGeminiSchema(v)]),
    );
  }
  if (schema.required) out.required = [...schema.required];
  return out;
}

export { PROMPTS };
