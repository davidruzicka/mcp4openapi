/**
 * Application constants
 * 
 * Why: Centralized constants improve readability and maintainability.
 * Magic numbers scattered through code are harder to understand and change.
 */

/**
 * Time conversion constants
 */
export const TIME = {
  MS_PER_SECOND: 1000,
  MS_PER_MINUTE: 60000,
  MS_PER_HOUR: 3600000,
  SECONDS_PER_MINUTE: 60,
  MINUTES_PER_HOUR: 60,
} as const;

/**
 * HTTP status codes
 * 
 * Why: Named constants more readable than numeric literals.
 * Makes intent clear (STATUS_TOO_MANY_REQUESTS vs 429).
 */
export const HTTP_STATUS = {
  OK: 200,
  CREATED: 201,
  ACCEPTED: 202,
  FOUND: 302,
  MULTIPLE_CHOICES: 300,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  NOT_ACCEPTABLE: 406,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_SERVER_ERROR: 500,
  BAD_GATEWAY: 502,
  SERVICE_UNAVAILABLE: 503,
  GATEWAY_TIMEOUT: 504,
} as const;

/**
 * MIME type constants
 * 
 * Why: Prevents typos in content-type headers and ensures consistency.
 */
export const MIME_TYPES = {
  JSON: 'application/json',
  EVENT_STREAM: 'text/event-stream',
  FORM_URLENCODED: 'application/x-www-form-urlencoded',
} as const;

/**
 * OAuth and Well-Known URL paths
 * 
 * Why: Centralized OAuth-related paths for consistency and easy updates.
 */
export const OAUTH_PATHS = {
  AUTHORIZE: '/oauth/authorize',
  TOKEN: '/oauth/token',
  CALLBACK: '/oauth/callback',
  REGISTER: '/oauth/register',
  WELL_KNOWN_AUTHORIZATION_SERVER: '/.well-known/oauth-authorization-server',
  WELL_KNOWN_OPENID_CONFIGURATION: '/.well-known/openid-configuration',
  WELL_KNOWN_PROTECTED_RESOURCE: '/.well-known/oauth-protected-resource/mcp',
} as const;

/**
 * Default timeout and interval values (in milliseconds)
 * 
 * Why: Centralized timing configuration for sessions, heartbeats, and cleanup.
 */
export const TIMEOUTS = {
  SESSION_TIMEOUT_MS: 30 * TIME.MS_PER_MINUTE,  // 30 minutes
  HEARTBEAT_INTERVAL_MS: 30 * TIME.MS_PER_SECOND, // 30 seconds
  RATE_LIMIT_WINDOW_MS: TIME.MS_PER_MINUTE,     // 1 minute
  CLEANUP_INTERVAL_MS: TIME.MS_PER_MINUTE,      // 1 minute
} as const;

/**
 * OAuth rate limiting defaults
 * 
 * Why: Centralized OAuth rate limiting configuration to prevent duplication
 * and ensure consistency across mcp-server.ts and http-transport.ts
 */
export const OAUTH_RATE_LIMIT = {
  MAX_REQUESTS: 10,                              // Max OAuth requests per window
  WINDOW_MS: 10 * TIME.MS_PER_MINUTE,            // 10 minutes window
} as const;

/**
 * Proxy Credentials for local proxy mode (VS Code compatibility)
 *
 * Why: Centralized credentials allow overrides via environment variables
 * and prevent hardcoded secrets in the codebase.
 */
export const PROXY_CREDENTIALS = {
  CLIENT_ID: process.env.MCP_PROXY_CLIENT_ID || 'mcp-proxy-client',
  CLIENT_SECRET: process.env.MCP_PROXY_CLIENT_SECRET || 'mcp-proxy-secret',
} as const;
