import { createClient } from 'jsr:@supabase/supabase-js@2';
import { MAX_ATTEMPTS, NEEDS, nextStep, NODES, successorsOf, type Step } from '../_shared/graph.ts';
import { resolveProviders, type ProviderSet } from '../_shared/config.ts';
import { createPipelineDb } from '../_shared/db.ts';
import { createStudyDb } from '../_shared/study-db.ts';
import {
  isStudyStep,
  STUDY_NODES,
  STUDY_PROVIDER_STEPS,
  studySuccessorsOf,
  type StudyStep,
} from '../_shared/study-graph.ts';
import { runStudyStep } from '../_shared/study-steps.ts';
import {
  BilledStepError,
  BudgetExhaustedError,
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
 * A step of either graph. The two share this machine and nothing else: a message
 * names its step, and a `study_*` step belongs to `study-graph.ts`.
 */
type AnyStep = Step | StudyStep;

function needsOf(step: AnyStep): readonly string[] {
  return isStudyStep(step) ? STUDY_NODES[step].needs : NEEDS[step];
}

function afterOf(step: AnyStep): readonly string[] {
  return isStudyStep(step) ? STUDY_NODES[step].after : NODES[step].after;
}

/**
 * Whether a FAILED attempt of this step may have been billed, and so must reach the
 * ledger when it carries usage. The study provider steps ledger each attempt
 * themselves; this is only their fallback for when that recording itself failed.
 */
function billableOnFailure(step: AnyStep): boolean {
  return isStudyStep(step) ? STUDY_PROVIDER_STEPS.has(step) : PROVIDER_STEPS.has(step);
}
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
/**
 * How a job waits on the day's generation budget.
 *
 * The same mechanism as a held source and a completely different timescale, which
 * is why it has its own count rather than sharing one. A source claim is held for
 * minutes, so thirty minutes of waiting means something is genuinely wrong; the
 * daily cap (20260914010000) refills at 00:00 UTC, so a job arriving at 08:00 on a
 * day that filled early waits sixteen hours and is still perfectly healthy.
 *
 * Fifteen minutes between asks, for twenty-four hours: long enough that a hundred
 * waiting jobs are not a load, short enough that the first one through after
 * midnight is through within the quarter hour. A wait that runs out really is a
 * failure -- a day whose budget never reopened is not a queueing problem.
 */
const BUDGET_WAIT_SECONDS = 900;
const MAX_BUDGET_WAITS = 96;

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  // Service role: the worker writes canonical content, which RLS denies to
  // every API role by design.
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  { auth: { persistSession: false } },
);

/**
 * Record a failure that cost nothing, and let go of what it was holding.
 *
 * The billed path goes through `record_failed_job_step`, which writes the step, the
 * ledger row and the settlement in one transaction. An UNBILLED failure has no ledger
 * row to write, so it used to insert the `job_steps` row directly and call nothing --
 * and a step that had already reserved against the daily cap (every provider step
 * reserves immediately before the call) left its hold open for the full TTL.
 *
 * That is the failure a provider outage produces in bulk: ~34 unbilled failures inside
 * an hour fill a 200-cent cap with holds for charges that never happened, and every
 * reader is then told the day's budget is spent. So the settle rides with the insert
 * here, the same way it rides with the ledger row there.
 *
 * RECORDED FIRST, AND SETTLED UNLESS THE STEP ALREADY SUCCEEDED -- which is the
 * opposite of what this said, and the body below is where the reasoning lives. A
 * collision with a `succeeded` row means `record_job_step` has already released this
 * step's money in its own transaction; settling again would take a share belonging to
 * another call. A collision with a FAILED row means nothing has been released, so it
 * settles. The caller treats the collision as success either way.
 */
