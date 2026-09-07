import { describe, expect, it } from 'vitest';
import { HANDLE_MAX, handleProblem, normaliseHandle, suggestHandle } from './handle.js';

describe('normaliseHandle', () => {
  it('lower-cases and trims, because that is what will be stored', () => {
    expect(normaliseHandle('  Ada_Lovelace ')).toBe('ada_lovelace');
  });
});

describe('handleProblem', () => {
  it('accepts the shape the database accepts', () => {
    for (const ok of ['ada', 'ada_lovelace', 'a1_2', 'x'.repeat(HANDLE_MAX)]) {
      expect(handleProblem(ok), ok).toBeNull();
    }
  });

  it('measures the normalised value, not what was typed', () => {
    // `  Ada  ` is three characters and fine; the spaces are not the problem.
    expect(handleProblem('  Ada  ')).toBeNull();
  });

  it('names the one thing wrong, in the reader’s terms', () => {
    expect(handleProblem('')).toBe('Choose a username.');
    expect(handleProblem('  ')).toBe('Choose a username.');
    expect(handleProblem('ab')).toContain('at least 3');
    expect(handleProblem('x'.repeat(HANDLE_MAX + 1))).toContain('at most 30');
    expect(handleProblem('ada lovelace')).toContain('no spaces');
    expect(handleProblem('ada.lovelace')).toContain('no spaces');
    expect(handleProblem('ada-lovelace')).toContain('no spaces');
  });

  /*
   * The prefix the database gives a profile nobody has named. Refused in SQL as well;
   * refused here so the reader is told why rather than watching a request fail.
   */
  it('refuses the shape a generated handle wears', () => {
    expect(handleProblem('reader_0123456789abcdef')).toContain('cannot begin');
    expect(handleProblem('READER_abc')).toContain('cannot begin');
    // Not a prefix match on the word alone: `readers_of_walden` is somebody's name.
    expect(handleProblem('readers_of_walden')).toBeNull();
  });
});

describe('suggestHandle', () => {
  it('makes a name out of a name', () => {
    expect(suggestHandle('Ada Lovelace')).toBe('ada_lovelace');
    expect(suggestHandle('Ada  Lovelace!')).toBe('ada_lovelace');
    expect(suggestHandle('José Ortega')).toBe('jose_ortega');
    expect(suggestHandle('  Jai Sharma  ')).toBe('jai_sharma');
  });

  it('never suggests an address', () => {
    // `handle_new_user` drops provider metadata carrying an `@`; this is the second
    // refusal, because the whole point of 20260901120000 is that the two are easy
    // to confuse and this is where a name becomes an identifier.
    expect(suggestHandle('someone@example.test')).toBe('');
  });

  it('offers nothing rather than something that would be refused', () => {
    expect(suggestHandle(null)).toBe('');
    expect(suggestHandle(undefined)).toBe('');
    expect(suggestHandle('   ')).toBe('');
    expect(suggestHandle('Jo')).toBe('');
    expect(suggestHandle('王')).toBe('');
  });

  it('fits the column, and is still a name the database accepts', () => {
    const long = suggestHandle('Wolfeschlegelsteinhausenbergerdorff Alexander');
    expect(long.length).toBeLessThanOrEqual(HANDLE_MAX);
    expect(handleProblem(long)).toBeNull();
  });
});
