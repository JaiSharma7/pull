import { describe, expect, it } from 'vitest';
import { bootstrapTarget } from './bootstrap-route.js';

describe('bootstrapTarget', () => {
  it('mounts the design preview only at its public route', () => {
    expect(bootstrapTarget('/design-preview')).toBe('design-preview');
    expect(bootstrapTarget('/design-preview/')).toBe('design-preview');
    expect(bootstrapTarget('/design-preview/anything')).toBe('app');
    expect(bootstrapTarget('/')).toBe('app');
  });
});
