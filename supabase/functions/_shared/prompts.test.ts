import { describe, expect, it } from 'vitest';
import { PROMPTS, promptFor, renderPrompt, toGeminiSchema } from './prompts.ts';
import { buildSummaryPrompt, TOPIC_SLUGS } from './providers.ts';
import { GENERATED_KINDS } from './pipeline.ts';

/**
 * The export is the contract now. These pin what the providers rely on, so a
 * change to `baml_src` that breaks one of them fails here rather than at the
 * first paid call.
 */
const summary = PROMPTS.WriteCanonicalSummary;

describe('the exported prompt', () => {
  it('names one pinned client and its model', () => {
    expect(summary.client).toBe('GeminiFlash');
    expect(summary.model).toMatch(/^gemini-/);
  });

  it('carries every parameter as a placeholder', () => {
    const text = summary.messages.map((m) => m.text).join('\n');
    for (const p of summary.params) expect(text).toContain(`{{${p}}}`);
  });

  it('renders by substitution and refuses a missing argument', () => {
    const rendered = promptFor('WriteCanonicalSummary', {
      workTitle: 'Meditations',
      kind: 'book',
      context: 'notes',
    });
    expect(rendered).toContain('Source: Meditations');
    expect(rendered).toContain('Medium: book');
    expect(rendered).not.toContain('{{');
    expect(() => promptFor('WriteCanonicalSummary', { workTitle: 'x' })).toThrow(
      /missing argument/,
    );
  });

  it('is what buildSummaryPrompt now returns, with the context fallback applied', () => {
    // The provider-side fallback text used to be inside the template's conditional;
    // an exported template cannot carry a conditional, so it moved here.
    const withContext = buildSummaryPrompt({ workTitle: 'T', kind: 'essay', context: 'C' });
    const without = buildSummaryPrompt({ workTitle: 'T', kind: 'essay', context: '' });
    expect(withContext).toContain('Context:\nC');
    expect(without).toContain('(no additional context supplied)');
  });

  it('keeps the product-level instructions the hand-written prompt carried', () => {
    // A `///` comment on a BAML field never reaches the model; only the prompt
    // text does. These sentences were instructions in `buildSummaryPrompt` and
    // must stay instructions -- the schema is satisfied without them, which is
    // exactly how they would be lost silently. Found by Codex.
    const text = summary.messages.map((m) => m.text).join('\n');
    expect(text).toContain('what changes if the reader believes it');
    expect(text).toContain('states the idea rather than teasing it');
    expect(text).toContain('Do not retell the work section by section');
  });

  it('leaves an unknown placeholder alone rather than blanking it', () => {
    expect(renderPrompt('a {{b}} c', {})).toBe('a {{b}} c');
  });
});

describe('the exported schema', () => {
  const topics = summary.schema.properties.topics;

  it('files topics under the same slugs the pipeline narrows to', () => {
    // Aliases, not member names: a JSON-mode model answering `Philosophy` would
    // have every topic dropped by narrowTopics.
    expect([...topics.items.enum]).toEqual([...TOPIC_SLUGS]);
  });

  // `BOUNDS` in the exporter, not `@assert` -- v1 ignores that annotation.
  it('carries the bounds the exporter layers on', () => {
    expect(topics.minItems).toBe(1);
    expect(topics.maxItems).toBe(4);
    expect(summary.schema.properties.pulls.minItems).toBe(1);

    // `questions` is an ARRAY now, not an optional object -- an idea with nothing
    // worth asking carries an empty list rather than a null, so there is no
    // `anyOf [T, null]` to follow through any more.
    type Bounded = {
      maxItems?: number;
      items: { properties: Record<string, { minItems?: number; maxItems?: number }> };
    };
    const questions = summary.schema.properties.pulls.items.properties
      .questions as unknown as Bounded;
    expect(questions.maxItems).toBe(3);

    // A CEILING AND NO FLOOR on `distractors`, which is the assertion rather than
    // an incomplete one. It was `minItems: 3, maxItems: 3` while every question was
    // MCQ-shaped; a `recall` question has none and a `cloze` has none, and this
    // schema is enforced by the provider, so a floor would fail the whole synthesis
    // rather than the one question. The per-kind floor is
    // `quiz_questions_mcq_has_distractors` in 20260905120001, and
    // `questionsToWrite` drops a question that would meet it.
    expect(questions.items.properties.distractors?.maxItems).toBe(8);
    expect(questions.items.properties.distractors?.minItems).toBeUndefined();
    expect(questions.items.properties.rationale?.maxItems).toBe(8);
  });

  it('converts to the Gemini dialect the API enforces', () => {
    const g = toGeminiSchema(summary.schema);
    expect(g.type).toBe('OBJECT');
    expect(g.required).toEqual(expect.arrayContaining(['title', 'pulls', 'topics']));
    expect(g.properties?.topics?.type).toBe('ARRAY');
    expect(g.properties?.topics?.items?.type).toBe('STRING');
    expect(g.properties?.topics?.items?.enum).toEqual([...TOPIC_SLUGS]);
    expect(g.properties?.topics?.minItems).toBe(1);
    // The questions are an array of objects; each one names its kind from the
    // three the generator produces, in the database's own spelling.
    const qs = g.properties?.pulls?.items?.properties?.questions;
    expect(qs?.type).toBe('ARRAY');
    expect(qs?.items?.type).toBe('OBJECT');
    expect(qs?.items?.properties?.kind?.enum).toEqual(['recall', 'mcq', 'cloze']);
  });

  /*
   * THE THIRD LINK IN THE CHAIN, and it was the unguarded one.
   *
   * `schema.test.ts` pins the BAML source against the export, and the case above pins
   * the export's `kind` enum. Nothing tied either to `GENERATED_KINDS`, which is what
   * `questionsToWrite` actually filters on -- so adding `ordering` to the BAML enum
   * without adding it here would have every ordering question silently DROPPED by the
   * writer, with a green suite. Review finding, and the repo already has this pattern:
   * `packages/prompts/src/topics.test.ts` asserts `TopicSlug` against `TOPIC_SLUGS` in
   * both directions for exactly this reason.
   *
   * Both directions, because each catches a different mistake. A kind in the schema and
   * not in the set is a question the provider is asked for and the writer throws away;
   * a kind in the set and not in the schema is a filter that can never fire.
   */
  it('generates exactly the kinds the writer will store', () => {
    // No cast: `PROMPTS` is `as const`, so the enum is already a readonly tuple of
    // literals and spreading it is enough. A cast here would be the thing that hides a
    // shape change from the assertion meant to catch one.
    const inSchema =
      summary.schema.properties.pulls.items.properties.questions.items.properties.kind.enum;
    expect([...inSchema].sort()).toEqual([...GENERATED_KINDS].sort());
  });

  it('refuses a construct it cannot express', () => {
    expect(() => toGeminiSchema({ anyOf: [{ type: 'string' }, { type: 'number' }] })).toThrow();
    expect(() => toGeminiSchema({})).toThrow(/no type/);
  });
});
