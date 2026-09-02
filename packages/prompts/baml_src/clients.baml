// The two vendors this repository actually calls, and nothing else.
//
// `baml init` scaffolds a dozen providers. Every one of them is a credential name
// a reader of this file has to check against law 7, so the ones we do not use are
// deleted rather than commented out — a commented client is still a client
// somebody will uncomment.
//
// Keys are read from the process environment by name. BAML never sees a literal,
// and these names are the same ones `supabase/functions/_shared/config.ts`
// resolves, so a deployment configures one set of variables rather than two.

/// Primary. Matches DEFAULT_SUMMARY_MODELS[0] in `_shared/gemini.ts`.
client<llm> GeminiFlash {
  provider google-ai
  retry_policy Exponential
  options {
    model "gemini-3.6-flash"
    api_key env.GOOGLE_AI_API_KEY
  }
}

/// Second in the Gemini chain. The newest Flash returns 503 under load often
/// enough that a pipeline pinned to it stalls — the same reasoning that made
/// `DEFAULT_SUMMARY_MODELS` a list rather than a string.
client<llm> GeminiFlashPrevious {
  provider google-ai
  retry_policy Exponential
  options {
    model "gemini-3.7-flash"
    api_key env.GOOGLE_AI_API_KEY
  }
}

/// Cross-vendor fallback. Matches DEFAULT_SUMMARY_MODEL in `_shared/anthropic.ts`.
client<llm> AnthropicHaiku {
  provider anthropic
  retry_policy Exponential
  options {
    model "claude-haiku-4-5-20251001"
    api_key env.ANTHROPIC_API_KEY
  }
}

/// What generation functions should name.
///
/// The order mirrors `createFallbackSummaryProvider`: exhaust the Gemini model
/// chain before paying a second vendor. It is not identical, and the difference
/// matters — that function falls through only on `ProviderUnavailableError`,
/// because a billed failure must reach `cost_ledger` rather than be retried
/// elsewhere. BAML's fallback has no such notion, so anything routed through
/// here still has to meter each attempt itself. See docs/baml.md.
client<llm> SummaryChain {
  provider fallback
  options {
    strategy [GeminiFlash, GeminiFlashPrevious, AnthropicHaiku]
  }
}

retry_policy Exponential {
  max_retries 2
  strategy {
    type exponential_backoff
    delay_ms 300
    multiplier 1.5
    max_delay_ms 10000
  }
}
