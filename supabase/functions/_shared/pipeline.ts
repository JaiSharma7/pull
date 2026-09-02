/**
 * The generation pipeline: what each of the twelve steps actually does.
 *
 * Kept apart from the worker because the worker's job is queue mechanics —
 * claiming, retrying, advancing, archiving — and this one's is content. Round 1
 * proved the mechanics with stubs that wrote nothing; this makes the steps real
 * without touching the machine around them.
 *
 * Two rules shape everything here:
 *
 *   Law 2 — models run at generation time, once per canonical summary, never in
 *   the read path. Every provider call in the product is reachable from this
 *   file and nowhere else.
 *
 *   One step per invocation. Edge Functions cap at 150s wall clock, so a step
 *   that cannot finish inside one invocation is a step that must be split. Each
 *   returns its output for the next to read; nothing is held in memory between
 *   them.
 */

import type { Step } from './steps.ts';
import { BilledProviderError, TOPIC_SLUGS } from './providers.ts';
import type {
  CanonicalSummary,
  EmbeddingProvider,
  SummaryProvider,
  TopicSlug,
  Usage,
} from './providers.ts';
import { contentHash, extractText, fetchBounded, MAX_SOURCE_CHARS, segment } from './source.ts';

export const NO_USAGE: Usage = { inputTokens: 0, outputTokens: 0, costCents: 0 };

/**
 * A step that failed *after* a provider had already been billed.
 *
 * The provider meters the call when it answers, not when we like the answer. So
 * a summary that comes back with a blank title or no Pulls has cost exactly what
 * a good one costs, and throwing a bare Error there loses the only record of it:
 * the worker's failure path writes a `job_steps` row and nothing to
 * `cost_ledger`. Since the step then retries, each retry silently adds another
 * unrecorded charge, and spend reports understate precisely the runs that are
 * paying for nothing.
 *
 * Law 2 says every model call writes to the ledger — not every successful one.
 * Carrying the usage on the error is what lets the worker keep that promise on
 * the path where it is easiest to forget.
 */
export class BilledStepError extends Error {
  readonly usage: Usage;
  readonly model: string | undefined;
  readonly provider: string | undefined;

  constructor(message: string, billed: { usage: Usage; model?: string; provider?: string }) {
    super(message);
    this.name = 'BilledStepError';
    this.usage = billed.usage;
    this.model = billed.model;
    this.provider = billed.provider;
  }
}

/**
 * What a step hands back: what it made, what it cost, and who made it.
 *
 * `usage` is optional because most steps spend nothing — only `synthesize`,
 * `embed` and `artwork` call a provider. Absent means "no provider was called",
 * which the worker records as a zero-cost step rather than as missing
 * accounting: a free or local provider has to stay distinguishable from a
 * measurement that never happened.
 */
export interface StepResult {
  usage?: Usage;
  output?: unknown;
  model?: string;
  provider?: string;
  /**
   * Skip ahead instead of advancing to the next step.
   *
   * The step machine is otherwise a straight line, and this is the one branch in it:
   * a job that adopts an existing summary has nothing left to generate. Expressed as
   * data returned by the step rather than as a decision the worker makes, so the
   * knowledge of *why* a jump is legal stays with the step that established it.
   */
  jumpTo?: Step;
}

export interface JobRow {
  id: string;
  kind: string;
  target: Record<string, unknown>;
  work_id: string | null;
  summary_id: string | null;
  visibility: string;
  /** Who asked. Becomes `summaries.author_id`, which is what makes a private
   *  summary readable by the person who requested it. */
  requester_id: string | null;
}

/**
 * Mirrors of the two Postgres enums this pipeline writes into.
 *
 * Written out rather than inferred because the failure they prevent is silent at
 * every layer above the database: TypeScript accepts any string, PostgREST
 * forwards it, and Postgres rejects the insert at the very end — after the
 * expensive call has already been paid for. `article` and `user_private` both
 * looked plausible and were both invalid, and each one failed every job that
 * reached it.
 *
 * If either enum changes, these change in the same commit. That is the same rule
 * `packages/db` already lives under.
 */
export const WORK_KINDS = [
  'book',
  'film',
  'documentary',
  'podcast',
  'paper',
  'essay',
  'lecture',
  'video',
  'interview',
  'other',
] as const;
export type WorkKind = (typeof WORK_KINDS)[number];

export const RIGHTS_STATUSES = [
  'public_domain',
  'licensed',
  'user_owned',
  'public_reference',
  'community',
  'review_required',
] as const;
export type RightsStatus = (typeof RIGHTS_STATUSES)[number];

/** How many topics one work may carry. Beyond this the signal stops meaning anything. */
const MAX_TOPICS_PER_WORK = 4;

