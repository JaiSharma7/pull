import { describe, expect, it } from 'vitest';
import { geminiConfigFrom, resolveProviders, type Env } from './config.ts';
import { DEFAULT_SUMMARY_MODELS } from './gemini.ts';

/**
 * Provider selection — the branch that decides whether readers get real summaries.
 *
 *   env GOOGLE_AI_API_KEY ──┐
 *                           ├─→ key? ──yes──→ Gemini providers
 *   Vault google_ai_api_key ┘      │
 *                                  └──no───→ REQUIRE_REAL_PROVIDERS? ──set──→ throw
 *                                                     │
 *                                                    unset
 *                                                     ↓
 *                                                   stubs
 *
 * This module had no tests until now, and the shape of that gap is worth recording:
 * `pipeline.test.ts` injects providers directly, which is correct for testing the
 * pipeline and is exactly why it never exercised the code that *chooses* them. The
 * consequence was a deployment that could serve stub summaries indefinitely with every
 * test green — the failure is a wrong selection, not a thrown error, so only a test of
 * the selector could ever have caught it.
 *
 * `getSecret` is counted, not just stubbed, because "did Vault get consulted at all"
 * is a distinct question from "was a key found" — a regression that stops asking is
 * invisible to an assertion that only looks at the result.
 */

const envOf = (vars: Record<string, string>): Env => ({
  get: (key: string) => vars[key],
});

/** Records what was asked for, so the fallback order itself can be asserted. */
function vaultWith(secrets: Record<string, string>) {
  const asked: string[] = [];
  return {
    asked,
    getSecret: async (name: string) => {
      asked.push(name);
      return secrets[name] ?? null;
    },
  };
}

const noVault = () => vaultWith({});

describe('resolveProviders — key resolution', () => {
  it('uses the environment key without consulting Vault', async () => {
    const vault = noVault();
    const providers = await resolveProviders(
      envOf({ GOOGLE_AI_API_KEY: 'env-key' }),
      vault.getSecret,
    );

    expect(providers.summary.name).toBe('gemini');
    // The embedding provider names itself with its model — `gemini:gemini-embedding-001`
    // — because `pipeline.ts` records `deps.embedding.name` as both model and provider
    // for the embed step. Matched on the prefix so changing the default embedding model
    // does not break a test that is asking a question about key resolution.
    expect(providers.embedding.name).toMatch(/^gemini:/);
    // Not merely "a key was found": the env var is documented as authoritative so the
    // key can move to Edge Function secrets later with no code change, and that promise
    // is only kept if Vault is never reached when the env var is present.
    expect(vault.asked).toEqual([]);
  });

  it('falls back to the Vault secret when the environment has no key', async () => {
    const vault = vaultWith({ google_ai_api_key: 'vault-key' });
    const providers = await resolveProviders(envOf({}), vault.getSecret);

    expect(providers.summary.name).toBe('gemini');
    expect(vault.asked).toEqual(['google_ai_api_key']);
  });

  it('falls back to stubs when neither source has a key', async () => {
    const providers = await resolveProviders(envOf({}), noVault().getSecret);

    // Law 3: a fresh clone runs the whole pipeline with no account. If this ever
    // becomes a throw, `pnpm db:reset` and every new contributor break at once.
    expect(providers.summary.name).toBe('stub');
    expect(providers.embedding.name).toBe('stub');
  });

  it('never asks Vault when no provider wants Gemini', async () => {
    const vault = vaultWith({ google_ai_api_key: 'vault-key' });
    const providers = await resolveProviders(
      envOf({ SUMMARY_PROVIDER: 'stub', EMBEDDING_PROVIDER: 'stub' }),
      vault.getSecret,
    );

    expect(providers.summary.name).toBe('stub');
    // A secret decrypt is a security-definer round trip. Paying for one to configure
    // providers that were never going to use it is waste on every step of every job.
    expect(vault.asked).toEqual([]);
  });

  it('selects per provider, so one can be real while the other is stubbed', async () => {
    const providers = await resolveProviders(
      envOf({ GOOGLE_AI_API_KEY: 'env-key', EMBEDDING_PROVIDER: 'stub' }),
      noVault().getSecret,
    );

    expect(providers.summary.name).toBe('gemini');
    expect(providers.embedding.name).toBe('stub');
  });

  it('leaves the image provider disabled regardless of key', async () => {
    const providers = await resolveProviders(
      envOf({ GOOGLE_AI_API_KEY: 'env-key', IMAGE_PROVIDER: 'gemini' }),
      noVault().getSecret,
    );

    // IMAGE_PROVIDER is read by nothing on purpose. Asserted so that stays a decision
    // rather than becoming an accident someone "fixes" without pricing artwork first.
    expect(providers.image.name).toBe('disabled');
  });
});

