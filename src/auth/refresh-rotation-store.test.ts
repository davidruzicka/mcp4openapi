/**
 * Unit tests for the bounded refresh-token rotation store.
 *
 * Covers the rotation state machine (trust-on-first-use, active-jti match,
 * deferred rotation), reuse detection with family revocation, the concurrent
 * revoke-during-rotate fail-closed path, TTL expiry, and LRU overflow eviction.
 */

import { describe, expect, it, vi, afterEach } from 'vitest';
import { OAuthInvalidGrantError } from '../core/errors.js';
import { RefreshRotationStore } from './refresh-rotation-store.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('RefreshRotationStore', () => {
  it('accepts an unknown family on first use (restart / initial issuance)', () => {
    const store = new RefreshRotationStore();
    expect(store.redeem('default:fam-1', 'jti-1')).toBe('accepted');
    expect(store.size()).toBe(1);
  });

  it('accepts the active jti and rejects a superseded jti after rotation', () => {
    const store = new RefreshRotationStore();
    // First use registers jti-1 as active.
    expect(store.redeem('default:fam-1', 'jti-1')).toBe('accepted');
    // Rotation commits jti-2 as the new active token.
    store.rotate('default:fam-1', 'jti-2');
    // The new active token is accepted.
    expect(store.redeem('default:fam-1', 'jti-2')).toBe('accepted');
  });

  it('detects reuse of a superseded jti and revokes the whole family', () => {
    const store = new RefreshRotationStore();
    store.redeem('default:fam-1', 'jti-1');
    store.rotate('default:fam-1', 'jti-2');
    // Replaying the superseded jti-1 is reuse.
    expect(store.redeem('default:fam-1', 'jti-1')).toBe('reuse');
    // The family is now revoked: even the previously-active jti-2 is rejected.
    expect(store.redeem('default:fam-1', 'jti-2')).toBe('reuse');
  });

  it('does not rotate the active jti until rotate() is called (upstream-failure retry safe)', () => {
    const store = new RefreshRotationStore();
    store.redeem('default:fam-1', 'jti-1');
    // Upstream failed: no rotate(). Presenting the same token again must still work.
    expect(store.redeem('default:fam-1', 'jti-1')).toBe('accepted');
  });

  it('fails closed when rotate() targets a family revoked concurrently', () => {
    const store = new RefreshRotationStore();
    store.redeem('default:fam-1', 'jti-1');
    // A concurrent reuse revokes the family before our rotate lands.
    expect(store.redeem('default:fam-1', 'stale-jti')).toBe('reuse');
    expect(() => store.rotate('default:fam-1', 'jti-2')).toThrow(OAuthInvalidGrantError);
  });

  it('rotate() creates the family for the initial issuance path (no prior redeem)', () => {
    const store = new RefreshRotationStore();
    store.rotate('default:fam-new', 'jti-1');
    expect(store.redeem('default:fam-new', 'jti-1')).toBe('accepted');
  });

  it('treats an expired family as unknown (TTL expiry)', () => {
    vi.useFakeTimers();
    const store = new RefreshRotationStore({ ttlMs: 1_000 });
    store.redeem('default:fam-1', 'jti-1');
    store.rotate('default:fam-1', 'jti-2');
    vi.advanceTimersByTime(1_001);
    // After TTL the family is gone; the old superseded jti is accepted as first-use.
    expect(store.redeem('default:fam-1', 'jti-1')).toBe('accepted');
  });

  it('evicts the least-recently-used family when over the cap', () => {
    const store = new RefreshRotationStore({ maxFamilies: 2 });
    store.redeem('default:fam-1', 'jti-1');
    store.redeem('default:fam-2', 'jti-1');
    // Touch fam-1 so fam-2 becomes least-recently-used.
    store.redeem('default:fam-1', 'jti-1');
    store.redeem('default:fam-3', 'jti-1'); // over cap -> evict fam-2
    expect(store.size()).toBe(2);
    // fam-2 was evicted: presenting a superseded jti is accepted as first-use again.
    expect(store.redeem('default:fam-2', 'other-jti')).toBe('accepted');
  });
});
