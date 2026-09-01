import { describe, expect, it } from 'vitest';
import { anchoredPullId, decodeSegment, isPath, queryParam, routeParam } from './routes.js';

const UUID = '0e825ac9-6df4-495a-8028-1868c7d35e95';
const PULL = '43005e69-e1c6-4fdd-bf34-dee342db375e';

describe('routeParam', () => {
  it('strips the fragment before reading the id', () => {
    /*
     * The regression this file exists for. `/pull/:id` resolves to
     * `/source/<uuid>#p-<pullId>`; leaving the anchor on made the id
     * "<uuid>#p-<uuid>", which Postgres rejects as 22P02 — so the single path the
     * route was built to serve showed "Could not load this source".
     */
    expect(routeParam(`/source/${UUID}#p-${PULL}`, '/source')).toBe(UUID);
  });

  it('strips a query string too', () => {
    expect(routeParam(`/source/${UUID}?from=share`, '/source')).toBe(UUID);
  });

  it('reads a plain path, with or without a trailing slash', () => {
    expect(routeParam(`/source/${UUID}`, '/source')).toBe(UUID);
    expect(routeParam(`/source/${UUID}/`, '/source')).toBe(UUID);
  });

  it('returns null for a different route, or for the bare prefix', () => {
    expect(routeParam('/library', '/source')).toBeNull();
    expect(routeParam('/source', '/source')).toBeNull();
    expect(routeParam('/source/', '/source')).toBeNull();
    expect(routeParam('/', '/source')).toBeNull();
  });

  it('does not claim a deeper path', () => {
    // `/source/a/b` is a path this route does not own, not a source called "a/b".
    expect(routeParam('/source/a/b', '/source')).toBeNull();
  });

  it('reads the pull route the same way', () => {
    expect(routeParam(`/pull/${PULL}`, '/pull')).toBe(PULL);
    expect(routeParam(`/pull/${PULL}#anything`, '/pull')).toBe(PULL);
  });

  it('does not confuse one route for a prefix of another', () => {
    expect(routeParam(`/pull/${PULL}`, '/source')).toBeNull();
    expect(routeParam(`/source/${UUID}`, '/pull')).toBeNull();
  });
});

describe('anchoredPullId', () => {
  it('reads the Pull an anchor names', () => {
    expect(anchoredPullId(`#p-${PULL}`)).toBe(PULL);
  });

  it('ignores an empty or unrelated fragment', () => {
    expect(anchoredPullId('')).toBeNull();
    expect(anchoredPullId('#p-')).toBeNull();
    expect(anchoredPullId('#main')).toBeNull();
  });
});

describe('queryParam', () => {
  it('reads a value that has a fragment glued to it', () => {
    // The shape /pull/:id actually produces.
    expect(queryParam(`/source/${UUID}?s=${PULL}#p-${PULL}`, 's')).toBe(PULL);
  });

  it('reads a value with no fragment', () => {
    expect(queryParam(`/source/${UUID}?s=${PULL}`, 's')).toBe(PULL);
  });

  it('returns null when the key, the query or the value is absent', () => {
    expect(queryParam(`/source/${UUID}`, 's')).toBeNull();
    expect(queryParam(`/source/${UUID}?other=1`, 's')).toBeNull();
    expect(queryParam(`/source/${UUID}?s=`, 's')).toBeNull();
  });

  it('does not read the fragment as a query', () => {
    expect(queryParam(`/source/${UUID}#s=nope`, 's')).toBeNull();
  });
});

describe('isPath', () => {
  it('matches the bare path', () => {
    expect(isPath('/search', '/search')).toBe(true);
  });

  it('ignores a query string, which is the whole reason it exists', () => {
    expect(isPath('/search?q=liberty', '/search')).toBe(true);
  });

  it('ignores a fragment, and a fragment glued after a query', () => {
    expect(isPath('/search#top', '/search')).toBe(true);
    expect(isPath('/search?q=a#top', '/search')).toBe(true);
  });

  it('ignores trailing slashes on either side', () => {
    expect(isPath('/search/', '/search')).toBe(true);
    expect(isPath('/search', '/search/')).toBe(true);
  });

  it('does not match a deeper path that merely starts the same way', () => {
    expect(isPath('/searching', '/search')).toBe(false);
    expect(isPath('/search/results', '/search')).toBe(false);
  });

  it('treats the root as the root however it is spelled', () => {
    expect(isPath('/', '/')).toBe(true);
    expect(isPath('/?q=x', '/')).toBe(true);
    expect(isPath('//', '/')).toBe(true);
  });
});

describe('decodeSegment', () => {
  it('decodes an ordinary percent-encoded slug', () => {
    expect(decodeSegment('caf%C3%A9')).toBe('café');
    expect(decodeSegment('arts-and-letters')).toBe('arts-and-letters');
  });

  it('returns a malformed segment raw instead of throwing', () => {
    /*
     * The crash this exists for. `decodeURIComponent` throws URIError on an
     * incomplete escape, and it was being called on the topic slug during
     * render with no error boundary above it — so `/topic/%`, a URL anyone can
     * type or link, blanked the whole application.
     *
     * Each of these throws when passed to `decodeURIComponent` directly; the
     * assertion below is what makes that a slug rather than a stack trace.
     */
    for (const bad of ['%', '%zz', '%E0%A4%A', '100%', 'a%b']) {
      expect(() => decodeURIComponent(bad), `${bad} should throw undecoded`).toThrow(URIError);
      expect(decodeSegment(bad), `${bad} should survive`).toBe(bad);
    }
  });

  it('returns raw rather than null, so the reader gets "no such topic"', () => {
    /*
     * A deliberate choice about which wrong answer to give. Null would mean
     * "this is not a topic route at all", dropping the reader somewhere
     * unrelated with no explanation. The raw string is simply a slug no topic
     * has, so `get_topic` matches nothing and Topic renders the not-found state
     * it already has — which is the honest answer to `/topic/%`.
     */
    expect(decodeSegment('%')).not.toBeNull();
    expect(decodeSegment('%')).toBe('%');
  });

  it('is not fooled by a segment that merely contains a percent', () => {
    expect(decodeSegment('%25')).toBe('%');
    expect(decodeSegment('50%25-off')).toBe('50%-off');
  });
});
