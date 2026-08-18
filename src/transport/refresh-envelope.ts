/**
 * Client-facing refresh token issuance and redemption for the HTTP transport.
 *
 * Pure functions of their inputs: HttpTransport passes a small context object
 * (profile id, consent flag, token keys, logger) plus an optional typed
 * identity resolver, so both directions of the refresh envelope flow are
 * testable without a transport instance.
 */

import { randomUUID } from 'node:crypto';
import type { OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { Logger } from '../core/logger.js';
import type { OidcIdentity } from '../auth/oidc-identity-verifier.js';
import { AuthenticationError, OAuthInvalidGrantError } from '../core/errors.js';
import { pseudonymizeSubject } from '../auth/observability-pseudonym.js';
import type { RefreshRotationStore } from '../auth/refresh-rotation-store.js';
import {
  assertRefreshEnvelopeClientBinding,
  decryptRefreshEnvelope,
  encryptRefreshEnvelope,
  isRefreshEnvelope,
} from '../auth/token-envelope.js';

/**
 * Resolves the verified OIDC identity bound to an IdP access token, or
 * undefined when the provider has none. Typed replacement for the former
 * `typeof getIdentity === 'function'` duck typing on the OAuth provider.
 */
export type AccessTokenIdentityResolver = (accessToken: string) => OidcIdentity | undefined;

/** Observable rotation events (fed to metrics/logging). */
export type RefreshRotationEvent = 'rotated' | 'reuse_detected';

/** A rotation chain reference threaded from redemption to re-issuance. */
export interface RefreshFamily {
  fid: string;
}

/** Per-profile inputs both refresh envelope directions depend on. */
export interface RefreshEnvelopeContext {
  profileId: string;
  /** True when the profile declares `consent_gate.required`. */
  consentRequired: boolean;
  /** 32-byte envelope key; undefined in plain-token mode. */
  tokenKey?: Buffer;
  /** Legacy SHA-256 KDF fallback key for pre-scrypt envelopes. */
  legacyTokenKey?: Buffer;
  /**
   * Bounded rotation state (OAuth 2.1 §4.3.1). Undefined disables rotation
   * tracking (plain-token mode / tests) - envelopes are still issued, just not
   * reuse-tracked.
   */
  rotationStore?: RefreshRotationStore;
  /** Observability sink; invoked on rotation and reuse detection. */
  recordRotation?: (event: RefreshRotationEvent) => void;
  logger: Logger;
}

/** Namespaced rotation-store key: fid is random, profileId keeps chains disjoint. */
function familyKey(profileId: string, fid: string): string {
  return `${profileId}:${fid}`;
}

/**
 * Wrap the IdP refresh token in an encrypted envelope carrying the verified
 * identity.
 *
 * Without this, a direct token-endpoint `refresh_token` grant after a restart
 * has no way to recover who the human was: the provider's in-process identity
 * map is empty, so the refreshed token would carry no principal at all. The
 * envelope is keyed and AAD-bound to the profile, so it cannot be replayed
 * across profiles or presented as an access token.
 *
 * Returns the original refresh token unchanged when no key is configured;
 * consent-gated profiles require the key at startup, so that path applies to
 * non-consent profiles only.
 */
export function buildClientRefreshToken(
  context: RefreshEnvelopeContext,
  tokens: OAuthTokens,
  clientId: string,
  resolveIdentity: AccessTokenIdentityResolver | undefined,
  previousFamily?: RefreshFamily,
): string | undefined {
  if (!tokens.refresh_token) return undefined;
  if (!context.tokenKey) return tokens.refresh_token;

  const identity = resolveIdentity && tokens.access_token
    ? resolveIdentity(tokens.access_token)
    : undefined;

  // Rotation (OAuth 2.1 §4.3.1): every issuance mints a fresh jti; the family id
  // is inherited across a refresh chain and freshly minted on initial issuance.
  const fid = previousFamily?.fid ?? randomUUID();
  const jti = randomUUID();

  try {
    const envelope = encryptRefreshEnvelope(
      {
        v: 1,
        rt: tokens.refresh_token,
        cid: clientId,
        sub: identity?.subject,
        iss: identity?.issuer,
        tid: identity?.tenantId,
        pid: context.profileId,
        iat: Date.now(),
        fid,
        jti,
      },
      context.tokenKey,
    );
    // Commit the rotation only after the envelope was minted. rotate() throws
    // (OAuthInvalidGrantError) when the family was revoked by a concurrent reuse,
    // which fails the exchange closed rather than resurrecting a dead chain.
    context.rotationStore?.rotate(familyKey(context.profileId, fid), jti);
    context.recordRotation?.('rotated');
    context.logger.info('Client refresh token rotated', {
      profileId: context.profileId,
      subjectHash: identity?.subject ? pseudonymizeSubject(identity.subject) : undefined,
    });
    return envelope;
  } catch (err) {
    if (err instanceof OAuthInvalidGrantError) throw err;
    if (context.consentRequired) {
      // A raw IdP refresh token carries no identity binding: on a consent-gated
      // profile resolveRefreshGrant would deterministically reject it later,
      // and the raw IdP credential would leak into client storage. Fail the
      // exchange instead so the client re-runs OAuth.
      context.logger.error(
        'Refresh envelope encryption failed on a consent-gated profile - failing token exchange',
        err instanceof Error ? err : new Error(String(err)),
        { profileId: context.profileId },
      );
      throw new AuthenticationError('Refresh token issuance failed for a consent-gated profile');
    }
    context.logger.warn('Refresh envelope encryption failed - returning plain refresh token', {
      profileId: context.profileId,
      error: err instanceof Error ? err.message : String(err),
    });
    return tokens.refresh_token;
  }
}

/**
 * Resolve a client-presented refresh token into the IdP refresh token plus the
 * verified identity it was issued to.
 *
 * A consent-gated profile refuses a refresh token that carries no identity:
 * accepting it would mint a session whose principal is unknown, which the gate
 * would then have to block on every call with no way for the user to recover.
 * Failing the grant makes the client re-run OAuth instead.
 *
 * `presentingClientId` is the validated client_id of the caller; an envelope
 * minted for another client is rejected so its verified identity cannot be
 * inherited (AuthenticationError maps to 400 invalid_grant in the handler).
 */
export function resolveRefreshGrant(
  context: RefreshEnvelopeContext,
  presentedToken: string,
  presentingClientId: string,
): { refreshToken: string; identity?: OidcIdentity; family?: RefreshFamily } {
  if (context.tokenKey && isRefreshEnvelope(presentedToken)) {
    const payload = decryptRefreshEnvelope(
      presentedToken,
      context.tokenKey,
      context.profileId,
      context.legacyTokenKey,
    );
    if (!payload) {
      throw new AuthenticationError('Refresh token envelope could not be verified');
    }
    assertRefreshEnvelopeClientBinding(payload, presentingClientId);
    const identity = payload.sub && payload.iss
      ? { subject: payload.sub, issuer: payload.iss, tenantId: payload.tid }
      : undefined;
    if (context.consentRequired && !identity) {
      throw new AuthenticationError('Refresh token carries no verified identity for a consent-gated profile');
    }
    // Reuse detection (OAuth 2.1 §4.3.1). Only rotation-tagged envelopes are
    // tracked; legacy envelopes (no fid/jti) pass through and are reissued as
    // rotating ones. The check runs before the upstream call so a replayed token
    // never reaches the IdP, and it fails closed (invalid_grant) on reuse.
    const family = payload.fid && payload.jti ? { fid: payload.fid } : undefined;
    if (family && payload.jti && context.rotationStore) {
      const status = context.rotationStore.redeem(familyKey(context.profileId, family.fid), payload.jti);
      if (status === 'reuse') {
        context.recordRotation?.('reuse_detected');
        context.logger.warn('Refresh token reuse detected - rotation chain revoked', {
          profileId: context.profileId,
          subjectHash: payload.sub ? pseudonymizeSubject(payload.sub) : undefined,
        });
        throw new OAuthInvalidGrantError('Refresh token has been superseded (reuse detected)');
      }
    }
    return { refreshToken: payload.rt, identity, ...(family ? { family } : {}) };
  }

  if (context.consentRequired) {
    throw new AuthenticationError('Consent-gated profile requires an identity-bearing refresh token');
  }
  return { refreshToken: presentedToken };
}
