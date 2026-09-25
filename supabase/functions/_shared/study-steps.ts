/**
 * The study generation steps: what each node of `study-graph.ts` does.
 *
 * The same contract as `runPipelineStep`: one step per invocation, inputs are only
 * what earlier steps wrote down, and a step that cannot finish inside one invocation
 * is split. `study_extract` is the one that would not fit -- a bundle of five long
 * versions is up to a dozen model calls -- so it makes ONE call per invocation and
 * asks the worker to send it again (`continue`) until every window is cached. The
 * cache, not the step output, is the progress record, which is why a redelivery or a
 * budget wait resumes at the first uncached window instead of paying again.
 *
 * Every provider attempt reaches the ledger through `recordStage` before the step
 * decides whether the call was usable, and the budget is held immediately before the
 * call. Step outputs carry ids and counts only: a reader can read their own
 * `job_steps`, and deleting a source must not leave text derived from it behind there.
 */

import { BilledStepError, type JobRow, type StepResult } from './pipeline.ts';
import { createJournalledTransport, type ProviderJournal } from './provider-journal.ts';
import type { ProviderCallRecord, StructuredOutcome, StructuredProvider } from './structured.ts';
import type { StudyStep } from './study-graph.ts';
import {
  assemblyArgs,
  buildClaimIndex,
  extractionArgs,
  looksLikeClaimMap,
  looksLikeCourse,
  normalizeStudyCourse,
  planWindows,
  promptVersion,
  selectAssemblyClaims,
  stageCacheKey,
  STUDY_LIMITS,
  type ClaimRow,
  type ExtractionRecord,
  type PromptVersion,
  type StudySourceText,
  type StudyWindow,
} from './study.ts';

export interface StudyGeneration {
  id: string;
  ownerId: string;
  goal: string;
  sources: StudySourceText[];
}

export interface CachedStage {
  id: string;
  stage: 'extract' | 'assemble';
  output: unknown;
  model: string;
  promptHash: string;
  schemaHash: string;
  providerCallId: string | null;
}

export interface StudyStagePayload {
  stage: 'extract' | 'assemble';
  cacheKey: string;
  output: unknown;
  promptName: string;
  promptHash: string;
  schemaHash: string;
  providerSignature: string;
  model: string;
  providerCallId: string | null;
  sourceVersionIds: string[];
}

export interface StudyDb {
  /** The course being generated, with the full text of each source. Null once deleted. */
  loadGeneration(jobId: string): Promise<StudyGeneration | null>;
  findCachedStage(
    ownerId: string,
    stage: 'extract' | 'assemble',
    cacheKey: string,
  ): Promise<CachedStage | null>;
  /** The entries with these ids that belong to this owner. */
  loadCachedStages(ownerId: string, ids: readonly string[]): Promise<CachedStage[]>;
  /**
   * Hold `cents` against the reader's daily study share and then the day's cap; throws
   * `BudgetExhaustedError` when either refuses.
   */
  reserveBudget(jobId: string, step: string, cents: number): Promise<void>;
  /**
   * Ledger every attempt and cache the result if any. Returns the cache id, or null when
   * there was nothing to cache or the course is gone. Does NOT settle: the worker does.
   */
  recordStage(
    jobId: string,
    step: string,
    calls: readonly ProviderCallRecord[],
    cache: StudyStagePayload | null,
  ): Promise<string | null>;
  persistCourse(jobId: string, payload: unknown): Promise<Record<string, unknown>>;
  /**
   * Move every draft claim, lesson and question of the course to `validated` or
   * `quarantined` by the deterministic checks in SQL; returns the counts by status.
   * Idempotent: only drafts move.
   */
  validateCourse(jobId: string): Promise<Record<string, unknown>>;
  journal: ProviderJournal;
}

export interface StudyDeps {
  job: JobRow;
  priorOutputs: Record<string, unknown>;
  provider: StructuredProvider;
  db: StudyDb;
  /** The network under the journal. Injectable so tests never reach a provider. */
  fetchImpl?: typeof fetch;
}

interface PrepareOutput {
  generationId: string;
  windows: StudyWindow[];
}

interface ExtractOutput {
  extractions: (StudyWindow & { cacheId: string })[];
}

interface AssembleOutput {
  cacheId: string;
  /**
   * The keys of the claims the model was shown, as it was shown them. `study_ground`
   * judges citations against this record rather than recomputing the selection, which a
   * deploy between the two steps could change. Keys only (`s1c3`), never text.
   */
  shownKeys?: string[];
}

