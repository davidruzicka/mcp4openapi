import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { EnterpriseAuthProvider } from './enterprise-auth-provider.js';
import { EnterpriseReplayStore } from './enterprise-replay-store.js';
import { JwksCache } from './jwks-cache.js';
import { ConsoleLogger } from '../core/logger.js';
import {
  EnterpriseIssuerDiscoveryError,
  EnterprisePolicyViolationError,
  EnterpriseTokenValidationError,
} from '../core/errors.js';

const logger = new ConsoleLogger();

describe('enterprise-auth-provider', () => {
  const originalFetch = global.fetch;

  async function createSigningMaterial() {
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const publicJwk = await exportJWK(publicKey);
    publicJwk.kid = 'kid-1';

    return { privateKey, publicJwk };
  }

  function createProvider(overrides?: Partial<ConstructorParameters<typeof EnterpriseAuthProvider>[0]['config']>) {
    return new EnterpriseAuthProvider({
      profileId: 'profile-a',
      config: {
        enabled: true,
        resource: 'https://resource.example/mcp',
        issuer: { issuer: 'https://127.0.0.1', jwks_uri: 'https://127.0.0.1/jwks', allowed_algs: ['RS256'] },
        token_exchange: { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', required_typ: ['at+jwt'] },
        ...overrides,
      },
      jwksCache: new JwksCache({ maxCachedIssuers: 4, maxCachedKeys: 8, refreshTimeoutMs: 5000, refreshBackoffMs: 0 }, logger),
      replayStore: new EnterpriseReplayStore({ maxEntries: 10 }),
      logger,
      ssrfValidator: new (class SSRFValidator { validate = vi.fn().mockResolvedValue(undefined); })() as any,
    });
  }

  async function createAssertion(
    privateKey: CryptoKey,
    claims: Record<string, unknown> = { sub: 'user-1' },
    header: Record<string, string> = { alg: 'RS256', kid: 'kid-1', typ: 'at+jwt' }
  ): Promise<string> {
    return new SignJWT(claims)
      .setProtectedHeader(header)
      .setIssuer('https://127.0.0.1')
      .setAudience('https://resource.example/mcp')
      .setIssuedAt()
      .setExpirationTime('5m')
      .setJti(`jti-${Math.random()}`)
      .sign(privateKey);
  }

  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    process.env.MCP4_SSRF_ALLOW_PRIVATE_NETWORK = 'true';
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.MCP4_SSRF_ALLOW_PRIVATE_NETWORK;
  });

  it('accepts a valid signed enterprise assertion', async () => {
    const { privateKey, publicJwk } = await createSigningMaterial();
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
      jwksCache: new JwksCache({ maxCachedIssuers: 4, maxCachedKeys: 8, refreshTimeoutMs: 5000, refreshBackoffMs: 0 }, logger),
      replayStore: new EnterpriseReplayStore({ maxEntries: 10 }),
      logger,
      ssrfValidator: new (class SSRFValidator { validate = vi.fn().mockResolvedValue(undefined); })() as any,
    });

    const principal = await provider.validateAssertion(assertion, 'client-1');
    expect(principal.subject).toBe('user-1');
    expect(principal.profileId).toBe('profile-a');
    expect(principal.scopes).toContain('api');
  });

  it('rejects replayed assertions', async () => {
    const { privateKey, publicJwk } = await createSigningMaterial();
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
      jwksCache: new JwksCache({ maxCachedIssuers: 4, maxCachedKeys: 8, refreshTimeoutMs: 5000, refreshBackoffMs: 0 }, logger),
      replayStore: new EnterpriseReplayStore({ maxEntries: 10 }),
      logger,
      ssrfValidator: new (class SSRFValidator { validate = vi.fn().mockResolvedValue(undefined); })() as any,
    });

    await provider.validateAssertion(assertion, 'client-1');
    await expect(provider.validateAssertion(assertion, 'client-1')).rejects.toThrow(/replay/i);
  });

  it('accepts assertions matching any configured required typ value', async () => {
    const { privateKey, publicJwk } = await createSigningMaterial();
    global.fetch = async () => new Response(JSON.stringify({ keys: [publicJwk] }), { status: 200 }) as Response;

    const assertion = await new SignJWT({ sub: 'user-1', scope: 'api' })
      .setProtectedHeader({ alg: 'RS256', kid: 'kid-1', typ: 'enterprise+jwt' })
      .setIssuer('https://127.0.0.1')
      .setAudience('https://resource.example/mcp')
      .setIssuedAt()
      .setExpirationTime('5m')
      .setJti('jti-2')
      .sign(privateKey);

    const provider = new EnterpriseAuthProvider({
      profileId: 'profile-a',
      config: {
        enabled: true,
        resource: 'https://resource.example/mcp',
        issuer: { issuer: 'https://127.0.0.1', jwks_uri: 'https://127.0.0.1/jwks', allowed_algs: ['RS256'] },
        token_exchange: {
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          required_typ: ['at+jwt', 'enterprise+jwt'],
        },
      },
      jwksCache: new JwksCache({ maxCachedIssuers: 4, maxCachedKeys: 8, refreshTimeoutMs: 5000, refreshBackoffMs: 0 }, logger),
      replayStore: new EnterpriseReplayStore({ maxEntries: 10 }),
      logger,
      ssrfValidator: new (class SSRFValidator { validate = vi.fn().mockResolvedValue(undefined); })() as any,
    });

    const principal = await provider.validateAssertion(assertion, 'client-1');
    expect(principal.subject).toBe('user-1');
  });

  it('rejects missing client identifiers when dynamic registration is disabled', async () => {
    const { privateKey, publicJwk } = await createSigningMaterial();
    global.fetch = async () => new Response(JSON.stringify({ keys: [publicJwk] }), { status: 200 }) as Response;
    const assertion = await new SignJWT({ sub: 'user-1' })
      .setProtectedHeader({ alg: 'RS256', kid: 'kid-1', typ: 'at+jwt' })
      .setIssuer('https://127.0.0.1')
      .setAudience('https://resource.example/mcp')
      .setIssuedAt()
      .setExpirationTime('5m')
      .setJti('jti-policy-1')
      .sign(privateKey);

    const provider = createProvider({
      token_exchange: {
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        required_typ: ['at+jwt'],
        allowed_client_ids: ['client-1'],
      },
      access_policy: { allow_dynamic_client_registration: false },
    });

    await expect(provider.validateAssertion(assertion)).rejects.toBeInstanceOf(EnterprisePolicyViolationError);
  });

  it('rejects assertions missing required claims', async () => {
    const { privateKey, publicJwk } = await createSigningMaterial();
    global.fetch = async () => new Response(JSON.stringify({ keys: [publicJwk] }), { status: 200 }) as Response;
    const assertion = await new SignJWT({ sub: 'user-1' })
      .setProtectedHeader({ alg: 'RS256', kid: 'kid-1', typ: 'at+jwt' })
      .setIssuer('https://127.0.0.1')
      .setAudience('https://resource.example/mcp')
      .setIssuedAt()
      .setExpirationTime('5m')
      .setJti('jti-claims-1')
      .sign(privateKey);

    const provider = createProvider({
      token_exchange: {
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        required_typ: ['at+jwt'],
        required_claims: ['tenant_id'],
      },
    });

    await expect(provider.validateAssertion(assertion, 'client-1')).rejects.toBeInstanceOf(EnterpriseTokenValidationError);
  });

  it('uses discovery metadata when jwks_uri is not configured explicitly', async () => {
    const { privateKey, publicJwk } = await createSigningMaterial();
    global.fetch = async (input) => {
      const url = String(input);
      if (url.endsWith('/.well-known/openid-configuration')) {
        return new Response(JSON.stringify({ issuer: 'https://127.0.0.1', jwks_uri: 'https://127.0.0.1/discovery-jwks' }), { status: 200 }) as Response;
      }
      return new Response(JSON.stringify({ keys: [publicJwk] }), { status: 200 }) as Response;
    };
    const assertion = await new SignJWT({ sub: 'user-1' })
      .setProtectedHeader({ alg: 'RS256', kid: 'kid-1', typ: 'at+jwt' })
      .setIssuer('https://127.0.0.1')
      .setAudience('https://resource.example/mcp')
      .setIssuedAt()
      .setExpirationTime('5m')
      .setJti('jti-discovery-1')
      .sign(privateKey);

    const provider = createProvider({
      issuer: { issuer: 'https://127.0.0.1', allowed_algs: ['RS256'], trust_mode: 'discovery' },
    });

    const principal = await provider.validateAssertion(assertion, 'client-1');
    expect(principal.subject).toBe('user-1');
  });

  it('rejects assertions that exceed the configured size limit', async () => {
    const provider = createProvider({
      token_exchange: {
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        required_typ: ['at+jwt'],
        max_assertion_size_bytes: 4,
      },
    });

    await expect(provider.validateAssertion('12345', 'client-1')).rejects.toThrow(/size limit/i);
  });

  it('rejects unsupported algorithms, unsigned assertions, and disallowed key ids', async () => {
    const unsupportedAlg = `${Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'at+jwt' })).toString('base64url')}.${Buffer.from('{}').toString('base64url')}.sig`;
    const unsigned = `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'at+jwt' })).toString('base64url')}.${Buffer.from('{}').toString('base64url')}.sig`;
    const disallowedKid = `${Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'unexpected', typ: 'at+jwt' })).toString('base64url')}.${Buffer.from('{}').toString('base64url')}.sig`;

    await expect(createProvider().validateAssertion(unsupportedAlg, 'client-1')).rejects.toThrow(/unsupported signing algorithm/i);
    await expect(createProvider({ issuer: { issuer: 'https://127.0.0.1', jwks_uri: 'https://127.0.0.1/jwks', allowed_algs: ['none', 'RS256'] } }).validateAssertion(unsigned, 'client-1')).rejects.toThrow(/unsigned enterprise assertions/i);
    await expect(createProvider({ issuer: { issuer: 'https://127.0.0.1', jwks_uri: 'https://127.0.0.1/jwks', allowed_algs: ['RS256'], allowed_kids: ['kid-1'] } }).validateAssertion(disallowedKid, 'client-1')).rejects.toThrow(/key id is not allowed/i);
  });

  it('rejects clients outside the allowed enterprise token exchange list', async () => {
    const { privateKey, publicJwk } = await createSigningMaterial();
    global.fetch = async () => new Response(JSON.stringify({ keys: [publicJwk] }), { status: 200 }) as Response;
    const assertion = await createAssertion(privateKey);

    await expect(
      createProvider({
        token_exchange: {
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          required_typ: ['at+jwt'],
          allowed_client_ids: ['client-1'],
        },
      }).validateAssertion(assertion, 'client-2')
    ).rejects.toBeInstanceOf(EnterprisePolicyViolationError);

    await expect(
      createProvider({
        token_exchange: {
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          required_typ: ['at+jwt'],
          allowed_client_ids: ['client-1'],
        },
        access_policy: { allow_dynamic_client_registration: false },
      }).validateAssertion(assertion, 'client-2')
    ).rejects.toBeInstanceOf(EnterprisePolicyViolationError);
  });

  it('maps jose expiration failures to enterprise token validation errors', async () => {
    const { privateKey, publicJwk } = await createSigningMaterial();
    global.fetch = async () => new Response(JSON.stringify({ keys: [publicJwk] }), { status: 200 }) as Response;
    const assertion = await new SignJWT({ sub: 'user-1' })
      .setProtectedHeader({ alg: 'RS256', kid: 'kid-1', typ: 'at+jwt' })
      .setIssuer('https://127.0.0.1')
      .setAudience('https://resource.example/mcp')
      .setIssuedAt(Math.floor(Date.now() / 1000) - 600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 300)
      .setJti('expired-jti')
      .sign(privateKey);

    await expect(createProvider().validateAssertion(assertion, 'client-1')).rejects.toThrow(/validation failed/i);
  });

  it('maps unexpected verifier failures to enterprise token validation errors', async () => {
    const { privateKey } = await createSigningMaterial();
    const assertion = await createAssertion(privateKey);
    const provider = new EnterpriseAuthProvider({
      profileId: 'profile-a',
      config: {
        enabled: true,
        resource: 'https://resource.example/mcp',
        issuer: { issuer: 'https://127.0.0.1', jwks_uri: 'https://127.0.0.1/jwks', allowed_algs: ['RS256'] },
        token_exchange: { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', required_typ: ['at+jwt'] },
      },
      jwksCache: { getResolver: vi.fn(async () => async () => { throw new Error('boom'); }) } as unknown as JwksCache,
      replayStore: new EnterpriseReplayStore({ maxEntries: 10 }),
      logger,
      ssrfValidator: new (class SSRFValidator { validate = vi.fn().mockResolvedValue(undefined); })() as any,
    });

    await expect(provider.validateAssertion(assertion, 'client-1')).rejects.toThrow('Enterprise assertion validation failed');
  });

  it('rejects discovery responses without jwks_uri or with failing status codes', async () => {
    const provider = createProvider({
      issuer: { issuer: 'https://127.0.0.1', allowed_algs: ['RS256'], trust_mode: 'discovery' },
    });

    global.fetch = async () => new Response('not found', { status: 404 }) as Response;
    await expect(provider['resolveJwksUri']()).rejects.toThrow(/failed to resolve issuer discovery metadata/i);

    global.fetch = async () => new Response(JSON.stringify({ issuer: 'https://127.0.0.1' }), { status: 200 }) as Response;
    await expect(provider['resolveJwksUri']()).rejects.toThrow(/did not include jwks_uri/i);
  });

  it('rejects mismatched discovery issuer metadata', async () => {
    global.fetch = async () => new Response(JSON.stringify({ issuer: 'https://unexpected.example', jwks_uri: 'https://127.0.0.1/jwks' }), { status: 200 }) as Response;
    const provider = createProvider({
      issuer: { issuer: 'https://127.0.0.1', allowed_algs: ['RS256'], trust_mode: 'discovery' },
    });

    await expect(provider['resolveJwksUri']()).rejects.toBeInstanceOf(EnterpriseIssuerDiscoveryError);
  });

  it('rejects assertions with invalid typ headers or missing sub claims', async () => {
    const { privateKey, publicJwk } = await createSigningMaterial();
    global.fetch = async () => new Response(JSON.stringify({ keys: [publicJwk] }), { status: 200 }) as Response;

    const wrongTypAssertion = await createAssertion(privateKey, { sub: 'user-1' }, { alg: 'RS256', kid: 'kid-1', typ: 'wrong+jwt' });
    const missingSubAssertion = await createAssertion(privateKey, { tenant_id: 'tenant-a' });

    await expect(createProvider().validateAssertion(wrongTypAssertion, 'client-1')).rejects.toThrow(/typ header is not allowed/i);
    await expect(createProvider({ token_exchange: { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', required_typ: ['at+jwt'], required_claims: [] } }).validateAssertion(missingSubAssertion, 'client-1')).rejects.toThrow(/missing sub claim/i);
  });
});