async function failUnbilled(
  jobId: string,
  step: AnyStep,
  attempt: number,
  message: string,
  durationMs: number,
) {
  /*
   * THIS STEP'S HOLD, not the job's.
   *
   * `graph.ts` dispatches `extract_evidence` beside `synthesize` and `artwork` beside
   * `embed`, in separate invocations — so a job can have two reservations open at once.
   * The first version of this called `settle_job_budget` (since dropped), which released every open row
   * for the job, so a transient failure of one step let go of a sibling's hold while
   * that sibling was still inside its provider call. Concurrent workers then reserved
   * against a total that was short by exactly the money about to be spent, which is the
   * overshoot the whole reservation exists to prevent.
   *
   * `record_failed_job_step` settles `(job, step)` on the billed path; this is the same
   * scope on the unbilled one, and so is the exhausted-retries path below -- a job
   * being failed is not the same moment as every one of its steps being over.
   *
   * RECORDED FIRST, AND SETTLED UNLESS THE STEP ALREADY SUCCEEDED. The order used to be
   * the other way round, on the reasoning that a 23505 collision should still release
   * the money. That is backwards now that a hold counts its calls: a collision with a
   * SUCCEEDED row means `record_job_step` already settled this step, so a second settle
   * takes a share belonging to a concurrently redelivered call still inside its
   * provider. A settle for a step that never held anything is a harmless no-op; a settle
   * for a step that has already settled is the overshoot this mechanism exists to stop.
   *
   * Checked, not a bare await: supabase-js resolves rather than throws on a Postgres
   * error, so an unchecked settle is a hold left open by exactly the transient
   * conditions that produce the outage this path exists for. Logged rather than thrown —
   * the caller still has to see the insert's own result, and the sweep's terminal pass
   * and the TTL are the backstops.
   */
  const recorded = await supabase.from('job_steps').insert({
    job_id: jobId,
    step,
    attempt,
    status: 'failed',
    error: message,
    duration_ms: durationMs,
    finished_at: new Date().toISOString(),
  });

  /*
   * A collision is not proof that the money was released.
   *
   * 23505 means a `job_steps` row for `(job, step, attempt)` already exists, and there
   * are two ways to get one. If it is a SUCCEEDED row, `record_job_step` wrote it and
   * settled this step in the same transaction, and settling again would take a share
   * belonging to a concurrently redelivered call. If it is a FAILED row -- two
   * deliveries that both read the same `attempt` before either wrote, which is exactly
   * what a redelivery storm produces -- then this call's own share has never been
   * released, and skipping the settle strands it against the cap until the sweep or the
   * TTL. So the row is read rather than assumed.
   *
   * A read that itself fails settles: an extra settle costs a share of one hold, a
   * missed one costs the same share for an hour.
   */
  const collided = (recorded.error as { code?: string } | null)?.code === '23505';
  let alreadySettled = false;
  if (collided) {
    const { data } = await supabase
      .from('job_steps')
      .select('status')
      .eq('job_id', jobId)
      .eq('step', step)
      .eq('attempt', attempt)
      .maybeSingle();
    alreadySettled = (data as { status?: string } | null)?.status === 'succeeded';
  }

  if (!alreadySettled) {
    const settled = await supabase.rpc('settle_budget', { p_job_id: jobId, p_step: step });
    if (settled.error) console.error('could not settle budget for', jobId, step, settled.error);
  }

  return recorded;
}

interface QueueMessage {
  msg_id: number;
  message: { jobId: string; step: AnyStep; waits?: number; budgetWaits?: number };
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
async function runStep(jobId: string, step: AnyStep, providers: ProviderSet): Promise<StepResult> {
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
    await supabase.rpc('job_step_outputs', { p_job_id: jobId, p_steps: [...needsOf(step)] }),
    'read prior step outputs',
  ) ?? {}) as Record<string, unknown>;

  // A study course walks its own graph and calls its own provider through a journalled
  // transport. A canonical step on a study job, or the reverse, is a corrupted message:
  // refuse it before anything is spent.
  if (isStudyStep(step)) {
    return await runStudyStep(step, {
      job,
      priorOutputs,
      provider: providers.study,
      db: createStudyDb(supabase),
    });
  }
  if (job.kind === 'study_course') {
    throw new Error(`step ${step} does not belong to a study course`);
  }

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
async function advance(
  jobId: string,
  step: AnyStep,
  jumpTo?: Step,
): Promise<Record<string, string>> {
  // The line's successor is asked for as well as the graph's. A job queued before
  // the graph existed was advanced along `STEPS` by the old worker, which never
  // wrote a dispatch row -- so at `extract_evidence` nothing has sent `synthesize`,
  // and at `artwork` nothing has sent `embed`; the graph alone would leave both
  // waiting on a sibling that never runs. Asking for `nextStep` too is free for a
  // job that started on the graph: its successor already has a dispatch row and
  // answers `already`. This is what lets the graph deploy under a live queue.
  const next = isStudyStep(step) ? null : nextStep(step);
  const targets: AnyStep[] = jumpTo
    ? [jumpTo]
    : isStudyStep(step)
      ? studySuccessorsOf(step)
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
    /*
     * `false` has two innocent causes now, not one, so it is not a warning.
     *
     * It used to mean only "the compare-and-set found `current_step` elsewhere".
     * `20260903010000` added `status in ('queued','running')` to the close, so a
     * redelivered close on an already-closed job — the ordinary outcome when a worker
     * dies between recording its step and archiving its message — also returns `false`.
     * That is the idempotent success path, and `warn` misclassifies it as a problem. The
     * line stays — it is the only trace of a redelivered close — at the level it belongs.
     *
     * A job genuinely stuck at `running` after its sink ran is caught by the stranded
     * sweep (`20260902170000`), which is the mechanism for it.
     */
    if (!closed) console.log(`[worker] job ${jobId}: close from ${step} was already settled`);
    return { closed: closed ? step : `not-closed:${step}` };
  }

  const verdicts: Record<string, string> = {};
  for (const to of targets) {
    verdicts[to] = must(
      await supabase.rpc('dispatch_generation_step', {
        p_job_id: jobId,
        p_to_step: to,
        p_after: jumpTo ? [] : [...afterOf(to)],
      }),
      `dispatch ${to}`,
    ) as string;
  }
  return verdicts;
}

