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
import type { EmbeddingProvider, SummaryProvider, Usage } from './providers.ts';
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
  publishSummary(summaryId: string): Promise<void>;
  attachSummaryToJob(jobId: string, summaryId: string, workId: string): Promise<void>;
}

interface AcquireOutput {
  text: string;
  hash: string;
  title: string;
  kind: WorkKind;
  /** Carried forward from `resolve_identity` so `template` writes the status that
   *  was actually validated, rather than re-deriving it from the raw target. */
  rights: RightsStatus;
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

/** What `acquire` records when the source has already been summarised. */
function reuseOf(priorOutputs: Record<string, unknown>): { summaryId: string } | null {
  const acquired = priorOutputs.acquire as { reuse?: { summaryId: string } } | undefined;
  return acquired?.reuse ?? null;
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
        truncated,
        ...(reuse ? { reuse } : {}),
      };
      return { output: out };
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
      // Every step from here to `publish` is a no-op and the job costs nothing.
      if (reuseOf(priorOutputs)) return { output: { skipped: 'reused an existing summary' } };

      const acquired = priorOutputs.acquire as AcquireOutput | undefined;
      if (!acquired?.text) throw new Error('synthesize: acquire produced no text');

      const { summary, usage, model } = await deps.summary.generateSummary({
        workTitle: acquired.title,
        kind: acquired.kind,
        context: acquired.text,
      });

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
          }
        | undefined;
      if (!acquired || !summary) throw new Error('template: missing acquire or synthesize output');

      const { workId } = await db.upsertWork({
        title: summary.title || acquired.title,
        kind: acquired.kind,
        contentHash: acquired.hash,
        rightsStatus: acquired.rights,
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
        { pulls: { headline: string; body: string; whyItMatters: string }[] } | undefined;
      const pulls = summary?.pulls ?? [];
      const written = await db.insertPulls(templated.summaryId, pulls);
      return { output: { pulls: written } };
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