async function requireGeneration(deps: StudyDeps, step: StudyStep): Promise<StudyGeneration> {
  const generation = await deps.db.loadGeneration(deps.job.id);
  if (!generation) throw new Error(`${step}: the study material for this job was deleted`);
  return generation;
}

function sumUsage(calls: readonly ProviderCallRecord[]) {
  return calls.reduce(
    (u, c) => ({
      inputTokens: u.inputTokens + c.inputTokens,
      outputTokens: u.outputTokens + c.outputTokens,
      costCents: u.costCents + c.costCents,
    }),
    { inputTokens: 0, outputTokens: 0, costCents: 0 },
  );
}

/**
 * Record the attempts, retrying once, and never let a charge go unrecorded.
 *
 * The recording is idempotent on each call id, so the retry cannot double a charge.
 * If it fails twice, the step throws `BilledStepError` with the summed usage: the
 * worker then writes one step-level ledger row, so the cap still sees the money, and
 * the journal rows left without a call-keyed ledger row are what the audit reports.
 */
async function recordAttempts(
  deps: StudyDeps,
  step: StudyStep,
  outcome: StructuredOutcome,
  cache: StudyStagePayload | null,
  ceilingCents: number,
): Promise<string | null> {
  /*
   * An attempt whose cost the provider never reported -- sent, then aborted or dropped,
   * or answered with a body that could not be read -- may still have been billed. It is
   * charged at the ceiling the hold was sized to, not at zero: recorded at zero, it would
   * release its hold and the day's total would forget money that may have been spent. A
   * cap that sometimes refuses too much is a cap; one that forgets is not. The row keeps
   * `usage_known = false`, so a cost report can tell a ceiling from a measurement.
   */
  /*
   * Every attempt the provider may have billed without saying what. A connection that
   * provably failed before sending (refused, DNS, TLS) comes back with its usage KNOWN
   * to be zero (see `isConnectPhase`), so it is never charged; a reset after the body
   * went out is not provably free and is charged like any other.
   */
  const calls = outcome.calls.map((c) =>
    c.usageKnown ? c : { ...c, costCents: Math.max(c.costCents, ceilingCents) },
  );
  try {
    return await deps.db.recordStage(deps.job.id, step, calls, cache);
  } catch {
    try {
      return await deps.db.recordStage(deps.job.id, step, calls, cache);
    } catch (e) {
      // The attempts matter more than the cache: if the entry is what Postgres refused,
      // ledger them without it and let the step fail and retry.
      if (cache) {
        const ledgered = await deps.db.recordStage(deps.job.id, step, calls, null).then(
          () => true,
          () => false,
        );
        if (ledgered) return null;
      }
      throw new BilledStepError(
        `${step}: could not record provider attempts: ${e instanceof Error ? e.message : String(e)}`,
        {
          usage: sumUsage(calls),
          model: outcome.model ?? undefined,
          provider: deps.provider.name,
        },
      );
    }
  }
}

/**
 * Why a recorded call produced nothing to go on with. A usable answer with no cache id
 * means `record_study_stage` found the course deleted: the attempts are ledgered, and
 * there is nothing left to cache for.
 */
function unusable(outcome: StructuredOutcome, usable: boolean, missing: string): string {
  if (!outcome.ok) return outcome.error;
  return usable
    ? 'the result could not be stored (the material was deleted, or the database refused it)'
    : `the provider returned ${missing}`;
}

function lastCallId(outcome: StructuredOutcome): string | null {
  return outcome.calls.at(-1)?.providerCallId ?? null;
}

async function extractionRecords(
  deps: StudyDeps,
  generation: StudyGeneration,
  step: StudyStep,
): Promise<ExtractionRecord[]> {
  const extracted = deps.priorOutputs.study_extract as ExtractOutput | undefined;
  if (!extracted?.extractions) throw new Error(`${step}: study_extract produced no extractions`);
  const ids = extracted.extractions.map((e) => e.cacheId);
  const cached = new Map(
    (await deps.db.loadCachedStages(generation.ownerId, ids)).map((c) => [c.id, c]),
  );
  return extracted.extractions.map((e) => {
    const entry = cached.get(e.cacheId);
    if (!entry || entry.stage !== 'extract') {
      throw new Error(`${step}: extraction ${e.cacheId} is no longer cached`);
    }
    return {
      cacheId: e.cacheId,
      window: { versionId: e.versionId, position: e.position, start: e.start, end: e.end },
      output: entry.output,
      provenance: {
        promptHash: entry.promptHash,
        schemaHash: entry.schemaHash,
        model: entry.model,
        providerCallId: entry.providerCallId,
      },
    };
  });
}

