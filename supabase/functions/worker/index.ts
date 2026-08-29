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

const QUEUE = 'generation';
const BATCH = 5;
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
 * supabase-js returns `{ error }` rather than throwing. Every write in this
 * worker must be checked, because an unchecked failure followed by archiving
 * the message strands the job silently — or worse, marks it complete.
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

/** Move the job on, and enqueue its successor. Throws if either write fails. */
async function advance(jobId: string, step: Step) {
  const following = nextStep(step);
  if (following) {
    must(
      await supabase
        .from('generation_jobs')
        .update({ current_step: following, status: 'running' })
        .eq('id', jobId)
        .select('id')
        .single(),
      'advance job',
    );
    must(
      await supabase.schema('pgmq_public').rpc('send', {
        queue_name: QUEUE,
        message: { jobId, step: following },
        sleep_seconds: 0,
      }),
      'enqueue next step',
    );
  } else {
    must(
      await supabase
        .from('generation_jobs')
        .update({ status: 'succeeded', finished_at: new Date().toISOString() })
        .eq('id', jobId)
        .select('id')
        .single(),
      'complete job',
    );
  }
}

Deno.serve(async () => {
  const messages = must(
    await supabase.schema('pgmq_public').rpc('read', {
      queue_name: QUEUE,
      sleep_seconds: VISIBILITY_SECONDS,
      n: BATCH,
    }),
    'read queue',
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
    // NEW attempt number. So resume: finish the transition, do not redo the work.
    if (last?.status === 'succeeded') {
      try {
        await advance(jobId, step);
        must(
          await supabase.schema('pgmq_public').rpc('archive', {
            queue_name: QUEUE,
            message_id: msg.msg_id,
          }),
          'archive resumed message',
        );
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
      await supabase
        .schema('pgmq_public')
        .rpc('archive', { queue_name: QUEUE, message_id: msg.msg_id });
      processed.push({ jobId, step, ok: false, exhausted: true });
      continue;
    }

    try {
      const result: any = await runStep(jobId, step);
      const usage = result?.usage ?? { inputTokens: 0, outputTokens: 0, costCents: 0 };

      const stepRow = must(
        await supabase
          .from('job_steps')
          .insert({
            job_id: jobId,
            step,
            attempt,
            status: 'succeeded',
            model: 'stub',
            input_tokens: usage.inputTokens,
            output_tokens: usage.outputTokens,
            cost_cents: usage.costCents,
            duration_ms: Date.now() - started,
            finished_at: new Date().toISOString(),
          })
          .select('id')
          .single(),
        'record step',
      );

      // Every generation writes to the ledger. Without it a bad summary is an
      // unfixable mystery; with it, it is a diff. See CLAUDE.md law 2.
      if (usage.costCents > 0) {
        must(
          await supabase
            .from('cost_ledger')
            .insert({
              job_id: jobId,
              step_id: stepRow?.id ?? null,
              provider: 'stub',
              operation: step,
              unit: 'tokens',
              quantity: usage.inputTokens + usage.outputTokens,
              cost_cents: usage.costCents,
            })
            .select('id')
            .single(),
          'record cost',
        );
      }

      await advance(jobId, step);

      // Only archive once every write above has been confirmed. Archiving
      // before that would drop the message with the job's state unpersisted.
      must(
        await supabase
          .schema('pgmq_public')
          .rpc('archive', { queue_name: QUEUE, message_id: msg.msg_id }),
        'archive message',
      );
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
