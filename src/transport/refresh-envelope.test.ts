/**
 * Unit tests for the pure refresh envelope functions.
 *
 * Covers both directions (issuance and redemption) including the consent-gated
 * failure modes: no degrade to raw IdP refresh tokens, client binding, and the
 * identity requirement.
 */

import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../core/logger.js';
import { AuthenticationError } from '../core/errors.js';
import { decryptRefreshEnvelope, encryptRefreshEnvelope } from '../auth/token-envelope.js';
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
