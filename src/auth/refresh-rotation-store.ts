/**
 * Bounded, in-memory rotation state for client-facing refresh tokens.
 *
 * Each rotation chain is a "family". A family tracks exactly one active token
 * (`activeJti`); every successful refresh mints a new jti and supersedes the
 * previous one. Presenting a superseded (already-rotated) jti is reuse: the
 * family is revoked so its still-active token dies too (OAuth 2.1 §4.3.1,
 * Security BCP §4.14.2 - a replay revokes the family).
 *
 * State is deliberately process-local and bounded (TTL + max families + LRU
 * eviction), mirroring the other in-memory OAuth stores. Consequences:
 *   - Restart resets all families. A client's latest envelope is accepted on
 *     first use (trust-on-first-use) and re-establishes its family, so
 *     restart-recovery is preserved. A token superseded *before* the restart is
 *     also accepted once after the restart (the chain cannot be reconstructed);
 *     this is the same restart caveat the encrypted-envelope format already
 *     documents.
 *   - Under memory pressure a least-recently-used family may be evicted early,
 *     re-opening trust-on-first-use for that chain. Bounded memory is preferred
 *     over unbounded growth; the cap is generous relative to active sessions.
 *
 * Zero I/O, no timers - expiry is checked lazily on access.
 */

import { OAuthInvalidGrantError } from '../core/errors.js';
import { REFRESH_IDENTITY_TTL_MS } from './token-envelope.js';

/** Outcome of presenting a `(family, jti)` pair for redemption. */
export type RefreshRedeemStatus = 'accepted' | 'reuse';

export interface RefreshRotationStoreOptions {
  /** Max tracked rotation families before LRU eviction. */
  maxFamilies?: number;
  /** How long a family entry (active or revoked tombstone) is retained. */
  ttlMs?: number;
}

interface FamilyEntry {
  activeJti: string;
  expiresAt: number;
  /** Tombstone: once true the whole chain is dead and every jti is rejected. */
  revoked: boolean;
}

/**
 * Default family cap. One family ~= one active refresh chain (one client
 * session), so this bounds tracked chains, not tokens - rotation updates a
 * family in place rather than adding entries.
 */
export const DEFAULT_REFRESH_ROTATION_MAX_FAMILIES = 10_000;

export class RefreshRotationStore {
  private readonly maxFamilies: number;
  private readonly ttlMs: number;
  private readonly families = new Map<string, FamilyEntry>();

  constructor(options: RefreshRotationStoreOptions = {}) {
    this.maxFamilies = options.maxFamilies ?? DEFAULT_REFRESH_ROTATION_MAX_FAMILIES;
    this.ttlMs = options.ttlMs ?? REFRESH_IDENTITY_TTL_MS;
  }

  /**
   * Validate a presented `(family, jti)`. Does NOT advance the active jti -
   * rotation is deferred to `rotate()` after the upstream exchange succeeds, so a
   * failed upstream leg leaves the active token intact and retryable.
   *
   *  - unknown / expired family -> trust-on-first-use (register jti active) -> 'accepted'
   *  - matches active jti        -> 'accepted' (LRU bump)
   *  - superseded jti / revoked  -> revoke the family (tombstone) -> 'reuse'
   */
  redeem(key: string, jti: string): RefreshRedeemStatus {
    const now = Date.now();
    this.evictExpired(now);

    const entry = this.families.get(key);
    if (!entry || entry.expiresAt <= now) {
      this.store(key, { activeJti: jti, expiresAt: now + this.ttlMs, revoked: false });
      return 'accepted';
    }
    if (entry.revoked) {
      return 'reuse';
    }
    if (entry.activeJti === jti) {
      this.touch(key, entry);
      return 'accepted';
    }
    // A superseded jti was presented: the chain is compromised. Revoke it so the
    // currently-active token is rejected on its next use as well.
    entry.revoked = true;
    entry.expiresAt = now + this.ttlMs;
    this.touch(key, entry);
    return 'reuse';
  }

  /**
   * Commit a rotation after a successful upstream exchange: `newJti` becomes the
   * sole active token in the family. Creates the family when absent (initial
   * issuance, which never calls `redeem`). Throws when the family was revoked by
   * a concurrent reuse so a dead chain is never resurrected (fail closed).
   */
  rotate(key: string, newJti: string): void {
    const now = Date.now();
    const entry = this.families.get(key);
    if (entry && entry.revoked && entry.expiresAt > now) {
      throw new OAuthInvalidGrantError('Refresh token rotation chain was revoked');
    }
    this.store(key, { activeJti: newJti, expiresAt: now + this.ttlMs, revoked: false });
  }

  size(): number {
    return this.families.size;
  }

  /** Insert or replace, moving the key to the most-recently-used position. */
  private store(key: string, entry: FamilyEntry): void {
    this.families.delete(key);
    this.families.set(key, entry);
    this.evictOverflow();
  }

  /** Move an existing key to the most-recently-used position. */
  private touch(key: string, entry: FamilyEntry): void {
    this.families.delete(key);
    this.families.set(key, entry);
  }

  private evictExpired(now: number): void {
    for (const [key, entry] of this.families) {
      if (entry.expiresAt <= now) {
        this.families.delete(key);
      }
    }
  }

  private evictOverflow(): void {
    while (this.families.size > this.maxFamilies) {
      const oldestKey = this.families.keys().next().value;
      if (oldestKey === undefined) break;
      this.families.delete(oldestKey);
    }
  }
}
