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

/** Auth-related HTTP status codes */
const AUTH_STATUS_CODES = new Set([401, 403]);

/** Patterns in error messages that indicate authentication failure */
const AUTH_ERROR_PATTERNS = /unauthorized|forbidden|authentication failed|invalid.*token/i;

export interface UpstreamConnectionManagerOptions {
  clientFactory?: () => Pick<Client, 'connect' | 'close' | 'setNotificationHandler'>;
  transportFactory?: (url: URL, options: Record<string, unknown>) => Pick<StreamableHTTPClientTransport, 'close'> & {
    onerror: ((error: Error) => void) | null;
    onclose: (() => void) | null;
  };
  ssrfValidator?: SSRFValidator;
  logger?: Logger;
}

export class UpstreamConnectionManager {
  /** Outer key: sessionId, inner key: providerName */
  private readonly connections = new Map<string, Map<string, UpstreamConnection>>();

  /** Key: `${sessionId}:${providerName}` - prevents concurrent duplicate connections */
  private readonly pendingConnections = new Map<string, Promise<Client>>();

  /**
   * Per-session notification queues for buffering when no SSE stream is attached.
   * Key: sessionId (single-provider-per-profile assumption for phase 2).
   * If multi-provider-per-session is needed in future, key should be `${sessionId}:${providerName}`.
   */
  private readonly notificationQueues = new Map<string, NotificationQueue>();

