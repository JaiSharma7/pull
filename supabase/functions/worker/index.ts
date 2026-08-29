// deno-lint-ignore-file no-explicit-any
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { MAX_ATTEMPTS, nextStep, type Step } from '../_shared/steps.ts';
import {
  disabledImageProvider,
  stubEmbeddingProvider,
  stubSummaryProvider,
} from '../_shared/providers.ts';

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
/** Long enough for one step, short enough that a dead worker frees the job. */
const VISIBILITY_SECONDS = 120;

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

async function runStep(jobId: string, step: Step) {
  // Round 1 wires the machine with stub providers so the whole pipeline is
  // exercisable with no API key. Round 2 swaps these for real ones.
  switch (step) {
    case 'synthesize':
      return stubSummaryProvider.generateSummary({ workTitle: jobId, kind: 'book', context: '' });
    case 'embed':
      return stubEmbeddingProvider.embed(['']);
    case 'artwork':
      return disabledImageProvider.generateArtwork('');
    default:
      return { usage: { inputTokens: 0, outputTokens: 0, costCents: 0 } };
  }
}

const archive = (msgId: number) => supabase.rpc('archive_generation_message', { p_msg_id: msgId });

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

Deno.serve(async () => {
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

    if (attempt > MAX_ATTEMPTS) {
      await supabase
        .from('generation_jobs')
        .update({
          status: 'failed',
          error: `step ${step} exhausted retries`,
          finished_at: new Date().toISOString(),
        })
        .eq('id', jobId);
      await archive(msg.msg_id);
      processed.push({ jobId, step, ok: false, exhausted: true });
      continue;
    }

    try {
      const result: any = await runStep(jobId, step);
      const usage = result?.usage ?? { inputTokens: 0, outputTokens: 0, costCents: 0 };

      // One transaction for the step and its cost. As two separate writes, a
      // ledger failure after a succeeded step left the spend permanently
      // unrecorded and unretryable: the step row already existed, so the retry
      // path could not replace it and resume treated it as fully done.
      must(
        await supabase.rpc('record_job_step', {
          p_job_id: jobId,
          p_step: step,
          p_attempt: attempt,
          p_model: 'stub',
          p_prompt_version: null,
          p_input_tokens: usage.inputTokens,
          p_output_tokens: usage.outputTokens,
          p_cost_cents: usage.costCents,
          p_duration_ms: Date.now() - started,
          p_provider: 'stub',
          // A zero-cost call is still a call: a free or local provider must stay
          // distinguishable from missing accounting.
          p_billable: PROVIDER_STEPS.has(step),
        }),
        'record step and cost',
      );

      await advance(jobId, step);

      // Only archive once every write above has been confirmed. Archiving
      // earlier would drop the message with the job's state unpersisted.
      must(await archive(msg.msg_id), 'archive message');
      processed.push({ jobId, step, attempt, ok: true });
    } catch (e) {
      await supabase.from('job_steps').insert({
        job_id: jobId,
        step,
        attempt,
        status: 'failed',
        error: e instanceof Error ? e.message : String(e),
        duration_ms: Date.now() - started,
        finished_at: new Date().toISOString(),
      });
      // Leave the message unarchived: its visibility timeout expires and the
      // next tick retries, up to MAX_ATTEMPTS.
      processed.push({ jobId, step, attempt, ok: false });
    }
  }

  return new Response(JSON.stringify({ processed }), {
    headers: { 'content-type': 'application/json' },
  });
});
