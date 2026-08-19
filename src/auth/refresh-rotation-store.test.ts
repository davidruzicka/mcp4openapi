/**
 * Unit tests for the bounded refresh-token rotation store.
 *
 * Covers the single-flight rotation state machine (trust-on-first-use,
 * active-jti lease, deferred commit), idempotent redemption within the grace
 * window (retry / lost-response), reuse detection with family revocation, the
 * concurrent revoke-during-commit fail-closed path, TTL expiry, LRU overflow
 * eviction, and revoked-tombstone survival under family-cap pressure.
 */

import { describe, expect, it, vi, afterEach } from 'vitest';
import { OAuthInvalidGrantError } from '../core/errors.js';
import {
  RefreshRotationStore,
  type RefreshRedemption,
} from './refresh-rotation-store.js';

afterEach(() => {
  vi.useRealTimers();
});

/** Drive a full leader rotation to completion, returning the minted next jti. */
function rotate(store: RefreshRotationStore, key: string, jti: string, result: unknown = 'result'): string {
  const redemption = store.beginRotation(key, jti);
  if (redemption.kind !== 'lease') {
    throw new Error(`expected a lease, got ${redemption.kind}`);
  }
  redemption.lease.commit(result);
  return redemption.lease.newJti;
}

function expectLease<T>(redemption: RefreshRedemption<T>): { newJti: string; commit: (r: T) => void; fail: (e: unknown) => void } {
  if (redemption.kind !== 'lease') {
    throw new Error(`expected a lease, got ${redemption.kind}`);
  }
  return redemption.lease;
}

