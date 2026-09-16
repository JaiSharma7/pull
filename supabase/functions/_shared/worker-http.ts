/** The worker's response when providers cannot be resolved before a queue claim. */
export function providerUnavailableResponse(
  error: unknown,
  log: (message: string, error: unknown) => void = console.error,
): Response {
  log('providers unavailable before queue claim', error);
  return new Response(JSON.stringify({ error: 'providers unavailable', claimed: 0 }), {
    status: 503,
    headers: { 'content-type': 'application/json' },
  });
}
