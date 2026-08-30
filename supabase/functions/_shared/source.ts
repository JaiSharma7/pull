/**
 * Getting a source, and preparing it for the steps that reason about it.
 *
 * Split out of `pipeline.ts` because these answer a different question. The
 * pipeline decides *what each of the twelve steps does*; this decides *how text
 * is obtained and made safe to work with* — fetching it without becoming a
 * confused deputy, bounding it so one step cannot exhaust the invocation,
 * fingerprinting it so the same source is summarised once, and cutting it at
 * boundaries a reader would recognise.
 *
 * The seam is also where the risk is concentrated. `acquire` follows a URL
 * chosen by whoever created the job, from a server holding a service-role key,
 * so the host checks below are the security boundary of the whole ingest path.
 * They deserve to be findable without reading the step machine around them.
 */

/** Text extraction, deliberately conservative. See `acquire`. */
export const MAX_SOURCE_CHARS = 200_000;

/**
 * A stable fingerprint of the source text.
 *
 * This is what makes the same source resolve to the same work twice, which is
 * the whole economic argument: one canonical generation serves every reader,
 * and a thousand personalised regenerations of one book cost about a thousand
 * times more than the one that would have done.
 */
export async function contentHash(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text.trim().replace(/\s+/g, ' ').toLowerCase());
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Strip a fetched document to something worth summarising.
 *
 * Not a readability implementation — script and style content removed, tags
 * dropped, entities decoded, whitespace collapsed. A real extractor belongs in
 * its own module when URL ingestion is more than a convenience; this is honest
 * about being the simple version rather than pretending to be the other one.
 */
/**
 * Drop an element and its contents by scanning, not by backtracking.
 *
 * `/<script[\s\S]*?<\/script>/g` looks harmless and is quadratic on hostile input:
 * every unterminated `<script` scans to end-of-string before failing, so k openers
 * over n bytes costs O(k·n). Measured on the regex this replaces:
 *
 *     100 KB of "<script"  →      0.4 s
 *     400 KB               →      6.0 s
 *       1 MB               →    340 s      ← against a 150 s platform ceiling
 *
 * A signed-in reader only had to point `target.url` at a server returning
 * `"<script".repeat(n)`. `FETCH_TIMEOUT_MS` does not help: it bounds the fetch, and
 * this runs synchronously afterwards on a single-threaded isolate, so the timer
 * cannot even fire. The invocation is killed with no `job_steps` row and no ledger
 * row, while pgmq charges `read_ct` on delivery — three of those fail the job with
 * nothing recorded to explain it, having burned three full invocations.
 *
 * An index scan has no backtracking to exploit: each byte is visited once. An
 * unterminated opener drops the remainder of the document, which is the safe
 * direction — the tail of a document whose script tag never closes is not content.
 */
function stripElement(html: string, tag: string): string {
  const lower = html.toLowerCase();
  const open = `<${tag}`;
  const close = `</${tag}>`;
  let out = '';
  let i = 0;
  for (;;) {
    const start = lower.indexOf(open, i);
    if (start === -1) return out + html.slice(i);
    out += html.slice(i, start) + ' ';
    const end = lower.indexOf(close, start);
    if (end === -1) return out;
    i = end + close.length;
  }
}

