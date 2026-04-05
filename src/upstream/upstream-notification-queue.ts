/**
 * Bounded notification queue for upstream MCP server notifications
 *
 * Buffers upstream server-initiated notifications (e.g. tools/list_changed)
 * for replay on client reconnect. Enforces a size cap and TTL to prevent
 * unbounded memory growth under disconnected or slow clients (D-08, REL-04).
 *
 * TTL eviction computes age as (Date.now() - entry.timestamp). The "now"
 * reference is always sampled at push/drain time (wall-clock), not derived
 * from the latest entry's timestamp, so entries are evicted based on absolute
 * elapsed time since insertion regardless of push frequency.
 */

export interface NotificationQueueEntry {
  method: string;
  timestamp: number;
  params?: unknown;
}

export interface NotificationQueueOptions {
  maxSize?: number;
  ttlMs?: number;
}

const DEFAULT_MAX_SIZE = 50;
const DEFAULT_TTL_MS = 300_000; // 5 minutes

export class NotificationQueue {
  private entries: NotificationQueueEntry[] = [];
  private readonly maxSize: number;
  private readonly ttlMs: number;

  constructor(options?: NotificationQueueOptions) {
    // No defensive clamping of maxSize/ttlMs: this class is internal and only instantiated
    // by UpstreamConnectionManager with defaults or explicit positive values. Edge cases like
    // maxSize=0 cannot occur in practice; adding clamping would hide programming errors
    // instead of surfacing them at the call site.
    this.maxSize = options?.maxSize ?? DEFAULT_MAX_SIZE;
    this.ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS;
  }

  /**
   * Add a notification entry to the queue.
   *
   * Before inserting, evicts entries that have exceeded their TTL based on
   * wall-clock time. If the queue is still at capacity after TTL eviction,
   * the oldest entry is shifted out.
   */
  push(entry: NotificationQueueEntry): void {
    // Evict entries older than ttlMs: age = Date.now() - entry.timestamp
    const now = Date.now();
    this.entries = this.entries.filter(e => (now - e.timestamp) < this.ttlMs);

    if (this.entries.length >= this.maxSize) {
      this.entries.shift();
    }

    this.entries.push(entry);
  }

  /**
   * Return all non-expired queued entries in insertion order and clear the queue.
   *
   * Re-applies TTL eviction at drain time so stale entries buffered during a
   * long disconnection are never replayed to a reconnecting client.
   */
  drain(): NotificationQueueEntry[] {
    const now = Date.now();
    const result = this.entries.filter(e => (now - e.timestamp) < this.ttlMs);
    this.entries = [];
    return result;
  }

  /**
   * Current number of entries in the queue.
   */
  get size(): number {
    return this.entries.length;
  }
}
