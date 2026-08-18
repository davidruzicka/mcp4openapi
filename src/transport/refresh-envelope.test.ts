/**
 * Unit tests for the pure refresh envelope functions.
 *
 * Covers both directions (issuance and redemption) including the consent-gated
 * failure modes: no degrade to raw IdP refresh tokens, client binding, and the
 * identity requirement.
 */

import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../core/logger.js';
import { AuthenticationError, OAuthInvalidGrantError } from '../core/errors.js';
import { decryptRefreshEnvelope, encryptRefreshEnvelope } from '../auth/token-envelope.js';
import { RefreshRotationStore } from '../auth/refresh-rotation-store.js';
import {
  buildClientRefreshToken,
  resolveRefreshGrant,
  type RefreshEnvelopeContext,
} from './refresh-envelope.js';

const KEY = Buffer.from('c'.repeat(64), 'hex');
const ISSUER = 'https://issuer.example';

const mkLogger = (): Logger => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
});

const mkContext = (overrides: Partial<RefreshEnvelopeContext> = {}): RefreshEnvelopeContext => ({
  profileId: 'default',
  consentRequired: false,
  tokenKey: KEY,
  logger: mkLogger(),
  ...overrides,
});

describe('buildClientRefreshToken', () => {
  it('returns undefined without a refresh token and the raw token without a key', () => {
    expect(buildClientRefreshToken(mkContext(), { access_token: 'at' }, 'c1', undefined)).toBeUndefined();
    expect(
      buildClientRefreshToken(mkContext({ tokenKey: undefined }), { access_token: 'at', refresh_token: 'rt' }, 'c1', undefined),
    ).toBe('rt');
  });

  it('issues an identity-bearing envelope via the typed identity resolver', () => {
    const token = buildClientRefreshToken(
      mkContext(),
      { access_token: 'idp-access', refresh_token: 'idp-refresh' },
      'client-1',
      (accessToken) => (accessToken === 'idp-access' ? { subject: 'person-1', issuer: ISSUER, tenantId: 't1' } : undefined),
    );

    expect(decryptRefreshEnvelope(token!, KEY, 'default')).toMatchObject({
      rt: 'idp-refresh',
      cid: 'client-1',
      sub: 'person-1',
      iss: ISSUER,
      tid: 't1',
    });
  });

  it('fails the exchange on a consent-gated profile when encryption fails (no raw-token degrade)', () => {
    const context = mkContext({ consentRequired: true, tokenKey: Buffer.alloc(16, 1) });
    expect(() =>
      buildClientRefreshToken(context, { access_token: 'at', refresh_token: 'rt' }, 'c1', undefined),
    ).toThrow(AuthenticationError);
    expect(context.logger.error).toHaveBeenCalled();
  });

  it('degrades to the raw refresh token on a non-consent profile when encryption fails', () => {
    const context = mkContext({ tokenKey: Buffer.alloc(16, 1) });
    expect(buildClientRefreshToken(context, { access_token: 'at', refresh_token: 'rt' }, 'c1', undefined)).toBe('rt');
    expect(context.logger.warn).toHaveBeenCalled();
  });
});

describe('resolveRefreshGrant', () => {
  const envelopeWithIdentity = encryptRefreshEnvelope(
    { v: 1, rt: 'idp-rt', cid: 'client-a', sub: 'person-a', iss: ISSUER, tid: 't1', pid: 'default', iat: Date.now() },
    KEY,
  );

  it('returns the IdP refresh token and identity for the issuing client', () => {
    expect(resolveRefreshGrant(mkContext(), envelopeWithIdentity, 'client-a')).toEqual({
      refreshToken: 'idp-rt',
      identity: { subject: 'person-a', issuer: ISSUER, tenantId: 't1' },
    });
  });

  it('rejects redemption by a different client (identity must not be inherited)', () => {
    expect(() => resolveRefreshGrant(mkContext(), envelopeWithIdentity, 'client-b')).toThrow(AuthenticationError);
    expect(() => resolveRefreshGrant(mkContext(), envelopeWithIdentity, '')).toThrow(AuthenticationError);
  });

  it('rejects an undecryptable envelope', () => {
    const foreign = encryptRefreshEnvelope(
      { v: 1, rt: 'idp-rt', cid: 'client-a', pid: 'other-profile', iat: Date.now() },
      KEY,
    );
    expect(() => resolveRefreshGrant(mkContext(), foreign, 'client-a')).toThrow(/could not be verified/);
  });

  it('rejects an identity-less envelope and a plain token on a consent-gated profile', () => {
    const anonymous = encryptRefreshEnvelope(
      { v: 1, rt: 'idp-rt', cid: 'client-a', pid: 'default', iat: Date.now() },
      KEY,
    );
    const context = mkContext({ consentRequired: true });

    expect(() => resolveRefreshGrant(context, anonymous, 'client-a')).toThrow(/no verified identity/);
    expect(() => resolveRefreshGrant(context, 'plain-refresh', 'client-a')).toThrow(/identity-bearing refresh token/);
  });

  it('passes a plain refresh token through on a non-consent profile', () => {
    expect(resolveRefreshGrant(mkContext(), 'plain-refresh', 'client-a')).toEqual({ refreshToken: 'plain-refresh' });
    expect(resolveRefreshGrant(mkContext({ tokenKey: undefined }), 'plain-refresh', 'client-a')).toEqual({
      refreshToken: 'plain-refresh',
    });
  });
});

