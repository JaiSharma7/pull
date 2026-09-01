import { createClient } from 'jsr:@supabase/supabase-js@2';

/**
 * Create a generation job.
 *
 * The insert and the queue send happen in one Postgres transaction inside
 * `enqueue_generation_job`, so there is no half-created state and no cleanup
 * path to get wrong — the previous version tried to fail the job from the
 * authenticated role, which RLS grants no `update` on, so the cleanup could
 * never have worked.
 *
 * The quota exists for sustainability, not monetisation: over quota the job is
 * delayed, never refused. Nobody is converted by hitting one; it only stops a
 * script burning the public instance. See docs/generation.md.
 */

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const auth = req.headers.get('Authorization');
  if (!auth) return new Response('Unauthorized', { status: 401 });

  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: auth } },
    auth: { persistSession: false },
  });

  const body = (await req.json().catch(() => null)) as { target?: unknown } | null;
  if (!body?.target) return new Response('Missing target', { status: 400 });

  // The RPC derives the requester from auth.uid() rather than trusting a
  // parameter, and raises if there is no session.
  const { data, error } = await supabase.rpc('enqueue_generation_job', {
    p_target: body.target as never,
  });

  if (error) {
    const unauthenticated = error.message.includes('requires an authenticated user');
    /*
     * A guest is signed in and still may not do this, which is a 403 and not a 400.
     *
     * `enqueue_generation_job` raises SQLSTATE 28000 for a guest specifically so a
     * client can tell "you may not" apart from "that failed" (20260901190000). Reading
     * the message and returning 400 threw that distinction away at the one hop that was
     * meant to carry it: the caller cannot tell a refusal it should explain from a
     * request it should retry differently.
     */
    const forbidden = error.code === '28000';
    return new Response(JSON.stringify({ error: error.message, code: error.code }), {
      status: unauthenticated ? 401 : forbidden ? 403 : 400,
      headers: { 'content-type': 'application/json' },
    });
  }

  const result = data as { jobId: string; queue: 'fast' | 'normal'; delaySeconds: number };

  return new Response(
    JSON.stringify({
      ...result,
      message:
        result.queue === 'normal'
          ? "You've used today's fast generations. This one is queued normally — still free, just slower."
          : 'Queued.',
    }),
    { headers: { 'content-type': 'application/json' } },
  );
});