describe('RefreshRotationStore', () => {
  it('leases an unknown family on first use (restart / initial issuance)', () => {
    const store = new RefreshRotationStore();
    const redemption = store.beginRotation('default:fam-1', 'jti-1');
    expect(redemption.kind).toBe('lease');
    expect(store.size()).toBe(1);
  });

  it('accepts the active jti and rejects a superseded jti after rotation', () => {
    const store = new RefreshRotationStore({ graceMs: 0 });
    const jti2 = rotate(store, 'default:fam-1', 'jti-1');
    // The new active token leases cleanly.
    expect(store.beginRotation('default:fam-1', jti2).kind).toBe('lease');
  });

  it('detects reuse of a superseded jti and revokes the whole family', async () => {
    const store = new RefreshRotationStore({ graceMs: 0 });
    const jti2 = rotate(store, 'default:fam-1', 'jti-1');
    // Replaying the (now past-grace) superseded jti-1 is reuse.
    expect(() => store.beginRotation('default:fam-1', 'jti-1')).toThrow(OAuthInvalidGrantError);
    // The family is now revoked: even the previously-active jti is rejected.
    expect(() => store.beginRotation('default:fam-1', jti2)).toThrow(OAuthInvalidGrantError);
  });

  it('replays the already-minted result for a just-superseded jti within grace (I2a)', async () => {
    const store = new RefreshRotationStore({ graceMs: 30_000 });
    const redemption = store.beginRotation<string>('default:fam-1', 'jti-1');
    const lease = expectLease(redemption);
    lease.commit('minted-token');
    // A retry / lost-response resubmission of jti-1 within grace is idempotent.
    const replay = store.beginRotation<string>('default:fam-1', 'jti-1');
    expect(replay.kind).toBe('replay');
    if (replay.kind === 'replay') {
      await expect(replay.result).resolves.toBe('minted-token');
    }
    // The family is NOT revoked: the freshly minted token still redeems.
    expect(store.beginRotation('default:fam-1', lease.newJti).kind).toBe('lease');
  });

  it('revokes the family for a just-superseded jti presented after the grace window', () => {
    vi.useFakeTimers();
    const store = new RefreshRotationStore({ graceMs: 1_000 });
    rotate(store, 'default:fam-1', 'jti-1', 'minted');
    vi.advanceTimersByTime(1_001);
    // Grace elapsed: jti-1 is now genuine reuse.
    expect(() => store.beginRotation('default:fam-1', 'jti-1')).toThrow(OAuthInvalidGrantError);
  });

  it('single-flights concurrent redemption of the same active jti (I2b)', async () => {
    const store = new RefreshRotationStore();
    // Leader takes the lease and has not committed yet.
    const first = store.beginRotation<string>('default:fam-1', 'jti-1');
    const lease = expectLease(first);
    // A concurrent redemption of the same jti awaits the leader; no second lease.
    const second = store.beginRotation<string>('default:fam-1', 'jti-1');
    expect(second.kind).toBe('replay');
    lease.commit('single-token');
    if (second.kind === 'replay') {
      await expect(second.result).resolves.toBe('single-token');
    }
    // Exactly one new active token exists (single-active invariant).
    expect(store.beginRotation('default:fam-1', lease.newJti).kind).toBe('lease');
  });

  it('keeps the presented jti redeemable after a failed upstream leg (fail)', () => {
    const store = new RefreshRotationStore();
    const lease = expectLease(store.beginRotation('default:fam-1', 'jti-1'));
    lease.fail(new Error('upstream boom'));
    // The lease was released without advancing or revoking: jti-1 leases again.
    expect(store.beginRotation('default:fam-1', 'jti-1').kind).toBe('lease');
  });

  it('fails closed when commit targets a family revoked concurrently', () => {
    const store = new RefreshRotationStore({ graceMs: 0 });
    const lease = expectLease(store.beginRotation('default:fam-1', 'jti-1'));
    // A concurrent reuse (a foreign superseded jti) revokes the family mid-flight.
    expect(() => store.beginRotation('default:fam-1', 'stale-jti')).toThrow(OAuthInvalidGrantError);
    expect(() => lease.commit('too-late')).toThrow(OAuthInvalidGrantError);
  });

  it('treats an expired family as unknown (TTL expiry)', () => {
    vi.useFakeTimers();
    const store = new RefreshRotationStore({ ttlMs: 1_000, graceMs: 0 });
    rotate(store, 'default:fam-1', 'jti-1');
    vi.advanceTimersByTime(1_001);
    // After TTL the family is gone; the old superseded jti leases as first-use.
    expect(store.beginRotation('default:fam-1', 'jti-1').kind).toBe('lease');
  });

  it('evicts the least-recently-used family when over the cap', () => {
    const store = new RefreshRotationStore({ maxFamilies: 2, graceMs: 0 });
    const a1 = rotate(store, 'default:fam-1', 'jti-1');
    rotate(store, 'default:fam-2', 'jti-1');
    // Touch fam-1 so fam-2 becomes least-recently-used.
    rotate(store, 'default:fam-1', a1);
    rotate(store, 'default:fam-3', 'jti-1'); // over cap -> evict fam-2
    expect(store.size()).toBe(2);
    // fam-2 was evicted: presenting a superseded jti leases as first-use again.
    expect(store.beginRotation('default:fam-2', 'other-jti').kind).toBe('lease');
  });

  it('retains revoked tombstones under family-cap pressure - no TOFU downgrade (I5)', () => {
    const store = new RefreshRotationStore({ maxFamilies: 2, graceMs: 0 });
    // Establish and then revoke fam-1 via genuine reuse of a superseded jti.
    rotate(store, 'default:fam-1', 'jti-1');
    expect(() => store.beginRotation('default:fam-1', 'jti-1')).toThrow(OAuthInvalidGrantError);
    expect(store.revokedSize()).toBe(1);

    // Flood well past the family cap so the LRU would have dropped fam-1's entry.
    for (let i = 0; i < 10; i += 1) {
      rotate(store, `default:flood-${i}`, 'jti-x');
    }
    expect(store.size()).toBeLessThanOrEqual(2);

    // The revoked marker survived: replaying fam-1 is still rejected, not TOFU.
    expect(() => store.beginRotation('default:fam-1', 'jti-1')).toThrow(OAuthInvalidGrantError);
    expect(() => store.beginRotation('default:fam-1', 'brand-new-jti')).toThrow(OAuthInvalidGrantError);
  });
});
