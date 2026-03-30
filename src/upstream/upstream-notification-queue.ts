/**
 * Bounded notification queue for upstream MCP server notifications
 *
 * Buffers upstream server-initiated notifications (e.g. tools/list_changed)
 * for replay on client reconnect. Enforces a size cap and TTL to prevent
 * unbounded memory growth under disconnected or slow clients (D-08, REL-04).
 *
 * TTL eviction uses Date.now() (wall-clock time), not the incoming entry's
 * timestamp, so eviction is correct even if the upstream clock skews or an
 * entry arrives with a non-current timestamp.
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
    // Evict expired entries using wall-clock time, NOT entry.timestamp
    const now = Date.now();
    this.entries = this.entries.filter(e => (now - e.timestamp) < this.ttlMs);

    if (this.entries.length >= this.maxSize) {
      this.entries.shift();
    }

    this.entries.push(entry);
  }

  /**
   * Return all queued entries in insertion order and clear the queue.
   */
  drain(): NotificationQueueEntry[] {
    const result = [...this.entries];
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