/**
 * Narrow a model-supplied topic list to slugs Postgres will accept.
 *
 * Drops unknown slugs rather than substituting a default. There is no safe default
 * here: filing an astronomy lecture under `philosophy` to avoid an empty list would
 * corrupt the one signal a reader's stated preferences steer by, and `topic_affinity`
 * already treats "no topics" correctly as no affinity.
 *
 * De-duplicated because the model occasionally returns a parent and its child twice
 * over, and `work_topics` is unique on `(work_id, topic_id)`.
 */
export function narrowTopics(value: unknown): TopicSlug[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<TopicSlug>();
  for (const entry of value) {
    if (TOPIC_SLUGS.includes(entry as TopicSlug)) seen.add(entry as TopicSlug);
    if (seen.size >= MAX_TOPICS_PER_WORK) break;
  }
  return [...seen];
}

/**
 * A fetched web page is an essay unless the caller says otherwise.
 *
 * The previous default was `article`, which is not a `work_kind` — so the most
 * ordinary request there is, "summarise this URL", failed at `template` after
 * paying for synthesis. `essay` is the member that actually describes prose
 * making an argument, and `product.md` already gives it a section shape
 * (Thesis · Evidence · Implications · Counterarguments).
 */
export const DEFAULT_WORK_KIND: WorkKind = 'essay';

/** Narrow a caller-supplied kind, rather than trusting it as far as Postgres. */
export function asWorkKind(value: unknown): WorkKind {
  return WORK_KINDS.includes(value as WorkKind) ? (value as WorkKind) : DEFAULT_WORK_KIND;
}

/**
 * Narrow a caller-supplied rights status.
 *
 * Unknown falls to `review_required` — the value that is explicitly not
 * publishable. An unrecognised rights claim is precisely the case that must not
 * quietly become a publishable one, and `resolve_identity` already refuses to
 * publish anything that is not `public_domain` or `licensed`.
 */
export function asRightsStatus(value: unknown): RightsStatus {
  return RIGHTS_STATUSES.includes(value as RightsStatus)
    ? (value as RightsStatus)
    : 'review_required';
}

/**
 * What the pipeline needs from the outside world.
 *
 * An interface rather than a Supabase client so the steps can be exercised
 * without a database or a network — the same reasoning that keeps `config.ts`
 * free of a client.
 */
export interface PipelineDeps {
  summary: SummaryProvider;
  embedding: EmbeddingProvider;
  /** Outputs of this job's already-succeeded steps, keyed by step name. */
  priorOutputs: Record<string, unknown>;
  job: JobRow;
  db: PipelineDb;
  fetchImpl?: typeof fetch;
}

