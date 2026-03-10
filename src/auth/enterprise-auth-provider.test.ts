import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { EnterpriseAuthProvider } from './enterprise-auth-provider.js';
import { EnterpriseReplayStore } from './enterprise-replay-store.js';
import { JwksCache } from './jwks-cache.js';
import { ConsoleLogger } from '../core/logger.js';

const logger = new ConsoleLogger();

describe('enterprise-auth-provider', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    process.env.MCP4_SSRF_ALLOW_PRIVATE_NETWORK = 'true';
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.MCP4_SSRF_ALLOW_PRIVATE_NETWORK;
  });

  it('accepts a valid signed enterprise assertion', async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const publicJwk = await exportJWK(publicKey);
    publicJwk.kid = 'kid-1';
    global.fetch = async () => new Response(JSON.stringify({ keys: [publicJwk] }), { status: 200 }) as Response;

    const assertion = await new SignJWT({ sub: 'user-1', scope: 'api', client_id: 'client-1', tenant_id: 'tenant-a' })
      .setProtectedHeader({ alg: 'RS256', kid: 'kid-1', typ: 'at+jwt' })
      .setIssuer('https://127.0.0.1')
      .setAudience('https://resource.example/mcp')
      .setIssuedAt()
      .setExpirationTime('5m')
      .setJti('jti-1')
      .sign(privateKey);

    const provider = new EnterpriseAuthProvider({
      profileId: 'profile-a',
      config: {
        enabled: true,
        mode: 'required',
        resource: 'https://resource.example/mcp',
        issuer: { issuer: 'https://127.0.0.1', jwks_uri: 'https://127.0.0.1/jwks', allowed_algs: ['RS256'] },
        token_exchange: { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', required_typ: ['at+jwt'], required_claims: ['sub'] },
      },
      jwksCache: new JwksCache({ maxCachedIssuers: 4, refreshTimeoutMs: 5000, refreshBackoffMs: 0 }, logger),
      replayStore: new EnterpriseReplayStore({ maxEntries: 10 }),
      logger,
    });

    const principal = await provider.validateAssertion(assertion, 'client-1');
    expect(principal.subject).toBe('user-1');
    expect(principal.profileId).toBe('profile-a');
    expect(principal.scopes).toContain('api');
  });

  it('rejects replayed assertions', async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const publicJwk = await exportJWK(publicKey);
    publicJwk.kid = 'kid-1';
    global.fetch = async () => new Response(JSON.stringify({ keys: [publicJwk] }), { status: 200 }) as Response;

    const assertion = await new SignJWT({ sub: 'user-1' })
      .setProtectedHeader({ alg: 'RS256', kid: 'kid-1', typ: 'at+jwt' })
      .setIssuer('https://127.0.0.1')
      .setAudience('https://resource.example/mcp')
      .setIssuedAt()
      .setExpirationTime('5m')
      .setJti('same-jti')
      .sign(privateKey);

    const provider = new EnterpriseAuthProvider({
      profileId: 'profile-a',
      config: {
        enabled: true,
        resource: 'https://resource.example/mcp',
        issuer: { issuer: 'https://127.0.0.1', jwks_uri: 'https://127.0.0.1/jwks', allowed_algs: ['RS256'] },
        token_exchange: { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', required_typ: ['at+jwt'] },
      },
      jwksCache: new JwksCache({ maxCachedIssuers: 4, refreshTimeoutMs: 5000, refreshBackoffMs: 0 }, logger),
      replayStore: new EnterpriseReplayStore({ maxEntries: 10 }),
      logger,
    });

    await provider.validateAssertion(assertion, 'client-1');
    await expect(provider.validateAssertion(assertion, 'client-1')).rejects.toThrow(/replay/i);
  });
});
