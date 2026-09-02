/**
 * Which model each BAML client pins.
 *
 * The sidecar reports the client that answered (`LlmCall.clientName`), not the
 * model string, and `job_steps.model` has to name the model or provenance is
 * fiction. This is the crossing, written once and asserted against
 * `clients.baml` by `clients.test.ts` so it cannot drift from the file it
 * mirrors.
 */
export const CLIENT_MODELS: Record<string, string> = {
  GeminiFlash: 'gemini-3.6-flash',
  GeminiFlashPrevious: 'gemini-3.7-flash',
  AnthropicHaiku: 'claude-haiku-4-5-20251001',
};

/** The model behind a client, or the client name when it is not a single model. */
export function modelOf(client: string | undefined): string {
  if (!client) return 'baml';
  return CLIENT_MODELS[client] ?? client;
}
