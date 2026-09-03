import { createClient } from 'jsr:@supabase/supabase-js@2';
import { MAX_ATTEMPTS, NEEDS, nextStep, NODES, successorsOf, type Step } from '../_shared/graph.ts';
import { resolveProviders, type ProviderSet } from '../_shared/config.ts';
import { createPipelineDb } from '../_shared/db.ts';
import {
  BilledStepError,
  jumpFor,
  runPipelineStep,
  SourceHeldError,
  type JobRow,
  type StepResult,
} from '../_shared/pipeline.ts';

/**
 * One tick of the generation step-machine.
 *
 * Reads a batch from the pgmq queue, executes exactly ONE step per job, records
 * what it cost, and enqueues the next step. Never loops a job to completion:
 * that is what the 150s wall-clock limit forbids.
 */

/**
 * Exactly one message per invocation.
 *
 * This went from five, to one-at-a-time-with-a-time-guard, to this. The guard
 * was still wrong: it reserved 40s for the next step while a single
 * `generateSummary` may spend up to its full provider budget (100s), so the
 * arithmetic permitted claiming a synthesis message that could not finish.
 *
 * There is no reserve that makes a second message safe. The provider budget is
 * 100s and the platform ceiling is 150s, so one slow step already consumes the
 * invocation — any second claim is a bet that the first was fast. pgmq charges
 * `read_ct` on delivery rather than execution, so losing that bet costs a
 * delivery on a step that never ran, and three of those fail the job at a step
 * with nothing in `job_steps` to explain it.
 *
 * Throughput does not depend on batching here. `pg_net` dispatches
 * asynchronously and `pg_cron` fires every 10s whenever the queue is non-empty,
 * so invocations overlap and pgmq's visibility timeout keeps them off each
 * other's messages. Concurrency comes from many workers each doing one thing,
 * which is also the only version of it that can be reasoned about.
 */
const MESSAGES_PER_INVOCATION = 1;
/** Steps that invoke a provider, and so must produce a ledger row. */
const PROVIDER_STEPS = new Set<Step>(['synthesize', 'embed', 'artwork']);
/**
 * Must exceed the platform's maximum request lifetime (150s wall clock), or the
 * next dispatcher tick can claim a message while the original invocation is
 * still legally running — and both would invoke the same billable provider,
 * with the unique step constraint only rejecting one *after* both paid for it.
 * Long enough to outlive any step, short enough that a dead worker frees the
 * job promptly.
 */
const VISIBILITY_SECONDS = 180;
/**
 * How a job waits on a source another job is synthesising.
 *
 * Not by throwing and being redelivered: that spends the same `MAX_ATTEMPTS` and
 * `read_ct` budget as a real failure, and a holder retrying a slow provider could
 * fail the waiter terminally for doing nothing wrong. The step is re-sent with a
 * delay instead, carrying a count. Thirty minutes of waiting is longer than any
 * live holder needs to reach `publish` and longer than a dead one keeps its claim
 * -- the sweeper fails a stranded job in ten and the status rule frees the claim
 * at once -- so a wait that runs out is a real failure and is recorded as one.
 */
const WAIT_SECONDS = 60;
const MAX_WAITS = 30;

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  // Service role: the worker writes canonical content, which RLS denies to
  // every API role by design.
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  { auth: { persistSession: false } },
);

interface QueueMessage {
  msg_id: number;
  message: { jobId: string; step: Step; waits?: number };
  /** pgmq's delivery count, incremented on every read of this message. */
  read_ct: number;
}

/**
 * supabase-js returns `{ error }` rather than throwing. Every write here must be
 * checked: an unchecked failure followed by archiving the message strands the
 * job silently, or worse marks it complete.
 */
function must<T>(result: { data: T; error: unknown }, what: string): T {
  if (result.error) {
    const e = result.error as { message?: string };
    throw new Error(`${what}: ${e.message ?? JSON.stringify(result.error)}`);
  }
  return result.data;
}

