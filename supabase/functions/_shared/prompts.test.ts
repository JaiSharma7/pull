import { describe, expect, it } from 'vitest';
import { PROMPTS, promptFor, renderPrompt, toGeminiSchema } from './prompts.ts';
import { buildSummaryPrompt, TOPIC_SLUGS } from './providers.ts';

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
    // `question` is optional, so it may arrive as `T` or as `anyOf [T, null]`.
    type Bounded = { properties: Record<string, { minItems?: number; maxItems?: number }> };
    const question: unknown = summary.schema.properties.pulls.items.properties.question;
    const inner = (
      question && typeof question === 'object' && 'anyOf' in question
        ? (question as { anyOf: readonly unknown[] }).anyOf[0]
        : question
    ) as Bounded;
    expect(inner.properties.distractors?.minItems).toBe(3);
    expect(inner.properties.distractors?.maxItems).toBe(3);
  });

  it('converts to the Gemini dialect the API enforces', () => {
    const g = toGeminiSchema(summary.schema);
    expect(g.type).toBe('OBJECT');
    expect(g.required).toEqual(expect.arrayContaining(['title', 'pulls', 'topics']));
    expect(g.properties?.topics?.type).toBe('ARRAY');
    expect(g.properties?.topics?.items?.type).toBe('STRING');
    expect(g.properties?.topics?.items?.enum).toEqual([...TOPIC_SLUGS]);
    expect(g.properties?.topics?.minItems).toBe(1);
    // An optional question is nullable in Gemini's dialect, not a union.
    const q = g.properties?.pulls?.items?.properties?.question;
    expect(q?.type).toBe('OBJECT');
  });

  it('refuses a construct it cannot express', () => {
    expect(() => toGeminiSchema({ anyOf: [{ type: 'string' }, { type: 'number' }] })).toThrow();
    expect(() => toGeminiSchema({})).toThrow(/no type/);
  });
});
