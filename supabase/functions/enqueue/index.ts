import { createClient } from 'jsr:@supabase/supabase-js@2';

/**
 * Create a generation job.
 *
 * Rate limits here exist for sustainability, not monetisation: nobody is
 * converted by hitting one. They stop a script burning the public instance,
 * and the normal (slower) queue stays open to everyone. See docs/generation.md.
 */

const DAILY_FAST_GENERATIONS = 3;

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const auth = req.headers.get('Authorization');
  if (!auth) return new Response('Unauthorized', { status: 401 });

  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: auth } },
    auth: { persistSession: false },
  });

  const { data: userData } = await supabase.auth.getUser();
  const user = userData?.user;
  if (!user) return new Response('Unauthorized', { status: 401 });

  const body = (await req.json().catch(() => null)) as { target?: unknown } | null;
  if (!body?.target) return new Response('Missing target', { status: 400 });

  const windowStart = new Date();
  windowStart.setUTCHours(0, 0, 0, 0);

  const { count } = await supabase
    .from('generation_jobs')
    .select('id', { count: 'exact', head: true })
    .eq('requester_id', user.id)
    .gte('created_at', windowStart.toISOString());

  const overQuota = (count ?? 0) >= DAILY_FAST_GENERATIONS;

  const { data: job, error } = await supabase
    .from('generation_jobs')
    .insert({ requester_id: user.id, target: body.target, status: 'queued' })
    .select('id')
    .single();

  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 400 });

  // Without this the job sits in `queued` forever: the worker only ever reads
  // the queue, and nothing else puts the first step on it.
  const { error: queueError } = await supabase.schema('pgmq_public').rpc('send', {
    queue_name: 'generation',
    message: { jobId: job.id, step: 'resolve_identity' },
    sleep_seconds: 0,
  });

  if (queueError) {
    // The row exists but nothing will ever pick it up, so fail it now rather
    // than leaving a job that looks pending and never moves.
    await supabase
      .from('generation_jobs')
      .update({ status: 'failed', error: `could not enqueue: ${queueError.message}` })
      .eq('id', job.id);
    return new Response(JSON.stringify({ error: 'could not queue the job' }), { status: 503 });
  }

  return new Response(
    JSON.stringify({
      jobId: job.id,
      // Over quota is not a refusal. The work still happens, just not first.
      queue: overQuota ? 'normal' : 'fast',
      message: overQuota
        ? "You've used today's fast generations. This one is queued normally — still free, just slower."
        : 'Queued.',
    }),
    { headers: { 'content-type': 'application/json' } },
  );
});
