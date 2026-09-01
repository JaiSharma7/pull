import { describe, expect, it } from 'vitest';
import { isKnownPath, SITE_TITLE, titleFor } from './title.js';

const base = { pathname: '/', tab: 'feed' } as const;

describe('titleFor', () => {
  it('is the bare product name on the feed', () => {
    // Not "What a Pull · What a Pull", which is what appending unconditionally gives.
    expect(titleFor(base)).toBe(SITE_TITLE);
  });

  it('names the section when one is showing', () => {
    expect(titleFor({ ...base, tab: 'library' })).toBe('Library · What a Pull');
    expect(titleFor({ ...base, tab: 'review' })).toBe('Review · What a Pull');
  });

  it('names a destination by its path', () => {
    expect(titleFor({ ...base, pathname: '/explore' })).toBe('Explore · What a Pull');
    expect(titleFor({ ...base, pathname: '/account' })).toBe('Account · What a Pull');
    expect(titleFor({ ...base, pathname: '/privacy' })).toBe('Privacy Policy · What a Pull');
  });

  it('puts the search text first, where a truncated tab still shows it', () => {
    expect(titleFor({ ...base, pathname: '/search', query: 'liberty' })).toBe(
      'liberty · Search · What a Pull',
    );
  });

  it('falls back to Search with no query, including whitespace-only', () => {
    expect(titleFor({ ...base, pathname: '/search' })).toBe('Search · What a Pull');
    expect(titleFor({ ...base, pathname: '/search', query: '   ' })).toBe('Search · What a Pull');
  });

  it('names a source once it is known, and says Source until then', () => {
    expect(titleFor({ ...base, pathname: '/source/abc', documentTitle: 'On Liberty' })).toBe(
      'On Liberty · What a Pull',
    );
    // Never the id: an id in a history list looks like an answer and is not one.
    expect(titleFor({ ...base, pathname: '/source/abc' })).toBe('Source · What a Pull');
    expect(titleFor({ ...base, pathname: '/source/abc', documentTitle: '  ' })).toBe(
      'Source · What a Pull',
    );
  });

  it('treats /pull/:id the same as a source, since it resolves to one', () => {
    expect(titleFor({ ...base, pathname: '/pull/xyz', documentTitle: 'Walden' })).toBe(
      'Walden · What a Pull',
    );
  });

  it('names a topic', () => {
    expect(titleFor({ ...base, pathname: '/topic/stoicism', documentTitle: 'Stoicism' })).toBe(
      'Stoicism · What a Pull',
    );
    expect(titleFor({ ...base, pathname: '/topic/stoicism' })).toBe('Topic · What a Pull');
  });

  it('says so when the address matches nothing', () => {
    expect(titleFor({ ...base, pathname: '/nonsense' })).toBe('Not found · What a Pull');
    expect(titleFor({ ...base, pathname: '/source' })).toBe('Not found · What a Pull');
  });

  it('treats a source or topic path as matched even before the row is known', () => {
    // The screen has not answered yet, and it may yet answer "no such source" —
    // which is a better message than a generic 404 and is that screen's to give.
    expect(isKnownPath('/source/anything')).toBe(true);
    expect(isKnownPath('/topic/anything')).toBe(true);
    expect(isKnownPath('/')).toBe(true);
    expect(isKnownPath('/account')).toBe(true);
    expect(isKnownPath('/nonsense')).toBe(false);
    expect(isKnownPath('/source')).toBe(false);
  });
});