Deno.serve(async (req) => {
  const auth = await authorised(req);
  if (!auth.ok) {
    /*
     * Same rule as the 503 below, and this one is reachable WITHOUT a credential.
     *
     * `authorised` distinguishes "bad token" from "no dispatch token configured" from
     * "dispatch token unreadable: <Postgres error>", and those distinctions are worth
     * having -- for whoever is setting the dispatcher up, in the log. Returned to an
     * unauthenticated caller they describe the inside of the deployment to someone who
     * has just failed to prove they belong there.
     */
    console.error('worker dispatch refused:', auth.why);
    return new Response(JSON.stringify({ error: 'unauthorised' }), {
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
    /*
     * The detail goes to the log, not down the wire.
     *
     * Provider resolution fails through `generation_secret`, so the thrown message
     * carries whatever Postgres said -- a function signature, a schema name, a
     * permission error naming a role. The caller here is pg_cron over pg_net and
     * cannot act on any of it; the person who can is reading the function log, which
     * is where it now goes in full, exception object and all.
     *
     * The status is the part that matters to the dispatcher, and it is unchanged:
     * 503 is still "try again shortly", the queue still stalls rather than burning
     * retries, and the ordering argument above still holds.
     */
    console.error('providers unavailable, not claiming', e);
    return new Response(JSON.stringify({ error: 'providers unavailable', claimed: 0 }), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    });
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
        const dispatched = await advance(
          jobId,
          step,
          isStudyStep(step) ? undefined : jumpFor(step, own[step]),
        );
        must(await archive(msg.msg_id), 'archive resumed message');
        processed.push({ jobId, step, resumed: true, dispatched });
      } catch (e) {
        processed.push({ jobId, step, resumed: false, error: String(e) });
      }
      continue;
    }

    /*
     * ONE ATTEMPT NUMBER PER DELIVERY, not per row already written.
     *
     * `(last.attempt ?? 0) + 1` is the same number for two deliveries that race, and
     * `job_steps` is unique on `(job_id, step, attempt)` — so when a long provider call
     * is redelivered at the 180 s visibility timeout and both calls return, the second
     * one's `record_job_step` violates that key and the WHOLE transaction rolls back,
     * ITS `cost_ledger` ROW WITH IT. Six cents of real spend then exists nowhere the cap
     * can see, for ever, and 20260914070000's header — which says both calls reach the
     * ledger through their own `record_job_step` — is only true if they can.
     *
     * `read_ct` is pgmq's own delivery counter, incremented before this function runs,
     * so two deliveries of one message never share it. Taking the larger of the two
     * keeps the number monotonic when a failed attempt did not manage to record itself,
     * which is the case the `read_ct` bound below exists for.
     */
    const attempt = Math.max(msg.read_ct, (last?.attempt ?? 0) + 1);

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
        /*
         * NO SETTLE HERE. The sweep does it, and it is the only thing that can.
         *
         * This path fails the JOB without having run the step, so it knows nothing about
         * what is in flight -- and with a hold counting the calls behind it, releasing a
         * share is releasing somebody's money. A message redelivered past MAX_ATTEMPTS is
         * the case where the first call HUNG: it is still inside the provider, its hold
         * is stacked with the deliveries that followed, and taking a share back here
         * means a concurrent `reserve_budget` fits work into money that is about to be
         * charged.
         *
         * Two earlier versions of this line each released too much. It called
         * `settle_job_budget` (dropped in 20260914050000), which let go of a parallel
         * step's hold -- `graph.ts` runs `extract_evidence` beside `synthesize` and
         * `artwork` beside `embed`. Narrowing it to `(job, step)` kept the same fault on
         * a smaller scale, because the step this is failing is the one most likely to
         * still be running.
         *
         * `sweep_stranded_generation_jobs` settles every open hold on a terminal job --
         * which this row is about to become -- and refuses to touch one younger than its
         * own threshold, precisely so a call still in flight keeps its money. That guard
         * is the thing this inline settle was going around, so the settle goes and the
         * sweep is left to do it, with the TTL behind that.
         */
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

      /*
       * The same step again, now, with no row written. The step has already recorded
       * what it spent and cached what it made, so there is nothing for `record_job_step`
       * to add -- and a `succeeded` row here would make the next delivery resume past a
       * step that has windows left. The wait counts ride along unchanged.
       */
      if (result.continue) {
        const requeued = must(
          await supabase.rpc('requeue_generation_message', {
            p_msg_id: msg.msg_id,
            p_job_id: jobId,
            p_step: step,
            p_delay_seconds: 0,
            p_waits: msg.message.waits ?? 0,
            p_budget_waits: msg.message.budgetWaits ?? 0,
          }),
          'requeue continuing step',
        ) as number | null;
        processed.push({
          jobId,
          step,
          attempt,
          ok: true,
          continuing: true,
          ...(requeued === null ? { alreadyQueued: true } : {}),
        });
        continue;
      }

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
          p_billable:
            result.provider !== undefined && !isStudyStep(step) && PROVIDER_STEPS.has(step),
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

      /*
       * A wait, not a failure -- unless it has waited long enough that something
       * is wrong, in which case it falls through and is recorded like any other.
       *
       * Two kinds of waiting, each with its own count and its own bound. Both go
       * through the same requeue, which carries both counts forward: a step that
       * waited on a held source and later waits on the budget must not spend the
       * source's allowance on the budget's problem, or vice versa.
       */
      const held = e instanceof SourceHeldError;
      const broke = e instanceof BudgetExhaustedError;
      if (held || broke) {
        const waits = (msg.message.waits ?? 0) + (held ? 1 : 0);
        const budgetWaits = (msg.message.budgetWaits ?? 0) + (broke ? 1 : 0);
        const within = held ? waits <= MAX_WAITS : budgetWaits <= MAX_BUDGET_WAITS;
        const delay = held ? WAIT_SECONDS : BUDGET_WAIT_SECONDS;

        if (within) {
          try {
            // Null means the message was already gone: a delivery that outlived
            // its visibility timeout was redelivered, and the other delivery has
            // archived and re-sent it. Nothing to do -- the wait is queued once.
            const requeued = must(
              await supabase.rpc('requeue_generation_message', {
                p_msg_id: msg.msg_id,
                p_job_id: jobId,
                p_step: step,
                p_delay_seconds: delay,
                p_waits: waits,
                p_budget_waits: budgetWaits,
              }),
              'requeue waiting step',
            ) as number | null;
            processed.push({
              jobId,
              step,
              waiting: held ? waits : budgetWaits,
              ...(broke ? { reason: 'budget' as const } : {}),
              ...(requeued === null ? { alreadyQueued: true } : {}),
            });
          } catch (requeueError) {
            // The message was left unarchived, so the visibility timeout redelivers
            // it; that costs a read_ct, which is the lesser evil next to losing it.
            processed.push({
              jobId,
              step,
              waiting: held ? waits : budgetWaits,
              error: String(requeueError),
            });
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
            p_billable: billableOnFailure(step),
          })
        : await failUnbilled(jobId, step, attempt, message, Date.now() - started);
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