describe('refresh token rotation (OAuth 2.1 §4.3.1)', () => {
  const identityResolver = (accessToken: string) =>
    accessToken === 'idp-access' ? { subject: 'person-1', issuer: ISSUER, tenantId: 't1' } : undefined;

  const rotationContext = () => {
    const recordRotation = vi.fn();
    const context = mkContext({ rotationStore: new RefreshRotationStore(), recordRotation });
    return { context, recordRotation };
  };

  it('issues a rotated refresh token that differs from the input and carries fid/jti', () => {
    const { context, recordRotation } = rotationContext();
    const token1 = buildClientRefreshToken(
      context,
      { access_token: 'idp-access', refresh_token: 'idp-refresh-1' },
      'client-a',
      identityResolver,
    )!;

    const grant = resolveRefreshGrant(context, token1, 'client-a');
    expect(grant.family?.fid).toBeDefined();

    const token2 = buildClientRefreshToken(
      context,
      { access_token: 'idp-access', refresh_token: 'idp-refresh-2' },
      'client-a',
      identityResolver,
      grant.family,
    )!;

    expect(token2).not.toBe(token1);
    const p1 = decryptRefreshEnvelope(token1, KEY, 'default')!;
    const p2 = decryptRefreshEnvelope(token2, KEY, 'default')!;
    expect(p2.fid).toBe(p1.fid); // same family
    expect(p2.jti).not.toBe(p1.jti); // rotated token id
    expect(recordRotation).toHaveBeenCalledWith('rotated');
  });

  it('rejects the superseded token after rotation and revokes the whole family', () => {
    const { context, recordRotation } = rotationContext();
    const token1 = buildClientRefreshToken(
      context,
      { access_token: 'idp-access', refresh_token: 'idp-refresh-1' },
      'client-a',
      identityResolver,
    )!;
    const grant = resolveRefreshGrant(context, token1, 'client-a');
    const token2 = buildClientRefreshToken(
      context,
      { access_token: 'idp-access', refresh_token: 'idp-refresh-2' },
      'client-a',
      identityResolver,
      grant.family,
    )!;

    // Replaying the superseded token1 is reuse -> invalid_grant + family revoked.
    expect(() => resolveRefreshGrant(context, token1, 'client-a')).toThrow(OAuthInvalidGrantError);
    expect(recordRotation).toHaveBeenCalledWith('reuse_detected');
    // The still-active token2 is now dead too (family revoked).
    expect(() => resolveRefreshGrant(context, token2, 'client-a')).toThrow(OAuthInvalidGrantError);
  });

  it('accepts the freshly rotated token on the next legitimate refresh', () => {
    const { context } = rotationContext();
    const token1 = buildClientRefreshToken(
      context,
      { access_token: 'idp-access', refresh_token: 'idp-refresh-1' },
      'client-a',
      identityResolver,
    )!;
    const grant1 = resolveRefreshGrant(context, token1, 'client-a');
    const token2 = buildClientRefreshToken(
      context,
      { access_token: 'idp-access', refresh_token: 'idp-refresh-2' },
      'client-a',
      identityResolver,
      grant1.family,
    )!;
    // The rotated token is the active one and redeems cleanly.
    expect(() => resolveRefreshGrant(context, token2, 'client-a')).not.toThrow();
  });

  it('client binding and 30-day TTL still enforced on rotated envelopes', () => {
    const { context } = rotationContext();
    const token1 = buildClientRefreshToken(
      context,
      { access_token: 'idp-access', refresh_token: 'idp-refresh-1' },
      'client-a',
      identityResolver,
    )!;
    // A different client cannot redeem the rotated envelope.
    expect(() => resolveRefreshGrant(context, token1, 'client-b')).toThrow(AuthenticationError);

    // An envelope past the 30-day identity TTL no longer decrypts.
    const stale = encryptRefreshEnvelope(
      {
        v: 1,
        rt: 'idp-refresh',
        cid: 'client-a',
        pid: 'default',
        iat: Date.now() - 31 * 24 * 60 * 60 * 1000,
        fid: 'fam-x',
        jti: 'jti-x',
      },
      KEY,
    );
    expect(() => resolveRefreshGrant(context, stale, 'client-a')).toThrow(/could not be verified/);
  });
});
