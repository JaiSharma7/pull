import { describe, expect, it } from 'vitest';
import { anchoredPullId, queryParam, routeParam } from './routes.js';

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