  /** Callback to forward notification to downstream client. Set by HttpTransport. */
  private downstreamNotifyFn: ((sessionId: string, method: string, params?: unknown) => void) | null = null;

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
    schema: typeof ToolListChangedNotificationSchema;
    method: string;
  }> = [
    { schema: ToolListChangedNotificationSchema, method: 'notifications/tools/list_changed' },
    // Future: { schema: ResourceListChangedNotificationSchema, method: 'notifications/resources/list_changed' },
  ];

  private readonly clientFactory: NonNullable<UpstreamConnectionManagerOptions['clientFactory']>;
  private readonly transportFactory: NonNullable<UpstreamConnectionManagerOptions['transportFactory']>;
  private readonly ssrfValidator: SSRFValidator;
  private readonly logger: Logger;

  constructor(options?: UpstreamConnectionManagerOptions) {
    this.clientFactory = options?.clientFactory ?? (
      () => new Client({ name: 'mcp4openapi', version: '0.1.0' })
    );
    this.transportFactory = options?.transportFactory ?? (
      (url, opts) => new StreamableHTTPClientTransport(url, opts) as ReturnType<NonNullable<UpstreamConnectionManagerOptions['transportFactory']>>
    );
    this.logger = options?.logger ?? new ConsoleLogger();
    this.ssrfValidator = options?.ssrfValidator ?? new SSRFValidator(this.logger);
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
   * Drain buffered notifications for a session. Called on SSE reconnect.
   */
  public drainNotifications(sessionId: string): NotificationQueueEntry[] {
    const queue = this.notificationQueues.get(sessionId);
    if (!queue) return [];
    return queue.drain();
  }

  /**
   * Clean up notification queue for a session.
   * Exposed as public so HttpTransport can call it from session destruction hooks
   * (timeout eviction, onSessionDestroy) that may bypass closeAll.
   */
  public cleanupSessionQueue(sessionId: string): void {
    this.notificationQueues.delete(sessionId);
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

    // Return existing CONNECTED client
    const existing = this.getConnection(sessionId, provider.name);
    if (existing && existing.state === 'CONNECTED') {
      existing.lastActivityAt = Date.now();
      return existing.client as Client;
    }

    // Return in-flight promise for concurrent dedup
    const pending = this.pendingConnections.get(dedupKey);
    if (pending) {
      return pending;
    }

    // Remove FAILED connection before creating fresh one
    if (existing && existing.state === 'FAILED') {
      const sessionMap = this.connections.get(sessionId);
      sessionMap?.delete(provider.name);
    }

    const connectPromise = this.createConnection(sessionId, provider, token);
    this.pendingConnections.set(dedupKey, connectPromise as Promise<Client>);

    try {
      const client = await connectPromise;
      return client;
    } finally {
      this.pendingConnections.delete(dedupKey);
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
  private wireNotificationListeners(client: Client, sessionId: string): void {
    for (const { schema, method } of UpstreamConnectionManager.NOTIFICATION_DISPATCH) {
      client.setNotificationHandler(schema, async (notification) => {
        this.handleUpstreamNotification(sessionId, method, notification.params);
      });
    }
  }

  /**
   * Handle an upstream notification: forward to downstream if stream active, otherwise queue.
   * Uses explicit hasActiveStreamFn check to avoid exception-as-control-flow anti-pattern.
   */
  private handleUpstreamNotification(sessionId: string, method: string, params?: unknown): void {
    if (this.downstreamNotifyFn && this.hasActiveStreamFn && this.hasActiveStreamFn(sessionId)) {
      this.downstreamNotifyFn(sessionId, method, params);
      return;
    }
    // Buffer in queue for replay on reconnect (D-08)
    const queue = this.getOrCreateQueue(sessionId);
    queue.push({ method, timestamp: Date.now(), params });
    this.logger.debug('Queued upstream notification for disconnected client', { sessionId, method, queueSize: queue.size });
  }

  /**
   * Close all upstream connections for a session.
   * Transport close errors are swallowed to prevent cascading failures.
   */
  async closeAll(sessionId: string): Promise<void> {
    const sessionMap = this.connections.get(sessionId);
    if (!sessionMap) return;

    const closePromises: Promise<void>[] = [];

    for (const [, conn] of sessionMap) {
      if (conn.heartbeatTimer) {
        clearInterval(conn.heartbeatTimer);
      }
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
    this.notificationQueues.delete(sessionId);
  }

  /**
   * Opt-in early auth validation against upstream validation_endpoint.
   * Performs SSRF validation then a lightweight HTTP probe to verify token is accepted.
   * No-op when validation_endpoint is not configured or token is absent.
   */
  async validateCredentials(
    sessionId: string,
    provider: UpstreamMcpServerConfig,
    token: string | undefined,
  ): Promise<void> {
    if (!provider.validation_endpoint || !token) {
      return;
    }

    // SSRF check first - block private/loopback/link-local targets
    await this.ssrfValidator.validate(provider.validation_endpoint, {
      allowPrivateNetwork: process.env.MCP4_SSRF_ALLOW_PRIVATE_NETWORK === 'true',
    });

    const authHeaders = buildAuthHeaders(provider, token);
    const validationUrl = buildAuthUrl(provider, new URL(provider.validation_endpoint), token);
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
        sanitizeAuthErrorMessage(err.message),
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
      sessionId,
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
    const authHeaders = buildAuthHeaders(provider, token);
    const url = buildAuthUrl(provider, new URL(provider.transport.url), token);

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

    // Wire transport event handlers
    transport.onerror = (error: Error) => {
      this.handleTransportError(sessionId, provider.name, error);
    };

    transport.onclose = () => {
      this.handleTransportClose(sessionId, provider.name);
    };

    try {
      await client.connect(transport as StreamableHTTPClientTransport);
    } catch (error) {
      // Map error to typed upstream error
      throw this.mapConnectError(error, provider);
    }

    // Wire upstream notification listeners after successful connection
    this.wireNotificationListeners(client as Client, sessionId);

    // Store connection
    const now = Date.now();
    const connection: UpstreamConnection = {
      client: client as Client,
      transport: transport as StreamableHTTPClientTransport,
      state: 'CONNECTED',
      providerName: provider.name,
      connectedAt: now,
      lastActivityAt: now,
    };

    let sessionMap = this.connections.get(sessionId);
    if (!sessionMap) {
      sessionMap = new Map();
      this.connections.set(sessionId, sessionMap);
    }
    sessionMap.set(provider.name, connection);

    return client as Client;
  }

  private mapConnectError(error: unknown, provider: UpstreamMcpServerConfig): Error {
    const err = error instanceof Error ? error : new Error(String(error));
    const statusCode = (error as Record<string, unknown>).statusCode as number | undefined;

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
      sanitizeAuthErrorMessage(`Failed to connect to upstream provider '${provider.name}': ${err.message}`),
      provider.name,
    );
  }

  private handleTransportError(sessionId: string, providerName: string, error: Error): void {
    const conn = this.getConnection(sessionId, providerName);
    if (conn) {
      conn.state = 'FAILED';
      conn.lastError = new Error(sanitizeAuthErrorMessage(error.message));
    }
  }

  private handleTransportClose(sessionId: string, providerName: string): void {
    const conn = this.getConnection(sessionId, providerName);
    if (conn) {
      conn.state = 'FAILED';
    }
  }
}
