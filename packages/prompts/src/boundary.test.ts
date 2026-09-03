/**
 * Importing this package must not boot the BAML runtime.
 *
 * `baml_sdk/index.ts` calls `initializeRuntimeFromBytecode` at module scope, so any
 * *value* import from it pulls in a native NAPI addon and 3.3 MB of bytecode — in
 * every consumer, including `apps/web`, where Vite would then try to bundle a
 * `.node` file. This regressed once already: `export { TopicSlug }` looks like a
 * type re-export but an `enum` is a value, and the runtime came with it.
 *
 * Asserted as text rather than by importing and watching the module graph, because
 * the failure is a build-time dependency edge — it is present whether or not any
 * test happens to touch the enum, and this way the message names the offending line.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('.', import.meta.url));

function sources(): [string, string][] {
  return readdirSync(SRC)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => [f, readFileSync(new URL(f, import.meta.url), 'utf8')]);
}

describe('the baml_sdk boundary', () => {
  it('reads the package sources', () => {
    // Guards the glob: a rename that empties this list must fail here rather than
    // make the assertion below vacuously true.
    expect(sources().map(([f]) => f)).toContain('index.ts');
  });

  it.each(sources())('%s imports baml_sdk only as a type', (file, source) => {
    const offending = source
      .split('\n')
      .map((line, i) => [i + 1, line] as const)
      .filter(([, line]) => line.includes('baml_sdk'))
      .filter(([, line]) => !/^\s*(import|export)\s+type\b/.test(line))
      .filter(([, line]) => !/^\s*(\/\/|\*|\/\*)/.test(line));

    expect(
      offending.map(([n, line]) => `${file}:${n}: ${line.trim()}`),
      'a value import from baml_sdk boots the native runtime; use `import type`',
    ).toEqual([]);
  });
});
