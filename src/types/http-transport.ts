/**
 * Type definitions for HTTP transport
 * 
 * Based on MCP Specification 2025-03-26
 * https://modelcontextprotocol.io/specification/2025-03-26/basic/transports
 */

import type { Request as ExpressRequest, Response } from 'express';
import type { OAuthConfig, AuthInterceptor } from './profile.js';
import type { SessionToolFilterRequest, SessionToolFilterCompat as SessionToolFilter } from '../tool-filter/index.js';
import type { OpenAPIParser } from '../openapi-parser.js';

export type { SessionToolFilter, SessionToolFilterRequest };

export interface SessionData {
  id: string;
  createdAt: number;
  lastActivityAt: number;
  sseStreams: Map<string, SSEStreamState>;
  authToken?: string;
  refreshToken?: string; // OAuth refresh token for automatic token renewal
  accessTokenExpiresAt?: number; // Access token expiration timestamp in ms
  scopes?: string[]; // OAuth scopes for debugging/validation
  oauthClientId?: string; // OAuth client ID for debugging/validation
  filtering?: Record<string, string[]>;
  filteringHeader?: string;
  toolFilterRequest?: SessionToolFilterRequest;
  toolFilter?: SessionToolFilter;
  toolFilterHeader?: string;
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
  profileRoutingEnabled?: boolean;
  defaultProfileId?: string;
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
  oauthSessionTimeoutMs?: number; // OAuth session timeout in ms (default: 24 hours, 0 = unlimited)
  oauthRefreshThresholdMs?: number; // Refresh token threshold in ms before expiration (default: 60 seconds)
  parser?: OpenAPIParser; // OpenAPI parser for operation resolution (optional, for category filtering)
}

export interface HttpProfileContext {
  profileId: string;
  oauthConfig?: OAuthConfig;
  authConfigs?: AuthInterceptor[];
  baseUrl?: string;
  rateLimitOAuthMax?: number;
  rateLimitOAuthWindowMs?: number;
  resourceName?: string;
  resourceDocumentation?: string;
  parser?: OpenAPIParser;
}

export interface McpRequest extends ExpressRequest {
  sessionId?: string;
  profileId?: string;
  forceProfilePrefix?: boolean;
}
