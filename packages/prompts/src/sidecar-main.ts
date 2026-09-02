/**
 * Entry point. `createSidecar` is separate so tests can build a server on port 0
 * with fake handlers; this is the ten lines that read the environment and listen.
 *
 * Run the CommonJS build (`pnpm --filter @wap/prompts sidecar`), not the source:
 * the generated client's imports are extensionless, which Vitest resolves and Node's
 * ESM loader does not.
 */
import { createSidecar, TOKEN_ENV } from './server.js';

const port = Number(process.env.PORT ?? 2024);
const server = createSidecar({ token: process.env[TOKEN_ENV] ?? '' });
server.listen(port, '0.0.0.0', () => {
  // The one thing worth printing. Not the token, not the provider key.
  console.warn(`[baml-sidecar] listening on :${port}`);
});
