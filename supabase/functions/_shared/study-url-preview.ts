import {
  DEFAULT_SOURCE_HOSTS,
  MAX_SOURCE_CHARS,
  assertFetchableUrl,
  extractText,
} from './source.ts';

/** A public endpoint uses the fixed corpus hosts, never the worker's configurable allowlist. */
const PUBLIC_PREVIEW_HOSTS = DEFAULT_SOURCE_HOSTS;
export const MAX_PREVIEW_BYTES = 1_000_000;
const PREVIEW_TIMEOUT_MS = 20_000;
const MAX_PREVIEW_REDIRECTS = 5;

export interface StudyUrlPreview {
  url: string;
  title: string;
  text: string;
  notes: string;
}

export function assertStudyPreviewUrl(raw: string): URL {
  if (raw.length > 240) throw new Error('Use a source URL shorter than 240 characters.');
  let url: URL;
  try {
    url = assertFetchableUrl(raw, PUBLIC_PREVIEW_HOSTS);
  } catch {
    throw new Error('This source host is not supported. Paste its text or upload a file instead.');
  }
  if (
    url.protocol !== 'https:' ||
    (url.port && url.port !== '443') ||
    url.username ||
    url.password
  ) {
    throw new Error('Use an HTTPS source URL without a custom port or embedded credentials.');
  }
  url.hash = '';
  return url;
}

export const MAX_PREVIEW_REQUEST_BYTES = 4_096;

export async function parseStudyPreviewRequest(req: Request): Promise<string> {
  if (req.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json' || !req.body) {
    throw new Error('Provide a JSON source URL.');
  }
  const reader = req.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let text = '';
  let bytes = 0;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void reader.cancel().catch(() => undefined);
  }, 5_000);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_PREVIEW_REQUEST_BYTES) {
        await reader.cancel();
        throw new Error('The URL request is too large.');
      }
      text += decoder.decode(value, { stream: true });
    }
    if (timedOut) throw new Error('The URL request took too long.');
    text += decoder.decode();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error('Provide a JSON source URL.');
    }
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      !('url' in body) ||
      typeof body.url !== 'string'
    ) {
      throw new Error('Provide a source URL.');
    }
    return assertStudyPreviewUrl(body.url).toString();
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
}

function suggestedTitle(url: URL, html: string, isHtml: boolean): string {
  if (isHtml) {
    const match = html.match(/<title(?:\s[^>]*)?>([^<]{1,300})<\/title\s*>/i);
    if (match) {
      const title = extractText(match[1] ?? '').trim();
      if (title) return title.slice(0, 200);
    }
  }
  try {
    const path = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() ?? '');
    if (path) return path.replace(/[_-]+/g, ' ').slice(0, 200);
  } catch {
    // A malformed path still has a safe host-based fallback.
  }
  return url.hostname;
}

/**
 * Preview only. The reader checks and edits the result before the private save RPC.
 * Every redirect is checked; too-large bodies fail rather than silently becoming
 * a misleading partial source.
 */
export async function previewStudyUrl(
  raw: string,
  doFetch: typeof fetch,
): Promise<StudyUrlPreview> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), PREVIEW_TIMEOUT_MS);
  let target = assertStudyPreviewUrl(raw);
  try {
    let response: Response | undefined;
    for (let hop = 0; hop <= MAX_PREVIEW_REDIRECTS; hop += 1) {
      response = await doFetch(target.toString(), {
        headers: { accept: 'text/html,text/plain' },
        redirect: 'manual',
        signal: abort.signal,
      });
      const location = response.headers.get('location');
      if (response.status >= 300 && response.status < 400 && location) {
        await response.body?.cancel();
        target = assertStudyPreviewUrl(new URL(location, target).toString());
        continue;
      }
      if (response.status >= 300 && response.status < 400) {
        throw new Error('The source redirected without a usable location.');
      }
      break;
    }
    if (!response || (response.status >= 300 && response.status < 400)) {
      throw new Error('The source redirected too many times.');
    }
    if (!response.ok) throw new Error('The source could not be fetched.');
    const type = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
    if (type !== 'text/html' && type !== 'text/plain') {
      throw new Error('This URL is not an HTML or plain-text page. Upload the file instead.');
    }
    const length = Number(response.headers.get('content-length'));
    if (Number.isFinite(length) && length > MAX_PREVIEW_BYTES) {
      throw new Error('This page is too large for one source. Paste a shorter reading.');
    }
    if (!response.body) throw new Error('The source returned no readable body.');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_PREVIEW_BYTES) {
          await reader.cancel();
          throw new Error('This page is too large for one source. Paste a shorter reading.');
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const body = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    let decoded: string;
    try {
      decoded = new TextDecoder('utf-8', { fatal: true }).decode(body);
    } catch {
      throw new Error('This page is not readable UTF-8. Save it as a text file and upload it.');
    }
    const text = type === 'text/html' ? extractText(decoded) : decoded.trim();
    if (!text || text.includes('\u0000')) {
      throw new Error('No readable source text was found. Paste text or upload a file.');
    }
    if (text.length > MAX_SOURCE_CHARS) {
      throw new Error('This reading is over 200,000 characters. Select a shorter section.');
    }
    return {
      url: target.toString(),
      title: suggestedTitle(target, decoded, type === 'text/html'),
      text,
      notes:
        'Fetched from the linked page. Check the extracted text against the original; page navigation, tables, and footnotes may need editing.',
    };
  } catch (cause) {
    if (abort.signal.aborted)
      throw new Error('The source took too long. Try again or paste its text.');
    throw cause;
  } finally {
    clearTimeout(timer);
  }
}
