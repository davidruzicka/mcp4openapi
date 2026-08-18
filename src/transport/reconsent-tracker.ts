/**
 * Bounded one-shot re-consent bookkeeping for the HTTP transport.
 *
 * A single Map keyed by profile/subject/rules-version tracks the two flags of
 * the re-consent state machine that were previously spread across two Sets:
 *
 * - `invalidated`: the subject already consumed its one-shot session
 *   invalidation for the current rules version, so repeat denials return the
 *   consent error without invalidating again (no OAuth loop for clients that
 *   cannot complete the browser acknowledgement).
 * - `pendingEnvelopeReject`: the subject's NEXT envelope restart-recovery must
 *   be rejected once with 401, so the client discards its `mcp4.v1.*` envelope
 *   and restarts OAuth instead of silently rebuilding the session.
 */
export class ReconsentTracker {
  private readonly entries = new Map<string, { invalidated: boolean; pendingEnvelopeReject: boolean }>();

  constructor(private readonly maxEntries: number) {}

  /** True when the key already consumed its one-shot invalidation budget. */
  isInvalidated(key: string): boolean {
    return this.entries.get(key)?.invalidated === true;
  }

  /**
   * Consume the invalidation budget for the key and optionally arm a one-time
   * envelope restart-recovery rejection. Bounded: at capacity the oldest entry
   * is evicted (FIFO), which only costs one extra invalidation for the evicted
   * subject, never a missed denial.
   */
  markInvalidated(key: string, options: { pendingEnvelopeReject: boolean }): void {
    const existing = this.entries.get(key);
    if (existing) {
      existing.invalidated = true;
      existing.pendingEnvelopeReject = existing.pendingEnvelopeReject || options.pendingEnvelopeReject;
      return;
    }
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, { invalidated: true, pendingEnvelopeReject: options.pendingEnvelopeReject });
  }

  /**
   * Reset the invalidation budget after a satisfied consent check, so a later
   * revocation or expiry can invalidate again. A still-armed envelope
   * rejection is preserved until consumed.
   */
  clearInvalidation(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    if (entry.pendingEnvelopeReject) {
      entry.invalidated = false;
    } else {
      this.entries.delete(key);
    }
  }

  /**
   * One-shot: returns true exactly once after `markInvalidated` armed the
   * envelope rejection for the key; the flag is consumed on use.
   */
  consumePendingEnvelopeRejection(key: string): boolean {
    const entry = this.entries.get(key);
    if (!entry?.pendingEnvelopeReject) return false;
    entry.pendingEnvelopeReject = false;
    if (!entry.invalidated) this.entries.delete(key);
    return true;
  }

  get size(): number {
    return this.entries.size;
  }

  /** Insertion-ordered keys, primarily for eviction observability and tests. */
  keys(): IterableIterator<string> {
    return this.entries.keys();
  }
}
