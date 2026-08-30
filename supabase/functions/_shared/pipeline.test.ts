import { describe, expect, it } from 'vitest';
import {
  assertFetchableUrl,
  contentHash,
  extractText,
  MAX_SOURCE_CHARS,
  runPipelineStep,
  segment,
} from './pipeline.ts';

/**
 * The generation pipeline.
 *
 * These live beside the Edge Function rather than in a workspace package
 * because the module is the one that actually runs — no copy to drift. It
 * depends on nothing Deno-specific (`crypto.subtle` and `fetch` are both
 * standard in Node), which is what lets Vitest load it at all.
 *
 * Steps needing a database or a provider are exercised against fakes that count
 * calls, because the properties worth protecting here are about *what was not
 * done*: no provider called on a reuse, no vector stored against the wrong Pull.
 */

describe('contentHash', () => {
  it('is stable for the same text', async () => {
    expect(await contentHash('the same words')).toBe(await contentHash('the same words'));
  });

  it('ignores whitespace and case, so trivial edits still dedupe', async () => {
    // This is the reuse branch's whole basis: one canonical generation serves
    // everyone, and a re-paste with different wrapping must not look like a new
    // source and pay for a second one.
    expect(await contentHash('  The  Same\n\nWords ')).toBe(await contentHash('the same words'));
  });

  it('separates genuinely different text', async () => {
    expect(await contentHash('one idea')).not.toBe(await contentHash('another idea'));
  });
});

describe('extractText', () => {
  it('drops script and style content rather than summarising it', () => {
    const html =
      '<p>Real prose.</p><script>var x = "not prose";</script><style>p{color:red}</style>';
    const text = extractText(html);
    expect(text).toContain('Real prose.');
    expect(text).not.toContain('not prose');
    expect(text).not.toContain('color:red');
  });

  it('decodes entities so quotes survive into the summary', () => {
    expect(extractText('<p>Darwin&#39;s &quot;long argument&quot; &amp; its critics</p>')).toBe(
      'Darwin\'s "long argument" & its critics',
    );
  });

  it('keeps paragraph breaks, because segment splits on them', () => {
    // This previously collapsed to "one two". `segment` splits on blank lines,
    // so that made every fetched article a single unsplittable chunk while the
    // segmentation tests passed against hand-written text that still had them.
    expect(extractText('<div>\n  <p>one</p>\n\n  <p>two</p>\n</div>')).toBe('one\n\ntwo');
  });

  it('collapses horizontal whitespace without eating the breaks', () => {
    expect(extractText('<p>one    two</p><p>three</p>')).toBe('one two\n\nthree');
  });

  it('produces text that segment can actually divide', () => {
    const html = Array.from({ length: 6 }, (_, i) => `<p>${'word '.repeat(400)}${i}</p>`).join('');
    expect(segment(extractText(html), 4000).length).toBeGreaterThan(1);
  });
});

describe('assertFetchableUrl', () => {
  // `acquire` follows a URL chosen by whoever created the job, from a server
  // holding a service-role key. These are the addresses where that becomes a
  // confused deputy rather than a fetch.
  it.each([
    'http://169.254.169.254/latest/meta-data/',
    'http://127.0.0.1:54321/rest/v1/',
    'http://localhost/admin',
    'http://10.0.0.5/',
    'http://192.168.1.1/',
    'http://172.16.0.1/',
    'http://metadata.google.internal/',
  ])('refuses %s', (url) => {
    expect(() => assertFetchableUrl(url)).toThrow(/private or link-local/);
  });

  it.each(['file:///etc/passwd', 'data:text/html,hi', 'gopher://example.com/'])(
    'refuses the %s scheme',
    (url) => {
      expect(() => assertFetchableUrl(url)).toThrow(/refusing to fetch a/);
    },
  );

  it('allows an ordinary public URL', () => {
    expect(assertFetchableUrl('https://example.com/essay').hostname).toBe('example.com');
  });
});

describe('segment', () => {
  it('keeps a short source as one section', () => {
    expect(segment('A single short paragraph.')).toEqual(['A single short paragraph.']);
  });

  it('never returns nothing, even for input it cannot split', () => {
    // A caller that has to special-case an empty array is a caller that will
    // forget to.
    expect(segment('   ').length).toBeGreaterThan(0);
  });

  it('splits on paragraph boundaries rather than mid-sentence', () => {
    const paragraphs = ['x'.repeat(3000), 'y'.repeat(3000), 'z'.repeat(3000)];
    const sections = segment(paragraphs.join('\n\n'), 4000);
    expect(sections.length).toBeGreaterThan(1);
    // Every section is a whole number of paragraphs: none begins part-way
    // through one, which is the property that makes a section summarisable.
    for (const section of sections) {
      expect(/^[xyz]+(\n\n[xyz]+)*$/.test(section)).toBe(true);
    }
  });

  it('does not lose text', () => {
    const source = ['alpha'.repeat(400), 'beta'.repeat(400), 'gamma'.repeat(400)].join('\n\n');
    const rejoined = segment(source, 1000).join('\n\n');
    expect(rejoined.replace(/\s/g, '')).toBe(source.replace(/\s/g, ''));
  });
});

/**
 * The reuse branch, which is the whole cost argument.
 *
 * A canonical generation serves every reader; regenerating per reader costs
 * roughly a thousand times more for the same thousand readers. The property
 * that makes that true is narrow and easy to lose: when the source has already
 * been summarised, no provider is called at all. Asserting on the summary's
 * content would not catch a regression here — only counting the calls does.
 */
