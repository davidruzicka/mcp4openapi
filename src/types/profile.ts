/**
 * Profile configuration types
 * 
 * Why these types: Profiles define which MCP tools are exposed and how they map
 * to OpenAPI operations. This enables same server to serve different use cases
 * (admin vs developer vs readonly) without code changes.
 */

export interface Profile {
  profile_name: string;
  description?: string;
  tools: ToolDefinition[];
  interceptors?: InterceptorConfig;
  parameter_aliases?: Record<string, string[]>; // e.g., {"id": ["resource_id", "project_id"]}
  
  // OAuth resource metadata (optional overrides)
  resource_name?: string;           // OAuth resource name (overrides OpenAPI info.title)
  resource_documentation?: string;  // OAuth resource documentation URL (overrides OpenAPI externalDocs.url)
}

export interface ToolDefinition {
  name: string;
  description: string;
  
  // Simple tools: direct mapping to single or multiple operations
  operations?: Record<string, OperationDefinition>;
  
  // Composite tools: chain multiple API calls
  composite?: boolean;
  steps?: CompositeStep[];
  partial_results?: boolean; // Return partial results on error (default: false)
  
  parameters: Record<string, ParameterDefinition>;
  
  // Parameters that are metadata (don't go to API body)
  metadata_params?: string[]; // default: ['action', 'resource_type']
  
  // Response field filtering (reduces verbosity for list operations)
  response_fields?: Record<string, string[]>; // e.g., {"list": ["id", "name", "path"]}
  
  // Whether to send response_fields as 'fields' query parameter (e.g. for YouTrack)
  send_response_fields_as_param?: boolean;
}

export interface ParameterDefinition {
  type: 'string' | 'integer' | 'number' | 'boolean' | 'array' | 'object';
  description: string;
  required?: boolean;
  required_for?: string[]; // Which actions require this parameter
  enum?: string[];
  items?: { type: string };
  properties?: Record<string, unknown>; // For object type (empty {} = free-form object)
  default?: unknown;
  example?: unknown;
}

export interface CompositeStep {
  call: string; // e.g., "GET /projects/{id}/merge_requests/{iid}"
  store_as: string; // JSONPath-like: "merge_request", "merge_request.comments"
  depends_on?: string[]; // Optional dependencies on other steps' store_as values
}

/**
 * Proxy download operation configuration
 * 
 * Why: Some APIs return file URLs that require authentication.
 * LLM cannot fetch these directly, so we proxy the download.
 */
export interface ProxyDownloadOperation {
  /** Must be 'proxy_download' */
  type: 'proxy_download';
  
  /** OpenAPI operation ID to fetch metadata (e.g., 'get_/issues/{id}/attachments/{attachmentId}') */
  metadata_endpoint: string;
  
  /** JSON path to URL field in metadata response (default: 'url') */
  url_field?: string;
  
  /** Maximum file size in bytes (default: 10MB = 10485760) */
  max_size_bytes?: number;
  
  /** Timeout for download in milliseconds (default: 30000) */
  timeout_ms?: number;
  
  /** Optional MIME type whitelist (e.g., ['image/*', 'application/pdf']) */
  allowed_mime_types?: string[];
  
  /**
   * Skip authentication for download URL (default: false)
   * 
   * Set to true for pre-signed URLs or public download links that don't need auth.
   * Metadata endpoint still uses normal authentication, only the file download is unauthenticated.
   * 
   * Example use cases:
   * - AWS S3 pre-signed URLs (https://bucket.s3.amazonaws.com/file?X-Amz-Signature=...)
   * - Azure Blob Storage SAS tokens (https://storage.blob.core.windows.net/container/file?sv=...)
   * - Temporary download URLs with embedded tokens
   */
  skip_auth?: boolean;
}

/**
 * Extended operation definition supporting proxy_download
 */
export type OperationDefinition = string | ProxyDownloadOperation;

export interface InterceptorConfig {
  auth?: AuthInterceptor | AuthInterceptor[]; // Single or multiple auth methods
  base_url?: BaseUrlConfig;
  rate_limit?: RateLimitConfig;
  retry?: RetryConfig;
  array_format?: 'brackets' | 'indices' | 'repeat' | 'comma'; // default: 'repeat'
}

/**
 * Auth interceptor configuration
 * 
 * - bearer: Standard HTTP Bearer token (Authorization: Bearer <token>)
 * - query: API key in query string (?api_key=<token>)
 * - custom-header: Custom header name (e.g., X-API-Key: <token>)
 * - oauth: OAuth 2.0 Authorization Code Flow with PKCE (HTTP transport only)
 * 
 * Multi-auth support:
 * - When multiple auth methods are provided as array, they are tried in order
 * - priority field determines the order (lower = higher priority)
 * - First successful authentication is used
 * 
 * Token validation (optional):
 * - validation_endpoint: API endpoint to verify token validity (e.g., "/api/v4/user")
 * - Validates token during initialization to fail fast with invalid tokens
 * - Improves UX by rejecting bad tokens immediately, not after first tool call
 */
