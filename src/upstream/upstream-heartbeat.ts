/**
 * Application-level heartbeat manager for upstream MCP connections.
 *
 * Detects silent SSE disconnects (from intermediate proxies, cloud LBs)
 * before tool calls fail by pinging at configurable intervals.
 * The ping timeout is delegated to the caller via the pingFn parameter
 * (e.g. () => client.ping({ timeout: config.timeoutMs })).
 */

export interface HeartbeatConfig {
  /** Ping interval in milliseconds (default: 30000) */
  intervalMs?: number;
  /** Ping timeout in milliseconds - used by caller to configure client.ping (default: 5000) */
  timeoutMs?: number;
}

export const DEFAULT_HEARTBEAT_CONFIG: Required<HeartbeatConfig> = {
  intervalMs: 30000,
  timeoutMs: 5000,
};

export class UpstreamHeartbeatManager {
  private readonly config: Required<HeartbeatConfig>;
  private readonly timers: Map<string, NodeJS.Timeout> = new Map();

  constructor(config?: HeartbeatConfig) {
    this.config = {
      ...DEFAULT_HEARTBEAT_CONFIG,
      ...config,
    };
  }

  /**
   * Start heartbeat pings for a given key.
   * Idempotent - calling start() with an already-running key is a no-op.
   *
   * @param key - Unique identifier (e.g. `${sessionId}:${providerName}`)
   * @param pingFn - Async function that sends a ping (e.g. () => client.ping({ timeout }))
   * @param onFailure - Called when pingFn rejects
   */
  start(
    key: string,
    pingFn: () => Promise<void>,
    onFailure: (error: Error) => void,
  ): void {
    if (this.timers.has(key)) {
      return;
    }

    let inFlight = false;
    const timer = setInterval(async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        await pingFn();
      } catch (error: unknown) {
        // Guard against stop()/stopAll() called while ping was in-flight:
        // the promise outlives clearInterval, so we must not invoke onFailure
        // after the heartbeat has been intentionally stopped.
        if (!this.timers.has(key)) return;
        onFailure(error instanceof Error ? error : new Error(String(error)));
      } finally {
        inFlight = false;
      }
    }, this.config.intervalMs);

    this.timers.set(key, timer);
  }

  /** Stop heartbeat for a specific key. No-op if not running. */
  stop(key: string): void {
    const timer = this.timers.get(key);
    if (timer !== undefined) {
      clearInterval(timer);
      this.timers.delete(key);
    }
  }

  /** Stop all active heartbeat timers. */
  stopAll(): void {
    for (const timer of this.timers.values()) {
      clearInterval(timer);
    }
    this.timers.clear();
  }

  /** Check if heartbeat is running for a given key. */
  isRunning(key: string): boolean {
    return this.timers.has(key);
  }

  /** Get the number of active heartbeat timers. */
  getActiveCount(): number {
    return this.timers.size;
  }

  /** Get the resolved config (with defaults applied). */
  getConfig(): Required<HeartbeatConfig> {
    return { ...this.config };
  }
}