describe('reuse skips the paid work', () => {
  function harness(reuse: { workId: string; summaryId: string } | null) {
    const calls = { summary: 0, embedding: 0, createSummary: 0, insertPulls: 0 };

    const deps = {
      summary: {
        name: 'fake',
        generateSummary: async () => {
          calls.summary++;
          return {
            summary: {
              title: 't',
              elevatorPitch: 'e',
              whyItMatters: 'w',
              // Non-empty: `synthesize` rejects a summary with no pulls, which is
              // itself a guarantee worth not accidentally disabling here.
              pulls: [{ headline: 'h', body: 'b', whyItMatters: 'w' }],
            },
            usage: { inputTokens: 1, outputTokens: 1, costCents: 1 },
          };
        },
      },
      embedding: {
        name: 'fake',
        embed: async (texts: string[]) => {
          calls.embedding++;
          return {
            vectors: texts.map(() => [1]),
            usage: { inputTokens: 1, outputTokens: 0, costCents: 1 },
          };
        },
      },
      job: {
        id: 'job-1',
        kind: 'canonical_summary',
        target: { text: 'x'.repeat(400) },
        work_id: null,
        summary_id: null,
        visibility: 'private',
      },
      db: {
        findPublishedSummaryByHash: async () => reuse,
        upsertWork: async () => ({ workId: 'w1', existing: false }),
        createSummary: async () => {
          calls.createSummary++;
          return 's1';
        },
        insertPulls: async () => {
          calls.insertPulls++;
          return [];
        },
        setPullEmbeddings: async () => undefined,
        publishSummary: async () => undefined,
        attachSummaryToJob: async () => undefined,
      },
    };
    return { deps, calls };
  }

  it('calls no provider when the source is already summarised', async () => {
    const { deps, calls } = harness({ workId: 'w9', summaryId: 's9' });

    const acquired = await runPipelineStep('acquire', { ...deps, priorOutputs: {} } as never);
    const prior = { acquire: acquired.output };

    await runPipelineStep('synthesize', { ...deps, priorOutputs: prior } as never);
    await runPipelineStep('critic', { ...deps, priorOutputs: prior } as never);
    const templated = await runPipelineStep('template', { ...deps, priorOutputs: prior } as never);

    expect(calls.summary).toBe(0);
    expect(calls.embedding).toBe(0);
    expect(calls.createSummary).toBe(0);
    expect(templated.output).toMatchObject({ summaryId: 's9', reused: true });
  });

  it('does call the provider when the source is new', async () => {
    const { deps, calls } = harness(null);

    const acquired = await runPipelineStep('acquire', { ...deps, priorOutputs: {} } as never);
    await runPipelineStep('synthesize', {
      ...deps,
      priorOutputs: { acquire: acquired.output },
    } as never);

    expect(calls.summary).toBe(1);
  });

  it('hashes the full source, so two long works sharing a prefix stay distinct', async () => {
    // Truncation is for what gets *sent* to the provider. Identity must not be
    // decided by the excerpt, or the second work adopts the first's summary.
    const shared = 'a'.repeat(MAX_SOURCE_CHARS);
    expect(await contentHash(shared + 'ending one')).not.toBe(
      await contentHash(shared + 'ending two'),
    );
  });
});

describe('embed', () => {
  it('refuses to publish when the provider returns too few vectors', async () => {
    const deps = {
      embedding: {
        name: 'fake',
        // One short: the last Pull would silently publish with no embedding,
        // invisible to ranking and to the Delta.
        embed: async (texts: string[]) => ({
          vectors: texts.slice(0, -1).map(() => [1]),
          usage: { inputTokens: 0, outputTokens: 0, costCents: 0 },
        }),
      },
      db: { setPullEmbeddings: async () => undefined },
      job: { visibility: 'private' },
      priorOutputs: {
        cards: {
          pulls: [
            { ordinal: 0, id: 'p0' },
            { ordinal: 1, id: 'p1' },
          ],
        },
        synthesize: {
          pulls: [
            { headline: 'a', body: 'a' },
            { headline: 'b', body: 'b' },
          ],
        },
      },
    };

    await expect(runPipelineStep('embed', deps as never)).rejects.toThrow(/1 vectors for 2 pulls/);
  });

  it('pairs each vector with the Pull ordinal it belongs to, not its position', async () => {
    const stored: { id: string; embedding: number[] }[] = [];
    const deps = {
      embedding: {
        name: 'fake',
        embed: async (texts: string[]) => ({
          vectors: texts.map((t) => [t.startsWith('first') ? 1 : 2]),
          usage: { inputTokens: 0, outputTokens: 0, costCents: 0 },
        }),
      },
      db: {
        setPullEmbeddings: async (rows: { id: string; embedding: number[] }[]) => {
          stored.push(...rows);
        },
      },
      job: { visibility: 'private' },
      priorOutputs: {
        // Returned out of order on purpose: the database promises no ordering.
        cards: {
          pulls: [
            { ordinal: 1, id: 'second-id' },
            { ordinal: 0, id: 'first-id' },
          ],
        },
        synthesize: {
          pulls: [
            { headline: 'first', body: 'first' },
            { headline: 'second', body: 'second' },
          ],
        },
      },
    };

    await runPipelineStep('embed', deps as never);
    expect(stored).toEqual([
      { id: 'second-id', embedding: [2] },
      { id: 'first-id', embedding: [1] },
    ]);
  });
});
