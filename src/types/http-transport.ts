/**
 * Type definitions for HTTP transport
 * 
 * Based on MCP Specification 2025-03-26
 * https://modelcontextprotocol.io/specification/2025-03-26/basic/transports
 */

import type { Request as ExpressRequest, Response } from 'express';
import type { OAuthConfig, AuthInterceptor } from './profile.js';

export interface SessionData {
  id: string;
  createdAt: number;
  lastActivityAt: number;
  sseStreams: Map<string, SSEStreamState>;
  authToken?: string;
}

export interface SSEStreamState {
  streamId: string;
  lastEventId: number;
  messageQueue: QueuedMessage[];
  active: boolean;
  response: Response; // HTTP response object for closing the stream
}

export interface QueuedMessage {
  eventId: number;
  data: unknown;
  timestamp: number;
}

export interface HttpTransportConfig {
  host: string;
  port: number;
  sessionTimeoutMs: number;
  heartbeatEnabled: boolean;
  heartbeatIntervalMs: number;
  metricsEnabled: boolean;
  metricsPath: string;
  allowedOrigins?: string[]; // Allowed origins/CIDR ranges
  rateLimitEnabled?: boolean; // Enable rate limiting (default: true)
  rateLimitWindowMs?: number; // Rate limit window in ms (default: 60000 = 1 min)
  rateLimitMaxRequests?: number; // Max requests per window (default: 100)
  rateLimitMetricsMax?: number; // Max requests for /metrics (default: 10)
  rateLimitOAuthMax?: number; // Max OAuth requests per window (default: 10)
  rateLimitOAuthWindowMs?: number; // OAuth rate limit window in ms (default: 10 minutes)
  maxTokenLength?: number; // Maximum token length in characters (default: 1000)
  oauthConfig?: OAuthConfig; // OAuth 2.0 configuration (optional)
  baseUrl?: string; // Base URL for API (for token validation)
  authConfigs?: AuthInterceptor[]; // Auth configurations (for token validation)
  resourceName?: string; // OAuth resource name (from OpenAPI info.title or profile override)
  resourceDocumentation?: string; // OAuth resource documentation URL (from OpenAPI externalDocs.url or profile override)
  sslCertFile?: string; // Path to SSL certificate file
  sslKeyFile?: string; // Path to SSL key file
}

export interface McpRequest extends ExpressRequest {
  sessionId?: string;
}

