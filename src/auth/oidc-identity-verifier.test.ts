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