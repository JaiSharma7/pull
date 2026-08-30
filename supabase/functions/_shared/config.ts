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
