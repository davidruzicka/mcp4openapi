/**
 * UpstreamConnectionManager - per-session upstream MCP client lifecycle
 *
 * Owns lazy connection creation, concurrent-safe deduplication, and
 * session-scoped cleanup for upstream MCP server connections.
 *
 * Connections are NOT created at session init time - only on first tool use
 * via getOrConnect(). This satisfies PROXY-01 (lazy initialization).
 *
 * closeAll(sessionId) is wired to the session destruction lifecycle
 * (reaper, DELETE /mcp, shutdown) to prevent connection leaks (REL-02).
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import type { $ZodType } from 'zod/v4/core';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { UpstreamMcpServerConfig } from '../types/profile.js';
import type { UpstreamConnection } from '../types/upstream-connection.js';
import { UpstreamConnectionError, UpstreamTimeoutError, UpstreamAuthError } from './upstream-errors.js';
import { buildAuthHeaders, buildAuthUrl } from './upstream-credential-store.js';
import { sanitizeAuthErrorMessage } from '../auth/auth-redaction.js';
import { SSRFValidator } from '../security/ssrf-validator.js';
import { ConsoleLogger } from '../core/logger.js';
import type { Logger } from '../core/logger.js';
import { NotificationQueue } from './upstream-notification-queue.js';
import type { NotificationQueueEntry } from './upstream-notification-queue.js';
import { UpstreamHeartbeatManager } from './upstream-heartbeat.js';
import type { HeartbeatConfig } from './upstream-heartbeat.js';

/** Auth-related HTTP status codes */
const AUTH_STATUS_CODES = new Set([401, 403]);

/** Type guard for MCP SDK errors that carry an HTTP status code */
function hasMcpStatusCode(e: unknown): e is { statusCode: number } {
  return (
    typeof e === 'object' &&
    e !== null &&
    'statusCode' in e &&
    typeof (e as Record<string, unknown>).statusCode === 'number'
  );
}

/** Patterns in error messages that indicate authentication failure */
const AUTH_ERROR_PATTERNS = /unauthorized|forbidden|authentication failed|invalid.*token/i;

export interface UpstreamConnectionManagerOptions {
  clientFactory?: () => Pick<Client, 'connect' | 'close' | 'ping' | 'setNotificationHandler'>;
  transportFactory?: (url: URL, options: Record<string, unknown>) => Pick<StreamableHTTPClientTransport, 'close'> & {
    onerror: ((error: Error) => void) | null;
    onclose: (() => void) | null;
  };
  ssrfValidator?: SSRFValidator;
  logger?: Logger;
  heartbeatConfig?: HeartbeatConfig;
}

export class UpstreamConnectionManager {
  /** Outer key: sessionId, inner key: providerName */
  private readonly connections = new Map<string, Map<string, UpstreamConnection>>();

  /**
   * Key: `${sessionId}:${providerName}` - prevents concurrent duplicate connections.
   * Stores the token alongside the promise to detect token-mismatch in concurrent callers (P2 guard).
   */
  private readonly pendingConnections = new Map<string, { promise: Promise<Client>; token: string | undefined }>();

  /**
   * Sessions that have been destroyed (closeAll called).
   * createConnection checks this after connect to close orphaned connections
   * created while closeAll was in flight (REL-02 race guard).
   * Stored as Map<sessionId, destroyedAt ms> for TTL-based pruning (memory leak prevention).
   */
  private readonly destroyedSessions = new Map<string, number>();

  private static readonly DESTROYED_SESSION_TTL_MS = 60_000; // 60s grace period

  /**
   * Per-session notification queues for buffering when no SSE stream is attached.
   * Key: sessionId (single-provider-per-profile assumption for phase 2).
   * If multi-provider-per-session is needed in future, key should be `${sessionId}:${providerName}`.
   */
  private readonly notificationQueues = new Map<string, NotificationQueue>();

  /** Callback to forward notification to downstream client. Set by HttpTransport. */
  private downstreamNotifyFn: ((sessionId: string, method: string, params?: unknown) => void) | null = null;

  /** Callbacks invoked when upstream sends notifications/tools/list_changed. */
  private readonly toolsListChangedHooks: Array<(sessionId: string, providerName: string) => void> = [];

  /**
   * Callback to check if downstream SSE stream is active. Set by HttpTransport.
   * Replaces the anti-pattern of catching exceptions from downstreamNotifyFn to detect "no stream".
   * Explicit check is more robust and does not rely on sendToClient's throw behavior as a
   * control-flow signal.
   */
  private hasActiveStreamFn: ((sessionId: string) => boolean) | null = null;