export interface AuthInterceptor {
  type: 'bearer' | 'query' | 'custom-header' | 'oauth';
  
  // Priority for multi-auth (lower = higher priority, default: 0)
  priority?: number;
  
  // For bearer/query/custom-header
  header_name?: string;  // Required for custom-header
  query_param?: string;  // Required for query
  value_from_env?: string; // Required for bearer/query/custom-header, not used for oauth
  
  // For oauth type
  oauth_config?: OAuthConfig;
  
  // OAuth rate limiting (only for oauth type)
  // Overrides default OAuth rate limits (10 requests per 10 minutes)
  oauth_rate_limit?: {
    max_requests: number;  // Max requests per window (default: 10)
    window_ms: number;     // Window in milliseconds (default: 10 * 60 * 1000 = 10 minutes)
  };
  
  // Optional token validation
  validation_endpoint?: string;  // API endpoint to verify token (e.g., "/api/v4/user")
  validation_method?: 'GET' | 'HEAD';  // HTTP method for validation (default: GET)
  validation_timeout_ms?: number;  // Timeout in milliseconds (default: 5000)
}

/**
 * OAuth 2.0 configuration
 * 
 * Supports Authorization Code Flow with PKCE (RFC 7636)
 * Only available in HTTP transport mode
 * 
 * Client registration can be:
 * - Static: pre-registered client_id and client_secret
 * - Dynamic: RFC 7591 dynamic client registration
 */
export interface OAuthConfig {
  /**
   * OAuth 2.0 issuer URL (RFC 8414)
   * e.g., "https://www.gitlab.com"
   * 
   * When provided, authorization_endpoint and token_endpoint are auto-derived:
   * - Tries fetching /.well-known/oauth-authorization-server
   * - Falls back to standard paths: /oauth/authorize and /oauth/token
   * 
   * Can reference environment variables: "${env:OAUTH_ISSUER}"
   * 
   * Priority: If both issuer and explicit endpoints are provided, explicit endpoints take precedence.
   */
  issuer?: string;
  
  /**
   * OAuth 2.0 authorization endpoint
   * e.g., "https://www.gitlab.com/oauth/authorize"
   * 
   * Optional if issuer is provided.
   * Can reference environment variables: "${env:OAUTH_AUTHORIZATION_URL}"
   */
  authorization_endpoint?: string;
  
  /**
   * OAuth 2.0 token endpoint
   * e.g., "https://www.gitlab.com/oauth/token"
   * 
   * Optional if issuer is provided.
   * Can reference environment variables: "${env:OAUTH_TOKEN_URL}"
   */
  token_endpoint?: string;
  
  /**
   * Pre-registered OAuth client ID (for static client registration)
   * Optional - if not provided, uses dynamic client registration (RFC 7591)
   * 
   * Can reference environment variables: "${env:OAUTH_CLIENT_ID}"
   */
  client_id?: string;
  
  /**
   * Pre-registered OAuth client secret (for static client registration)
   * Optional - only needed for confidential clients
   * 
   * Can reference environment variables: "${env:OAUTH_CLIENT_SECRET}"
   */
  client_secret?: string;
  
  /**
   * OAuth 2.0 scopes to request
   * e.g., ["api", "read_user", "write_repository"]
   * Optional - if not provided, no scopes will be requested (some APIs don't require scopes)
   */
  scopes?: string[];
  
  /**
   * Redirect URI for OAuth callback
   * Defaults to: http://{MCP4_HOST}:{MCP4_PORT}/oauth/callback
   * 
   * Must match URI registered with OAuth provider
   */
  redirect_uri?: string;
  
  /**
   * Optional: Client registration endpoint for dynamic registration (RFC 7591)
   * e.g., "https://www.gitlab.com/oauth/register"
   * 
   * If provided and client_id is not set, will attempt dynamic client registration
   */
  registration_endpoint?: string;
  
  /**
   * Optional: Token introspection endpoint (RFC 7662)
   * e.g., "https://www.gitlab.com/oauth/introspect"
   * 
   * Used for token validation
   */
  introspection_endpoint?: string;
  
  /**
   * Optional: Token revocation endpoint (RFC 7009)
   * e.g., "https://www.gitlab.com/oauth/revoke"
   */
  revocation_endpoint?: string;

  /**
   * Optional: Allowed redirect hosts for OAuth callbacks
   * Used to prevent open redirect vulnerabilities
   * 
   * Supports wildcards: "*.example.com" matches any subdomain
   * Defaults to ["localhost", "127.0.0.1"] for security
   * 
   * Can reference MCP4_ALLOWED_ORIGINS environment variable
   */
  allowed_redirect_hosts?: string[];
}

export interface BaseUrlConfig {
  value_from_env: string;
  default?: string;
}

export interface RateLimitConfig {
  max_requests_per_minute: number;
  overrides?: Record<string, { max_requests_per_minute: number }>;
}

export interface RetryConfig {
  max_attempts: number;
  backoff_ms: number[]; // e.g., [1000, 2000, 4000]
  retry_on_status: number[];
}