/**
 * How long a resolved provider set is reused before the key is read again.
 *
 * Resolving per step was deliberate — a key added to Vault should take effect on the
 * next tick, not the next deploy — but it meant a twelve-step job paid twelve
 * `security definer` decrypts of the same unchanged secret. Caching at module scope
 * would have bought that back by giving up the property it was protecting: a rotated
 * key would then wait for the isolate to recycle, which is a duration nobody controls
 * or can observe.
 *
 * A short TTL keeps both. Eleven of every twelve decrypts disappear, and the worst case
 * for a key change is a bounded, stated minute rather than an unbounded unknown.
 */
const PROVIDER_CACHE_MS = 60_000;

let providerCache: { at: number; providers: ProviderSet } | null = null;

async function providersNow(): Promise<ProviderSet> {
  const now = Date.now();
  if (providerCache && now - providerCache.at < PROVIDER_CACHE_MS) return providerCache.providers;

  const providers = await resolveProviders(
    { get: (key: string) => Deno.env.get(key) },
    async (name: string) => {
      const { data, error } = await supabase.rpc('generation_secret', { p_name: name });
      // A missing secret is a supported state — the stubs take over. Only a
      // failure to *ask* is worth surfacing.
      if (error) throw new Error(`read secret ${name}: ${error.message}`);
      return (data as string | null) ?? null;
    },
  );

  // Cached only on success. A throw — which is what REQUIRE_REAL_PROVIDERS produces when
  // the key is missing — must not be able to poison the next minute of invocations, and
  // must not be remembered as though it were an answer.
  providerCache = { at: now, providers };
  return providers;
}

/**
 * Run one step of the real pipeline.
 *
 * The job row and the outputs of its already-succeeded steps are read fresh
 * each time, because the worker holds nothing between invocations — one step
 * per request is what the 150s wall-clock limit forces, and it means a step's
 * only inputs are what earlier steps wrote down.
 *
 * Providers are the exception and are passed IN, already resolved. They have to be,
 * because resolving them can fail and that failure must happen before a message is
 * claimed — see the ordering argument in `Deno.serve` below.
 */
async function runStep(jobId: string, step: Step, providers: ProviderSet): Promise<StepResult> {
  const job = must(
    await supabase
      .from('generation_jobs')
      .select('id, kind, target, work_id, summary_id, visibility, requester_id, status')
      .eq('id', jobId)
      .single(),
    'read job',
  ) as JobRow & { status: string };

  // A message can outlive its job. With the fan-out, one branch can exhaust its
  // attempts and fail the job while a sibling's message is still queued; running
  // that sibling would pay a provider for a job nobody will publish, and
  // `dispatch_generation_step` would then refuse its successors anyway. Stop here,
  // before anything is spent, and let the caller archive the message.
  if (job.status !== 'queued' && job.status !== 'running') {
    throw new JobClosedError(jobId, job.status);
  }

  // Only the outputs this step declares it reads. The one-argument form returned
  // every succeeded step's output -- source text included, twice -- on every
  // invocation; see NEEDS for the arithmetic. PostgREST resolves the overload by
  // the named arguments, so passing `p_steps` selects the two-argument function.
  const priorOutputs = (must(
    await supabase.rpc('job_step_outputs', { p_job_id: jobId, p_steps: [...NEEDS[step]] }),
    'read prior step outputs',
  ) ?? {}) as Record<string, unknown>;

  return await runPipelineStep(step, {
    summary: providers.summary,
    embedding: providers.embedding,
    priorOutputs,
    job,
    db: createPipelineDb(supabase),
  });
}

const archive = (msgId: number) => supabase.rpc('archive_generation_message', { p_msg_id: msgId });

/** The job this message belongs to is already failed or done; there is nothing to run. */
class JobClosedError extends Error {
  constructor(jobId: string, status: string) {
    super(
      `job ${jobId} is ${status}; its ${status === 'failed' ? 'remaining' : 'stale'} message is dropped`,
    );
    this.name = 'JobClosedError';
  }
}