async function assemblyKey(
  deps: StudyDeps,
  generation: StudyGeneration,
  version: PromptVersion,
  args: { goal: string; claims: string },
): Promise<string> {
  return await stageCacheKey({
    stage: 'assemble',
    ownerId: generation.ownerId,
    version,
    providerSignature: deps.provider.signature,
    // The course's own versions too: an entry is linked to the sources of the course that
    // made it, and a course over a different set should not depend on those links.
    input: [generation.sources.map((s) => s.versionId).sort(), args.goal, args.claims],
  });
}

function payloadClaim(claim: ClaimRow) {
  return {
    key: claim.key,
    sourceVersionId: claim.sourceVersionId,
    kind: claim.kind,
    statement: claim.statement,
    qualifications: claim.qualifications,
    attribution: claim.attribution,
    status: claim.status,
    rejectionReasons: claim.rejectionReasons,
    evidence: claim.evidence,
    provenance: claim.provenance,
  };
}

export async function runStudyStep(step: StudyStep, deps: StudyDeps): Promise<StepResult> {
  const { job, db, provider } = deps;
  if (job.kind !== 'study_course') {
    throw new Error(`${step}: job ${job.id} is a ${job.kind} job, not a study course`);
  }

  switch (step) {
    /** Plan the windows. No model, no content in the output. */
    case 'study_prepare': {
      const generation = await requireGeneration(deps, step);
      const total = generation.sources.reduce((n, s) => n + [...s.text].length, 0);
      if (generation.sources.length < 1 || generation.sources.length > STUDY_LIMITS.maxSources) {
        throw new Error(`study_prepare: ${generation.sources.length} sources is outside 1 to 5`);
      }
      if (total > STUDY_LIMITS.maxTotalChars) {
        throw new Error(`study_prepare: ${total} characters is over the 200,000 limit`);
      }
      const windows = planWindows(generation.sources);
      const output: PrepareOutput & { sources: number; characters: number } = {
        generationId: generation.id,
        windows,
        sources: generation.sources.length,
        characters: total,
      };
      return { output };
    }

    /** One window per invocation, cached per reader, version, window and prompt. */
    case 'study_extract': {
      const plan = deps.priorOutputs.study_prepare as PrepareOutput | undefined;
      if (!plan?.windows) throw new Error('study_extract: study_prepare produced no plan');
      const generation = await requireGeneration(deps, step);
      const bySource = new Map(generation.sources.map((s) => [s.versionId, s]));
      const version = await promptVersion('ExtractStudyClaims');

      const done: ExtractOutput['extractions'] = [];
      let called = false;
      let model: string | undefined;

      for (const window of plan.windows) {
        const source = bySource.get(window.versionId);
        if (!source) throw new Error(`study_extract: version ${window.versionId} is gone`);
        const cacheKey = await stageCacheKey({
          stage: 'extract',
          ownerId: generation.ownerId,
          version,
          providerSignature: provider.signature,
          input: [window.versionId, window.start, window.end],
        });

        const hit = await db.findCachedStage(generation.ownerId, 'extract', cacheKey);
        if (hit) {
          done.push({ ...window, cacheId: hit.id });
          continue;
        }
        // One paid call per invocation: the rest wait for the next delivery.
        if (called) return { continue: true, model };

        const args = extractionArgs(source, window);
        const ceiling = provider.worstCaseCentsFor('ExtractStudyClaims', args);
        await db.reserveBudget(job.id, step, ceiling);
        const transport = createJournalledTransport(
          db.journal,
          { jobId: job.id, step },
          deps.fetchImpl,
        );
        const outcome = await provider.generate('ExtractStudyClaims', args, transport);
        const usable = outcome.ok && looksLikeClaimMap(outcome.value);

        const cacheId = await recordAttempts(
          deps,
          step,
          outcome,
          usable && outcome.ok
            ? {
                stage: 'extract',
                cacheKey,
                output: outcome.value,
                ...version,
                providerSignature: provider.signature,
                model: outcome.model,
                providerCallId: lastCallId(outcome),
                sourceVersionIds: [window.versionId],
              }
            : null,
          ceiling,
        );
        if (!usable || !cacheId) {
          throw new Error(`study_extract: ${unusable(outcome, usable, 'no claims array')}`);
        }
        done.push({ ...window, cacheId });
        called = true;
        model = outcome.model;
      }

      const output: ExtractOutput = { extractions: done };
      return { output, model };
    }

    /** One course per reader, goal and grounded claim set. */
    case 'study_assemble': {
      const generation = await requireGeneration(deps, step);
      const claims = buildClaimIndex(
        generation.sources,
        await extractionRecords(deps, generation, step),
      );
      const shown = selectAssemblyClaims(claims);
      if (shown.length === 0) {
        throw new Error(
          'study_assemble: no claim in the material could be matched to its source text; ' +
            'check the extraction and try again',
        );
      }

      const args = assemblyArgs(generation.goal, shown);
      const version = await promptVersion('AssembleStudyCourse');
      const cacheKey = await assemblyKey(deps, generation, version, args);
      const hit = await db.findCachedStage(generation.ownerId, 'assemble', cacheKey);
      const counts = {
        claims: claims.length,
        grounded: claims.filter((c) => c.status === 'draft').length,
        shown: shown.length,
        shownKeys: shown.map((c) => c.key),
      };
      if (hit) return { output: { cacheId: hit.id, cached: true, ...counts } };

      const ceiling = provider.worstCaseCentsFor('AssembleStudyCourse', args);
      await db.reserveBudget(job.id, step, ceiling);
      const transport = createJournalledTransport(
        db.journal,
        { jobId: job.id, step },
        deps.fetchImpl,
      );
      const outcome = await provider.generate('AssembleStudyCourse', args, transport);
      const usable = outcome.ok && looksLikeCourse(outcome.value);

      const cacheId = await recordAttempts(
        deps,
        step,
        outcome,
        usable && outcome.ok
          ? {
              stage: 'assemble',
              cacheKey,
              output: outcome.value,
              ...version,
              providerSignature: provider.signature,
              model: outcome.model,
              providerCallId: lastCallId(outcome),
              // Every source of the course, not only those whose claims were shown: the
              // entry is this course's output, and deleting any of its sources must
              // take it too.
              sourceVersionIds: generation.sources.map((s) => s.versionId),
            }
          : null,
        ceiling,
      );
      if (!usable || !cacheId) {
        throw new Error(`study_assemble: ${unusable(outcome, usable, 'no course')}`);
      }
      return { output: { cacheId, cached: false, ...counts }, model: outcome.model };
    }

    /** Resolve, check and write. No model. */
    case 'study_ground': {
      const assembled = deps.priorOutputs.study_assemble as AssembleOutput | undefined;
      if (!assembled?.cacheId) throw new Error('study_ground: study_assemble produced no course');
      const generation = await requireGeneration(deps, step);
      const claims = buildClaimIndex(
        generation.sources,
        await extractionRecords(deps, generation, step),
      );
      // As the assembly recorded it; recomputed only for a job assembled before it did.
      const recorded = Array.isArray(assembled.shownKeys) ? new Set(assembled.shownKeys) : null;
      const shown = recorded
        ? claims.filter((c) => c.status === 'draft' && recorded.has(c.key))
        : selectAssemblyClaims(claims);

      const [course] = await db.loadCachedStages(generation.ownerId, [assembled.cacheId]);
      if (!course || course.stage !== 'assemble') {
        throw new Error('study_ground: the assembled course is no longer cached');
      }
      const normalized = normalizeStudyCourse(course.output, shown);
      const persisted = await db.persistCourse(job.id, {
        course: normalized.course,
        claims: claims.map(payloadClaim),
        lessons: normalized.lessons,
        items: normalized.items,
        provenance: {
          cacheId: course.id,
          promptHash: course.promptHash,
          schemaHash: course.schemaHash,
          model: course.model,
          providerCallId: course.providerCallId,
        },
      });

      const count = <T extends { status: string }>(rows: readonly T[]) => ({
        draft: rows.filter((r) => r.status === 'draft').length,
        rejected: rows.filter((r) => r.status === 'rejected').length,
      });
      return {
        output: {
          ...persisted,
          claimStatus: count(claims),
          lessonStatus: count(normalized.lessons),
          itemStatus: count(normalized.items),
          dropped: normalized.dropped,
          withheld: normalized.course.withheld.length,
        },
      };
    }

    /**
     * Decide what a learner may be shown. No model: `validate_study_course` runs the
     * deterministic checks in the same transaction as the statuses they set, the same
     * checks a reader's revision must pass.
     */
    case 'study_validate': {
      const validated = await db.validateCourse(job.id);
      return { output: validated };
    }
  }
}
