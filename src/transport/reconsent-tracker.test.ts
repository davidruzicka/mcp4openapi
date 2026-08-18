import { describe, it, expect } from 'vitest';
import { ReconsentTracker } from './reconsent-tracker.js';

describe('ReconsentTracker', () => {
  it('marks a key invalidated and reports it', () => {
    const tracker = new ReconsentTracker(10);
    expect(tracker.isInvalidated('k1')).toBe(false);
    tracker.markInvalidated('k1', { pendingEnvelopeReject: false });
    expect(tracker.isInvalidated('k1')).toBe(true);
    expect(tracker.size).toBe(1);
  });

  it('does not arm an envelope rejection unless requested', () => {
    const tracker = new ReconsentTracker(10);
    tracker.markInvalidated('k1', { pendingEnvelopeReject: false });
    expect(tracker.consumePendingEnvelopeRejection('k1')).toBe(false);
    expect(tracker.isInvalidated('k1')).toBe(true);
  });

  it('consumes an armed envelope rejection exactly once', () => {
    const tracker = new ReconsentTracker(10);
    tracker.markInvalidated('k1', { pendingEnvelopeReject: true });
    expect(tracker.consumePendingEnvelopeRejection('k1')).toBe(true);
    expect(tracker.consumePendingEnvelopeRejection('k1')).toBe(false);
    // The invalidation budget stays consumed after the rejection is used.
    expect(tracker.isInvalidated('k1')).toBe(true);
  });

  it('returns false for unknown keys', () => {
    const tracker = new ReconsentTracker(10);
    expect(tracker.consumePendingEnvelopeRejection('missing')).toBe(false);
    expect(tracker.isInvalidated('missing')).toBe(false);
  });

  it('clearInvalidation resets the budget but preserves an armed envelope rejection', () => {
    const tracker = new ReconsentTracker(10);
    tracker.markInvalidated('k1', { pendingEnvelopeReject: true });
    tracker.clearInvalidation('k1');
    expect(tracker.isInvalidated('k1')).toBe(false);
    expect(tracker.consumePendingEnvelopeRejection('k1')).toBe(true);
    // With both flags spent the entry is fully released.
    expect(tracker.size).toBe(0);
  });

  it('clearInvalidation drops the entry entirely when no rejection is armed', () => {
    const tracker = new ReconsentTracker(10);
    tracker.markInvalidated('k1', { pendingEnvelopeReject: false });
    tracker.clearInvalidation('k1');
    expect(tracker.size).toBe(0);
    expect(tracker.isInvalidated('k1')).toBe(false);
  });

  it('clearInvalidation on an unknown key is a no-op', () => {
    const tracker = new ReconsentTracker(10);
    expect(() => tracker.clearInvalidation('missing')).not.toThrow();
    expect(tracker.size).toBe(0);
  });

  it('re-invalidation after clearInvalidation keeps a previously armed rejection', () => {
    const tracker = new ReconsentTracker(10);
    tracker.markInvalidated('k1', { pendingEnvelopeReject: true });
    tracker.clearInvalidation('k1');
    tracker.markInvalidated('k1', { pendingEnvelopeReject: false });
    expect(tracker.isInvalidated('k1')).toBe(true);
    expect(tracker.consumePendingEnvelopeRejection('k1')).toBe(true);
  });

  it('evicts the oldest entry at capacity (FIFO) and never exceeds the bound', () => {
    const tracker = new ReconsentTracker(3);
    tracker.markInvalidated('k1', { pendingEnvelopeReject: true });
    tracker.markInvalidated('k2', { pendingEnvelopeReject: false });
    tracker.markInvalidated('k3', { pendingEnvelopeReject: false });
    tracker.markInvalidated('k4', { pendingEnvelopeReject: false });

    expect(tracker.size).toBe(3);
    expect(tracker.isInvalidated('k1')).toBe(false);
    expect(tracker.consumePendingEnvelopeRejection('k1')).toBe(false);
    expect(tracker.isInvalidated('k4')).toBe(true);
    expect(Array.from(tracker.keys())).toEqual(['k2', 'k3', 'k4']);
  });

  it('re-marking an existing key updates it in place without eviction', () => {
    const tracker = new ReconsentTracker(3);
    tracker.markInvalidated('k1', { pendingEnvelopeReject: false });
    tracker.markInvalidated('k2', { pendingEnvelopeReject: false });
    tracker.markInvalidated('k3', { pendingEnvelopeReject: false });
    tracker.markInvalidated('k2', { pendingEnvelopeReject: true });

    expect(tracker.size).toBe(3);
    expect(tracker.isInvalidated('k1')).toBe(true);
    expect(tracker.consumePendingEnvelopeRejection('k2')).toBe(true);
  });
});
