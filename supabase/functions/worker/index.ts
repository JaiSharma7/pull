// deno-lint-ignore-file no-explicit-any
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { MAX_ATTEMPTS, nextStep, type Step } from '../_shared/steps.ts';
import { resolveProviders } from '../_shared/config.ts';
import { createPipelineDb } from '../_shared/db.ts';
import { runPipelineStep, type JobRow, type StepResult } from '../_shared/pipeline.ts';

/**
 * One tick of the generation step-machine.
 *
 * Reads a batch from the pgmq queue, executes exactly ONE step per job, records
 * what it cost, and enqueues the next step. Never loops a job to completion:
 * that is what the 150s wall-clock limit forbids.
 */

const BATCH = 5;
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

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  // Service role: the worker writes canonical content, which RLS denies to
  // every API role by design.
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  { auth: { persistSession: false } },
);

interface QueueMessage {
  msg_id: number;
  message: { jobId: string; step: Step };
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
 * Run one step of the real pipeline.
 *
 * The job row and the outputs of its already-succeeded steps are read fresh
 * each time, because the worker holds nothing between invocations — one step
 * per request is what the 150s wall-clock limit forces, and it means a step's
 * only inputs are what earlier steps wrote down.
 *
 * Providers are resolved per step rather than at module load so a key added to
 * Vault takes effect on the next tick instead of the next deploy.
 */
async function runStep(jobId: string, step: Step): Promise<StepResult> {
  const job = must(
    await supabase
      .from('generation_jobs')
      .select('id, kind, target, work_id, summary_id, visibility')
      .eq('id', jobId)
      .single(),
    'read job',
  ) as JobRow;

  const priorOutputs = (must(
    await supabase.rpc('job_step_outputs', { p_job_id: jobId }),
    'read prior step outputs',
  ) ?? {}) as Record<string, unknown>;

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

  return await runPipelineStep(step, {
    summary: providers.summary,
    embedding: providers.embedding,
    priorOutputs,
    job,
    db: createPipelineDb(supabase),
  });
}

const archive = (msgId: number) => supabase.rpc('archive_generation_message', { p_msg_id: msgId });

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
 * Move the job on and enqueue its successor.
 *
 * Both writes happen inside one Postgres transaction (`pgmq.send` is itself a
 * SQL function), so the pair is atomic. Previously they were separate round
 * trips: a crash between them left the job advanced with nothing queued, which
 * — with no sweeper — is a permanent stall rather than a recoverable one.
 *
 * The compare-and-set lives inside that same transaction, so a redelivered
 * message cannot enqueue the successor twice.
 */
async function advance(jobId: string, step: Step) {
  must(
    await supabase.rpc('advance_generation_job', {
      p_job_id: jobId,
      p_from_step: step,
      p_to_step: nextStep(step),
    }),
    'advance job',
  );
}

Deno.serve(async (req) => {
  const auth = await authorised(req);
  if (!auth.ok) {
    return new Response(JSON.stringify({ error: auth.why }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }

  const messages = must(
    await supabase.rpc('claim_generation_messages', {
      p_count: BATCH,
      p_visibility_seconds: VISIBILITY_SECONDS,
    }),
    'claim queue messages',
  ) as QueueMessage[] | null;

  const processed: unknown[] = [];

  for (const msg of messages ?? []) {
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
        await advance(jobId, step);
        must(await archive(msg.msg_id), 'archive resumed message');
        processed.push({ jobId, step, resumed: true });
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
      const result = await runStep(jobId, step);
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

      await advance(jobId, step);

      // Only archive once every write above has been confirmed. Archiving
      // earlier would drop the message with the job's state unpersisted.
      must(await archive(msg.msg_id), 'archive message');
      processed.push({ jobId, step, attempt, ok: true });
    } catch (e) {
      // The one write here that must not use `must()`: throwing out of a catch
      // would skip the bookkeeping below and lose the original error. Its result
      // is still checked, because an unrecorded attempt is what lets a job cycle
      // without ever reaching MAX_ATTEMPTS.
      const { error: recordError } = await supabase.from('job_steps').insert({
        job_id: jobId,
        step,
        attempt,
        status: 'failed',
        error: e instanceof Error ? e.message : String(e),
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
        error: e instanceof Error ? e.message : String(e),
        ...(recorded ? {} : { attemptUnrecorded: recordError.message }),
      });
    }
  }

  return new Response(JSON.stringify({ processed }), {
    headers: { 'content-type': 'application/json' },
  });
});
