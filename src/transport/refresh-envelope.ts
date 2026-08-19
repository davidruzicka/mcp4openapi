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
  jtiOverride?: string,
): string | undefined {
  if (!tokens.refresh_token) return undefined;
  if (!context.tokenKey) return tokens.refresh_token;

  const identity = resolveIdentity && tokens.access_token
    ? resolveIdentity(tokens.access_token)
    : undefined;

  // Rotation (OAuth 2.1 §4.3.1): every issuance mints a fresh jti; the family id
  // is inherited across a refresh chain and freshly minted on initial issuance.
  // On a rotating refresh grant the jti is assigned by the rotation lease so the
  // store can advance the family to the same id; initial issuance mints its own.
  const fid = previousFamily?.fid ?? randomUUID();
  const jti = jtiOverride ?? randomUUID();

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
    context.recordRotation?.('rotated');
    context.logger.info('Client refresh token rotated', {
      profileId: context.profileId,
      subjectHash: identity?.subject ? pseudonymizeSubject(identity.subject) : undefined,
    });
    return envelope;
  } catch (err) {
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
export interface ResolvedRefreshGrant {
  refreshToken: string;
  identity?: OidcIdentity;
  family?: RefreshFamily;
  /** Presented rotation token id; drives the single-flight redemption key. */
  jti?: string;
}

export function resolveRefreshGrant(
  context: RefreshEnvelopeContext,
  presentedToken: string,
  presentingClientId: string,
): ResolvedRefreshGrant {
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
    // Only rotation-tagged envelopes are reuse-tracked; legacy envelopes (no
    // fid/jti) pass through and are reissued as rotating ones. Reuse detection
    // and the single-flight run in rotateRefreshGrant once the family/jti are
    // resolved here, so a replayed token never reaches the IdP.
    const family = payload.fid && payload.jti ? { fid: payload.fid } : undefined;
    return {
      refreshToken: payload.rt,
      identity,
      ...(family ? { family } : {}),
      ...(payload.jti ? { jti: payload.jti } : {}),
    };
  }

  if (context.consentRequired) {
    throw new AuthenticationError('Consent-gated profile requires an identity-bearing refresh token');
  }
  return { refreshToken: presentedToken };
}

/**
 * Orchestrate a client-facing refresh grant with idempotent, single-flight
 * rotation (OAuth 2.1 §4.3.1).
 *
 * Decrypts and validates the presented token, then coordinates redemption
 * through the rotation store: a concurrent or grace-window-retried redemption of
 * the same token replays the leader's result (no second upstream exchange, no
 * spurious family revocation), while genuine reuse of an older/foreign
 * superseded jti revokes the family and fails closed (invalid_grant).
 *
 * `perform` runs the upstream exchange and mints the response; it receives the
 * lease-assigned `newJti` to embed in the new refresh envelope (pass it to
 * `buildClientRefreshToken`). It runs exactly once per rotation.
 */
export async function rotateRefreshGrant<T>(
  context: RefreshEnvelopeContext,
  presentedToken: string,
  presentingClientId: string,
  perform: (grant: ResolvedRefreshGrant & { newJti?: string }) => Promise<T>,
): Promise<T> {
  const grant = resolveRefreshGrant(context, presentedToken, presentingClientId);
  const store = context.rotationStore;
  if (!store || !grant.family || !grant.jti) {
    // Untracked (plain / legacy / no store): no rotation coordination needed.
    return perform(grant);
  }

  const key = familyKey(context.profileId, grant.family.fid);
  let redemption;
  try {
    redemption = store.beginRotation<T>(key, grant.jti);
  } catch (err) {
    if (err instanceof OAuthInvalidGrantError) {
      context.recordRotation?.('reuse_detected');
      context.logger.warn('Refresh token reuse detected - rotation chain revoked', {
        profileId: context.profileId,
        subjectHash: grant.identity?.subject ? pseudonymizeSubject(grant.identity.subject) : undefined,
      });
    }
    throw err;
  }

  if (redemption.kind === 'replay') {
    return redemption.result;
  }

  const { lease } = redemption;
  try {
    const result = await perform({ ...grant, newJti: lease.newJti });
    lease.commit(result);
    return result;
  } catch (err) {
    lease.fail(err);
    throw err;
  }
}
