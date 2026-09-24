import { describe, expect, it, vi } from 'vitest';
import {
  assertStudyPreviewUrl,
  parseStudyPreviewRequest,
  previewStudyUrl,
} from './study-url-preview.js';

const html = (text: string, headers: Record<string, string> = {}) =>
  new Response('<title>A reading</title><article><p>' + text + '</p></article>', {
    headers: { 'content-type': 'text/html', ...headers },
  });

describe('study URL preview', () => {
  it('bounds and validates incoming JSON before reserving a fetch', async () => {
    const request = (body: string, type = 'application/json') =>
      new Request('https://example.test/study-url-preview', {
        method: 'POST',
        headers: { 'content-type': type },
        body,
      });
    expect(
      await parseStudyPreviewRequest(
        request(
          JSON.stringify({
            url: 'https://en.wikisource.org/wiki/Reading',
          }),
        ),
      ),
    ).toBe('https://en.wikisource.org/wiki/Reading');
    await expect(parseStudyPreviewRequest(request('x'.repeat(5_000)))).rejects.toThrow('too large');
    await expect(parseStudyPreviewRequest(request('not json'))).rejects.toThrow('JSON');
    await expect(parseStudyPreviewRequest(request('{}', 'text/plain'))).rejects.toThrow('JSON');
  });
  it('requires exact HTTPS allowlisted hosts without credentials or custom ports', () => {
    expect(assertStudyPreviewUrl('https://en.wikisource.org/wiki/Reading').hostname).toBe(
      'en.wikisource.org',
    );
    for (const url of [
      'http://en.wikisource.org/wiki/Reading',
      'https://evilwikisource.org/wiki/Reading',
      'https://en.wikisource.org.evil.test/wiki/Reading',
      'https://user:pass@en.wikisource.org/wiki/Reading',
      'https://en.wikisource.org:8443/wiki/Reading',
      'https://127.0.0.1/wiki/Reading',
      'file:///etc/passwd',
      'https://en.wikisource.org/' + 'a'.repeat(250),
    ]) {
      expect(() => assertStudyPreviewUrl(url)).toThrow();
    }
  });

  it('returns inspectable extracted text and its final source URL', async () => {
    const doFetch = vi.fn(async () => html('An argument &amp; its qualification.'));
    const result = await previewStudyUrl(
      'https://en.wikisource.org/wiki/Reading#section',
      doFetch as typeof fetch,
    );
    expect(result.url).toBe('https://en.wikisource.org/wiki/Reading');
    expect(result.title).toBe('A reading');
    expect(result.text).toContain('An argument & its qualification.');
    expect(result.notes).toContain('Check');
    expect(doFetch).toHaveBeenCalledOnce();
  });

  it('rejects a redirect to an unlisted or private host before a second fetch', async () => {
    const doFetch = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: 'http://127.0.0.1/admin' },
        }),
    );
    await expect(
      previewStudyUrl('https://en.wikisource.org/wiki/Reading', doFetch as typeof fetch),
    ).rejects.toThrow();
    expect(doFetch).toHaveBeenCalledOnce();
  });

  it('rejects a body over the streaming cap instead of saving a partial source', async () => {
    const doFetch = vi.fn(async () => html('a'.repeat(1_000_001)));
    await expect(
      previewStudyUrl('https://en.wikisource.org/wiki/Reading', doFetch as typeof fetch),
    ).rejects.toThrow('too large');
  });

  it('refuses nontext content and text too long for a version', async () => {
    const binary = vi.fn(
      async () =>
        new Response('pdf', {
          headers: { 'content-type': 'application/pdf' },
        }),
    );
    await expect(
      previewStudyUrl('https://en.wikisource.org/wiki/Reading', binary as typeof fetch),
    ).rejects.toThrow('not an HTML or plain-text');
    const longText = vi.fn(
      async () =>
        new Response('a'.repeat(200_001), {
          headers: { 'content-type': 'text/plain' },
        }),
    );
    await expect(
      previewStudyUrl('https://en.wikisource.org/wiki/Reading', longText as typeof fetch),
    ).rejects.toThrow('over 200,000');
  });
});
