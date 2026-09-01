import { createClient } from 'jsr:@supabase/supabase-js@2';

/**
 * Share-card metadata for /pull/:id.
 *
 * The app is a client-rendered SPA so the same bundle can drop into Capacitor
 * unchanged — but a link someone shares still has to unfurl. This renders Open
 * Graph tags for that one route rather than adopting server rendering for the
 * whole app, and redirects a real browser straight through to the app.
 */

// Overridable by an APP_ORIGIN secret; the default is the deployed origin so this
// works without one. It is a URL, not a credential, so it belongs in the source
// rather than in the secret store.
//
// SET THE SECRET IN PRODUCTION. Every link this function emits carries this
// origin into somebody else's inbox, so while the default is a preview host,
// every share advertises the preview rather than the product. It is the one
// piece of configuration here whose absence is invisible until a stranger
// clicks it.
const APP_ORIGIN =
  Deno.env.get('APP_ORIGIN') ?? 'https://pull-jai-sharmas-projects-d3062905.vercel.app';

const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
  auth: { persistSession: false },
});

const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

Deno.serve(async (req) => {
  const id = new URL(req.url).pathname.split('/').filter(Boolean).pop();
  if (!id) return new Response('Not found', { status: 404 });

  // Anon key + RLS: this can only ever return a published, public pull.
  const { data } = await supabase
    .from('pulls')
    .select('headline, body, summaries(title, works(title, slug))')
    .eq('id', id)
    .single();

  if (!data) return Response.redirect(APP_ORIGIN, 302);

  const work = (data.summaries as { works?: { title?: string } } | null)?.works;
  const title = escape(data.headline);
  const description = escape(data.body.slice(0, 200));
  const site = escape(work?.title ?? 'What a Pull');
  const url = `${APP_ORIGIN}/pull/${encodeURIComponent(id)}`;

  /*
   * `summary`, not `summary_large_image`.
   *
   * The card declared a large image and supplied none, which is a promise
   * unfurlers cannot keep: they fall back to a bare card anyway, and the
   * declaration only makes the omission look like a bug rather than a gap.
   *
   * A real image belongs here eventually, and it should be a deterministic
   * typographic card rendered ONCE PER SUMMARY at publish time — not per
   * request. Generating it per unfurl would put work on the read path for a page
   * a crawler fetches, and an image model would put a provider there, which law
   * 2 forbids outright. So it waits for the pipeline step that can write one
   * into Storage.
   */
  return new Response(
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${title} — What a Pull</title>
<meta name="description" content="${description}">
<meta property="og:type" content="article">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${description}">
<meta property="og:site_name" content="${site}">
<meta property="og:url" content="${url}">
<meta name="twitter:card" content="summary">
<meta http-equiv="refresh" content="0; url=${url}">
</head>
<body><a href="${url}">${title}</a></body>
</html>`,
    {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'public, max-age=600',
      },
    },
  );
});
