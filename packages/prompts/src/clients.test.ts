import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CLIENT_MODELS } from './clients.js';

const read = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../baml_src/${name}`, import.meta.url)), 'utf8');

/** Every `client<llm> Name { provider p ... model "m" }` block that pins one model. */
function pinnedClients(): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /client<llm>\s+(\w+)\s*\{[^}]*?model\s+"([^"]+)"/gs;
  for (const m of read('clients.baml').matchAll(re)) out[m[1] as string] = m[2] as string;
  return out;
}

describe('client → model parity', () => {
  it('finds the pinned clients', () => {
    expect(Object.keys(pinnedClients()).length).toBeGreaterThanOrEqual(3);
  });

  it('maps every pinned client to the model clients.baml pins', () => {
    expect(CLIENT_MODELS).toEqual(pinnedClients());
  });

  it('lets no function name the fallback chain', () => {
    // Law 2. BAML's fallback would retry a billed failure on the next client, and
    // the sidecar could not tell the worker what the first attempt cost.
    const functions = read('canonical_summary.baml');
    expect(functions).not.toMatch(/client\s+SummaryChain/);
  });
});
