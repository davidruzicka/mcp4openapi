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

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { UpstreamMcpServerConfig } from '../types/profile.js';
import type { UpstreamConnection, UpstreamCredentials } from '../types/upstream-connection.js';
import { UpstreamConnectionError, UpstreamTimeoutError, UpstreamAuthError } from './upstream-errors.js';
import { buildAuthHeaders } from './upstream-credential-store.js';
import { sanitizeAuthErrorMessage } from '../auth/auth-redaction.js';

/** Auth-related HTTP status codes */
const AUTH_STATUS_CODES = new Set([401, 403]);

/** Patterns in error messages that indicate authentication failure */
const AUTH_ERROR_PATTERNS = /unauthorized|forbidden|authentication failed|invalid.*token/i;

export interface UpstreamConnectionManagerOptions {
  clientFactory?: () => Pick<Client, 'connect' | 'close'>;
  transportFactory?: (url: URL, options: Record<string, unknown>) => Pick<StreamableHTTPClientTransport, 'close'> & {
    onerror: ((error: Error) => void) | null;
    onclose: (() => void) | null;
  };
}

export class UpstreamConnectionManager {
  /** Outer key: sessionId, inner key: providerName */
  private readonly connections = new Map<string, Map<string, UpstreamConnection>>();

  /** Key: `${sessionId}:${providerName}` - prevents concurrent duplicate connections */
  private readonly pendingConnections = new Map<string, Promise<Client>>();

  private readonly clientFactory: NonNullable<UpstreamConnectionManagerOptions['clientFactory']>;
  private readonly transportFactory: NonNullable<UpstreamConnectionManagerOptions['transportFactory']>;

  constructor(options?: UpstreamConnectionManagerOptions) {
    this.clientFactory = options?.clientFactory ?? (() => {
      throw new Error('Default clientFactory not available in production - inject via options');
    });
    this.transportFactory = options?.transportFactory ?? (() => {
      throw new Error('Default transportFactory not available in production - inject via options');
    });
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
    credentials: UpstreamCredentials,
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

    const connectPromise = this.createConnection(sessionId, provider, credentials);
    this.pendingConnections.set(dedupKey, connectPromise as Promise<Client>);

    try {
      const client = await connectPromise;
      return client;
    } finally {
      this.pendingConnections.delete(dedupKey);
    }
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
        (conn.transport.close() as Promise<void>).catch(() => {
          // Swallow close errors - session is being destroyed anyway
        }),
      );
    }

    await Promise.all(closePromises);
    this.connections.delete(sessionId);
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
    credentials: UpstreamCredentials,
  ): Promise<Client> {
    const authHeaders = buildAuthHeaders(provider, credentials);

    const transport = this.transportFactory(
      new URL(provider.transport.url),
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