describe('resolveProviders — REQUIRE_REAL_PROVIDERS', () => {
  it('throws rather than stubbing when set and no key resolves', async () => {
    await expect(
      resolveProviders(envOf({ REQUIRE_REAL_PROVIDERS: '1' }), noVault().getSecret),
    ).rejects.toThrow(/no Gemini key resolved/);
  });

  it('names both places a key can go, so the error is actionable', async () => {
    // An operator reading this in a log at 3am should not have to open the source to
    // learn where the key belongs.
    await expect(
      resolveProviders(envOf({ REQUIRE_REAL_PROVIDERS: 'true' }), noVault().getSecret),
    ).rejects.toThrow(/GOOGLE_AI_API_KEY.*google_ai_api_key/s);
  });

  it('is satisfied by a key from Vault, not just from the environment', async () => {
    const vault = vaultWith({ google_ai_api_key: 'vault-key' });
    const providers = await resolveProviders(
      envOf({ REQUIRE_REAL_PROVIDERS: '1' }),
      vault.getSecret,
    );

    // The hosted deployment keeps its key in Vault, so a flag that only accepted the
    // env var would fail exactly the configuration it was written to protect.
    expect(providers.summary.name).toBe('gemini');
  });

  it.each(['1', 'true', 'TRUE', 'yes', 'on', ' true '])('treats %o as set', async (raw) => {
    await expect(
      resolveProviders(envOf({ REQUIRE_REAL_PROVIDERS: raw }), noVault().getSecret),
    ).rejects.toThrow(/no Gemini key resolved/);
  });

  it.each(['', '0', 'false', 'no', 'off', 'maybe'])(
    'treats %o as unset and still stubs',
    async (raw) => {
      const providers = await resolveProviders(
        envOf({ REQUIRE_REAL_PROVIDERS: raw }),
        noVault().getSecret,
      );

      // `false` reading as true is the failure that matters here: it would turn a flag
      // meant to protect production into one that takes production down.
      expect(providers.summary.name).toBe('stub');
    },
  );

  it('does not throw when nothing wants Gemini, even with a key absent', async () => {
    const providers = await resolveProviders(
      envOf({ REQUIRE_REAL_PROVIDERS: '1', SUMMARY_PROVIDER: 'stub', EMBEDDING_PROVIDER: 'stub' }),
      noVault().getSecret,
    );

    // The flag requires the providers that were asked for, not Gemini specifically.
    expect(providers.summary.name).toBe('stub');
  });
});

