import { afterEach, describe, expect, it, vi } from 'vitest';
import { exportJWK, generateKeyPair } from 'jose';
import { JwksCache } from './jwks-cache.js';
import { ConsoleLogger } from '../core/logger.js';

const logger = new ConsoleLogger();

describe('jwks-cache', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.MCP4_SSRF_ALLOW_PRIVATE_NETWORK;
    vi.restoreAllMocks();
  });

  it('reuses cached JWKS responses', async () => {
    const { publicKey } = await generateKeyPair('RS256');
    const jwk = await exportJWK(publicKey);
    jwk.kid = 'kid-1';
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200 }) as Response);
    global.fetch = fetchSpy;
    process.env.MCP4_SSRF_ALLOW_PRIVATE_NETWORK = 'true';

    const cache = new JwksCache({ maxCachedIssuers: 2, refreshTimeoutMs: 1000, refreshBackoffMs: 0 }, logger);
    await cache.getResolver('https://127.0.0.1', 'https://127.0.0.1/jwks', 'kid-1');
    await cache.getResolver('https://127.0.0.1', 'https://127.0.0.1/jwks', 'kid-1');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