/** Length-independent comparison, so a wrong token leaks nothing through timing. */
function secureEquals(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Who is allowed to tick the machine.
 *
 * There are two supported dispatchers and this accepts either, because the repository
 * documents both and picking one would silently break the other:
 *
 *   • `enable_generation_dispatcher_with_token` sends `x-worker-token` from Vault. Used
 *     when the function is deployed with JWT verification off, which is what lets the
 *     dispatcher be scheduled without anyone reading the service_role key out of the
 *     dashboard.
 *   • `enable_generation_dispatcher` sends the service_role key as a bearer token. The
 *     platform has already verified it when `verify_jwt` is on, but this function cannot
 *     tell whether that happened, so it compares against the key it was given itself.
 *
 * Fails closed. A worker with no credential configured refuses every request rather than
 * running open: this endpoint spends money, and "misconfigured" must not mean "public".
 */
async function authorised(req: Request): Promise<{ ok: true } | { ok: false; why: string }> {
  const bearer = req.headers.get('Authorization')?.replace(/^Bearer\s+/i, '');
  if (secureEquals(bearer, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'))) return { ok: true };

  const presented = req.headers.get('x-worker-token');

  // Env first so a local stack can run without touching Vault, which `db:reset` wipes.
  let expected = Deno.env.get('WORKER_DISPATCH_TOKEN') ?? null;
  if (!expected) {
    const { data, error } = await supabase.rpc('generation_secret', {
      p_name: 'worker_dispatch_token',
    });
    if (error) return { ok: false, why: `dispatch token unreadable: ${error.message}` };
    expected = data as string | null;
  }

  if (!expected) {
    return {
      ok: false,
      why: 'no dispatch token configured — run enable_generation_dispatcher_with_token',
    };
  }
  return secureEquals(presented, expected) ? { ok: true } : { ok: false, why: 'bad token' };
}

/**
 * Move the job on: dispatch every successor this node unblocks, or close the job.
 *
 * The pipeline is a graph (`_shared/graph.ts`), so "next" is a set. Each successor
 * is dispatched through `dispatch_generation_step`, which reads the successor's
 * `after` list, verifies every one of those nodes has a SUCCEEDED row, and guards
 * the send with a unique index on (job, step). So a join is sent by whichever
 * predecessor commits last, exactly once, and a redelivered message cannot send a
 * successor twice -- the dispatch row from the first attempt is still there. The
 * verdicts are returned so the invocation log says which of those happened.
 *
 * `jumpTo` is still a step's own decision -- a reused job goes straight to
 * `publish` -- and it is dispatched with an empty `after`, because the step that
 * chose the jump has already established that nothing else needs to run.
 *
 * `publish` has no successors, so completing it closes the job. That still goes
 * through `advance_generation_job(…, null)` and its compare-and-set on
 * `current_step`, which the dispatch has just set to `publish`.
 */
async function advance(jobId: string, step: Step, jumpTo?: Step): Promise<Record<string, string>> {
  // The line's successor is asked for as well as the graph's. A job queued before
  // the graph existed was advanced along `STEPS` by the old worker, which never
  // wrote a dispatch row -- so at `extract_evidence` nothing has sent `synthesize`,
  // and at `artwork` nothing has sent `embed`; the graph alone would leave both
  // waiting on a sibling that never runs. Asking for `nextStep` too is free for a
  // job that started on the graph: its successor already has a dispatch row and
  // answers `already`. This is what lets the graph deploy under a live queue.
  const next = nextStep(step);
  const targets = jumpTo
    ? [jumpTo]
    : [...new Set([...successorsOf(step), ...(next ? [next] : [])])];

  if (targets.length === 0) {
    const closed = must(
      await supabase.rpc('advance_generation_job', {
        p_job_id: jobId,
        p_from_step: step,
        p_to_step: null,
      }),
      'close job',
    ) as boolean;
    // `false` is the compare-and-set finding `current_step` elsewhere. It is not
    // an error -- a redelivered close after a successful one lands here -- but a
    // job that stays `running` after its sink ran is worth a line in the log.
    if (!closed) console.warn(`[worker] job ${jobId}: close from ${step} matched nothing`);
    return { closed: closed ? step : `not-closed:${step}` };
  }

  const verdicts: Record<string, string> = {};
  for (const to of targets) {
    verdicts[to] = must(
      await supabase.rpc('dispatch_generation_step', {
        p_job_id: jobId,
        p_to_step: to,
        p_after: jumpTo ? [] : [...NODES[to].after],
      }),
      `dispatch ${to}`,
    ) as string;
  }
  return verdicts;
}

Deno.serve(async (req) => {
  const auth = await authorised(req);
  if (!auth.ok) {
    return new Response(JSON.stringify({ error: auth.why }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }

  const processed: unknown[] = [];

  /*
   * Resolved BEFORE anything is claimed, and this ordering is the whole point.
   *
   * `REQUIRE_REAL_PROVIDERS` exists so a rotated or unreadable key is loud rather
   * than silently served as stubs. Resolving it inside `runStep` — after the claim —
   * turned that into something worse than the silence it replaced:
   *
   *   claim → read_ct 1 → throw → record failed attempt → leave message
   *   claim → read_ct 2 → throw → …                        (pg_cron, every 10s)
   *   claim → read_ct 3 → throw → …
   *   claim → read_ct 4 → attempt > MAX_ATTEMPTS → job marked FAILED, archived
   *
   * Every queued job terminally failed within about a minute of a key rotation,
   * unrecoverable, with "exhausted retries" as the only explanation. A worker that
   * cannot reach its provider has nothing useful to do, and the correct behaviour is
   * for the queue to STALL — jobs stay queued, retries stay unspent, and the work
   * resumes when the key comes back.
   *
   * 503 rather than 500: this is "try again shortly", not "this request was wrong".
   * The 60s cache means the healthy path pays for this at most once a minute.
   */
  let providers: ProviderSet;
  try {
    providers = await providersNow();
  } catch (e) {
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : String(e), claimed: 0 }),
      { status: 503, headers: { 'content-type': 'application/json' } },
    );
  }

  // Claimed immediately before it is run, and never more than one: `read_ct` is
  // charged on delivery, so a message claimed and not reached is a retry spent
  // on nothing.
  const batch = must(
    await supabase.rpc('claim_generation_messages', {
      p_count: MESSAGES_PER_INVOCATION,
      p_visibility_seconds: VISIBILITY_SECONDS,
    }),
    'claim queue messages',
  ) as QueueMessage[] | null;

  for (const msg of batch ?? []) {
    const { jobId, step } = msg.message;
    const started = Date.now();

    const prior = must(
      await supabase
        .from('job_steps')
        .select('attempt, status')
        .eq('job_id', jobId)
        .eq('step', step)
        .order('attempt', { ascending: false })
        .limit(1),
      'read prior attempts',
    ) as { attempt: number; status: string }[] | null;

    const last = prior?.[0];

    // A worker can die after recording a successful step but before archiving
    // its message, and the visibility timeout then redelivers it. Rerunning
    // would repeat a billable provider call — and the unique key on
    // (job_id, step, attempt) cannot prevent that, because each replay picks a
    // NEW attempt number. So resume: finish the transition, do not redo the
    // work. `advance` is idempotent, so repeating it is safe.
    if (last?.status === 'succeeded') {
      try {
        // The result that carried `jumpTo` belongs to an invocation that has ended,
        // so the jump is read back from the output that invocation persisted. That
        // is not optional: resuming a reused `acquire` down the normal path would
        // dispatch `chunk` beside the `publish` it had already sent, overwrite
        // `current_step`, and strand the job -- see `jumpFor`. With the jump in
        // hand every dispatch here answers `already` if the dying invocation got
        // that far, and sends exactly what it would have if it did not.
        const own = (must(
          await supabase.rpc('job_step_outputs', { p_job_id: jobId, p_steps: [step] }),
          'read resumed step output',
        ) ?? {}) as Record<string, unknown>;
        const dispatched = await advance(jobId, step, jumpFor(step, own[step]));
        must(await archive(msg.msg_id), 'archive resumed message');
        processed.push({ jobId, step, resumed: true, dispatched });
      } catch (e) {
        processed.push({ jobId, step, resumed: false, error: String(e) });
      }
      continue;
    }

    const attempt = (last?.attempt ?? 0) + 1;

    // Two bounds, because the first one can be lost. `attempt` comes from
    // `job_steps`, which assumes every failed attempt manages to record itself;
    // when that insert is the thing that failed, no row appears and the next
    // tick derives this same number again, forever. `read_ct` is pgmq's own
    // delivery counter — incremented before this function runs and regardless
    // of what it writes — so it holds when the ledger cannot.
    if (attempt > MAX_ATTEMPTS || msg.read_ct > MAX_ATTEMPTS) {
      // Checked like every other write. Bare awaits here would let a failed
      // update be followed by an archive that removes the only queue message,
      // leaving the job stuck in `running` with nothing to retry it.
      try {
        must(
          await supabase
            .from('generation_jobs')
            .update({
              status: 'failed',
              error: `step ${step} exhausted retries`,
              finished_at: new Date().toISOString(),
            })
            .eq('id', jobId)
            // Only a live job. A sibling branch may already have closed it (failed,
            // or succeeded via the reuse jump); rewriting its status and error here
            // would make a finished job lie. A zero-row match still archives below.
            .in('status', ['queued', 'running'])
            .select('id'),
          'mark job failed',
        );
        must(await archive(msg.msg_id), 'archive exhausted message');
        processed.push({ jobId, step, ok: false, exhausted: true });
      } catch (e) {
        // Leave the message unarchived so the next tick can try again rather
        // than dropping a job that was never marked failed.
        processed.push({ jobId, step, ok: false, exhausted: false, error: String(e) });
      }
      continue;
    }

    try {
      const result = await runStep(jobId, step, providers);
      const usage = result.usage ?? { inputTokens: 0, outputTokens: 0, costCents: 0 };

      // One transaction for the step, its output and its cost. As separate
      // writes, a ledger failure after a succeeded step left the spend
      // permanently unrecorded and unretryable: the step row already existed, so
      // the retry path could not replace it and resume treated it as fully done.
      must(
        await supabase.rpc('record_job_step', {
          p_job_id: jobId,
          p_step: step,
          p_attempt: attempt,
          p_model: result.model ?? null,
          p_prompt_version: null,
          p_input_tokens: usage.inputTokens,
          p_output_tokens: usage.outputTokens,
          p_cost_cents: usage.costCents,
          p_duration_ms: Date.now() - started,
          p_provider: result.provider ?? 'none',
          // Billable when a provider was actually called, not merely when the
          // step is one that *can* call one. A reuse skips `synthesize`'s call
          // entirely, and charging a ledger row for it would misreport the
          // reuse ratio — the number the whole cost argument is measured by.
          p_billable: result.provider !== undefined && PROVIDER_STEPS.has(step),
          // What this step produced, for the next one to read. The worker keeps
          // nothing in memory between invocations.
          p_output: (result.output ?? null) as never,
        }),
        'record step and cost',
      );

      const dispatched = await advance(jobId, step, result.jumpTo);

      // Only archive once every write above has been confirmed. Archiving
      // earlier would drop the message with the job's state unpersisted.
      must(await archive(msg.msg_id), 'archive message');
      processed.push({ jobId, step, attempt, ok: true, dispatched });
    } catch (e) {
      // Not a failed attempt: the job was closed by another branch before this
      // step ran, nothing was spent, and recording a failure against a job that is
      // already failed would only make its history lie. Archive and move on.
      if (e instanceof JobClosedError) {
        const { error: archiveError } = await archive(msg.msg_id);
        processed.push({
          jobId,
          step,
          ok: false,
          closed: true,
          ...(archiveError ? { archiveError: archiveError.message } : {}),
        });
        continue;
      }

      const message = e instanceof Error ? e.message : String(e);

      // A wait, not a failure -- unless it has waited long enough that something
      // is wrong, in which case it falls through and is recorded like any other.
      if (e instanceof SourceHeldError) {
        const waits = (msg.message.waits ?? 0) + 1;
        if (waits <= MAX_WAITS) {
          try {
            // Null means the message was already gone: a delivery that outlived
            // its visibility timeout was redelivered, and the other delivery has
            // archived and re-sent it. Nothing to do -- the wait is queued once.
            const requeued = must(
              await supabase.rpc('requeue_generation_message', {
                p_msg_id: msg.msg_id,
                p_job_id: jobId,
                p_step: step,
                p_delay_seconds: WAIT_SECONDS,
                p_waits: waits,
              }),
              'requeue waiting step',
            ) as number | null;
            processed.push({
              jobId,
              step,
              waiting: waits,
              ...(requeued === null ? { alreadyQueued: true } : {}),
            });
          } catch (requeueError) {
            // The message was left unarchived, so the visibility timeout redelivers
            // it; that costs a read_ct, which is the lesser evil next to losing it.
            processed.push({ jobId, step, waiting: waits, error: String(requeueError) });
          }
          continue;
        }
      }

      // A failure that happened *after* the provider was billed. The tokens are
      // spent either way, so the ledger has to hear about it: law 2 counts every
      // model call, not every successful one, and the step is about to be
      // retried — each retry paying again.
      const billed = e instanceof BilledStepError ? e : null;

      // The one write here that must not use `must()`: throwing out of a catch
      // would skip the bookkeeping below and lose the original error. Its result
      // is still checked, because an unrecorded attempt is what lets a job cycle
      // without ever reaching MAX_ATTEMPTS.
      //
      // Routed through an RPC when there is spend to record, so the failed step
      // and its ledger row land in one transaction — the same guarantee
      // `record_job_step` gives the success path, for the same reason.
      const { error: recordError } = billed
        ? await supabase.rpc('record_failed_job_step', {
            p_job_id: jobId,
            p_step: step,
            p_attempt: attempt,
            p_error: message,
            p_duration_ms: Date.now() - started,
            p_model: billed.model ?? null,
            p_provider: billed.provider ?? null,
            p_input_tokens: billed.usage.inputTokens,
            p_output_tokens: billed.usage.outputTokens,
            p_cost_cents: billed.usage.costCents,
            p_billable: PROVIDER_STEPS.has(step),
          })
        : await supabase.from('job_steps').insert({
            job_id: jobId,
            step,
            attempt,
            status: 'failed',
            error: message,
            duration_ms: Date.now() - started,
            finished_at: new Date().toISOString(),
          });
      // A duplicate key means `record_job_step` already wrote a *succeeded* row
      // for this attempt and only the transition after it failed. There is
      // nothing to mark failed in that case — the resume path picks it up on
      // redelivery — so it is the expected collision, not a lost write.
      const recorded = !recordError || recordError.code === '23505';
      // Leave the message unarchived: its visibility timeout expires and the
      // next tick retries, bounded by MAX_ATTEMPTS on either counter.
      processed.push({
        jobId,
        step,
        attempt,
        ok: false,
        error: message,
        ...(billed ? { billedCostCents: billed.usage.costCents } : {}),
        ...(recorded ? {} : { attemptUnrecorded: recordError.message }),
      });
    }
  }

  return new Response(JSON.stringify({ processed }), {
    headers: { 'content-type': 'application/json' },
  });
});