export interface PipelineDb {
  /**
   * The reuse lookup, by content fingerprint rather than by work id.
   *
   * Keyed on the hash because that is what is known *before* generating: asking
   * "has this exact source already been summarised" only saves money if it can
   * be asked before the expensive call, not after it.
   *
   * `requesterId` is not optional and is not for filtering convenience: reuse
   * must be limited to what this requester could read, or the job adopts a
   * summary it cannot show them. Public summaries are reusable by anyone —
   * which is the case the economics actually rest on — and a reader's own
   * private summaries are reusable by that reader.
   */
  findPublishedSummaryByHash(
    contentHash: string,
    requesterId: string | null,
  ): Promise<{ workId: string; summaryId: string } | null>;
  upsertWork(input: {
    title: string;
    kind: WorkKind;
    contentHash: string;
    rightsStatus: RightsStatus;
    /**
     * Already narrowed by `narrowTopics`. Written to `work_topics` only for a work
     * this call actually creates: an existing work has been classified once already,
     * and re-filing it on every reuse would let one job's classification overwrite
     * another's for a source that has not changed.
     */
    topics: TopicSlug[];
    /**
     * Where a reader can open the original, and who wrote it.
     *
     * Both come from the job target, and both were in hand from the first step and
     * dropped on the floor: `resolve_identity` validates the URL and returns it, and
     * `scripts/seed-corpus.mjs` reads an author out of the manifest and deliberately
     * did not forward it because `works` had no column for one. It does now
     * (20260901160000).
     *
     * This is not decoration. "Analysis, not reproduction" (law 4) is an argument that
     * rests on sending the reader to the source; a summary with no author credited and
     * nothing linking to the original is the artefact that argument disclaims.
     */
    sourceUrl: string | null;
    author: string | null;
    /**
     * Null from any job that is not publishing canonically, and that is a
     * security boundary rather than a tidiness rule.
     *
     * `enqueue_generation_job` is `security definer`, granted to `authenticated`,
     * and inserts the requester's `target` jsonb verbatim without validating it.
     * `generation_jobs.visibility` defaults to `private`, and `resolve_identity`
     * only refuses a bad rights claim when the job is public — so a signed-in
     * reader can queue any URL with any rights claim, or none, which narrows to
     * `review_required` and scores 0.3. `template` is step 5 and `moderate`, the
     * rights gate, is step 10: separate Edge Function invocations, so the `works`
     * row commits five steps before anything checks it.
     *
     * Since `works` is keyed by `content_hash` and adopted rather than
     * duplicated, that reader could pre-create the row for a source the project
     * was about to publish and pin 0.24 of its `get_feed` score at 0.3 for every
     * reader, permanently, at 50 jobs a day.
     *
     * So a non-canonical job writes no score at all and the column defaults
     * stand. A canonical one writes, and — unlike before — also RE-scores a row
     * it adopts, because otherwise a row a private job created first would keep
     * its defaults forever. The original rule this replaces ("written only on
     * creation") was reasoning about two honest jobs racing, which it got right;
     * it simply never considered an adversarial requester.
     */
    qualityScore: number | null;
    trustScore: number | null;
  }): Promise<{ workId: string; existing: boolean }>;
  createSummary(input: {
    workId: string;
    title: string;
    elevatorPitch: string;
    whyItMatters: string;
    sections: unknown;
    visibility: string;
    /**
     * The reader this was generated for. Null only for canonical content with no
     * requester. `summary_is_readable` keys non-public access off this column, so
     * it is not decoration — see `createSummary` in `db.ts`.
     */
    authorId: string | null;
  }): Promise<string>;
  /**
   * Returns each Pull with the ordinal it was written at.
   *
   * Not a bare id list: `embed` has to put the right vector on the right Pull,
   * and matching by array position assumes an ordering the database never
   * promised. A silently transposed pair of vectors is invisible — the Delta
   * and search would simply be wrong about two ideas forever.
   */
  insertPulls(
    summaryId: string,
    pulls: { headline: string; body: string; whyItMatters: string | null }[],
  ): Promise<{ ordinal: number; id: string }[]>;
  setPullEmbeddings(rows: { id: string; embedding: number[] }[]): Promise<void>;
  /**
   * Recall questions, one per Pull that has one.
   *
   * Keyed by the written Pull's id rather than by array position, for the reason
   * `insertPulls` returns ordinals at all: a question attached to the wrong idea
   * is invisible and permanent.
   */
  insertQuizQuestions(
    rows: { pullId: string; prompt: string; answer: string; distractors: string[] }[],
  ): Promise<void>;
  publishSummary(summaryId: string): Promise<void>;
  attachSummaryToJob(jobId: string, summaryId: string, workId: string): Promise<void>;
}

/**
 * How far a source is to be trusted, from where it came from.
 *
 * `works.trust_score` and `works.quality_score` are 0.24 of `get_feed`'s score
 * combined, and no step has ever written either — so every generated work has
 * sat at the 0.5 default forever while the six hand-seeded ones carry real
 * numbers. A quarter of the ranking has been a constant.
 *
 * Deterministic, and deliberately not a model's opinion: this runs at generation
 * time where a model would be permitted, but a provenance judgement that varies
 * between two runs over the same URL is not a judgement, it is noise with a
 * decimal point. A known public-domain archive is more trustworthy than an
 * arbitrary host serving the same text, and that is the whole claim.
 */
export function trustFromProvenance(rights: RightsStatus, url: string | null): number {
  if (rights === 'review_required') return 0.3;
  if (rights === 'public_domain') {
    let host = '';
    try {
      host = url ? new URL(url).hostname.toLowerCase() : '';
    } catch {
      host = '';
    }
    /*
     * Subdomains count, because the real ones are where the texts live —
     * `www.gutenberg.org`, `en.wikisource.org`. With one exception that the
     * suffix rule got wrong: `web.archive.org` is the Wayback Machine, which
     * serves an archived copy of *any* site under an archive.org hostname. So
     * `https://web.archive.org/web/…/https://anywhere.example/text` inherited
     * the maximum score on the strength of a host that says nothing about the
     * text behind it.
     */
    const known = ['gutenberg.org', 'wikisource.org', 'classics.mit.edu', 'archive.org'];
    if (host === 'web.archive.org') return 0.7;
    return known.some((k) => host === k || host.endsWith(`.${k}`)) ? 0.9 : 0.7;
  }
  if (rights === 'licensed') return 0.8;
  return 0.5;
}

/**
 * How good the draft looks, from its own shape.
 *
 * Structural only, for the same reason: a critic model asked "how good is this"
 * returns a different number each time it is asked. What can be measured
 * consistently is whether the summary is the shape a summary should be — enough
 * ideas, bodies of a readable length, every idea saying why it matters, and a
 * classification that lets a reader's preferences reach it at all.
 *
 * Centred so a merely adequate draft lands near the 0.5 default rather than
 * above it: this has to be able to rank a weak generated work BELOW the seeded
 * corpus, or writing it changes nothing.
 */
