/**
 * Bounded, in-memory rotation state for client-facing refresh tokens.
 *
 * Each rotation chain is a "family". A family tracks exactly one active token
 * (`activeJti`); every successful refresh mints a new jti and supersedes the
 * previous one. Presenting a superseded (already-rotated) jti is reuse: the
 * family is revoked so its still-active token dies too (OAuth 2.1 §4.3.1,
 * Security BCP §4.14.2 - a replay revokes the family).
 *
 * Redemption is an idempotent single-flight keyed by (family, presented jti):
 *   - a concurrent redemption of the still-active jti (real-client retry /
 *     double-submit) awaits the leader's in-flight rotation instead of running a
 *     second upstream exchange, so exactly one new token is minted (single-active
 *     invariant preserved);
 *   - a retry of the just-superseded jti within a short grace window returns the
 *     already-minted next token instead of revoking the family (a lost rotation
 *     response must not force whole-family re-auth);
 *   - an OLDER / foreign superseded jti (not active and not the just-superseded
 *     one within grace) still revokes the family - genuine reuse detection is
 *     unchanged.
 *
 * State is deliberately process-local and bounded (TTL + max families + LRU
 * eviction), mirroring the other in-memory OAuth stores. Revoked-family markers
 * live in a SEPARATE bounded set that the family LRU cap never evicts, so a
 * family that has ever been revoked can never silently downgrade to
 * trust-on-first-use while its marker is retained (replay stays closed even
 * under family-cap pressure).
 *
 * Zero I/O, no timers - expiry is checked lazily on access.
 */

import { randomUUID } from 'node:crypto';
import { OAuthInvalidGrantError } from '../core/errors.js';
import { REFRESH_IDENTITY_TTL_MS } from './token-envelope.js';

export interface RefreshRotationStoreOptions {
  /** Max tracked rotation families before LRU eviction. */
  maxFamilies?: number;
  /** How long a family entry is retained. */
  ttlMs?: number;
  /**
   * Idempotency grace window: how long the just-superseded jti still redeems to
   * the already-minted next token instead of revoking the family. Bounds a
   * real-client retry / lost-response double-submit.
   */
  graceMs?: number;
  /**
   * Max retained revoked-family markers before LRU eviction of the oldest
   * marker. Independent of the family cap so a burst of new families never
   * drops a tombstone that still guards against replay.
   */
  maxRevokedFamilies?: number;
}

/**
 * A rotation lease handed to the single caller allowed to run the upstream
 * exchange for a given redemption. The caller mints the new envelope with
 * `newJti`, then calls `commit` (publishes the result to concurrent/retried
 * redemptions and advances the family) or `fail` (releases the lease so the
 * presented jti stays redeemable after an upstream failure).
 */
export interface RefreshRotationLease<T> {
  /** The new jti to embed in the freshly minted refresh envelope. */
  readonly newJti: string;
  /** Publish the successful rotation result and advance the family. */
  commit(result: T): void;
  /** Release the in-flight lease after a failed upstream leg (retryable). */
  fail(error: unknown): void;
}

/**
 * Outcome of `beginRotation`. `lease` is returned to the leader that must run
 * the upstream exchange; `replay` resolves to the leader's result for a
 * concurrent or grace-window retry - the follower must NOT run its own exchange.
 */
export type RefreshRedemption<T> =
  | { kind: 'lease'; lease: RefreshRotationLease<T> }
  | { kind: 'replay'; result: Promise<T> };

interface FamilyEntry {
  activeJti: string;
  expiresAt: number;
  /** In-flight rotation for `pendingJti`, awaited by concurrent redemptions. */
  pending?: Promise<unknown>;
  pendingJti?: string;
  /** The just-superseded jti and its already-minted result, within the grace TTL. */
  grace?: { prevJti: string; result: unknown; expiresAt: number };
}

/**
 * Default family cap. One family ~= one active refresh chain (one client
 * session), so this bounds tracked chains, not tokens - rotation updates a
 * family in place rather than adding entries.
 */
export const DEFAULT_REFRESH_ROTATION_MAX_FAMILIES = 10_000;

/** Default idempotency grace window for a just-superseded jti (30 seconds). */
export const DEFAULT_REFRESH_ROTATION_GRACE_MS = 30_000;

export class RefreshRotationStore {
  private readonly maxFamilies: number;
  private readonly ttlMs: number;
  private readonly graceMs: number;
  private readonly maxRevokedFamilies: number;
  private readonly families = new Map<string, FamilyEntry>();
  /** Revoked-family markers (key -> expiresAt). Never evicted by the family LRU cap. */
  private readonly revoked = new Map<string, number>();

  constructor(options: RefreshRotationStoreOptions = {}) {
    this.maxFamilies = options.maxFamilies ?? DEFAULT_REFRESH_ROTATION_MAX_FAMILIES;
    this.ttlMs = options.ttlMs ?? REFRESH_IDENTITY_TTL_MS;
    this.graceMs = options.graceMs ?? DEFAULT_REFRESH_ROTATION_GRACE_MS;
    this.maxRevokedFamilies = options.maxRevokedFamilies ?? this.maxFamilies;
  }

