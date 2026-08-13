import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { describe, expect, it, vi } from 'vitest';
import { OidcIdentityVerifier } from './oidc-identity-verifier.js';
import { JwksCache } from './jwks-cache.js';
import type { Logger } from '../core/logger.js';

const logger = {
  debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
} as unknown as Logger;

function signWith(
  privateKey: CryptoKey,
  issuer: string,
  audience: string | string[],
  claims: Record<string, unknown>,
) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'key-1' })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject('subject-1')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
}

async function fixture() {
  const issuer = 'https://issuer.example.test/tenant/v2.0';
  const audience = 'client-id';
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey);
  const fetchFn = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/.well-known/openid-configuration')) {
      return new Response(JSON.stringify({ issuer, jwks_uri: `${issuer}/jwks` }), { status: 200 });
    }
    if (url.endsWith('/jwks')) {
      return new Response(JSON.stringify({ keys: [{ ...jwk, kid: 'key-1', alg: 'RS256', use: 'sig' }] }), { status: 200 });
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  const ssrfValidator = { validate: vi.fn(async () => undefined) };
  const resolver = createLocalJWKSet({ keys: [{ ...jwk, kid: 'key-1', alg: 'RS256', use: 'sig' }] });
  const jwksCache = {
    getResolver: vi.fn(async () => resolver),
  } as unknown as JwksCache;
  const verifier = new OidcIdentityVerifier({
    issuer,
    audience,
    jwksCache,
    logger,
    fetchFn,
    ssrfValidator: ssrfValidator as never,
  });
  const sign = (claims: Record<string, unknown>) => new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'key-1' })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject('subject-1')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
  return { verifier, sign, privateKey, issuer, audience };
}

describe('OidcIdentityVerifier', () => {
  it('verifies signature, issuer, audience and nonce and prefers Entra oid', async () => {
    const { verifier, sign } = await fixture();
    const token = await sign({ nonce: 'nonce-1', oid: 'object-id', tid: 'tenant-id' });
    await expect(verifier.verify(token, 'nonce-1')).resolves.toEqual({
      subject: 'object-id',
      issuer: 'https://issuer.example.test/tenant/v2.0',
      tenantId: 'tenant-id',
    });
  });

  it('rejects a nonce mismatch', async () => {
    const { verifier, sign } = await fixture();
    const token = await sign({ nonce: 'nonce-1' });
    await expect(verifier.verify(token, 'nonce-2')).rejects.toThrow('nonce validation failed');
  });

  it('rejects a token for another audience', async () => {
    const { verifier, privateKey } = await fixture();
    const token = await new SignJWT({ nonce: 'nonce-1' })
      .setProtectedHeader({ alg: 'RS256', kid: 'key-1' })
      .setIssuedAt()
      .setExpirationTime('5m')
      .setIssuer('https://issuer.example.test/tenant/v2.0')
      .setAudience('other-client')
      .setSubject('subject-1')
      .sign(privateKey);
    await expect(verifier.verify(token, 'nonce-1')).rejects.toThrow();
  });

  it('rejects a multi-audience token without azp', async () => {
    const { verifier, privateKey, issuer, audience } = await fixture();
    const token = await signWith(privateKey, issuer, [audience, 'other-client'], { nonce: 'nonce-1' });
    await expect(verifier.verify(token, 'nonce-1')).rejects.toThrow('authorized party');
  });

  it('rejects a multi-audience token with a mismatched azp', async () => {
    const { verifier, privateKey, issuer, audience } = await fixture();
    const token = await signWith(privateKey, issuer, [audience, 'other-client'], {
      nonce: 'nonce-1',
      azp: 'other-client',
    });
    await expect(verifier.verify(token, 'nonce-1')).rejects.toThrow('authorized party');
  });

  it('accepts a multi-audience token with a matching azp', async () => {
    const { verifier, privateKey, issuer, audience } = await fixture();
    const token = await signWith(privateKey, issuer, [audience, 'other-client'], {
      nonce: 'nonce-1',
      azp: audience,
    });
    await expect(verifier.verify(token, 'nonce-1')).resolves.toMatchObject({ subject: 'subject-1' });
  });

  it('rejects a single-audience token with a mismatched azp', async () => {
    const { verifier, sign } = await fixture();
    const token = await sign({ nonce: 'nonce-1', azp: 'other-client' });
    await expect(verifier.verify(token, 'nonce-1')).rejects.toThrow('authorized party');
  });

  it('accepts a single-element audience array', async () => {
    const { verifier, privateKey, issuer, audience } = await fixture();
    const token = await signWith(privateKey, issuer, [audience], { nonce: 'nonce-1' });
    await expect(verifier.verify(token, 'nonce-1')).resolves.toMatchObject({ subject: 'subject-1' });
  });
});
/**
 * Fixture variant with tweakable discovery, for the failure paths that never
 * reach token verification.
 */
