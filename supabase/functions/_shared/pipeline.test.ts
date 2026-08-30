import { describe, expect, it } from 'vitest';
import {
  asRightsStatus,
  asWorkKind,
  BilledStepError,
  NO_USAGE,
  RIGHTS_STATUSES,
  runPipelineStep,
  WORK_KINDS,
} from './pipeline.ts';
import {
  assertFetchableUrl,
  contentHash,
  extractText,
  MAX_SOURCE_CHARS,
  segment,
} from './source.ts';
import { stubSummaryProvider } from './providers.ts';

/** A synthesize output, so `template` can be exercised without re-running it. */
const SYNTHESIZED = {
  title: 't',
  elevatorPitch: 'e',
  whyItMatters: 'w',
  pulls: [{ headline: 'h', body: 'b', whyItMatters: 'w' }],
};

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

  /**
   * Unterminated tags used to be quadratic, and the numbers were not close.
   *
   *     100 KB → 0.4s     400 KB → 6s     1 MB → 340s
   *
   * against a platform that kills the invocation at 150s — and synchronously, on a
   * single-threaded isolate, so no timeout could fire and nothing was recorded. Any
   * signed-in reader could point `target.url` at a server returning `"<script"` on
   * repeat. The bound is asserted rather than the implementation, because what must
   * stay true is "hostile input is not quadratic", not "an index scan is used".
   */
  it.each(['script', 'style'])('strips unterminated <%s> in linear time', (tag) => {
    const hostile = `<${tag}`.repeat(200_000); // ~1.2MB, 200k unclosed openers
    const started = Date.now();
    extractText(hostile);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('drops the tail after an unterminated script rather than keeping it', () => {
    // The safe direction: the remainder of a document whose script never closes is
    // not content, and keeping it would mean summarising markup.
    expect(extractText('<p>Before.</p><script>var x = 1;')).toBe('Before.');
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

  /**
   * The same addresses spelled in IPv6, which the IPv4 patterns cannot see.
   *
   * Blocking `::1` alone left every other private range reachable. The worker
   * writes what it fetched into `job_steps.output`, which the requester can
   * read — so this is an exfiltration path, not just an unwanted request.
   */
  it.each([
    'http://[::1]/',
    'http://[::1]:54321/rest/v1/',
    'http://[0:0:0:0:0:0:0:1]/',
    'http://[fd00::1]/', // unique-local
    'http://[fdff:ffff::9]/', // unique-local, upper half of fc00::/7
    'http://[fc00::1]/', // unique-local, lower half
    'http://[fe80::1]/', // link-local
    'http://[febf::1]/', // link-local, top of fe80::/10
    'http://[::ffff:127.0.0.1]/', // loopback, IPv4-mapped
    'http://[::ffff:169.254.169.254]/', // cloud metadata, IPv4-mapped
    'http://[::]/', // unspecified
    // Four spellings that reached the private network. The first two embed an IPv4
    // address in forms the mapped-address patterns never matched; `64:ff9b::/96` is
    // the one that actually routes, because an IPv6-only runtime behind NAT64/DNS64
    // translates it straight to the embedded IPv4 with no v4 check ever seeing a v4
    // address. Blocking spellings was the wrong shape — `::/96` is refused wholesale.
    'http://[::127.0.0.1]/', // IPv4-compatible → ::7f00:1
    'http://[::ffff:0:127.0.0.1]/', // IPv4-translated → ::ffff:0:7f00:1
    'http://[64:ff9b::127.0.0.1]/', // NAT64 well-known prefix
    'http://[fec0::1]/', // site-local, deprecated but still routed by some stacks
  ])('refuses the IPv6 address %s', (url) => {
    expect(() => assertFetchableUrl(url)).toThrow(/private or link-local/);
  });

  // A blocklist that refuses everything with a colon in it would be a different bug
  // wearing the same fix, so the allow side is asserted with the same weight.
  it.each(['http://[2606:4700:4700::1111]/', 'http://[2001:4860:4860::8888]/'])(
    'still allows the public IPv6 address %s',
    (url) => {
      expect(() => assertFetchableUrl(url)).not.toThrow();
    },
  );

  it.each(['file:///etc/passwd', 'data:text/html,hi', 'gopher://example.com/'])(
    'refuses the %s scheme',
    (url) => {
      expect(() => assertFetchableUrl(url)).toThrow(/refusing to fetch a/);
    },
  );

  it('allows an ordinary public URL', () => {
    expect(assertFetchableUrl('https://example.com/essay').hostname).toBe('example.com');
  });

  // Public IPv6 must still work; a blocklist that refuses everything with a
  // colon in it would be a different bug wearing the same fix.
  it('allows a public IPv6 address', () => {
    expect(() => assertFetchableUrl('http://[2606:4700:4700::1111]/')).not.toThrow();
  });
});

describe('enum narrowing at the boundary', () => {
  // Each of these values was actually sent to Postgres and rejected, failing
  // every job that reached the step. TypeScript cannot catch a string that is
  // invalid only in the database, so the narrowing is the check.
  it('maps an unknown kind to a real work_kind', () => {
    expect(asWorkKind('article')).toBe('essay');
    expect(asWorkKind(undefined)).toBe('essay');
    expect(asWorkKind('book')).toBe('book');
    for (const kind of WORK_KINDS) expect(asWorkKind(kind)).toBe(kind);
  });

  it('maps an unknown rights status to review_required, never to a publishable one', () => {
    expect(asRightsStatus('user_private')).toBe('review_required');
    expect(asRightsStatus(undefined)).toBe('review_required');
    expect(asRightsStatus('public_domain')).toBe('public_domain');
    for (const status of RIGHTS_STATUSES) expect(asRightsStatus(status)).toBe(status);
  });

  it('never defaults an unrecognised rights claim to something publishable', () => {
    // The direction of the failure is the point: an unknown claim must not
    // become publishable by accident. `resolve_identity` refuses anything that
    // is not public_domain or licensed.
    expect(['public_domain', 'licensed']).not.toContain(asRightsStatus('totally-made-up'));
  });
});

describe('the stub provider', () => {
  /**
   * "Runs with no API key" is a promise to every contributor cloning this repo.
   * The stub returned an empty `pulls` array and `synthesize` rejects exactly
   * that, so the documented no-key path failed at the step it was meant to
   * prove.
   */
  it('returns at least one Pull, so the no-key path can reach publish', async () => {
    const { summary } = await stubSummaryProvider.generateSummary({
      workTitle: 'On Liberty',
      kind: 'essay',
      context: 'The only freedom which deserves the name is that of pursuing our own good.',
    });

    expect(summary.pulls.length).toBeGreaterThan(0);
    expect(summary.pulls[0]?.headline).toContain('On Liberty');
    expect(summary.pulls[0]?.body.length).toBeGreaterThan(0);
  });

  it('survives the check synthesize actually applies', async () => {
    const { summary } = await stubSummaryProvider.generateSummary({
      workTitle: 'A Work',
      kind: 'essay',
      context: '',
    });
    // The literal condition from `synthesize`.
    expect(!summary.title || summary.pulls.length === 0).toBe(false);
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
    // What the fakes were handed, so the tests can assert on the values that
    // actually reach Postgres rather than only on how often it was called.
    const received: {
      upsertWork?: { kind: string; rightsStatus: string };
      createSummary?: { authorId: string | null; visibility: string };
    } = {};

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
            // Deliberately not equal to `name`: a provider that fell back to a
            // different model must be recorded as the model that answered.
            model: 'fake-model-b',
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
        requester_id: 'reader-1',
      },
      db: {
        findPublishedSummaryByHash: async (_hash: string, _requesterId: string | null) => reuse,
        upsertWork: async (input: { kind: string; rightsStatus: string }) => {
          received.upsertWork = input;
          return { workId: 'w1', existing: false };
        },
        createSummary: async (input: { authorId: string | null; visibility: string }) => {
          calls.createSummary++;
          received.createSummary = input;
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
    return { deps, calls, received };
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

  /*
   * The short-circuit.
   *
   *   reuse found:   acquire ──jumpTo──────────────────────────────→ publish
   *   source new:    acquire → chunk → … → template → … → publish
   *
   * Nine invocations of difference on the path law 2 predicts will dominate. Asserted
   * on the returned `jumpTo` rather than by counting invocations, because the worker
   * is what acts on it and the step's job is only to say so.
   */
  it('sends a reused job straight to publish', async () => {
    const { deps } = harness({ workId: 'w9', summaryId: 's9' });

    const acquired = await runPipelineStep('acquire', { ...deps, priorOutputs: {} } as never);

    expect(acquired.jumpTo).toBe('publish');
  });

  it('leaves a new source to walk every step', async () => {
    const { deps } = harness(null);

    const acquired = await runPipelineStep('acquire', { ...deps, priorOutputs: {} } as never);

    // Absent, not 'chunk'. `nextStep` stays the default so the pipeline is a straight
    // line unless a step has a reason to say otherwise.
    expect(acquired.jumpTo).toBeUndefined();
  });

  it('publishes a jumped job that never ran template', async () => {
    const { deps } = harness({ workId: 'w9', summaryId: 's9' });

    const acquired = await runPipelineStep('acquire', { ...deps, priorOutputs: {} } as never);
    // Exactly what the worker holds after a jump: acquire's output and nothing else.
    // Before `publish` learned to check reuse first, this threw "no summary to
    // publish" — the short-circuit would have failed every job it was meant to save.
    const published = await runPipelineStep('publish', {
      ...deps,
      priorOutputs: { acquire: acquired.output },
    } as never);

    expect(published.output).toMatchObject({ published: false, reason: 'reused' });
  });

  /**
   * The race `acquire` cannot see.
   *
   *   job A   acquire ─────── … ─────── synthesize ─── template(commit)
   *   job B        acquire(miss) ─── … ─────── synthesize ← re-check catches it here
   *
   * `acquire` and `synthesize` are separate invocations minutes apart, so the reuse
   * answer can go stale between them and two jobs can both pay for the same source.
   * The re-check narrows that window; it does not close it. See the comment in
   * `synthesize` for why reserving the fingerprint is deferred rather than half-built.
   */
  /** Misses on the first lookup and hits on the second — the race, deterministically. */
  function racingHarness() {
    const calls = { summary: 0, lookups: 0 };
    const attached: { jobId: string; summaryId: string; workId: string }[] = [];

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
              pulls: [{ headline: 'h', body: 'b', whyItMatters: 'w' }],
            },
            usage: { inputTokens: 1, outputTokens: 1, costCents: 1 },
            model: 'fake-model-b',
          };
        },
      },
      embedding: { name: 'fake', embed: async () => ({ vectors: [], usage: NO_USAGE }) },
      job: {
        id: 'job-2',
        kind: 'canonical_summary',
        target: { text: 'y'.repeat(400) },
        work_id: null,
        summary_id: null,
        visibility: 'private',
        requester_id: 'reader-1',
      },
      db: {
        findPublishedSummaryByHash: async () => {
          calls.lookups++;
          return calls.lookups === 1 ? null : { workId: 'w7', summaryId: 's7' };
        },
        upsertWork: async () => ({ workId: 'w1', existing: false }),
        createSummary: async () => 's1',
        insertPulls: async () => [],
        setPullEmbeddings: async () => undefined,
        publishSummary: async () => undefined,
        attachSummaryToJob: async (jobId: string, summaryId: string, workId: string) => {
          attached.push({ jobId, summaryId, workId });
        },
      },
    };
    return { deps, calls, attached };
  }

  it('calls no provider when another job published the source first', async () => {
    const { deps, calls } = racingHarness();

    const acquired = await runPipelineStep('acquire', { ...deps, priorOutputs: {} } as never);
    await runPipelineStep('synthesize', {
      ...deps,
      priorOutputs: { acquire: acquired.output },
    } as never);

    // The point of the whole change: the second job does not pay. Without the
    // re-check this is 1, and the money is already gone by the time `template`
    // adopts the winner's row.
    expect(calls.summary).toBe(0);
    expect(calls.lookups).toBe(2);
  });

  it('adopts the winner’s summary and jumps to publish', async () => {
    const { deps, attached } = racingHarness();

    const acquired = await runPipelineStep('acquire', { ...deps, priorOutputs: {} } as never);
    const synthesized = await runPipelineStep('synthesize', {
      ...deps,
      priorOutputs: { acquire: acquired.output },
    } as never);

    expect(synthesized.jumpTo).toBe('publish');
    // Attached, not merely detected: a job that skips generation and does not point at
    // the summary it adopted succeeds while showing the reader nothing.
    expect(attached).toEqual([{ jobId: 'job-2', summaryId: 's7', workId: 'w7' }]);
  });

  it('records the adoption in the shape publish already understands', async () => {
    const { deps } = racingHarness();

    const acquired = await runPipelineStep('acquire', { ...deps, priorOutputs: {} } as never);
    const synthesized = await runPipelineStep('synthesize', {
      ...deps,
      priorOutputs: { acquire: acquired.output },
    } as never);

    // Both origins write `reuse`, so `publish` never has to know which race it won.
    const published = await runPipelineStep('publish', {
      ...deps,
      priorOutputs: { acquire: acquired.output, synthesize: synthesized.output },
    } as never);

    expect(published.output).toMatchObject({ published: false, reason: 'reused' });
  });

  /**
   * These four assert the values that reach Postgres, not the shape of the code.
   *
   * Every one of them was wrong in a way that type-checked, passed every existing
   * test, and failed only against a real database — which is why the hosted
   * project has zero completed generation jobs. A test that mocks the database
   * cannot catch an invalid enum member unless it asserts the member.
   */
  it('writes a real work_kind, never the caller-supplied string', async () => {
    const { deps, received } = harness(null);
    // `article` is the natural thing to send for a URL and is not a work_kind.
    const job = { ...deps.job, target: { text: 'x'.repeat(400), kind: 'article' } };

    const identity = await runPipelineStep('resolve_identity', {
      ...deps,
      job,
      priorOutputs: {},
    } as never);
    const acquired = await runPipelineStep('acquire', {
      ...deps,
      job,
      priorOutputs: { resolve_identity: identity.output },
    } as never);
    const prior = { acquire: acquired.output, synthesize: SYNTHESIZED };
    await runPipelineStep('template', { ...deps, job, priorOutputs: prior } as never);

    expect(received.upsertWork?.kind).toBe('essay');
    expect(WORK_KINDS).toContain(received.upsertWork?.kind);
  });

  it('writes a real rights_status, and defaults an unknown one to review_required', async () => {
    const { deps, received } = harness(null);
    const job = {
      ...deps.job,
      target: { text: 'x'.repeat(400), rights_status: 'user_private' },
    };

    const identity = await runPipelineStep('resolve_identity', {
      ...deps,
      job,
      priorOutputs: {},
    } as never);
    const acquired = await runPipelineStep('acquire', {
      ...deps,
      job,
      priorOutputs: { resolve_identity: identity.output },
    } as never);
    await runPipelineStep('template', {
      ...deps,
      job,
      priorOutputs: { acquire: acquired.output, synthesize: SYNTHESIZED },
    } as never);

    // Not `user_private`, which is not a member and was rejected by Postgres.
    expect(received.upsertWork?.rightsStatus).toBe('review_required');
    expect(RIGHTS_STATUSES).toContain(received.upsertWork?.rightsStatus);
  });

  it('assigns a private summary to the reader who asked for it', async () => {
    const { deps, received } = harness(null);

    const acquired = await runPipelineStep('acquire', { ...deps, priorOutputs: {} } as never);
    await runPipelineStep('template', {
      ...deps,
      priorOutputs: { acquire: acquired.output, synthesize: SYNTHESIZED },
    } as never);

    // Without this, `summary_is_readable` hides the result from the only person
    // entitled to see it: the job succeeds and the requester gets nothing.
    expect(received.createSummary?.visibility).toBe('private');
    expect(received.createSummary?.authorId).toBe('reader-1');
  });

  /**
   * Reuse is the cost argument, but it can only reuse what the requester could
   * read. Summaries are published with the job's visibility, which defaults to
   * private — so matching on `status = 'published'` alone handed the second
   * submitter of a source the first submitter's private summary, skipped the
   * paid work, and reported success on a result `summary_is_readable` then
   * refused to show them.
   */
  describe('reuse respects who may read the summary', () => {
    function lookupWith(
      summaries: { id: string; status: string; visibility: string; author_id: string | null }[],
    ) {
      // Mirrors the predicate in db.ts against the same row shapes PostgREST
      // returns, so the rule is asserted rather than the query string.
      return (requesterId: string | null) =>
        summaries.find(
          (s) =>
            s.status === 'published' &&
            (s.visibility === 'public' || (s.author_id !== null && s.author_id === requesterId)),
        ) ?? null;
    }

    it('reuses a public summary for anyone', () => {
      const find = lookupWith([
        { id: 's-pub', status: 'published', visibility: 'public', author_id: 'someone-else' },
      ]);
      expect(find('reader-2')?.id).toBe('s-pub');
      expect(find(null)?.id).toBe('s-pub');
    });

    it('does not hand one reader another reader’s private summary', () => {
      const find = lookupWith([
        { id: 's-priv', status: 'published', visibility: 'private', author_id: 'reader-1' },
      ]);
      // The bug: this used to return s-priv, and the job succeeded with a
      // result the requester could not open.
      expect(find('reader-2')).toBeNull();
    });

    it('does reuse a reader’s own earlier private summary', () => {
      const find = lookupWith([
        { id: 's-priv', status: 'published', visibility: 'private', author_id: 'reader-1' },
      ]);
      expect(find('reader-1')?.id).toBe('s-priv');
    });

    it('ignores a draft even when it is public', () => {
      const find = lookupWith([
        { id: 's-draft', status: 'draft', visibility: 'public', author_id: null },
      ]);
      expect(find('reader-1')).toBeNull();
    });
  });

  it('passes the requester into the reuse lookup', async () => {
    let sawRequester: string | null | undefined;
    const { deps } = harness(null);
    const spied = {
      ...deps,
      db: {
        ...deps.db,
        findPublishedSummaryByHash: async (_hash: string, requesterId: string | null) => {
          sawRequester = requesterId;
          return null;
        },
      },
    };

    await runPipelineStep('acquire', { ...spied, priorOutputs: {} } as never);
    expect(sawRequester).toBe('reader-1');
  });

  /**
   * A provider that answers has already charged for the tokens, whether or not
   * the answer was usable. Throwing a bare Error there loses the only record of
   * the spend — and since the step retries, each retry pays again.
   */
  describe('a provider billed before the failure still reaches the ledger', () => {
    function harnessReturning(summary: {
      title: string;
      elevatorPitch: string;
      whyItMatters: string;
      pulls: { headline: string; body: string; whyItMatters: string }[];
    }) {
      const { deps } = harness(null);
      return {
        ...deps,
        summary: {
          name: 'fake',
          generateSummary: async () => ({
            summary,
            usage: { inputTokens: 900, outputTokens: 120, costCents: 7 },
            model: 'fake-model-b',
          }),
        },
      };
    }

    it.each([
      ['no pulls', { title: 't', elevatorPitch: 'e', whyItMatters: 'w', pulls: [] }],
      [
        'no title',
        {
          title: '',
          elevatorPitch: 'e',
          whyItMatters: 'w',
          pulls: [{ headline: 'h', body: 'b', whyItMatters: 'w' }],
        },
      ],
    ])('carries the usage when the provider returns %s', async (_label, summary) => {
      const deps = harnessReturning(summary);
      const acquired = await runPipelineStep('acquire', { ...deps, priorOutputs: {} } as never);

      const thrown = await runPipelineStep('synthesize', {
        ...deps,
        priorOutputs: { acquire: acquired.output },
      } as never).catch((e: unknown) => e);

      expect(thrown).toBeInstanceOf(BilledStepError);
      const billed = thrown as InstanceType<typeof BilledStepError>;
      // Without this the worker writes a failed step and nothing to cost_ledger,
      // and spend reports understate exactly the runs paying for nothing.
      expect(billed.usage.costCents).toBe(7);
      expect(billed.usage.inputTokens).toBe(900);
      expect(billed.model).toBe('fake-model-b');
      expect(billed.provider).toBe('fake');
    });
  });

  it('records the model that answered, not the head of the provider chain', async () => {
    const { deps } = harness(null);

    const acquired = await runPipelineStep('acquire', { ...deps, priorOutputs: {} } as never);
    const synthesized = await runPipelineStep('synthesize', {
      ...deps,
      priorOutputs: { acquire: acquired.output },
    } as never);

    expect(synthesized.model).toBe('fake-model-b');
    expect(synthesized.provider).toBe('fake');
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