export function extractText(html: string): string {
  return (
    stripElement(stripElement(html, 'script'), 'style')
      // Block boundaries become paragraph breaks *before* tags are stripped.
      // Collapsing all whitespace first — which this used to do — destroyed the
      // only structure `segment` can split on, so every fetched article arrived
      // as one undivided chunk and the segmentation below did nothing at all.
      .replace(/<\/(?:p|div|section|article|h[1-6]|li|blockquote|tr|pre)\s*>/gi, '\n\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&#39;|&apos;/gi, "'")
      .replace(/&quot;/gi, '"')
      // Horizontal whitespace only, so the paragraph breaks just established
      // survive the tidy-up.
      .replace(/[^\S\n]+/g, ' ')
      .replace(/\s*\n\s*\n\s*/g, '\n\n')
      .replace(/ *\n */g, '\n')
      .trim()
  );
}

/**
 * Hosts the worker must never be talked into fetching.
 *
 * What this does NOT cover, stated plainly so nobody reads it as complete: a
 * hostname that resolves to a private address. `evil.example.com` with an A
 * record of `10.0.0.1` passes every check here, because the check is on the
 * literal and the resolution happens inside `fetch`. Closing that needs the
 * address resolved before connecting and the socket pinned to it, which Deno's
 * `fetch` does not expose. Every redirect hop is re-checked, so the cheap
 * version of the attack — a public URL that 302s to a private one — is covered;
 * DNS rebinding is not. It is a real residual risk on an endpoint any signed-in
 * reader can reach, and it belongs on the roadmap rather than in a comment
 * claiming otherwise.
 *
 * `acquire` follows a URL supplied by whoever created the job, and it runs
 * server-side holding a service-role key. Without this it is a confused deputy:
 * a job targeting `169.254.169.254` reaches cloud instance metadata, and one
 * targeting `127.0.0.1:54321` reaches this project's own API from inside the
 * trust boundary. Neither needs a credential to be handed over — the worker
 * already has one.
 */
const BLOCKED_HOST_V4 =
  /^(?:localhost$|127\.|0\.0\.0\.0$|0\.|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|metadata\.google\.internal$)/i;

/**
 * The IPv6 half, which the v4 patterns above cannot express.
 *
 * Blocking only `::1` left every other way of naming a private address open:
 * `fd00::1` is unique-local, `fe80::1` is link-local, and `::ffff:127.0.0.1`
 * is loopback wearing an IPv6 spelling. Any of them reaches the private network
 * from a worker holding a service-role key, and `acquire` writes what it fetched
 * into `job_steps.output` — which the requester can read. That is exfiltration,
 * not merely an unwanted request.
 */
function isBlockedIpv6(host: string): boolean {
  // The WHATWG URL parser returns IPv6 hosts bracketed; the checks below are
  // written against the bare address.
  const bare = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (!bare.includes(':')) return false;

  // Loopback and unspecified. The parser has already collapsed the long forms —
  // `0:0:0:0:0:0:0:1` arrives here as `::1`.
  if (bare === '::1' || bare === '::') return true;

  /*
   * IPv4-mapped addresses, which do not survive parsing in the form they were
   * written. `http://[::ffff:127.0.0.1]/` normalises to `::ffff:7f00:1` — the
   * final two groups are the four IPv4 bytes in hex. Matching the dotted form
   * alone therefore never fires, which is precisely the bug the tests caught:
   * the check looked right and covered nothing.
   */
  const mappedHex = bare.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const high = Number.parseInt(mappedHex[1]!, 16);
    const low = Number.parseInt(mappedHex[2]!, 16);
    const dotted = [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
    return BLOCKED_HOST_V4.test(dotted);
  }
  // The dotted spelling too, for any caller reaching this without a URL parse.
  const mappedDotted = bare.match(/^::(?:ffff:)?((?:\d{1,3}\.){3}\d{1,3})$/);
  if (mappedDotted?.[1]) return BLOCKED_HOST_V4.test(mappedDotted[1]);

  /*
   * Everything whose first 96 bits are zero, whatever the last 32 say.
   *
   * Enumerating spellings was the wrong shape: `::127.0.0.1` (IPv4-compatible) and
   * `::ffff:0:127.0.0.1` (IPv4-translated) both normalise to forms the patterns above
   * do not match, and both embed an IPv4 address. Rather than add two more patterns,
   * refuse the whole `::/96` and `::ffff:0:0/96` prefixes: no public address lives
   * there, so a blanket refusal costs nothing and cannot be spelled around.
   */
  if (/^::(?:ffff:0:)?[0-9a-f]{0,4}(?::[0-9a-f]{1,4})?$/.test(bare)) return true;

  /*
   * 64:ff9b::/96 and 64:ff9b:1::/48 — the NAT64 well-known prefixes.
   *
   * The one on this list that actually routes. An IPv6-only runtime behind NAT64 and
   * DNS64 — increasingly what an edge function sits on — translates
   * `64:ff9b::7f00:1` straight to 127.0.0.1, so the embedded IPv4 reaches the private
   * network with none of the v4 checks above ever seeing a v4 address.
   */
  if (/^64:ff9b:/.test(bare) || bare.startsWith('64:ff9b::')) return true;

  const head = bare.split(':')[0] ?? '';
  // fec0::/10 — site-local. Deprecated by RFC 3879, still routed by some stacks.
  if (/^fe[cdef][0-9a-f]?$/.test(head)) return true;
  // fc00::/7 — unique local. Covers the fc.. and fd.. halves.
  if (/^f[cd][0-9a-f]{0,2}$/.test(head)) return true;
  // fe80::/10 — link local, which is where cloud metadata lives on IPv6.
  if (/^fe[89ab][0-9a-f]?$/.test(head)) return true;

  return false;
}

export function assertFetchableUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`acquire: "${raw}" is not a valid URL`);
  }
  // `file:` and `data:` would read the worker's own filesystem and memory.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`acquire: refusing to fetch a ${url.protocol} URL`);
  }
  if (BLOCKED_HOST_V4.test(url.hostname) || isBlockedIpv6(url.hostname)) {
    throw new Error(`acquire: refusing to fetch a private or link-local host (${url.hostname})`);
  }
  return url;
}

