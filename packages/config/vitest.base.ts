import { defineConfig } from 'vitest/config';

/**
 * Shared Vitest preset. `include` is deliberately scoped to `src` and `dist` is
 * excluded — `tsc -b` emits compiled copies of the test files, and without this
 * every test runs twice (once from source, once from build output).
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    passWithNoTests: true,
  },
});
