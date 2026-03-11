import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { HttpTransport } from './http-transport.js';
import { ConsoleLogger } from '../core/logger.js';

const logger = new ConsoleLogger();

describe('HttpTransport enterprise authorization', () => {
  let transport: HttpTransport;
  let app: Express;
  let privateKey: CryptoKey;
  let publicJwk: Record<string, unknown>;
  const originalFetch = global.fetch;

  beforeEach(async () => {
    process.env.NODE_ENV = 'test';
    process.env.MCP4_SSRF_ALLOW_PRIVATE_NETWORK = 'true';
    const keys = await generateKeyPair('RS256');
    privateKey = keys.privateKey;
    publicJwk = await exportJWK(keys.publicKey);
    publicJwk.kid = 'kid-1';
    global.fetch = async () => new Response(JSON.stringify({ keys: [publicJwk] }), { status: 200 }) as Response;

    transport = new HttpTransport({
      host: '127.0.0.1',
      port: 0,
      sessionTimeoutMs: 1800000,
      heartbeatEnabled: false,
      heartbeatIntervalMs: 30000,
      metricsEnabled: false,
      metricsPath: '/metrics',
      profileRoutingEnabled: true,
    }, logger);
    transport.setProfileContextProvider(async (profileId) => ({
      profileId,
      enterpriseAuthorization: {
        enabled: true,
        mode: 'required',
        resource: `https://resource.example/${profileId}/mcp`,
        issuer: { issuer: 'https://127.0.0.1', jwks_uri: 'https://127.0.0.1/jwks', allowed_algs: ['RS256'] },
        token_exchange: { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', required_typ: ['at+jwt'], required_claims: ['sub'] },
        access_policy: { scopes_supported: ['api'], default_scopes: ['api'] },
      },
    }));
    transport.setMessageHandler(async (message) => ({ jsonrpc: '2.0', id: (message as { id?: number }).id ?? 1, result: { ok: true } }));
    app = (transport as any).app;
  });

  afterEach(async () => {
    global.fetch = originalFetch;
    delete process.env.MCP4_SSRF_ALLOW_PRIVATE_NETWORK;
    await transport.stop();
  });

  async function createAssertion(audience: string, jti: string): Promise<string> {
    return new SignJWT({ sub: 'user-1', scope: 'api' })
      .setProtectedHeader({ alg: 'RS256', kid: 'kid-1', typ: 'at+jwt' })
      .setIssuer('https://127.0.0.1')
      .setAudience(audience)
      .setIssuedAt()
      .setExpirationTime('5m')
      .setJti(jti)
      .sign(privateKey);
  }

  it('mints enterprise bearer tokens from jwt bearer grant', async () => {
    const assertion = await createAssertion('https://resource.example/alpha/mcp', 'jti-1');
    const response = await request(app)
      .post('/profile/alpha/oauth/token')
      .type('form')
      .send({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion, client_id: 'client-1' });

    expect(response.status).toBe(200);
    expect(response.body.token_type).toBe('Bearer');
    expect(response.body.access_token).toBeTruthy();
    expect(response.body.access_token).not.toContain('.');
  });

  it('rejects grant confusion parameters for enterprise token exchange', async () => {
    const assertion = await createAssertion('https://resource.example/alpha/mcp', 'jti-2');
    const response = await request(app)
      .post('/profile/alpha/oauth/token')
      .type('form')
      .send({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion, code: 'unexpected' });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('invalid_request');
  });

  it('rejects enterprise tokens on a different profile route', async () => {
    const assertion = await createAssertion('https://resource.example/alpha/mcp', 'jti-3');
    const tokenResponse = await request(app)
      .post('/profile/alpha/oauth/token')
      .type('form')
      .send({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion });

    const response = await request(app)
      .post('/profile/bravo/mcp')
      .set('Authorization', `Bearer ${tokenResponse.body.access_token}`)
      .set('Accept', 'application/json')
      .send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' } } });

    expect(response.status).toBe(401);
    expect(String(response.body.message)).toContain('Enterprise authorization required');
  });

  it('normalizes enterprise runtime config defaults and overrides', () => {
    const config = (transport as any).resolveEnterpriseRuntimeConfig({
      global_max_enterprise_tokens: 12,
      enterprise_grant_rate_limit_max: 3,
    });

    expect(config.enabled).toBe(true);
    expect(config.global_max_enterprise_tokens).toBe(12);
    expect(config.enterprise_grant_rate_limit_max).toBe(3);
    expect(config.enterprise_grant_max_concurrency_per_profile).toBe(4);
  });

  it('enforces enterprise grant rate and concurrency limits and releases counters', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const limitedTransport = new HttpTransport({
      host: '127.0.0.1',
      port: 0,
      sessionTimeoutMs: 1800000,
      heartbeatEnabled: false,
      heartbeatIntervalMs: 30000,
      metricsEnabled: false,
      metricsPath: '/metrics',
      profileRoutingEnabled: true,
      enterpriseAuthorizationRuntimeConfig: {
        enterprise_grant_rate_limit_max: 1,
        enterprise_grant_rate_limit_window_ms: 60_000,
        enterprise_grant_max_concurrency_per_profile: 1,
      },
    }, logger);

    expect(() => (limitedTransport as any).enforceEnterpriseGrantRateLimit('alpha')).not.toThrow();
    expect(() => (limitedTransport as any).enforceEnterpriseGrantRateLimit('alpha')).toThrow(/rate limit exceeded/i);

    expect(() => (limitedTransport as any).acquireEnterpriseGrantConcurrency('alpha')).not.toThrow();
    expect(() => (limitedTransport as any).acquireEnterpriseGrantConcurrency('alpha')).toThrow(/concurrency limit exceeded/i);

    (limitedTransport as any).releaseEnterpriseGrantConcurrency('alpha');
    expect((limitedTransport as any).enterpriseGrantConcurrencyByProfile.has('alpha')).toBe(false);
  });
});
