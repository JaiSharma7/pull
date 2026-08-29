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
 *
 * Idempotency comes from `unique (job_id, step, attempt)` on job_steps — a
 * worker that dies mid-step cannot double-charge or duplicate work on resume.
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

Deno.serve(async () => {
  const { data: messages, error } = await supabase.schema('pgmq_public').rpc('read', {
    queue_name: QUEUE,
    sleep_seconds: VISIBILITY_SECONDS,
    n: BATCH,
  });

  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });

  const processed: unknown[] = [];

  for (const msg of (messages ?? []) as QueueMessage[]) {
    const { jobId, step } = msg.message;
    const started = Date.now();

    const { data: prior } = await supabase
      .from('job_steps')
      .select('attempt')
      .eq('job_id', jobId)
      .eq('step', step)
      .order('attempt', { ascending: false })
      .limit(1);

    const attempt = ((prior?.[0]?.attempt as number | undefined) ?? 0) + 1;

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
      continue;
    }

    try {
      const result: any = await runStep(jobId, step);
      const usage = result?.usage ?? { inputTokens: 0, outputTokens: 0, costCents: 0 };

      const { data: stepRow } = await supabase
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
        .single();

      // Every generation writes to the ledger. Without this a bad summary is an
      // unfixable mystery; with it, it is a diff. See CLAUDE.md law 2.
      if (usage.costCents > 0) {
        await supabase.from('cost_ledger').insert({
          job_id: jobId,
          step_id: stepRow?.id ?? null,
          provider: 'stub',
          operation: step,
          unit: 'tokens',
          quantity: usage.inputTokens + usage.outputTokens,
          cost_cents: usage.costCents,
        });
      }

      const following = nextStep(step);
      if (following) {
        await supabase
          .from('generation_jobs')
          .update({ current_step: following, status: 'running' })
          .eq('id', jobId);
        await supabase.schema('pgmq_public').rpc('send', {
          queue_name: QUEUE,
          message: { jobId, step: following },
          sleep_seconds: 0,
        });
      } else {
        await supabase
          .from('generation_jobs')
          .update({ status: 'succeeded', finished_at: new Date().toISOString() })
          .eq('id', jobId);
      }

      await supabase
        .schema('pgmq_public')
        .rpc('archive', { queue_name: QUEUE, message_id: msg.msg_id });
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
