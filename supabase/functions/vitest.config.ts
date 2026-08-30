import { defineConfig } from 'vitest/config';

/**
 * Not the shared preset: that looks in `src/`, and these files are laid out for
 * the Deno deploy (`_shared/`, `worker/`, `og/`) rather than for a build. The
 * layout is fixed by the runtime, so the test config bends instead.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['**/*.test.ts'],
    exclude: ['**/node_modules/**'],
    passWithNoTests: true,
  },
});
