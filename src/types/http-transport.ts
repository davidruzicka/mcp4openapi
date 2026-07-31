/**
 * Type definitions for HTTP transport
 * 
 * Based on MCP Specification 2025-03-26
 * https://modelcontextprotocol.io/specification/2025-03-26/basic/transports
 */

import type { Request as ExpressRequest, Response } from 'express';
import type { OAuthConfig, AuthInterceptor, EnterpriseAuthorizationConfig, UpstreamMcpServerConfig, ClientAuthGateConfig, ConsentGateConfig } from './profile.js';
import type { HttpTenantIndex } from './http-tenants.js';
import type { SessionToolFilterRequest, SessionToolFilterCompat as SessionToolFilter } from '../tool-filter/index.js';
import type { OpenAPIParser } from '../openapi/openapi-parser.js';
import type { FilteringRules } from '../core/filtering.js';
import type { AuthorizedPrincipal } from '../auth/inbound-auth-principal.js';

export type { SessionToolFilter, SessionToolFilterRequest };

export const PROFILE_INDEX_REDIRECT_STATUSES = [301, 302] as const;
export type ProfileIndexRedirectStatus = (typeof PROFILE_INDEX_REDIRECT_STATUSES)[number];

export interface SessionData {
  id: string;
  createdAt: number;
  lastActivityAt: number;
  sseStreams: Map<string, SSEStreamState>;
  replayQueue: QueuedMessage[];
  nextEventId: number; // Monotonic counter for SSE event IDs (shared across POST and GET SSE responses)
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
  tenantId?: string;
  tenantBaseUrl?: string;
  tenantHeaderValue?: string;
  tenantAuthMode?: 'oauth' | 'token';
  tenantOAuthConfig?: OAuthConfig;
  tenantAuthConfigs?: AuthInterceptor[];
  /**
   * Authenticated client identity resolved by the client auth gate.
   *
   * Populated during session init when `client_auth_gate` is configured on the
   * profile. Downstream policy/audit code reads this to attribute tool calls
   * to a specific subject. Undefined when the gate is absent or `mode=optional`
   * and no identity was resolved.
   */
  clientPrincipal?: AuthorizedPrincipal;
}

export interface SSEStreamState {
  streamId: string;
  lastEventId: number;
  active: boolean;
  response: Response; // HTTP response object for closing the stream
}

export interface QueuedMessage {
  eventId: number;
  data: unknown;
  timestamp: number;
}

export interface EnterpriseAuthorizationRuntimeConfig {
  enabled?: boolean;
  global_max_cached_jwks_keys?: number;
  global_max_cached_issuers?: number;
  global_max_replay_entries?: number;
  global_max_enterprise_tokens?: number;
  jwks_refresh_timeout_ms?: number;
  jwks_refresh_backoff_ms?: number;
  enterprise_grant_rate_limit_max?: number;
  enterprise_grant_rate_limit_window_ms?: number;
  enterprise_grant_max_concurrency_per_profile?: number;
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
  profileIndexEnabled?: boolean;
  profileIndexRedirectUrl?: string;
  profileIndexRedirectStatus?: ProfileIndexRedirectStatus;
  defaultProfileId?: string;
  allowedOrigins?: string[]; // Allowed origins/CIDR ranges
  rateLimitEnabled?: boolean; // Enable rate limiting (default: true)
  rateLimitWindowMs?: number; // Rate limit window in ms (default: 60000 = 1 min)
  rateLimitMaxRequests?: number; // Max requests per window (default: 100)
  rateLimitMetricsMax?: number; // Max requests for /metrics (default: 10)
  rateLimitOAuthMax?: number; // Max OAuth requests per window (default: 10)
  rateLimitOAuthWindowMs?: number; // OAuth rate limit window in ms (default: 1 minute)
  maxTokenLength?: number; // Maximum token length in characters (default: 1000)
  /**
   * 32-byte symmetric key used to encrypt/decrypt token envelopes (mcp4.v1.* tokens).
   * Derived from `MCP4_OAUTH_KEY` env var by `deriveTokenKey()`:
   *   - 64-char hex string -> Buffer.from(raw, 'hex')
   *   - anything else      -> scrypt(raw, fixed application salt, 32)
   * When undefined, the gateway operates in plain-token mode (backward compat).
   * See src/auth/token-envelope.ts for the envelope format and security boundary.
   */
  tokenKey?: Buffer;
  /**
   * Legacy SHA-256-derived key used only as a decrypt fallback for envelopes
   * issued before the scrypt KDF migration. Undefined for 64-hex keys (both
   * KDFs derive identically there) and when tokenKey is unset.
   */
  legacyTokenKey?: Buffer;
  trustProxy?: boolean | number | string; // Express trust proxy setting
  oauthConfig?: OAuthConfig; // OAuth 2.0 configuration (optional)
  baseUrl?: string; // Base URL for API (for token validation)
  authConfigs?: AuthInterceptor[]; // Auth configurations (for token validation)
  enterpriseAuthorization?: EnterpriseAuthorizationConfig;
  enterpriseAuthorizationRuntimeConfig?: EnterpriseAuthorizationRuntimeConfig;
  resourceName?: string; // OAuth resource name (from OpenAPI info.title or profile override)
  resourceDocumentation?: string; // OAuth resource documentation URL (from OpenAPI externalDocs.url or profile override)
  sslCertFile?: string; // Path to SSL certificate file
  sslKeyFile?: string; // Path to SSL key file
  oauthSessionTimeoutMs?: number; // OAuth session timeout in ms (default: 24 hours, 0 = unlimited)
  oauthRefreshThresholdMs?: number; // Refresh token threshold in ms before expiration (default: 60 seconds)
  parser?: OpenAPIParser; // OpenAPI parser for operation resolution (optional, for category filtering)
  tenantIndex?: HttpTenantIndex; // Preloaded tenant configuration index (optional)
  globalFiltering?: FilteringRules; // Process-wide baseline parameter filtering
  upstreamMcp?: UpstreamMcpServerConfig; // Upstream MCP provider for this profile
  client_auth_gate?: ClientAuthGateConfig; // Inbound client auth gate (single-profile mode)
}

export interface HttpProfileContext {
  profileId: string;
  oauthConfig?: OAuthConfig;
  authConfigs?: AuthInterceptor[];
  enterpriseAuthorization?: EnterpriseAuthorizationConfig;
  baseUrl?: string;
  rateLimitOAuthMax?: number;
  rateLimitOAuthWindowMs?: number;
  resourceName?: string;
  resourceDocumentation?: string;
  parser?: OpenAPIParser;
  upstreamMcp?: UpstreamMcpServerConfig;
  client_auth_gate?: ClientAuthGateConfig;
  consent_gate?: ConsentGateConfig;
}

export interface McpRequest extends ExpressRequest {
  sessionId?: string;
  profileId?: string;
  forceProfilePrefix?: boolean;
}
