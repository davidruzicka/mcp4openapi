import { afterEach, describe, expect, it, vi } from 'vitest';
import { exportJWK, generateKeyPair } from 'jose';
import { JwksCache } from './jwks-cache.js';
import { ConsoleLogger } from '../core/logger.js';
import { EnterpriseIssuerDiscoveryError } from '../core/errors.js';

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

    const cache = new JwksCache({ maxCachedIssuers: 2, maxCachedKeys: 8, refreshTimeoutMs: 1000, refreshBackoffMs: 0 }, logger);
    await cache.getResolver('https://127.0.0.1', 'https://127.0.0.1/jwks', 'kid-1');
    await cache.getResolver('https://127.0.0.1', 'https://127.0.0.1/jwks', 'kid-1');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('throws when the requested key id is not present after refresh', async () => {
    const { publicKey } = await generateKeyPair('RS256');
    const jwk = await exportJWK(publicKey);
    jwk.kid = 'kid-1';
    global.fetch = async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200 }) as Response;
    process.env.MCP4_SSRF_ALLOW_PRIVATE_NETWORK = 'true';

    const cache = new JwksCache({ maxCachedIssuers: 2, maxCachedKeys: 8, refreshTimeoutMs: 1000, refreshBackoffMs: 0 }, logger);

    await expect(cache.getResolver('https://127.0.0.1', 'https://127.0.0.1/jwks', 'kid-2')).rejects.toBeInstanceOf(EnterpriseIssuerDiscoveryError);
  });

  it('reuses a fresh cached entry during refresh backoff windows', async () => {
    const { publicKey } = await generateKeyPair('RS256');
    const jwk = await exportJWK(publicKey);
    jwk.kid = 'kid-1';
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200 }) as Response);
    global.fetch = fetchSpy;
    process.env.MCP4_SSRF_ALLOW_PRIVATE_NETWORK = 'true';
    const nowSpy = vi.spyOn(Date, 'now');
    nowSpy.mockReturnValue(10_000);

    const cache = new JwksCache({
      maxCachedIssuers: 2,
      maxCachedKeys: 8,
      refreshTimeoutMs: 1000,
      refreshBackoffMs: 5_000,
      cacheTtlMs: 60_000,
    }, logger);

    await cache.getResolver('https://127.0.0.1', 'https://127.0.0.1/jwks', 'kid-1');
    nowSpy.mockReturnValue(11_000);
    await cache.getResolver('https://127.0.0.1', 'https://127.0.0.1/jwks');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('shares inflight refresh requests for the same issuer', async () => {
    const { publicKey } = await generateKeyPair('RS256');
    const jwk = await exportJWK(publicKey);
    jwk.kid = 'kid-1';
    let releaseFetch!: () => void;
    const pendingFetch = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    const fetchSpy = vi.fn(async () => {
      await pendingFetch;
      return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 }) as Response;
    });
    global.fetch = fetchSpy;
    process.env.MCP4_SSRF_ALLOW_PRIVATE_NETWORK = 'true';

    const cache = new JwksCache({ maxCachedIssuers: 2, maxCachedKeys: 8, refreshTimeoutMs: 1000, refreshBackoffMs: 0 }, logger);

    const first = cache.getResolver('https://127.0.0.1', 'https://127.0.0.1/jwks', 'kid-1');
    const second = cache.getResolver('https://127.0.0.1', 'https://127.0.0.1/jwks', 'kid-1');
    releaseFetch();

    await Promise.all([first, second]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('rejects oversized JWKS responses', async () => {
    const oversized = JSON.stringify({ keys: [{ kty: 'RSA', kid: 'kid-1', n: 'a'.repeat(270_000), e: 'AQAB' }] });
    global.fetch = async () => new Response(oversized, { status: 200 }) as Response;
    process.env.MCP4_SSRF_ALLOW_PRIVATE_NETWORK = 'true';

    const cache = new JwksCache({ maxCachedIssuers: 2, maxCachedKeys: 8, refreshTimeoutMs: 1000, refreshBackoffMs: 0 }, logger);

    await expect(cache.getResolver('https://127.0.0.1', 'https://127.0.0.1/jwks')).rejects.toThrow(/size limit/i);
  });

  it('rejects non-success JWKS responses and payloads without keys', async () => {
    process.env.MCP4_SSRF_ALLOW_PRIVATE_NETWORK = 'true';
    const cache = new JwksCache({ maxCachedIssuers: 2, maxCachedKeys: 8, refreshTimeoutMs: 1000, refreshBackoffMs: 0 }, logger);

    global.fetch = async () => new Response('bad gateway', { status: 502 }) as Response;
    await expect(cache.getResolver('https://127.0.0.1', 'https://127.0.0.1/jwks')).rejects.toThrow(/failed to fetch enterprise jwks/i);

    global.fetch = async () => new Response(JSON.stringify({ keys: [] }), { status: 200 }) as Response;
    await expect(cache.getResolver('https://127.0.0.2', 'https://127.0.0.2/jwks')).rejects.toThrow(/did not include keys/i);
  });

  it('evicts oldest issuers when cache capacity is exceeded', async () => {
    const { publicKey } = await generateKeyPair('RS256');
    const jwk = await exportJWK(publicKey);
    jwk.kid = 'kid-1';
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200 }) as Response);
    global.fetch = fetchSpy;
    process.env.MCP4_SSRF_ALLOW_PRIVATE_NETWORK = 'true';

    const cache = new JwksCache({ maxCachedIssuers: 1, maxCachedKeys: 8, refreshTimeoutMs: 1000, refreshBackoffMs: 0 }, logger);

    await cache.getResolver('https://127.0.0.1', 'https://127.0.0.1/jwks', 'kid-1');
    await cache.getResolver('https://127.0.0.2', 'https://127.0.0.2/jwks', 'kid-1');
    await cache.getResolver('https://127.0.0.1', 'https://127.0.0.1/jwks', 'kid-1');

    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('stops issuer eviction cleanly even when configured with a negative issuer capacity', async () => {
    const { publicKey } = await generateKeyPair('RS256');
    const jwk = await exportJWK(publicKey);
    jwk.kid = 'kid-1';
    global.fetch = async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200 }) as Response;
    process.env.MCP4_SSRF_ALLOW_PRIVATE_NETWORK = 'true';

    const cache = new JwksCache({ maxCachedIssuers: -1, maxCachedKeys: 8, refreshTimeoutMs: 1000, refreshBackoffMs: 0 }, logger);

    await expect(cache.getResolver('https://127.0.0.1', 'https://127.0.0.1/jwks', 'kid-1')).resolves.toBeTypeOf('function');
    expect((cache as any).issuers.size).toBe(0);
  });
});
