import { describe, expect, it } from 'vitest';
import { INTERRUPT_KINDS, RELATION_KINDS, WORK_KINDS } from './index.js';

describe('shared enums', () => {
  it('has no duplicate members', () => {
    for (const list of [WORK_KINDS, RELATION_KINDS, INTERRUPT_KINDS]) {
      expect(new Set(list).size).toBe(list.length);
    }
  });
});
