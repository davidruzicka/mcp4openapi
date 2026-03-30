/**
 * Type definitions for upstream MCP connections
 *
 * Defines the state machine, connection shape, and credential interface
 * for managing connections to upstream MCP servers.
 */

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

/** Upstream connection lifecycle states */
export type UpstreamConnectionState =
  | 'IDLE'
  | 'CONNECTING'
  | 'CONNECTED'
  | 'RECONNECTING'
  | 'FAILED';

/** A live connection to an upstream MCP server */
export interface UpstreamConnection {
  client: Client;
  transport: StreamableHTTPClientTransport;
  state: UpstreamConnectionState;
  providerName: string;
  connectedAt?: number;
  lastActivityAt: number;
  lastError?: Error;
  heartbeatTimer?: NodeJS.Timeout;
}