  /**
   * Data-driven dispatch map for upstream notification types.
   * Adding a new notification type is a one-liner (D-07).
   */
  private static readonly NOTIFICATION_DISPATCH: ReadonlyArray<{
    schema: $ZodType;
    method: string;
  }> = [
    { schema: ToolListChangedNotificationSchema, method: 'notifications/tools/list_changed' },
    // Future: { schema: ResourceListChangedNotificationSchema, method: 'notifications/resources/list_changed' },
  ];

  private readonly clientFactory: NonNullable<UpstreamConnectionManagerOptions['clientFactory']>;
  private readonly transportFactory: NonNullable<UpstreamConnectionManagerOptions['transportFactory']>;
  private readonly ssrfValidator: SSRFValidator;
  private readonly logger: Logger;
  private readonly heartbeatManager: UpstreamHeartbeatManager;

  constructor(options?: UpstreamConnectionManagerOptions) {
    this.clientFactory = options?.clientFactory ?? (
      () => new Client({ name: 'mcp4openapi', version: '0.1.0' })
    );
    this.transportFactory = options?.transportFactory ?? (
      (url, opts) => new StreamableHTTPClientTransport(url, opts) as ReturnType<NonNullable<UpstreamConnectionManagerOptions['transportFactory']>>
    );
    this.logger = options?.logger ?? new ConsoleLogger();
    this.ssrfValidator = options?.ssrfValidator ?? new SSRFValidator(this.logger);
    this.heartbeatManager = new UpstreamHeartbeatManager(options?.heartbeatConfig);
  }

  /**
   * Set callback for forwarding notifications to downstream clients.
   * Called by HttpTransport to wire the notification path.
   */
  public setDownstreamNotifyFn(fn: (sessionId: string, method: string, params?: unknown) => void): void {
    this.downstreamNotifyFn = fn;
  }

  /**
   * Set callback for checking if a downstream SSE stream is active for a session.
   * Called by HttpTransport to wire the stream presence check.
   */
  public setHasActiveStreamFn(fn: (sessionId: string) => boolean): void {
    this.hasActiveStreamFn = fn;
  }

  /**
   * Register a hook called whenever upstream sends notifications/tools/list_changed.
   * MCPServer registers this to invalidate its sanitized-tool cache so that newly
   * added upstream tools are not incorrectly blocked on the next tools/call.
   */
  public addToolsListChangedHook(fn: (sessionId: string, providerName: string) => void): () => void {
    this.toolsListChangedHooks.push(fn);
    return () => {
      const idx = this.toolsListChangedHooks.indexOf(fn);
      if (idx !== -1) this.toolsListChangedHooks.splice(idx, 1);
    };
  }

  /**
   * Drain buffered notifications for a session. Called on SSE reconnect.
   */
  public drainNotifications(sessionId: string): NotificationQueueEntry[] {
    const queue = this.notificationQueues.get(sessionId);
    if (!queue) return [];
    return queue.drain();
  }

  /**
   * Get an existing connected client or create a new connection.
   *
   * Concurrent calls for the same session+provider return the same promise
   * (no duplicate connections). FAILED connections are replaced with fresh ones.
   */
  async getOrConnect(
    sessionId: string,
    provider: UpstreamMcpServerConfig,
    token: string | undefined,
  ): Promise<Client> {
    const dedupKey = `${sessionId}:${provider.name}`;

    // Return existing CONNECTED client, unless the token has changed.
    // Token comparison is skipped when provider.auth is not configured: no auth header/query
    // is sent upstream, so token rotation has no effect on the upstream connection and forcing
    // a reconnect would only cause unnecessary churn (P2 guard).
    const existing = this.getConnection(sessionId, provider.name);
    if (existing && existing.state === 'CONNECTED') {
      if (provider.auth && existing.token !== token) {
        // Token rotated - stop heartbeat and close old connection before creating a fresh one
        this.heartbeatManager.stop(dedupKey);
        const sessionMap = this.connections.get(sessionId);
        sessionMap?.delete(provider.name);
        existing.client.close().catch(() => {});
        existing.transport.close().catch(() => {});
        // Invalidate sanitized-tool cache: reconnection under new token may expose different tools
        this.fireToolsListChangedHooks(sessionId, provider.name);
      } else {
        existing.lastActivityAt = Date.now();
        return existing.client as Client;
      }
    }

    // Return in-flight promise for concurrent dedup - but only when the token matches.
    // If the caller has a different token, wait for the in-flight to settle and start fresh
    // so the session is not established under stale credentials (P2 guard).
    // When provider.auth is absent, token differences are irrelevant - always reuse the
    // in-flight promise to avoid duplicate connections.
    const pending = this.pendingConnections.get(dedupKey);
    if (pending) {
      if (!provider.auth || pending.token === token) {
        return pending.promise;
      }
      await pending.promise.catch(() => {});
      return this.getOrConnect(sessionId, provider, token);
    }

    // Remove FAILED connection before creating fresh one (stop stale heartbeat first,
    // then close transport/client so stale onerror/onclose handlers cannot fire against
    // the replacement connection and accumulated leaked sockets are released).
    if (existing && existing.state === 'FAILED') {
      this.heartbeatManager.stop(dedupKey);
      const sessionMap = this.connections.get(sessionId);
      sessionMap?.delete(provider.name);
      existing.client.close().catch(() => {});
      existing.transport.close().catch(() => {});
    }

    const connectPromise = this.createConnection(sessionId, provider, token);
    this.pendingConnections.set(dedupKey, { promise: connectPromise as Promise<Client>, token });

    try {
      const client = await connectPromise;
      return client;
    } finally {
      // Only delete if this is still the current pending entry (not replaced by a concurrent call)
      if (this.pendingConnections.get(dedupKey)?.promise === (connectPromise as Promise<Client>)) {
        this.pendingConnections.delete(dedupKey);
      }
    }
  }

