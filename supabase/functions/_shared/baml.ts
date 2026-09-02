/**
 * The BAML sidecar, as a `SummaryProvider`.
 *
 * BAML's TypeScript runtime is a native Node addon and this file runs in a Deno
 * isolate, so the prompts in `packages/prompts` run in a separate process and this
 * is the HTTP client for it. What crosses the wire is the function name, its
 * arguments, and -- coming back -- the parsed result plus what it cost. The sidecar
 * is `packages/prompts/src/server.ts`; the reason it is not `baml-cli serve` is
 * that the CLI's `/call` drops usage, and law 2 counts every model call.
 *
 * The failure classification is the whole point of this file, and it mirrors the
 * Gemini provider's rather than inventing a new one:
 *
 *   sidecar answered 200                  → summary, usage, model
 *   sidecar answered 502 `billed: true`   → BilledProviderError, with the usage
 *   sidecar answered 502 `billed: false`  → ProviderUnavailableError (nothing charged)
 *   sidecar answered 503, or refused      → ProviderUnavailableError (nothing charged)
 *   sidecar answered 401 / 404            → plain Error. A wrong token or a function
 *                                            the deploy does not know is a local
 *                                            configuration bug, and paying a second
 *                                            vendor to rediscover a local bug is the
 *                                            expensive way to find out.
 *   timed out                             → plain Error. The sidecar may have paid;
 *                                            this cannot know, and must not claim to.
 */
import {
  BilledProviderError,
  ProviderUnavailableError,
  type CanonicalSummary,
  type SummaryInput,
  type SummaryProvider,
  type Usage,
} from './providers.ts';
import { usdToCents } from './gemini.ts';

export const TOKEN_HEADER = 'x-baml-sidecar-token';
const DEFAULT_TIMEOUT_MS = 110_000;

export interface BamlSidecarConfig {
  url: string;
  token: string;
  /** The sidecar returns tokens; the price is this deployment's configuration. */
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

interface SidecarUsage {
  inputTokens?: number;
  outputTokens?: number;
}

interface SidecarBody {
  result?: unknown;
  error?: string;
  billed?: boolean;
  usage?: SidecarUsage;
  model?: string;
  client?: string;
}

export function usageFrom(
  raw: SidecarUsage | undefined,
  prices: Pick<BamlSidecarConfig, 'inputUsdPerMTok' | 'outputUsdPerMTok'>,
): Usage {
  const inputTokens = raw?.inputTokens ?? 0;
  const outputTokens = raw?.outputTokens ?? 0;
  const usd =
    (inputTokens / 1_000_000) * prices.inputUsdPerMTok +
    (outputTokens / 1_000_000) * prices.outputUsdPerMTok;
  return { inputTokens, outputTokens, costCents: usdToCents(usd) };
}

/**
 * The shape the pipeline needs, checked rather than cast.
 *
 * The sidecar has already parsed and asserted this against the BAML schema, and
 * has already turned topic enum members into database slugs. This checks the few
 * things the next steps dereference without looking, because a 200 with the wrong
 * shape is a billed call and must be reported as one.
 */
export function asCanonicalSummary(value: unknown): CanonicalSummary | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.title !== 'string' || !Array.isArray(v.pulls)) return null;
  for (const p of v.pulls) {
    if (!p || typeof p !== 'object') return null;
    const q = p as Record<string, unknown>;
    if (typeof q.headline !== 'string' || typeof q.body !== 'string') return null;
  }
  return v as unknown as CanonicalSummary;
}

export function createBamlSummaryProvider(config: BamlSidecarConfig): SummaryProvider {
  const doFetch = config.fetchImpl ?? fetch;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const endpoint = `${config.url.replace(/\/+$/, '')}/call/WriteCanonicalSummary`;

  return {
    name: 'baml',

    async generateSummary(input: SummaryInput) {
      let res: Response;
      try {
        res = await doFetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', [TOKEN_HEADER]: config.token },
          body: JSON.stringify({
            workTitle: input.workTitle,
            kind: input.kind,
            context: input.context,
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (e instanceof Error && e.name === 'TimeoutError') {
          throw new Error(`baml sidecar: no answer within ${timeoutMs}ms; usage unknown`);
        }
        throw new ProviderUnavailableError(`baml sidecar unreachable: ${message}`, 'baml');
      }

      const body = (await res.json().catch(() => null)) as SidecarBody | null;
      const model = body?.model ?? body?.client ?? 'baml';

      if (res.status === 401) {
        throw new Error('baml sidecar refused the token; check BAML_SIDECAR_TOKEN on both sides');
      }
      if (res.status === 404) {
        throw new Error(`baml sidecar does not know WriteCanonicalSummary: ${body?.error ?? ''}`);
      }
      if (res.status === 503) {
        throw new ProviderUnavailableError('baml sidecar is not ready', 'baml');
      }
      if (!res.ok) {
        const message = `baml sidecar ${res.status}: ${body?.error ?? 'no detail'}`;
        if (body?.billed) {
          throw new BilledProviderError(message, {
            usage: usageFrom(body.usage, config),
            model,
          });
        }
        throw new ProviderUnavailableError(message, 'baml');
      }

      const usage = usageFrom(body?.usage, config);
      const summary = asCanonicalSummary(body?.result);
      if (!summary) {
        // Billed: the vendor answered and the sidecar parsed it. What came back is
        // simply not what this pipeline can write, and the charge has to reach the
        // ledger rather than vanish behind a retry.
        throw new BilledProviderError('baml sidecar returned a summary of the wrong shape', {
          usage,
          model,
        });
      }
      return { summary, usage, model };
    },
  };
}
