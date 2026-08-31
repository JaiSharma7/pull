import { describe, expect, it } from 'vitest';
import { int, isRecord, nonNull, nullableInt, nullableStr, rows, str } from './shape.js';

/**
 * The primitives every RPC shaper is built from.
 *
 * Worth testing directly rather than only through their callers, because the
 * whole point of them is what they do with values a caller never thinks about:
 * `NaN`, an array where an object was expected, `null` where a string was.
 */

describe('isRecord', () => {
  it('accepts a plain object and nothing else', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
    // An array is an object to `typeof`, which is the trap this exists for.
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(isRecord('x')).toBe(false);
    expect(isRecord(undefined)).toBe(false);
  });
});

describe('str', () => {
  it('passes a string through, including an empty one', () => {
    expect(str('a')).toBe('a');
    expect(str('')).toBe('');
  });

  it('never lets a missing value become the word "undefined"', () => {
    expect(str(undefined)).toBe('');
    expect(str(null)).toBe('');
    expect(str(42)).toBe('');
    expect(str({})).toBe('');
  });
});

describe('nullableStr', () => {
  it('keeps null distinct from empty, because the column does', () => {
    expect(nullableStr('a')).toBe('a');
    expect(nullableStr('')).toBe('');
    expect(nullableStr(null)).toBeNull();
    expect(nullableStr(7)).toBeNull();
  });
});

describe('int', () => {
  it('passes finite numbers through, including zero and negatives', () => {
    expect(int(0)).toBe(0);
    expect(int(-3)).toBe(-3);
    expect(int(42)).toBe(42);
  });

  it('refuses NaN and Infinity, which survive a typeof check', () => {
    expect(int(Number.NaN)).toBe(0);
    expect(int(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it('does not coerce a numeric string', () => {
    expect(int('42')).toBe(0);
  });
});

describe('nullableInt', () => {
  it('distinguishes absent from zero', () => {
    expect(nullableInt(0)).toBe(0);
    expect(nullableInt(null)).toBeNull();
    expect(nullableInt(Number.NaN)).toBeNull();
    expect(nullableInt('1859')).toBeNull();
  });
});

describe('rows', () => {
  it('keeps the object entries and discards the rest', () => {
    expect(rows([{ a: 1 }, 'x', null, [1], { b: 2 }])).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('returns an empty array for anything that is not one', () => {
    expect(rows(null)).toEqual([]);
    expect(rows({})).toEqual([]);
    expect(rows(undefined)).toEqual([]);
  });
});

describe('nonNull', () => {
  it('filters nulls and narrows the type', () => {
    const mixed: (string | null)[] = ['a', null, 'b'];
    expect(mixed.filter(nonNull)).toEqual(['a', 'b']);
  });
});
