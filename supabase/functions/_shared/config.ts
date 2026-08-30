/**
 * Which providers this deployment runs, chosen by environment.
 *
 * `docs/architecture.md` has described this selection since round 1; nothing implemented
 * it, and the worker hard-coded the stubs. The point is that a self-hosted instance is
 * never forced to reproduce our vendors: no key, no problem — it falls back to stubs and
 * the pipeline still runs end to end.
 */

import {
  disabledImageProvider,
  stubEmbeddingProvider,
  stubSummaryProvider,
  type EmbeddingProvider,
  type ImageProvider,
  type SummaryProvider,
} from './providers.ts';
import {
  createGeminiEmbeddingProvider,
  createGeminiSummaryProvider,
  DEFAULT_SUMMARY_MODELS,
  type GeminiConfig,
} from './gemini.ts';

export interface ProviderSet {
  summary: SummaryProvider;
  embedding: EmbeddingProvider;
  image: ImageProvider;
}

/** Reading the environment is injected so this is testable off the Edge runtime. */
export interface Env {
  get(key: string): string | undefined;
}

/**
 * Deliberately strict about what counts as on.
 *
 * A flag that turns a safety check off when someone writes `REQUIRE_REAL_PROVIDERS=false`
 * and on when they write `no` is worse than no flag, so only the affirmative spellings
 * enable it and everything else — including the empty string a shell exports for an unset
 * variable — leaves it off.
 */
const isTruthy = (raw: string | undefined): boolean =>
  raw !== undefined && ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());

const numberFrom = (env: Env, key: string, fallback: number): number => {
  const raw = env.get(key);
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  // A typo in a price must not silently become NaN and make every cost row NaN too.
  return Number.isFinite(parsed) ? parsed : fallback;
};

/**
 * Published rates change often enough that they are configuration, not constants
 * (docs/generation.md). These defaults are a starting point for the ledger to be
 * approximately right out of the box, not a quoted price.
 */
const DEFAULT_INPUT_USD_PER_MTOK = 0.75;
const DEFAULT_OUTPUT_USD_PER_MTOK = 3.0;
const DEFAULT_EMBEDDING_USD_PER_MTOK = 0.15;

export function geminiConfigFrom(env: Env, apiKey: string): GeminiConfig {
  const configured = env.get('GEMINI_SUMMARY_MODELS');
  return {
    apiKey,
    summaryModels: configured
      ? configured
          .split(',')
          .map((m) => m.trim())
          .filter(Boolean)
      : DEFAULT_SUMMARY_MODELS,
    embeddingModel: env.get('GEMINI_EMBEDDING_MODEL') ?? 'gemini-embedding-001',
    inputUsdPerMTok: numberFrom(env, 'GEMINI_INPUT_USD_PER_MTOK', DEFAULT_INPUT_USD_PER_MTOK),
    outputUsdPerMTok: numberFrom(env, 'GEMINI_OUTPUT_USD_PER_MTOK', DEFAULT_OUTPUT_USD_PER_MTOK),
    embeddingUsdPerMTok: numberFrom(
      env,
      'GEMINI_EMBEDDING_USD_PER_MTOK',
      DEFAULT_EMBEDDING_USD_PER_MTOK,
    ),
  };
}

/**
 * Resolve the provider set.
 *
 * The key comes from the environment first and Vault second. Vault is what lets
 * generation be switched on without anyone opening the dashboard — the same reasoning as
 * the dispatch token — while the env var stays authoritative so moving the key to Edge
 * Function secrets later needs no code change.
 *
 * `getSecret` is a callback rather than a Supabase client so this module has no database
 * dependency and can be exercised directly.
 *
 *   REQUIRE_REAL_PROVIDERS unset       REQUIRE_REAL_PROVIDERS set
 *   ──────────────────────────────     ──────────────────────────────
 *   key found  → Gemini                key found  → Gemini
 *   no key     → stubs, silently       no key     → throws here
 *
 * The right-hand column exists because the left-hand one is indistinguishable from
 * working. A deployment whose key has been rotated, revoked or quota-exhausted keeps
 * answering — with stub summaries, at zero cost, writing nothing to `cost_ledger` — and
 * the only symptom is that readers quietly get placeholder prose. Nothing throws, so
 * nothing alerts, and the failure is discovered by reading the app rather than by any
 * monitor. The hosted worker sets the flag; a fresh clone does not, which is what keeps
 * the no-key promise in law 3 intact.
 */
export async function resolveProviders(
  env: Env,
  getSecret: (name: string) => Promise<string | null>,
): Promise<ProviderSet> {
  const wantSummary = env.get('SUMMARY_PROVIDER') ?? 'gemini';
  const wantEmbedding = env.get('EMBEDDING_PROVIDER') ?? 'gemini';

  const needsGemini = wantSummary === 'gemini' || wantEmbedding === 'gemini';
  let apiKey: string | null = null;
  if (needsGemini) {
    apiKey = env.get('GOOGLE_AI_API_KEY') ?? (await getSecret('google_ai_api_key'));
  }

  // Fail before a job is claimed rather than after one is silently mis-served. A worker
  // that cannot reach the provider it was told to require has nothing useful to do, and
  // this is the loudest moment available — before any message is claimed, any `read_ct`
  // is spent, or any reader is handed a stub.
  if (needsGemini && !apiKey && isTruthy(env.get('REQUIRE_REAL_PROVIDERS'))) {
    throw new Error(
      'REQUIRE_REAL_PROVIDERS is set but no Gemini key resolved. Set GOOGLE_AI_API_KEY in ' +
        'the Edge Function environment, or store `google_ai_api_key` in Vault. Refusing to ' +
        'fall back to stub providers, which would serve readers placeholder summaries with ' +
        'no error anywhere.',
    );
  }

  // No key is a supported state, not a crash: the stubs exercise every step, which is
  // what keeps `pnpm db:reset` and a fresh contributor's clone working with no account.
  const gemini = apiKey ? geminiConfigFrom(env, apiKey) : null;

  return {
    summary:
      wantSummary === 'gemini' && gemini
        ? createGeminiSummaryProvider(gemini)
        : stubSummaryProvider,
    embedding:
      wantEmbedding === 'gemini' && gemini
        ? createGeminiEmbeddingProvider(gemini)
        : stubEmbeddingProvider,
    // No image provider exists to select between yet. `IMAGE_PROVIDER` is read by
    // nothing on purpose: branching on a value whose every outcome is the same reads
    // like a choice and hides that there is none. Artwork is also the first thing to
    // switch off under cost pressure — an illustration can cost several times the text
    // it accompanies — so `disabled` is the right default when one does arrive.
    image: disabledImageProvider,
  };
}