export function qualityFromDraft(summary: {
  pulls: { body: string; whyItMatters?: string }[];
  // `unknown` because the caller reads this off a stored step output, where it
  // has already been through JSON and back. Narrowed below rather than asserted.
  topics?: unknown;
}): number {
  const pulls = summary.pulls ?? [];
  if (pulls.length === 0) return 0.3;

  // Eight to fourteen ideas is what a source page needs for the Delta to say
  // anything ("4 of 18 are new to you" needs an 18). Fewer is thin; more is
  // usually the model padding -- and until now that sentence was a comment
  // rather than a term: `min(1, n / 8)` saturated at eight and treated forty
  // Pulls as ideal. A band, then: full marks from eight to fourteen, falling
  // off linearly on either side and reaching zero at forty, the same slope
  // out as in.
  const n = pulls.length;
  const count = n < 8 ? n / 8 : n <= 14 ? 1 : Math.max(0, 1 - (n - 14) / 26);

  const lengths = pulls.map((p) => (p.body ?? '').trim().length);
  const inBand = lengths.filter((n) => n >= 200 && n <= 900).length / pulls.length;

  const explained =
    pulls.filter((p) => (p.whyItMatters ?? '').trim().length > 0).length / pulls.length;

  const classified = Array.isArray(summary.topics) && summary.topics.length > 0 ? 1 : 0;

  const score = 0.35 * count + 0.3 * inBand + 0.2 * explained + 0.15 * classified;
  // Clamped rather than trusted: every term is already bounded, and a future
  // edit that unbalances the weights should produce a wrong ranking rather than
  // a value Postgres refuses.
  return Math.max(0, Math.min(1, Number(score.toFixed(3))));
}

/**
 * The quiz questions that are safe to write, paired to the Pulls that were.
 *
 * Narrowed rather than trusted. The provider's schema requires all three fields,
 * but a stub or a future provider does not go through Gemini at all — and this
 * repo has already lost a run to four values TypeScript accepted and Postgres
 * refused, discovered only after the expensive call had been paid for.
 *
 * A question missing either half is dropped rather than written half-formed:
 * `get_due_reviews` copes with a Pull that has no question, and cannot cope with
 * one whose answer is the string "undefined".
 *
 * Paired by ORDINAL, never by array position. `insertPulls` returns ordinals for
 * exactly this reason — a question attached to the wrong idea is invisible and
 * permanent.
 */
export function questionsToWrite(
  pulls: readonly { question?: { prompt?: unknown; answer?: unknown; distractors?: unknown } }[],
  written: readonly { ordinal: number; id: string }[],
): { pullId: string; prompt: string; answer: string; distractors: string[] }[] {
  const byOrdinal = new Map(written.map((w) => [w.ordinal, w.id]));
  const out: { pullId: string; prompt: string; answer: string; distractors: string[] }[] = [];

  pulls.forEach((p, ordinal) => {
    const pullId = byOrdinal.get(ordinal);
    const q = p.question;
    if (!pullId || !q) return;
    const prompt = typeof q.prompt === 'string' ? q.prompt.trim() : '';
    const answer = typeof q.answer === 'string' ? q.answer.trim() : '';
    if (!prompt || !answer) return;
    const distractors = Array.isArray(q.distractors)
      ? q.distractors.filter((d): d is string => typeof d === 'string' && d.trim().length > 0)
      : [];
    out.push({ pullId, prompt, answer, distractors });
  });

  return out;
}