async function discoveryFixture(overrides: {
  discoveryStatus?: number;
  discoveryBody?: unknown;
  fetchError?: Error;
}) {
  const issuer = 'https://issuer.example.test/tenant/v2.0';
  const audience = 'client-id';
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey);
  const fetchFn = vi.fn(async (input: string | URL | Request) => {
    if (overrides.fetchError) throw overrides.fetchError;
    const url = String(input);
    if (url.endsWith('/.well-known/openid-configuration')) {
      return new Response(
        JSON.stringify(overrides.discoveryBody ?? { issuer, jwks_uri: `${issuer}/jwks` }),
        { status: overrides.discoveryStatus ?? 200 },
      );
    }
    return new Response(JSON.stringify({ keys: [{ ...jwk, kid: 'key-1', alg: 'RS256', use: 'sig' }] }), { status: 200 });
  }) as typeof fetch;
  const resolver = createLocalJWKSet({ keys: [{ ...jwk, kid: 'key-1', alg: 'RS256', use: 'sig' }] });
  const verifier = new OidcIdentityVerifier({
    issuer,
    audience,
    jwksCache: { getResolver: vi.fn(async () => resolver) } as unknown as JwksCache,
    logger,
    fetchFn,
    ssrfValidator: { validate: vi.fn(async () => undefined) } as never,
  });
  const token = await signWith(privateKey, issuer, audience, { nonce: 'nonce-1' });
  return { verifier, token };
}

describe('OidcIdentityVerifier subject claim source', () => {
  it('falls back to sub when oid is absent', async () => {
    const { verifier, sign } = await fixture();
    const token = await sign({ nonce: 'nonce-1', tid: 'tenant-id' });
    await expect(verifier.verify(token, 'nonce-1')).resolves.toEqual({
      subject: 'subject-1',
      issuer: 'https://issuer.example.test/tenant/v2.0',
      tenantId: 'tenant-id',
    });
  });

  it('falls back to sub when oid is present but not a string', async () => {
    const { verifier, sign } = await fixture();
    const token = await sign({ nonce: 'nonce-1', oid: 12345 });
    await expect(verifier.verify(token, 'nonce-1')).resolves.toMatchObject({ subject: 'subject-1' });
  });

  it('omits tenantId when tid is absent or not a string', async () => {
    const { verifier, sign } = await fixture();
    const token = await sign({ nonce: 'nonce-1', tid: 99 });
    await expect(verifier.verify(token, 'nonce-1')).resolves.toEqual({
      subject: 'subject-1',
      issuer: 'https://issuer.example.test/tenant/v2.0',
      tenantId: undefined,
    });
  });

  it('rejects a token that carries neither oid nor sub', async () => {
    // One fixture only: a second fixture would generate different key material,
    // so the rejection could come from signature verification instead of the
    // missing-subject check this test is about.
    const { verifier, privateKey, issuer, audience } = await fixture();
    const token = await new SignJWT({ nonce: 'nonce-1' })
      .setProtectedHeader({ alg: 'RS256', kid: 'key-1' })
      .setIssuer(issuer)
      .setAudience(audience)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);

    await expect(verifier.verify(token, 'nonce-1')).rejects.toThrow('missing a subject claim');
  });
});

describe('OidcIdentityVerifier failure paths', () => {
  it('rejects an unsigned token before any network call', async () => {
    const { verifier } = await discoveryFixture({});
    const header = Buffer.from(JSON.stringify({ alg: 'none' }), 'utf8').toString('base64url');
    const payload = Buffer.from(JSON.stringify({ sub: 'subject-1' }), 'utf8').toString('base64url');

    await expect(verifier.verify(`${header}.${payload}.`, 'nonce-1')).rejects.toThrow(
      'unsupported signing algorithm',
    );
  });

  it('rejects a token whose header carries no algorithm', async () => {
    const { verifier } = await discoveryFixture({});
    const header = Buffer.from(JSON.stringify({ typ: 'JWT' }), 'utf8').toString('base64url');
    const payload = Buffer.from(JSON.stringify({ sub: 'subject-1' }), 'utf8').toString('base64url');

    await expect(verifier.verify(`${header}.${payload}.`, 'nonce-1')).rejects.toThrow(
      'unsupported signing algorithm',
    );
  });

  it('fails closed when discovery returns a non-OK status', async () => {
    const { verifier, token } = await discoveryFixture({ discoveryStatus: 500 });
    await expect(verifier.verify(token, 'nonce-1')).rejects.toThrow('OIDC discovery failed');
  });

  it('fails closed when discovery metadata names a different issuer', async () => {
    const { verifier, token } = await discoveryFixture({
      discoveryBody: {
        issuer: 'https://evil.example.test',
        jwks_uri: 'https://issuer.example.test/tenant/v2.0/jwks',
      },
    });
    await expect(verifier.verify(token, 'nonce-1')).rejects.toThrow('discovery metadata is invalid');
  });

  it('fails closed when discovery metadata omits jwks_uri', async () => {
    const { verifier, token } = await discoveryFixture({
      discoveryBody: { issuer: 'https://issuer.example.test/tenant/v2.0' },
    });
    await expect(verifier.verify(token, 'nonce-1')).rejects.toThrow('discovery metadata is invalid');
  });

  it('fails closed when the JWKS endpoint is not on the issuer origin', async () => {
    const { verifier, token } = await discoveryFixture({
      discoveryBody: {
        issuer: 'https://issuer.example.test/tenant/v2.0',
        jwks_uri: 'https://cdn.evil.example/jwks',
      },
    });
    await expect(verifier.verify(token, 'nonce-1')).rejects.toThrow('JWKS endpoint is not trusted');
  });

  it('maps a transport failure to a generic identity error without leaking details', async () => {
    const { verifier, token } = await discoveryFixture({
      fetchError: new TypeError('getaddrinfo ENOTFOUND issuer.example.test'),
    });
    const error = await verifier.verify(token, 'nonce-1').catch((err: unknown) => err as Error);
    expect(error.message).toBe('OIDC identity validation failed');
    expect(error.message).not.toContain('ENOTFOUND');
  });
});
