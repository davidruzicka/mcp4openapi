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
  NOT_MODIFIED: 304,
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
 * Default loopback redirect allowances for local OAuth clients.
 *
 * Why: Keep loopback host defaults centralized so logs, validation, and
 * compatibility fallbacks stay aligned without scattering hardcoded hosts.
 */
export const DEFAULT_ALLOWED_REDIRECT_HOSTS = ['localhost', '127.0.0.1'] as const;
export const DEFAULT_OAUTH_LOOPBACK_CALLBACK_URIS = DEFAULT_ALLOWED_REDIRECT_HOSTS.map(
  (host) => `http://${host}:3003${OAUTH_PATHS.CALLBACK}`,
);

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
  HTTP_REQUEST_TIMEOUT_MS: 30 * TIME.MS_PER_SECOND, // 30 seconds
} as const;

/**
 * OAuth rate limiting defaults
 * 
 * Why: Centralized OAuth rate limiting configuration to prevent duplication
 * and ensure consistency across mcp-server.ts and http-transport.ts
 */
export const OAUTH_RATE_LIMIT = {
  MAX_REQUESTS: 10,                              // Max OAuth requests per window
  WINDOW_MS: TIME.MS_PER_MINUTE,                 // 1 minute window
} as const;

/**
 * OAuth state/code cleanup defaults
 *
 * Why: Keep OAuth state lifetime independent from request rate limiting.
 */
export const OAUTH_CLEANUP = {
  STATE_TIMEOUT_MS: 10 * TIME.MS_PER_MINUTE,     // 10 minutes
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

export const INPUT_LIMITS = {
  METHOD_NAME_LOG: 200,        // max chars of req.method reflected in server logs
  PROMPT_NAME: 256,            // max chars for prompts/get "name" param
  RESOURCE_URI: 2048,          // max chars for resources/read "uri" param
  TOOL_NAME_ERROR_MSG: 100,    // max chars of tool name reflected in error messages to clients
  TOOL_NAME_AUDIT: 255,        // max chars of tool name in audit:tool_call log entries
  TOOL_NAME_LABEL: 64,         // max chars of tool name used as a Prometheus label value
  OPERATION_LABEL: 64,         // max chars of operation name used as a Prometheus label value
  CLIENT_PRINCIPAL_AUDIT: 256, // max chars of clientPrincipal in audit:tool_call log entries (256 matches OIDC sub max)
} as const;