interface AcquireOutput {
  text: string;
  hash: string;
  title: string;
  kind: WorkKind;
  /** Carried forward from `resolve_identity` so `template` writes the status that
   *  was actually validated, rather than re-deriving it from the raw target. */
  rights: RightsStatus;
  /** The source URL, carried forward for exactly the same reason as `rights`: the
   *  one `resolve_identity` validated, not the raw target re-read at the far end.
   *  Empty for a job that supplied pasted text, which is a legitimate state — a
   *  work with no URL simply renders without an outbound link. */
  url: string;
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

/**
 * What a step records when the source turns out to be already summarised.
 *
 * Two steps can establish this and both write it under the same `reuse` key, so every
 * downstream check is one question rather than one per origin:
 *
 *   acquire.reuse     — the source was already summarised when this job started
 *   synthesize.reuse  — another job published it while this one was queued
 *
 * The second is rarer and is caught immediately before the provider call. Keeping the
 * shape identical is what lets `publish` stay ignorant of which race it won.
 */
function reuseOf(priorOutputs: Record<string, unknown>): { summaryId: string } | null {
  const acquired = priorOutputs.acquire as { reuse?: { summaryId: string } } | undefined;
  const synthesized = priorOutputs.synthesize as { reuse?: { summaryId: string } } | undefined;
  return acquired?.reuse ?? synthesized?.reuse ?? null;
}

/**
 * Run one step.
 *
 * Steps that produce nothing yet return zero usage and no output, which is a
 * real state rather than a placeholder: `critic` and `moderate` are gates, and a
 * gate that passes has nothing to write.
 */
export async function runPipelineStep(step: Step, deps: PipelineDeps): Promise<StepResult> {
  const { job, db, priorOutputs } = deps;

  switch (step) {
    /**
     * Decide what this job is about, and whether it needs to run at all.
     *
     * The reuse branch is the one that matters commercially. If a published
     * summary already exists for this work, the job stops here and adopts it —
     * the difference between generating once for everyone and generating once
     * per reader.
     */
    case 'resolve_identity': {
      const target = job.target;
      // Narrowed to a real `work_kind` here, at the boundary, rather than passed
      // through as whatever the caller typed. `template` writes this into
      // `works.kind`, and an invalid value fails there — after synthesis has been
      // paid for.
      const kind = asWorkKind(target.kind);
      const text = asString(target.text);
      const url = asString(target.url);
      const title = asString(target.title, url || 'Untitled source');

      if (!text && !url) {
        throw new Error('resolve_identity: target has neither text nor url');
      }

      // Rights are checked here, not at `moderate`, because they are knowable
      // now and the answer never changes. Leaving it until after synthesis meant
      // paying a provider, writing a summary and embedding every Pull for a job
      // that was always going to be refused at the last step.
      //
      // An unset or unrecognised claim narrows to `review_required`, which is
      // never publishable — so the default direction of any mistake here is to
      // refuse, not to publish.
      const rights = asRightsStatus(target.rights_status);
      if (job.visibility === 'public' && rights !== 'public_domain' && rights !== 'licensed') {
        throw new Error(
          `resolve_identity: cannot publish a summary of a source with rights_status "${asString(target.rights_status) || 'unset'}"`,
        );
      }

      return { output: { kind, title, url, rights, hasInlineText: text.length > 0 } };
    }

    /**
     * Get the text.
     *
     * Inline text is taken as given. A URL is fetched and stripped. Anything
     * else — a book by name, a film — needs a resolver that does not exist yet,
     * and failing loudly here is better than generating a summary of a title.
     */
    case 'acquire': {
      const identity = (priorOutputs.resolve_identity ?? {}) as Record<string, unknown>;
      const target = job.target;
      let text = asString(target.text);

      if (!text) {
        const url = asString(target.url);
        if (!url) throw new Error('acquire: no text and no url to fetch');
        text = extractText(await fetchBounded(url, deps.fetchImpl ?? fetch));
      }

      if (text.length < 200) {
        throw new Error(
          `acquire: only ${text.length} characters of source; too little to summarise`,
        );
      }

      // Hashed before truncation, deliberately. Two long works sharing an
      // introduction would otherwise collapse into one, and the second would
      // adopt the first's summary — dedupe turning into corruption.
      const hash = await contentHash(text);

      /*
       * The reuse branch, and the reason it lives here rather than after
       * synthesis.
       *
       * One canonical generation serves every reader; a thousand personalised
       * regenerations of one source cost roughly a thousand times more. That
       * argument only holds if "does this already exist" is asked *before* the
       * provider is called. Asked afterwards — where it used to be — a duplicate
       * request still paid in full and then discarded the result.
       */
      const reuse = await db.findPublishedSummaryByHash(hash, job.requester_id);
      if (reuse) await db.attachSummaryToJob(job.id, reuse.summaryId, reuse.workId);

      /*
       * A reused job is finished, and walking it to `publish` one step at a time
       * costs nine Edge Function invocations to reach nine no-ops.
       *
       *   without jumpTo   acquire → chunk → evidence → synthesize → template →
       *                    critic → cards → artwork → embed → moderate → publish
       *                              └──────── nine invocations, all skipped ────────┘
       *
       *   with jumpTo      acquire ─────────────────────────────────────────→ publish
       *
       * This is the path law 2 predicts will dominate: one canonical summary serving
       * thousands of readers means reuse is the common case and generation the rare
       * one, so the cheapest outcome was burning the most invocations per unit of
       * value. It is the same argument the dispatcher gate made — the invocation is
       * what costs, not the tick.
       *
       * It jumps to `publish` rather than straight to done so a reused job still ends
       * with `current_step = 'publish'` like every other job, and still records a step
       * row saying it concluded by reuse. `publish` is a no-op on a reused summary —
       * the summary it adopted was already published, which is how it was found.
       *
       * Skipping `moderate` is safe here and only here: moderate is the rights gate
       * before *publication*, and this job publishes nothing. `findPublishedSummaryByHash`
       * already restricts what can be adopted to summaries that are public or the
       * requester's own, so no rights decision is being taken on trust.
       */

      // Truncated rather than refused: a long work still produces a useful
      // canonical summary, and the alternative is a job that can never succeed.
      // Where the cut falls is recorded so a later pass can tell it happened.
      const truncated = text.length > MAX_SOURCE_CHARS;
      const kept = truncated ? text.slice(0, MAX_SOURCE_CHARS) : text;

      const out: AcquireOutput & {
        truncated: boolean;
        reuse?: { workId: string; summaryId: string };
      } = {
        text: kept,
        hash,
        title: asString(identity.title, 'Untitled source'),
        kind: asWorkKind(identity.kind),
        rights: asRightsStatus(identity.rights),
        url: asString(identity.url),
        truncated,
        ...(reuse ? { reuse } : {}),
      };
      return reuse ? { output: out, jumpTo: 'publish' } : { output: out };
    }

    /** Structural segmentation. A model pass can refine these later. */
    case 'chunk': {
      const acquired = priorOutputs.acquire as AcquireOutput | undefined;
      if (!acquired?.text) throw new Error('chunk: acquire produced no text');
      const sections = segment(acquired.text);
      return { output: { sectionCount: sections.length, sections } };
    }

    /**
     * Evidence spans, so a claim can be traced back to what produced it.
     *
     * Currently the section offsets themselves — enough for `citation_anchors`
     * to point at a region of the source. Quote-level anchoring needs the
     * synthesis to exist first, so it belongs after `cards`, not here.
     */
    case 'extract_evidence': {
      const chunked = (priorOutputs.chunk ?? {}) as { sections?: string[] };
      const sections = chunked.sections ?? [];
      let offset = 0;
      const spans = sections.map((section, index) => {
        const span = { index, start: offset, end: offset + section.length };
        offset += section.length;
        return span;
      });
      return { output: { spans } };
    }

    /** The one expensive call. Produces the canonical summary and its Pulls. */
    case 'synthesize': {
      // The whole point of the reuse branch: when `acquire` already found a
      // published summary for this exact source, no provider is called at all.
      // A job that took that branch normally jumps straight to `publish`; this
      // still guards the path where a crash between `acquire` and its advance sent
      // the job the long way round.
      if (reuseOf(priorOutputs)) return { output: { skipped: 'reused an existing summary' } };

      const acquired = priorOutputs.acquire as AcquireOutput | undefined;
      if (!acquired?.text) throw new Error('synthesize: acquire produced no text');

      /*
       * Asked a second time, immediately before paying.
       *
       *   job A   acquire ──────── … ──────── synthesize ─── template(commit)
       *   job B        acquire(miss) ──── … ──────── synthesize ← re-check catches it here
       *
       * `acquire` asks whether this source is already summarised, but the answer can
       * go stale: `acquire` and `synthesize` are separate invocations, minutes apart
       * on a queue, so two jobs fingerprinting the same text can both miss and both
       * pay. The adopt-on-23505 in `createSummary` stops that ending in a crash — but
       * a duplicated provider bill is a law 2 failure whether or not anything throws.
       *
       * This does not serialize; it narrows. The window shrinks from the whole
       * acquire→synthesize span to the moment between this lookup and the call below.
       * Closing it properly means reserving the fingerprint — a `generation_hash_claims`
       * row taken at `acquire` and released at publish or failure — which is a migration,
       * a lease timeout, and a new way for a crashed job to block every later one on the
       * same source. That is worth doing when reuse volume justifies it and is recorded
       * as such, rather than half-built here where it would read as solved.
       */
      const raced = await db.findPublishedSummaryByHash(acquired.hash, job.requester_id);
      if (raced) {
        await db.attachSummaryToJob(job.id, raced.summaryId, raced.workId);
        return {
          output: { reuse: raced, skipped: 'another job published this source first' },
          jumpTo: 'publish',
        };
      }

      /*
       * Two ways to be billed and get nothing, and both have to reach the ledger.
       *
       *   provider answered, answer unusable   → BilledProviderError, caught here
       *   provider answered, answer empty      → the check below
       *   provider never answered              → a plain Error, and correctly free
       *
       * The first was the gap: a model can return HTTP 200 with a full
       * `usageMetadata` and no usable text — most likely by spending its whole
       * output budget on thinking tokens — which charged for tens of thousands of
       * input tokens and threw a bare Error carrying none of it. Each retry then
       * bought another unrecorded charge. Law 2 counts every model call, not every
       * successful one, so the usage is carried across the provider boundary rather
       * than discarded at it.
       */
      let summary: CanonicalSummary;
      let usage: Usage;
      let model: string;
      try {
        ({ summary, usage, model } = await deps.summary.generateSummary({
          workTitle: acquired.title,
          kind: acquired.kind,
          context: acquired.text,
        }));
      } catch (e) {
        if (e instanceof BilledProviderError) {
          throw new BilledStepError(`synthesize: ${e.message}`, {
            usage: e.usage,
            model: e.model,
            provider: deps.summary.name,
          });
        }
        throw e;
      }

      if (!summary.title || summary.pulls.length === 0) {
        // Billed before it was rejected: the provider charged for these tokens
        // whether or not the result was usable, so the error carries the usage
        // to the worker rather than dropping it.
        throw new BilledStepError(
          `synthesize: provider returned ${!summary.title ? 'a summary with no title' : 'a summary with no pulls'}`,
          { usage, model, provider: deps.summary.name },
        );
      }

      return {
        output: summary,
        usage,
        // The model that actually answered, not the head of the chain. Gemini
        // falls back between models mid-run — the newest Flash 503s under load
        // often enough that the provider is built to retry down a list — and
        // recording `deps.summary.name` would file every fallback run under
        // "gemini". Provenance that is wrong exactly when something unusual
        // happened is worse than none, because it is trusted.
        model,
        provider: deps.summary.name,
      };
    }

    /**
     * Persist the summary and adopt or create its work.
     *
     * Writing happens here rather than in `synthesize` so a retry of the
     * expensive call cannot leave two summaries behind: `synthesize` is
     * idempotent in effect because it writes nothing, and this step is the one
     * that commits.
     */
    case 'template': {
      const reuse = reuseOf(priorOutputs);
      if (reuse) return { output: { summaryId: reuse.summaryId, reused: true } };

      const acquired = priorOutputs.acquire as AcquireOutput | undefined;
      const summary = priorOutputs.synthesize as
        | {
            title: string;
            elevatorPitch: string;
            whyItMatters: string;
            pulls: { headline: string; body: string; whyItMatters: string }[];
            topics?: unknown;
          }
        | undefined;
      if (!acquired || !summary) throw new Error('template: missing acquire or synthesize output');

      const { workId } = await db.upsertWork({
        title: summary.title || acquired.title,
        kind: acquired.kind,
        contentHash: acquired.hash,
        rightsStatus: acquired.rights,
        // `acquired.url` is the one `resolve_identity` validated, not the raw target —
        // the same distinction the scores below make about re-deriving from input.
        sourceUrl: acquired.url || null,
        author: asString(job.target.author) || null,
        // Both deterministic, both from what is already in hand: no extra call,
        // and a quarter of `get_feed`'s score stops being the 0.5 default.
        //
        // Only from a canonical job, though. See `upsertWork` for why the
        // requester's own visibility is what decides whether their claims about
        // a source are allowed to move a shared row's ranking.
        qualityScore: job.visibility === 'public' ? qualityFromDraft(summary) : null,
        trustScore:
          job.visibility === 'public'
            ? trustFromProvenance(acquired.rights, acquired.url || null)
            : null,
        // `topics` is whatever came back in the synthesize step's stored output, so
        // it is narrowed here rather than trusted — the same treatment `kind` and
        // `rights` already get. A job queued before this field existed replays with
        // no topics at all, which narrows to an empty list rather than throwing.
        topics: narrowTopics(summary.topics),
      });

      const summaryId = await db.createSummary({
        workId,
        title: summary.title,
        elevatorPitch: summary.elevatorPitch,
        whyItMatters: summary.whyItMatters,
        sections: { elevatorPitch: summary.elevatorPitch, whyItMatters: summary.whyItMatters },
        visibility: job.visibility,
        // Model provenance is deliberately not stored here. `summaries` has no
        // `model` column, and inventing one would duplicate what `job_steps`
        // already records per step — which is the granularity a bad summary has
        // to be traced at anyway, since twelve steps and several models
        // contribute to one row. See docs/generation.md.
        authorId: job.requester_id,
      });
      await db.attachSummaryToJob(job.id, summaryId, workId);
      return { output: { workId, summaryId, reused: false } };
    }

    /**
     * Quality gate.
     *
     * Structural for now — a Pull with no body, or a headline long enough to be
     * a paragraph, is a generation that went wrong in a way worth catching
     * before it reaches a reader. A model-scored factuality pass against the
     * evidence spans is the next thing to land here, and claiming this is that
     * would be worse than it being visibly not yet.
     */
    case 'critic': {
      // Nothing was generated on a reuse, so there is nothing to judge. Judging
      // the discarded draft anyway could fail a job whose adopted summary is
      // perfectly good.
      if (reuseOf(priorOutputs)) return { output: { skipped: 'reused an existing summary' } };

      const summary = priorOutputs.synthesize as
        { pulls: { headline: string; body: string }[] } | undefined;
      const pulls = summary?.pulls ?? [];
      const bad = pulls.filter((p) => !p.body?.trim() || p.headline.length > 200);
      if (bad.length > 0) {
        throw new Error(`critic: ${bad.length} of ${pulls.length} pulls failed structural checks`);
      }
      return { output: { checked: pulls.length, passed: true } };
    }

    /** Write the Pulls. Skipped when `template` adopted an existing summary. */
    case 'cards': {
      const templated = (priorOutputs.template ?? {}) as {
        summaryId?: string;
        reused?: boolean;
      };
      if (templated.reused) return { output: { skipped: 'reused an existing summary' } };
      if (!templated.summaryId) throw new Error('cards: template produced no summary');

      const summary = priorOutputs.synthesize as
        | {
            pulls: {
              headline: string;
              body: string;
              whyItMatters: string;
              question?: { prompt?: unknown; answer?: unknown; distractors?: unknown };
            }[];
          }
        | undefined;
      const pulls = summary?.pulls ?? [];
      const written = await db.insertPulls(templated.summaryId, pulls);

      const questions = questionsToWrite(pulls, written);

      if (questions.length > 0) await db.insertQuizQuestions(questions);

      return { output: { pulls: written, questions: questions.length } };
    }

    /**
     * Artwork is off.
     *
     * An illustration can cost several times the text it accompanies, which is
     * why `generation.md` calls it the first thing to switch off under cost
     * pressure. Returning nothing is a supported outcome — the card degrades to
     * typography, which is what The Archive wanted anyway.
     */
    case 'artwork':
      return { output: { generated: false, reason: 'image provider disabled' } };

    /**
     * Embed every Pull.
     *
     * These are what the Delta, ranking and search all read, so a wrong vector
     * here is wrong everywhere downstream and silently — which is why the
     * provider normalises and asserts dimensionality rather than trusting the
     * API to have done it.
     */
    case 'embed': {
      const carded = (priorOutputs.cards ?? {}) as {
        pulls?: { ordinal: number; id: string }[];
        skipped?: string;
      };
      if (carded.skipped) return { output: { skipped: carded.skipped } };

      const written = carded.pulls ?? [];
      const summary = priorOutputs.synthesize as
        { pulls: { headline: string; body: string }[] } | undefined;
      const pulls = summary?.pulls ?? [];
      if (written.length === 0) return { output: { embedded: 0 } };

      // Paired by the ordinal each Pull was written at, not by array position.
      // Position would assume an ordering the database never promised, and a
      // transposed pair of vectors is invisible: the Delta and search would
      // simply be wrong about two ideas, forever, with nothing to notice.
      const pairs = written.map((row) => {
        const p = pulls[row.ordinal];
        if (!p) throw new Error(`embed: no generated pull at ordinal ${row.ordinal}`);
        return { id: row.id, text: `${p.headline}\n\n${p.body}` };
      });

      const { vectors, usage } = await deps.embedding.embed(pairs.map((p) => p.text));

      // A short vector list means some Pulls would publish unembedded — invisible
      // to ranking and to the Delta. Fail the step instead: a retry costs one
      // embedding call, and the alternative is a summary that is quietly missing
      // from search with nothing recording why.
      if (vectors.length !== pairs.length) {
        throw new Error(
          `embed: provider returned ${vectors.length} vectors for ${pairs.length} pulls`,
        );
      }

      await db.setPullEmbeddings(
        pairs.map((p, i) => ({ id: p.id, embedding: vectors[i] as number[] })),
      );

      return {
        output: { embedded: pairs.length },
        usage,
        model: deps.embedding.name,
        provider: deps.embedding.name,
      };
    }

    /**
     * The rights gate, re-checked immediately before publication.
     *
     * The same assertion runs at `resolve_identity`, which is what stops an
     * uncleared job from ever reaching a provider. This one is not redundant:
     * the visibility and rights on the job can be edited between the two, and
     * the check that protects law 4 is the one nearest the act it governs —
     * publishing, not processing. A reader's private document is theirs to
     * summarise; the same summary made public is a different act.
     */
    case 'moderate': {
      if (job.visibility !== 'public') return { output: { visibility: job.visibility } };

      const rights = asString(job.target.rights_status);
      if (rights !== 'public_domain' && rights !== 'licensed') {
        throw new Error(
          `moderate: cannot publish a summary of a source with rights_status "${rights || 'unset'}"`,
        );
      }
      return { output: { visibility: 'public', rights } };
    }

    case 'publish': {
      // Checked before `template`'s output, because a reused job jumps here directly
      // from `acquire` and never runs `template` at all — reading that output first
      // would find nothing and throw "no summary to publish" on a job that succeeded.
      // The summary this job adopted is already published; that is how it was found.
      if (reuseOf(priorOutputs)) return { output: { published: false, reason: 'reused' } };

      const templated = (priorOutputs.template ?? {}) as {
        summaryId?: string;
        reused?: boolean;
      };
      if (templated.reused) return { output: { published: false, reason: 'reused' } };
      if (!templated.summaryId) throw new Error('publish: no summary to publish');
      await db.publishSummary(templated.summaryId);
      return { output: { published: true, summaryId: templated.summaryId } };
    }

    default:
      return { usage: NO_USAGE };
  }
}
