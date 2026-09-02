/**
 * The BAML sidecar: the process that runs the prompts, because the worker cannot.
 *
 * BAML's TypeScript runtime is a native Node addon and Supabase Edge Functions are
 * Deno isolates that cannot load one, so this is where `baml_client` runs. The
 * worker posts a function name and its arguments; this answers with the parsed
 * result AND what it cost -- which is the reason this exists at all rather than
 * `baml-cli serve`. That command's `/call/<Function>` returns the parsed object and
 * nothing else (verified 2026-09-02 against its own OpenAPI document), so a worker
 * behind it could not write `cost_ledger`, and law 2 counts every model call.
 *
 * Three rules from law 7, each visible in the code below:
 *
 *   - Not publicly reachable. Every route but `/_debug/ping` requires the shared
 *     token, compared in constant time, and the process REFUSES TO START without
 *     one. "Misconfigured" must not mean "public": an open endpoint here is an open
 *     proxy to paid model calls.
 *   - The provider key lives in this process's environment and nowhere the worker
 *     can read it. BAML reads `GOOGLE_AI_API_KEY` itself; nothing here echoes it.
 *   - Every call is metered by the caller. The response carries usage summed over
 *     every attempt BAML made (retries are billed too), the client that answered
 *     and the model it pins. A failure after a billed attempt is a 502 with
 *     `billed: true` and the same usage, so the worker can raise the same
 *     `BilledProviderError` it would for any other vendor.
 */
import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Collector, type FunctionLog } from '@boundaryml/baml';
import { b } from '../baml_client/index.js';
import { modelOf } from './clients.js';
import { topicSlugOf } from './topics.js';

export const TOKEN_HEADER = 'x-baml-sidecar-token';
export const TOKEN_ENV = 'BAML_SIDECAR_TOKEN';
/** Source text is capped at 200,000 characters upstream; this leaves room for JSON. */
const MAX_BODY_BYTES = 2 * 1024 * 1024;

export interface SidecarUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}

export interface SidecarOk {
  result: unknown;
  usage: SidecarUsage;
  attempts: number;
  client: string | undefined;
  provider: string | undefined;
  model: string;
}

export interface SidecarFailure {
  error: string;
  billed: boolean;
  usage: SidecarUsage;
  attempts: number;
  client: string | undefined;
  provider: string | undefined;
  model: string;
}

/** A callable function: runs the BAML function with the collector attached. */
export type Handler = (args: Record<string, unknown>, collector: Collector) => Promise<unknown>;

const str = (v: unknown, name: string): string => {
  if (typeof v !== 'string') throw new BadRequest(`${name} must be a string`);
  return v;
};

class BadRequest extends Error {}

/**
 * The functions the worker may call, by name. An allowlist rather than a lookup on
 * `b`, so a typo in a request cannot reach a function that was never meant to be
 * reachable over HTTP -- and so each one can translate its output for the caller,
 * which for topics means enum member → database slug (see topics.ts).
 */
export const HANDLERS: Record<string, Handler> = {
  async WriteCanonicalSummary(args, collector) {
    const summary = await b.WriteCanonicalSummary(
      str(args.workTitle, 'workTitle'),
      str(args.kind, 'kind'),
      str(args.context, 'context'),
      { collector },
    );
    return { ...summary, topics: summary.topics.map(topicSlugOf) };
  },
};

/**
 * What the attempts cost, all of them.
 *
 * A retry policy on the client means one call to `b.Fn` may be several HTTP calls
 * to the vendor, and each one that answered was billed whether or not its answer
 * was usable. Summing only the selected call would under-report exactly the runs
 * that are paying for nothing.
 */
export function accountFor(log: FunctionLog | null): Omit<SidecarOk, 'result'> {
  const calls = log?.calls ?? [];
  const usage: SidecarUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
  for (const c of calls) {
    const u = c.usage;
    if (!u) continue;
    usage.inputTokens += u.inputTokens ?? 0;
    usage.outputTokens += u.outputTokens ?? 0;
    usage.cachedInputTokens += u.cachedInputTokens ?? 0;
  }
  const answered = calls.find((c) => c.selected) ?? calls.at(-1);
  const client = answered?.clientName;
  return {
    usage,
    attempts: calls.length,
    client,
    provider: answered?.provider,
    model: modelOf(client),
  };
}

function tokenMatches(presented: string | undefined, expected: string): boolean {
  if (!presented) return false;
  const a = Buffer.from(presented);
  const bb = Buffer.from(expected);
  return a.length === bb.length && timingSafeEqual(a, bb);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new BadRequest(`body exceeds ${MAX_BODY_BYTES} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

export interface SidecarOptions {
  /** Required. The process refuses to serve without one. */
  token: string;
  handlers?: Record<string, Handler>;
}

/** Build the server. Listening is the caller's job, so tests can bind port 0. */
export function createSidecar(options: SidecarOptions): Server {
  const token = options.token;
  if (!token || token.length < 16) {
    throw new Error(
      `${TOKEN_ENV} is unset or too short; the sidecar will not run open. ` +
        'Mint one with `select public.mint_baml_sidecar_token();` and set it here.',
    );
  }
  const handlers = options.handlers ?? HANDLERS;

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://sidecar');

    if (req.method === 'GET' && url.pathname === '/_debug/ping') {
      send(res, 200, { ok: true });
      return;
    }

    // Everything else is behind the token, including 404s: an unauthenticated
    // caller learns nothing about which functions exist.
    const presented = req.headers[TOKEN_HEADER];
    if (!tokenMatches(Array.isArray(presented) ? presented[0] : presented, token)) {
      send(res, 401, { error: 'missing or wrong token' });
      return;
    }

    const match = /^\/call\/([A-Za-z0-9_]+)$/.exec(url.pathname);
    if (!match) {
      send(res, 404, { error: 'not found' });
      return;
    }
    if (req.method !== 'POST') {
      send(res, 405, { error: 'POST only' });
      return;
    }
    const handler = handlers[match[1] as string];
    if (!handler) {
      send(res, 404, { error: `no such function: ${match[1]}` });
      return;
    }

    let args: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse((await readBody(req)) || '{}');
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new BadRequest('body must be a JSON object');
      }
      args = parsed as Record<string, unknown>;
    } catch (e) {
      send(res, 400, { error: e instanceof Error ? e.message : 'bad request' });
      return;
    }

    const collector = new Collector(match[1]);
    try {
      const result = await handler(args, collector);
      const ok: SidecarOk = { result, ...accountFor(collector.last) };
      send(res, 200, ok);
    } catch (e) {
      if (e instanceof BadRequest) {
        send(res, 400, { error: e.message });
        return;
      }
      // The error may have come after the vendor answered and billed: a parse
      // failure, an assert, a MAX_TOKENS with no usable text. The usage says which.
      const account = accountFor(collector.last);
      const billed = account.usage.inputTokens + account.usage.outputTokens > 0;
      const failure: SidecarFailure = {
        error: e instanceof Error ? e.message : String(e),
        billed,
        ...account,
      };
      send(res, 502, failure);
    }
  });
}
