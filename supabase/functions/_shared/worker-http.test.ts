import { describe, expect, it, vi } from 'vitest';
import { providerUnavailableResponse } from './worker-http.ts';

describe('providerUnavailableResponse', () => {
  it('logs provider details but returns only the generic public error', async () => {
    const cause = new Error('GOOGLE_AI_API_KEY missing at /srv/provider.ts:12');
    const log = vi.fn();

    const response = providerUnavailableResponse(cause, log);

    expect(log).toHaveBeenCalledWith('providers unavailable before queue claim', cause);
    expect(response.status).toBe(503);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({
      error: 'providers unavailable',
      claimed: 0,
    });
  });
});