describe('geminiConfigFrom', () => {
  it('defaults the model chain to the models that actually answer', () => {
    const config = geminiConfigFrom(envOf({}), 'k');
    expect(config.summaryModels).toEqual([...DEFAULT_SUMMARY_MODELS]);
  });

  it('parses a configured chain, trimming and dropping blanks', () => {
    const config = geminiConfigFrom(envOf({ GEMINI_SUMMARY_MODELS: ' a , ,b ,' }), 'k');
    // A trailing comma is the most ordinary way to edit this variable wrong, and an
    // empty model name would be requested as a URL path segment and 404 the whole chain.
    expect(config.summaryModels).toEqual(['a', 'b']);
  });

  it('carries the api key through untouched', () => {
    expect(geminiConfigFrom(envOf({}), 'secret-key').apiKey).toBe('secret-key');
  });

  it('reads prices from the environment', () => {
    const config = geminiConfigFrom(
      envOf({
        GEMINI_INPUT_USD_PER_MTOK: '2.5',
        GEMINI_OUTPUT_USD_PER_MTOK: '10',
        GEMINI_EMBEDDING_USD_PER_MTOK: '0.5',
      }),
      'k',
    );

    expect(config.inputUsdPerMTok).toBe(2.5);
    expect(config.outputUsdPerMTok).toBe(10);
    expect(config.embeddingUsdPerMTok).toBe(0.5);
  });

  it.each(['not-a-number', '', undefined])(
    'falls back to the default price rather than NaN for %o',
    (raw) => {
      const config = geminiConfigFrom(
        envOf(raw === undefined ? {} : { GEMINI_INPUT_USD_PER_MTOK: raw }),
        'k',
      );

      // One NaN price makes every cost_ledger row for that call NaN, and a ledger of
      // NaN is a law 2 instrument that reports nothing while looking populated.
      expect(Number.isFinite(config.inputUsdPerMTok)).toBe(true);
      expect(config.inputUsdPerMTok).toBeGreaterThan(0);
    },
  );

  it('accepts a zero price without treating it as missing', () => {
    // A free tier is a real configuration, and `0 || default` would silently overwrite it.
    expect(geminiConfigFrom(envOf({ GEMINI_INPUT_USD_PER_MTOK: '0' }), 'k').inputUsdPerMTok).toBe(
      0,
    );
  });
});

/*
 * The fallback is opt-in because it is the only provider in this file that costs real
 * money on a deployment whose primary is free. Every assertion below is about it
 * staying off unless somebody deliberately turned it on — a fallback that engages by
 * accident is a bill nobody reads until it arrives.
 */
describe('resolveProviders — the paid fallback', () => {
  it('is absent unless asked for, even with a key sitting right there', async () => {
    const providers = await resolveProviders(
      envOf({ GOOGLE_AI_API_KEY: 'k', ANTHROPIC_API_KEY: 'sk-ant-test' }),
      noVault().getSecret,
    );

    expect(providers.summary.name).toBe('gemini');
  });

  it('never asks Vault for a key it was not told to want', async () => {
    // Vault reads are a round trip on every worker cold start; asking for a secret no
    // configured provider could use is waste on every step of every job.
    const vault = vaultWith({ google_ai_api_key: 'k', anthropic_api_key: 'sk-ant-test' });
    await resolveProviders(envOf({}), vault.getSecret);

    expect(vault.asked).not.toContain('anthropic_api_key');
  });

  it('chains Gemini to Anthropic when both are configured', async () => {
    const providers = await resolveProviders(
      envOf({
        GOOGLE_AI_API_KEY: 'k',
        SUMMARY_FALLBACK_PROVIDER: 'anthropic',
        ANTHROPIC_API_KEY: 'sk-ant-test',
      }),
      noVault().getSecret,
    );

    expect(providers.summary.name).toBe('gemini->anthropic');
  });

  it('resolves the fallback key from Vault, so it can be switched on without a redeploy', async () => {
    const vault = vaultWith({ google_ai_api_key: 'k', anthropic_api_key: 'sk-ant-test' });
    const providers = await resolveProviders(
      envOf({ SUMMARY_FALLBACK_PROVIDER: 'anthropic' }),
      vault.getSecret,
    );

    expect(providers.summary.name).toBe('gemini->anthropic');
    expect(vault.asked).toContain('anthropic_api_key');
  });

  it('runs the primary alone when the fallback was asked for but has no key', async () => {
    /*
     * Deliberately silent, unlike the primary's REQUIRE_REAL_PROVIDERS check. A missing
     * *primary* is dangerous because the deployment keeps answering with stub prose and
     * nothing errors; a missing fallback costs nothing and loses nothing — the queue
     * simply behaves as it did before anyone tried to add one.
     */
    const providers = await resolveProviders(
      envOf({ GOOGLE_AI_API_KEY: 'k', SUMMARY_FALLBACK_PROVIDER: 'anthropic' }),
      noVault().getSecret,
    );

    expect(providers.summary.name).toBe('gemini');
  });
});
