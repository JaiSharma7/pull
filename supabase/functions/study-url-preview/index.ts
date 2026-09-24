import { createClient } from 'jsr:@supabase/supabase-js@2';
import { parseStudyPreviewRequest, previewStudyUrl } from '../_shared/study-url-preview.ts';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'content-type': 'application/json; charset=utf-8' },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
  const auth = req.headers.get('Authorization');
  if (!auth) return json({ error: 'Sign in to preview a source.' }, 401);

  let url: string;
  try {
    url = await parseStudyPreviewRequest(req);
  } catch (cause) {
    return json({ error: cause instanceof Error ? cause.message : 'Invalid source URL.' }, 400);
  }

  // No service credential. The RPC uses auth.uid(), locks the account row and
  // consumes one of twenty daily previews before this function makes a request.
  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: auth } },
    auth: { persistSession: false },
  });
  const { error } = await supabase.rpc('reserve_study_url_preview');
  if (error) {
    return json(
      {
        error:
          error.code === '28000'
            ? 'Sign in with a full account to preview source URLs.'
            : error.code === '54000'
              ? 'Your twenty URL previews for today are used. Paste text or try tomorrow.'
              : 'Could not reserve a URL preview. Try again.',
      },
      error.code === '28000' ? 403 : error.code === '54000' ? 429 : 500,
    );
  }

  try {
    return json(await previewStudyUrl(url, fetch), 200);
  } catch (cause) {
    return json(
      { error: cause instanceof Error ? cause.message : 'Could not preview this source.' },
      422,
    );
  }
});