/**
 * Split into sections at paragraph boundaries, never mid-sentence.
 *
 * The research is specific that segmentation should follow meaningful
 * boundaries rather than fixed windows — hippocampal responses track event
 * boundaries in continuous experience, and a chunk that starts halfway through
 * an argument is a chunk with no beginning. A model pass over the text can
 * place better boundaries than this, and that belongs in `chunk` once the
 * cheaper structural signal has been used first: paragraphs are free and
 * usually right.
 */
export function segment(text: string, targetChars = 6000): string[] {
  const paragraphs = text.split(/\n{2,}|(?<=\.)\s{2,}/).filter((p) => p.trim().length > 0);
  const sections: string[] = [];
  let current = '';

  for (const paragraph of paragraphs) {
    if (current && current.length + paragraph.length > targetChars) {
      sections.push(current.trim());
      current = paragraph;
    } else {
      current = current ? `${current}\n\n${paragraph}` : paragraph;
    }
  }
  if (current.trim()) sections.push(current.trim());
  // A single unbroken block is still one section — better than returning nothing
  // and making the caller special-case emptiness.
  return sections.length > 0 ? sections : [text];
}

export const FETCH_TIMEOUT_MS = 20_000;
/** Read cap. Generous for an article, far below anything that threatens the step. */
export const MAX_FETCH_BYTES = 5_000_000;
export const MAX_REDIRECTS = 5;

/**
 * Fetch a URL with both bounds a step-machine needs.
 *
 * An Edge Function has 150s of wall clock and one attempt in three before the
 * job is failed, so an unbounded read is a job that burns every retry on the
 * same slow response and reports nothing useful. The size cap is applied while
 * streaming rather than after: a multi-gigabyte body must never be buffered
 * first and measured second.
 */
export async function fetchBounded(url: string, doFetch: typeof fetch): Promise<string> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), FETCH_TIMEOUT_MS);

  try {
    let target = assertFetchableUrl(url);
    let response: Response;

    // Redirects are followed by hand so every hop is checked. Letting fetch
    // follow them automatically would validate only the first URL, and a public
    // address that 302s to 169.254.169.254 defeats the check entirely.
    for (let hop = 0; ; hop++) {
      if (hop > MAX_REDIRECTS) throw new Error(`acquire: too many redirects from ${url}`);
      response = await doFetch(target.toString(), {
        headers: { accept: 'text/html,text/plain' },
        signal: abort.signal,
        redirect: 'manual',
      });
      const location = response.headers.get('location');
      if (response.status >= 300 && response.status < 400 && location) {
        target = assertFetchableUrl(new URL(location, target).toString());
        continue;
      }
      break;
    }

    if (!response.ok) throw new Error(`acquire: fetching ${url} returned ${response.status}`);

    const body = response.body;
    // A mocked fetch in a test may return a bodyless Response; fall back to
    // text() rather than making the helper untestable.
    if (!body) return (await response.text()).slice(0, MAX_FETCH_BYTES);

    const reader = body.getReader();
    const decoder = new TextDecoder();
    let out = '';
    let bytes = 0;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      out += decoder.decode(value, { stream: true });
      if (bytes >= MAX_FETCH_BYTES) {
        await reader.cancel();
        break;
      }
    }
    return out;
  } finally {
    clearTimeout(timer);
  }
}