  /**
   * Get or create the notification queue for a session.
   */
  private getOrCreateQueue(sessionId: string): NotificationQueue {
    let queue = this.notificationQueues.get(sessionId);
    if (!queue) {
      queue = new NotificationQueue();
      this.notificationQueues.set(sessionId, queue);
    }
    return queue;
  }

  /**
   * Wire notification listeners on an upstream MCP Client.
   */
  private wireNotificationListeners(client: Client, sessionId: string, providerName: string): void {
    for (const { schema, method } of UpstreamConnectionManager.NOTIFICATION_DISPATCH) {
      client.setNotificationHandler(schema, (notification) => {
        try {
          this.handleUpstreamNotification(sessionId, providerName, method, (notification as { params?: unknown }).params);
        } catch (error) {
          this.logger.error('Error handling upstream notification', error instanceof Error ? error : new Error(String(error)));
        }
      });
    }
  }

  private fireToolsListChangedHooks(sessionId: string, providerName: string): void {
    for (const hook of this.toolsListChangedHooks) {
      try {
        hook(sessionId, providerName);
      } catch (error) {
        this.logger.error('Error in toolsListChangedHook', error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  /**
   * Handle an upstream notification: forward to downstream if stream active, otherwise queue.
   * Uses explicit hasActiveStreamFn check to avoid exception-as-control-flow anti-pattern.
   * Fires toolsListChangedHooks when method is notifications/tools/list_changed so callers
   * can invalidate stale caches before the next tools/call.
   */
  private handleUpstreamNotification(sessionId: string, providerName: string, method: string, params?: unknown): void {
    if (method === 'notifications/tools/list_changed') {
      this.fireToolsListChangedHooks(sessionId, providerName);
    }
    if (this.downstreamNotifyFn && this.hasActiveStreamFn && this.hasActiveStreamFn(sessionId)) {
      this.downstreamNotifyFn(sessionId, method, params);
      return;
    }
    // Buffer in queue for replay on reconnect (D-08)
    const queue = this.getOrCreateQueue(sessionId);
    queue.push({ method, params });
    this.logger.debug('Queued upstream notification for disconnected client', { sessionId, method, queueSize: queue.size });
  }

  /**
   * Close all upstream connections for a session.
   * Transport close errors are swallowed to prevent cascading failures.
   *
   * Handles in-flight connections: marks the session as destroyed before awaiting
   * pending promises so that createConnection() can detect the race and self-close
   * any connection established after teardown began (REL-02).
   */
  async closeAll(sessionId: string): Promise<void> {
    // Mark destroyed first so any in-flight createConnection checks this and self-closes
    this.destroyedSessions.set(sessionId, Date.now());

    // Wait for in-flight connections to settle - they will see destroyedSessions and abort
    const pendingKeys = [...this.pendingConnections.keys()].filter(k => k.startsWith(`${sessionId}:`));
    if (pendingKeys.length > 0) {
      await Promise.allSettled(pendingKeys.map(k => this.pendingConnections.get(k)?.promise));
    }

    const sessionMap = this.connections.get(sessionId);
    const closePromises: Promise<void>[] = [];

    if (sessionMap) {
      for (const [, conn] of sessionMap) {
        this.heartbeatManager.stop(`${sessionId}:${conn.providerName}`);
        closePromises.push(
          (conn.client.close() as Promise<void>).catch(() => {
            // Swallow close errors - session is being destroyed anyway
          }),
        );
        closePromises.push(
          (conn.transport.close() as Promise<void>).catch(() => {
            // Swallow close errors - session is being destroyed anyway
          }),
        );
      }

      await Promise.all(closePromises);
      this.connections.delete(sessionId);
    }

    this.notificationQueues.delete(sessionId);
    // Intentionally retain the destroyedSessions marker for at least DESTROYED_SESSION_TTL_MS:
    // a session, once destroyed, is never reused (HTTP transport removes it from profileStates).
    // Retaining the marker prevents a race window where a reconnect attempt fires between
    // closeAll() and the transport's own session removal, and would otherwise create a new
    // orphaned upstream connection.

    // Prune stale destroyed-session markers (memory leak prevention)
    const cutoff = Date.now() - UpstreamConnectionManager.DESTROYED_SESSION_TTL_MS;
    for (const [id, destroyedAt] of this.destroyedSessions) {
      if (destroyedAt < cutoff) this.destroyedSessions.delete(id);
    }
  }

  /**
   * Opt-in early auth validation against upstream validation_endpoint.
   * Performs SSRF validation then a lightweight HTTP probe to verify token is accepted.
   * No-op when validation_endpoint is not configured or token is absent.
   */
  async validateCredentials(
    sessionId: string | undefined,
    provider: UpstreamMcpServerConfig,
    token: string | undefined,
  ): Promise<void> {
    if (!provider.validation_endpoint || !token) {
      return;
    }

    // SSRF check first - block private/loopback/link-local targets.
    // Parse once and reuse: validate() must see the same normalized form that fetch() connects to.
    const parsedValidationUrl = new URL(provider.validation_endpoint);
    await this.ssrfValidator.validate(parsedValidationUrl.toString(), {
      allowPrivateNetwork: process.env.MCP4_SSRF_ALLOW_PRIVATE_NETWORK === 'true',
    });

    const authHeaders = buildAuthHeaders(provider, token);
    const validationUrl = buildAuthUrl(provider, parsedValidationUrl, token);
    const timeoutMs = provider.validation_timeout_ms ?? 5000;

    let response: { status: number };
    try {
      response = await fetch(validationUrl.toString(), {
        method: provider.validation_method ?? 'HEAD',
        headers: authHeaders,
        signal: AbortSignal.timeout(timeoutMs),
        // Prevent SSRF bypass: a redirect could send the probe to a private address
        // that bypasses the pre-fetch SSRF validation above.
        redirect: 'manual',
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      if (err.name === 'TimeoutError' || err.name === 'AbortError') {
        throw new UpstreamTimeoutError(provider.name, timeoutMs);
      }
      throw new UpstreamConnectionError(
        err.message,
        provider.name,
      );
    }

    if (response.status === 401 || response.status === 403) {
      throw new UpstreamAuthError(provider.name);
    }

    if (response.status < 200 || response.status >= 300) {
      throw new UpstreamConnectionError(
        `Validation endpoint returned unexpected status ${response.status}`,
        provider.name,
      );
    }

    this.logger.debug('Upstream credential validation passed', {
      provider: provider.name,
      ...(sessionId ? { sessionId } : { phase: 'pre-session-init' }),
      status: response.status,
    });
  }

  /** Get connection metadata for a session+provider, or undefined */
  getConnection(sessionId: string, providerName: string): UpstreamConnection | undefined {
    return this.connections.get(sessionId)?.get(providerName);
  }

  /** Number of sessions with at least one upstream connection */
  getActiveSessionCount(): number {
    return this.connections.size;
  }

  private async createConnection(
    sessionId: string,
    provider: UpstreamMcpServerConfig,
    token: string | undefined,
  ): Promise<Client> {
    // SSRF check: validate transport URL before opening any network connection.
    // Parse once and reuse: validate() must see the same normalized form that the transport connects to.
    const parsedTransportUrl = new URL(provider.transport.url);
    await this.ssrfValidator.validate(parsedTransportUrl.toString(), {
      allowPrivateNetwork: process.env.MCP4_SSRF_ALLOW_PRIVATE_NETWORK === 'true',
    });

    const authHeaders = buildAuthHeaders(provider, token);
    // For query-auth providers, the token is embedded in the URL as a query parameter.
    // Security note: StreamableHTTPClientTransport (MCP SDK) does not log the URL it connects to
    // and does not include the URL in error messages — verified against SDK source. The URL is only
    // used as a fetch target and passed to auth() for OAuth metadata discovery (not relevant here).
    // Network-level errors from fetch propagate through mapConnectError → UpstreamConnectionError,
    // which sanitizes internally; raw query params are not redacted, but Node.js fetch (undici)
    // error messages include the hostname only, not the full URL+query string.
    const url = buildAuthUrl(provider, parsedTransportUrl, token);

    const transport = this.transportFactory(
      url,
      {
        requestInit: { headers: authHeaders },
        reconnectionOptions: {
          initialReconnectionDelay: 1000,
          maxReconnectionDelay: 30000,
          reconnectionDelayGrowFactor: 1.5,
          maxRetries: 2,
        },
      },
    );

    const client = this.clientFactory();

    // Wire transport event handlers.
    // Identity check (conn.transport === transport) prevents a stale transport's delayed
    // onerror/onclose from marking a replacement connection as FAILED after token rotation
    // or recovery (P2 guard).
    transport.onerror = (error: Error) => {
      const conn = this.getConnection(sessionId, provider.name);
      if (conn && (conn.transport as unknown) === (transport as unknown)) {
        this.handleTransportError(sessionId, provider.name, error);
      }
    };

    transport.onclose = () => {
      const conn = this.getConnection(sessionId, provider.name);
      if (conn && (conn.transport as unknown) === (transport as unknown)) {
        this.handleTransportClose(sessionId, provider.name);
      }
    };

    try {
      await client.connect(transport as StreamableHTTPClientTransport);
    } catch (error) {
      // Prevent resource leaks: close transport and client before rethrowing.
      // Without this, orphaned transports keep retry timers/sockets alive across
      // repeated connect failures.
      transport.close().catch(() => {});
      client.close().catch(() => {});
      throw this.mapConnectError(error, provider);
    }

    // Guard: session may have been destroyed while we were connecting
    if (this.destroyedSessions.has(sessionId)) {
      (transport as StreamableHTTPClientTransport).close().catch(() => {});
      client.close().catch(() => {});
      throw new UpstreamConnectionError('Session destroyed during upstream connection', provider.name);
    }

    // Wire upstream notification listeners after successful connection
    this.wireNotificationListeners(client as Client, sessionId, provider.name);

    // Store connection
    const now = Date.now();
    const connection: UpstreamConnection = {
      client: client as Client,
      transport: transport as StreamableHTTPClientTransport,
      state: 'CONNECTED',
      providerName: provider.name,
      connectedAt: now,
      lastActivityAt: now,
      token,
    };

    let sessionMap = this.connections.get(sessionId);
    if (!sessionMap) {
      sessionMap = new Map();
      this.connections.set(sessionId, sessionMap);
    }
    sessionMap.set(provider.name, connection);

    const heartbeatKey = `${sessionId}:${provider.name}`;
    this.heartbeatManager.start(
      heartbeatKey,
      async () => { await (client as Client).ping({ timeout: this.heartbeatManager.getConfig().timeoutMs }); },
      (error) => this.handleTransportError(sessionId, provider.name, error),
    );

    return client as Client;
  }

  private mapConnectError(error: unknown, provider: UpstreamMcpServerConfig): Error {
    const err = error instanceof Error ? error : new Error(String(error));
    const statusCode = hasMcpStatusCode(error) ? error.statusCode : undefined;

    // Auth errors: 401/403 or message pattern match
    if (statusCode && AUTH_STATUS_CODES.has(statusCode)) {
      return new UpstreamAuthError(provider.name);
    }
    if (AUTH_ERROR_PATTERNS.test(err.message)) {
      return new UpstreamAuthError(provider.name);
    }

    // Timeout errors
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      return new UpstreamTimeoutError(provider.name, provider.timeout_ms ?? 30000);
    }

    // Generic connection error
    return new UpstreamConnectionError(
      `Failed to connect to upstream provider '${provider.name}': ${err.message}`,
      provider.name,
    );
  }

  private handleTransportError(sessionId: string, providerName: string, error: Error): void {
    const conn = this.getConnection(sessionId, providerName);
    if (conn) {
      conn.state = 'FAILED';
      conn.lastError = new Error(sanitizeAuthErrorMessage(error.message));
      this.heartbeatManager.stop(`${sessionId}:${providerName}`);
    }
  }

  private handleTransportClose(sessionId: string, providerName: string): void {
    const conn = this.getConnection(sessionId, providerName);
    if (conn) {
      conn.state = 'FAILED';
      this.heartbeatManager.stop(`${sessionId}:${providerName}`);
    }
  }
}
