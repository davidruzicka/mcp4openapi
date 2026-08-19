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
  rotateRefreshGrant,
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

  const rotationContext = (storeOpts?: ConstructorParameters<typeof RefreshRotationStore>[0]) => {
    const recordRotation = vi.fn();
    const context = mkContext({ rotationStore: new RefreshRotationStore(storeOpts), recordRotation });
    return { context, recordRotation };
  };

  const issue = (context: RefreshEnvelopeContext, refreshToken: string) =>
    buildClientRefreshToken(context, { access_token: 'idp-access', refresh_token: refreshToken }, 'client-a', identityResolver)!;

  /** perform callback that mints the next rotated envelope and counts exchanges. */
  const performFactory = (context: RefreshEnvelopeContext, nextRefresh: string, exchange: () => void) =>
    async ({ family, newJti }: { family?: { fid: string }; newJti?: string }) => {
      exchange();
      const clientRefreshToken = buildClientRefreshToken(
        context,
        { access_token: 'idp-access', refresh_token: nextRefresh },
        'client-a',
        identityResolver,
        family,
        newJti,
      )!;
      return { refresh_token: clientRefreshToken };
    };

  it('issues a rotated refresh token that differs from the input and carries fid/jti', async () => {
    const { context, recordRotation } = rotationContext();
    const token1 = issue(context, 'idp-refresh-1');
    const exchange = vi.fn();
    const { refresh_token: token2 } = await rotateRefreshGrant(
      context,
      token1,
      'client-a',
      performFactory(context, 'idp-refresh-2', exchange),
    );

    expect(token2).not.toBe(token1);
    const p1 = decryptRefreshEnvelope(token1, KEY, 'default')!;
    const p2 = decryptRefreshEnvelope(token2, KEY, 'default')!;
    expect(p2.fid).toBe(p1.fid); // same family
    expect(p2.jti).not.toBe(p1.jti); // rotated token id
    expect(exchange).toHaveBeenCalledTimes(1);
    expect(recordRotation).toHaveBeenCalledWith('rotated');
  });

  it('rejects a superseded token past the grace window and revokes the whole family', async () => {
    const { context, recordRotation } = rotationContext({ graceMs: 0 });
    const token1 = issue(context, 'idp-refresh-1');
    const { refresh_token: token2 } = await rotateRefreshGrant(
      context,
      token1,
      'client-a',
      performFactory(context, 'idp-refresh-2', vi.fn()),
    );

    // Replaying the (past-grace) superseded token1 is reuse -> invalid_grant + revoke.
    await expect(
      rotateRefreshGrant(context, token1, 'client-a', performFactory(context, 'idp-refresh-x', vi.fn())),
    ).rejects.toThrow(OAuthInvalidGrantError);
    expect(recordRotation).toHaveBeenCalledWith('reuse_detected');
    // The still-active token2 is now dead too (family revoked).
    await expect(
      rotateRefreshGrant(context, token2, 'client-a', performFactory(context, 'idp-refresh-y', vi.fn())),
    ).rejects.toThrow(OAuthInvalidGrantError);
  });

  it('accepts the freshly rotated token on the next legitimate refresh', async () => {
    const { context } = rotationContext();
    const token1 = issue(context, 'idp-refresh-1');
    const { refresh_token: token2 } = await rotateRefreshGrant(
      context,
      token1,
      'client-a',
      performFactory(context, 'idp-refresh-2', vi.fn()),
    );
    // The rotated token is the active one and redeems cleanly.
    await expect(
      rotateRefreshGrant(context, token2, 'client-a', performFactory(context, 'idp-refresh-3', vi.fn())),
    ).resolves.toMatchObject({ refresh_token: expect.any(String) });
  });

  it('retries with the just-superseded token within grace are idempotent, family not revoked (I2a)', async () => {
    const { context, recordRotation } = rotationContext({ graceMs: 30_000 });
    const token1 = issue(context, 'idp-refresh-1');
    const exchange = vi.fn();
    const first = await rotateRefreshGrant(context, token1, 'client-a', performFactory(context, 'idp-refresh-2', exchange));
    // A retry / lost-response resubmission of token1 within grace replays the result.
    const second = await rotateRefreshGrant(context, token1, 'client-a', performFactory(context, 'idp-refresh-should-not-mint', exchange));
    expect(second).toEqual(first); // same already-minted next token
    expect(exchange).toHaveBeenCalledTimes(1); // no second upstream exchange
    expect(recordRotation).not.toHaveBeenCalledWith('reuse_detected');
    // The family is not revoked: the freshly rotated token still redeems.
    await expect(
      rotateRefreshGrant(context, first.refresh_token, 'client-a', performFactory(context, 'idp-refresh-3', vi.fn())),
    ).resolves.toMatchObject({ refresh_token: expect.any(String) });
  });

  it('single-flights concurrent redemption of the same token - one exchange, one new token (I2b)', async () => {
    const { context } = rotationContext();
    const token1 = issue(context, 'idp-refresh-1');
    let exchanges = 0;
    const exchange = () => { exchanges += 1; };
    // Two concurrent redemptions of the same token, neither awaited before the other starts.
    const p1 = rotateRefreshGrant(context, token1, 'client-a', performFactory(context, 'idp-refresh-2', exchange));
    const p2 = rotateRefreshGrant(context, token1, 'client-a', performFactory(context, 'idp-refresh-3', exchange));
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(exchanges).toBe(1); // single upstream exchange
    expect(r2).toEqual(r1); // both callers get the same minted result
    // Exactly one new active token exists (single-active invariant).
    await expect(
      rotateRefreshGrant(context, r1.refresh_token, 'client-a', performFactory(context, 'idp-refresh-4', vi.fn())),
    ).resolves.toMatchObject({ refresh_token: expect.any(String) });
  });

  it('keeps the presented token redeemable after a failed upstream leg', async () => {
    const { context } = rotationContext();
    const token1 = issue(context, 'idp-refresh-1');
    await expect(
      rotateRefreshGrant(context, token1, 'client-a', async () => {
        throw new Error('upstream boom');
      }),
    ).rejects.toThrow('upstream boom');
    // The failed leg released the lease without revoking: token1 redeems on retry.
    await expect(
      rotateRefreshGrant(context, token1, 'client-a', performFactory(context, 'idp-refresh-2', vi.fn())),
    ).resolves.toMatchObject({ refresh_token: expect.any(String) });
  });

  it('client binding and 30-day TTL still enforced on rotated envelopes', async () => {
    const { context } = rotationContext();
    const token1 = issue(context, 'idp-refresh-1');
    // A different client cannot redeem the rotated envelope.
    await expect(
      rotateRefreshGrant(context, token1, 'client-b', performFactory(context, 'idp-refresh-2', vi.fn())),
    ).rejects.toThrow(AuthenticationError);

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
    await expect(
      rotateRefreshGrant(context, stale, 'client-a', performFactory(context, 'idp-refresh-2', vi.fn())),
    ).rejects.toThrow(/could not be verified/);
  });
});