  /**
   * Begin an idempotent, single-flight redemption of `(key, jti)`.
   *
   *  - revoked family (tombstone retained)      -> throw invalid_grant (reuse)
   *  - concurrent redemption of the pending jti -> replay (await the leader)
   *  - just-superseded jti within grace         -> replay (already-minted result)
   *  - active jti / unknown / expired family    -> lease (leader runs the exchange)
   *  - older / foreign superseded jti           -> revoke the family, throw invalid_grant
   *
   * The active jti is advanced only in `commit`, after the upstream exchange, so
   * a failed leg (`fail`) leaves the presented jti redeemable and retryable.
   */
  beginRotation<T>(key: string, jti: string): RefreshRedemption<T> {
    const now = Date.now();
    this.evictExpired(now);

    if (this.isRevoked(key, now)) {
      throw new OAuthInvalidGrantError('Refresh token rotation chain was revoked');
    }

    const entry = this.families.get(key);
    if (entry && entry.expiresAt > now) {
      if (entry.pending && entry.pendingJti === jti) {
        return { kind: 'replay', result: entry.pending as Promise<T> };
      }
      if (entry.grace && entry.grace.prevJti === jti && entry.grace.expiresAt > now) {
        return { kind: 'replay', result: Promise.resolve(entry.grace.result as T) };
      }
      if (entry.activeJti !== jti) {
        // A superseded / foreign jti outside the grace window: genuine reuse.
        this.revoke(key, now);
        throw new OAuthInvalidGrantError('Refresh token has been superseded (reuse detected)');
      }
      // Active jti with no in-flight rotation: this caller becomes the leader.
    }

    return this.lease<T>(key, jti, entry && entry.expiresAt > now ? entry : undefined, now);
  }

  size(): number {
    return this.families.size;
  }

  /** Number of retained revoked-family markers (test/introspection aid). */
  revokedSize(): number {
    return this.revoked.size;
  }

  private lease<T>(key: string, jti: string, existing: FamilyEntry | undefined, now: number): RefreshRedemption<T> {
    const newJti = randomUUID();
    let resolveFn!: (value: T) => void;
    let rejectFn!: (error: unknown) => void;
    const promise = new Promise<T>((resolve, reject) => {
      resolveFn = resolve;
      rejectFn = reject;
    });
    // A leader with no concurrent follower must not surface an unhandled rejection.
    promise.catch(() => {});

    const leaderEntry: FamilyEntry = existing ?? { activeJti: jti, expiresAt: now + this.ttlMs };
    leaderEntry.pending = promise;
    leaderEntry.pendingJti = jti;
    this.store(key, leaderEntry);

    let settled = false;
    const lease: RefreshRotationLease<T> = {
      newJti,
      commit: (result: T) => {
        if (settled) return;
        settled = true;
        const at = Date.now();
        if (this.isRevoked(key, at)) {
          // A concurrent reuse revoked the family during the exchange: fail closed.
          const revokedError = new OAuthInvalidGrantError('Refresh token rotation chain was revoked');
          rejectFn(revokedError);
          throw revokedError;
        }
        const entry = this.families.get(key) ?? leaderEntry;
        entry.activeJti = newJti;
        entry.expiresAt = at + this.ttlMs;
        entry.grace = { prevJti: jti, result, expiresAt: at + this.graceMs };
        if (entry.pendingJti === jti) {
          entry.pending = undefined;
          entry.pendingJti = undefined;
        }
        this.store(key, entry);
        resolveFn(result);
      },
      fail: (error: unknown) => {
        if (settled) return;
        settled = true;
        const entry = this.families.get(key);
        if (entry && entry.pendingJti === jti) {
          entry.pending = undefined;
          entry.pendingJti = undefined;
          this.store(key, entry);
        }
        rejectFn(error);
      },
    };
    return { kind: 'lease', lease };
  }

  private revoke(key: string, now: number): void {
    this.families.delete(key);
    this.revoked.delete(key);
    this.revoked.set(key, now + this.ttlMs);
    this.evictRevokedOverflow();
  }

  private isRevoked(key: string, now: number): boolean {
    const expiresAt = this.revoked.get(key);
    if (expiresAt === undefined) return false;
    if (expiresAt <= now) {
      this.revoked.delete(key);
      return false;
    }
    return true;
  }

  /** Insert or replace, moving the key to the most-recently-used position. */
  private store(key: string, entry: FamilyEntry): void {
    this.families.delete(key);
    this.families.set(key, entry);
    this.evictOverflow();
  }

  private evictExpired(now: number): void {
    for (const [key, entry] of this.families) {
      if (entry.expiresAt <= now) {
        this.families.delete(key);
      }
    }
    for (const [key, expiresAt] of this.revoked) {
      if (expiresAt <= now) {
        this.revoked.delete(key);
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

  private evictRevokedOverflow(): void {
    while (this.revoked.size > this.maxRevokedFamilies) {
      const oldestKey = this.revoked.keys().next().value;
      if (oldestKey === undefined) break;
      this.revoked.delete(oldestKey);
    }
  }
}
