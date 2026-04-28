/**
 * Profile configuration types
 * 
 * Why these types: Profiles define which MCP tools are exposed and how they map
 * to OpenAPI operations. This enables same server to serve different use cases
 * (admin vs developer vs readonly) without code changes.
 */

export interface Profile {
  profile_name: string;
  profile_id?: string;
  profile_aliases?: string[];
  openapi_spec_path?: string;
  description?: string;
  tools: ToolDefinition[];
  prompts?: PromptDefinition[];
  resources?: ResourceDefinition[];
  interceptors?: InterceptorConfig;
  parameter_aliases?: Record<string, string[]>; // e.g., {"id": ["resource_id", "project_id"]}
  enterprise_authorization?: EnterpriseAuthorizationConfig;
  upstream_mcp?: UpstreamMcpServerConfig[];
  upstream_mcp_from_env?: string;
  
  // OAuth resource metadata (optional overrides)
  resource_name?: string;           // OAuth resource name (overrides OpenAPI info.title)
  resource_documentation?: string;  // OAuth resource documentation URL (overrides OpenAPI externalDocs.url)
}

/**
 * Upstream MCP provider configuration
 *
 * Why: MCP proxy support needs a transport-agnostic provider boundary so remote
 * MCP discovery/invocation can evolve without overloading the OpenAPI profile model.
 * The first iteration supports only remote HTTP streamable MCP upstreams.
 */
export interface UpstreamMcpServerConfig {
  /** Stable provider name used for namespacing, logs, and policy. */
  name: string;

  /** Transport-specific connection settings. */
  transport: UpstreamMcpTransportConfig;

  /** Optional auth from mcp4openapi to the upstream MCP server. */
  auth?: UpstreamMcpAuthConfig;

  /** Optional prefix applied when exposing upstream tools downstream. */
  tool_prefix?: string;

  /** Optional allow/deny policy for upstream tool exposure. */
  tools?: UpstreamMcpToolPolicy;

  /** Optional request timeout for upstream MCP calls. */
  timeout_ms?: number;

  /** Optional endpoint to validate upstream credentials at session init (fail-fast). */
  validation_endpoint?: string;
  /** HTTP method for validation probe. Default: 'HEAD'. */
  validation_method?: 'HEAD' | 'GET';
  /** Timeout for validation probe in ms. Default: 5000. */
  validation_timeout_ms?: number;
}

export type UpstreamMcpTransportConfig = UpstreamMcpHttpStreamableTransportConfig;

export interface UpstreamMcpHttpStreamableTransportConfig {
  type: 'http-streamable';
  url: string;
}

/** Minimal shape shared by auth configs that use bearer/query/custom-header token types. */
export interface AuthTokenConfig {
  type: 'bearer' | 'query' | 'custom-header';
  header_name?: string;
  query_param?: string;
}

/**
 * Upstream auth is intentionally narrower than inbound profile auth.
 * Secrets must be referenced via environment variables, never stored inline.
 */
export interface UpstreamMcpAuthConfig extends AuthTokenConfig {
  value_from_env: string;
}

export interface UpstreamMcpToolPolicy {
  allow?: string[];
  deny?: string[];
}

export interface ResourceDefinition {
  name: string;
  kind: 'static' | 'template';
  uri?: string;
  uri_template?: string;
  title?: string;
  description?: string;
  mime_type: string;
  file_path?: string;
  inline_text?: string;
  fetch?: ResourceFetchDefinition;
  completion?: ResourceCompletionDefinition;
  apps?: ResourceAppsDefinition;
}

export interface ResourceFetchDefinition {
  source: 'operation' | 'composite';
  operation?: string;
  composite_tool?: string;
  parameter_mapping?: Record<string, string>;
  result_path?: string;
  cache_ttl_seconds?: number;
}

export interface ResourceCompletionDefinition {
  variables: Record<string, ResourceCompletionVariableDefinition>;
}

export interface ResourceCompletionVariableDefinition {
  source: 'static' | 'operation' | 'composite_tool';
  values?: string[];
  operation?: string;
  composite_tool?: string;
  result_path?: string;
  label_path?: string;
  value_path?: string;
  parameter_mapping?: Record<string, string>;
}

export interface ResourceAppsDefinition {
  widget_description?: string;
  widget_prefers_border?: boolean;
  widget_csp?: {
    connect_domains?: string[];
    resource_domains?: string[];
  };
  custom_meta?: Record<string, unknown>;
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
  apps?: ToolAppsDefinition;
}

export interface ToolAppsDefinition {
  output_template_resource_uri?: string;
  template_parameter_mapping?: Record<string, string>;
  widget_accessible?: boolean;
  tool_invocation_message?: {
    invoking?: string;
    invoked?: string;
  };
  invocation_text?: {
    invoking?: string;
    invoked?: string;
  };
  annotations?: Record<string, unknown>;
  custom_meta?: Record<string, unknown>;
}

export interface PromptDefinition {
  name: string;
  description?: string;
  arguments?: PromptArgumentDefinition[];
  messages: PromptMessageTemplate[];
}

export interface PromptArgumentDefinition {
  name: string;
  description?: string;
  required?: boolean;
}

export type PromptMessageRole = 'user' | 'assistant';

export interface PromptMessageTemplate {
  role: PromptMessageRole;
  content: PromptContentTemplate;
}

export interface PromptContentTemplate {
  type: 'text';
  text: string;
}

export type ParameterType = 'string' | 'integer' | 'number' | 'boolean' | 'array' | 'object'

export interface ParameterDefinition {
  type: ParameterType | ParameterType[];
  description: string;
  required?: boolean;
  required_for?: string[]; // Which actions require this parameter
  allowed_for?: string[]; // Which actions allow this parameter (optional allowlist)
  forbidden_for?: string[]; // Which actions must reject this parameter
  enum?: string[];
  enum_for?: Record<string, string[]>; // Action-scoped enum values (optional)
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  items?: { type: string };
  properties?: Record<string, unknown>; // For object type (empty {} = free-form object)
  default?: unknown;
  example?: unknown;
  object_entries_to_array?: {
    key_field: string;
    value_field: string;
    wrap_value_field?: string;
  };
  array_item_to_object?: {
    key_field: string;
  };
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

  /**
   * Optional OpenAPI operation ID for direct download endpoint.
   * 
   * Why: Some APIs (e.g., GitLab job artifacts) don't expose pre-signed URLs in metadata.
   * When provided, the proxy will call this endpoint directly instead of extracting a URL.
   */
  download_endpoint?: string;
  
  /** JSON path to URL field in metadata response (default: 'url') */
  url_field?: string;
  
  /** Maximum file size in bytes (default: 10MB = 10485760) */
  max_size_bytes?: number;

  /** Optional environment variable that overrides max_size_bytes (e.g., 'CUSTOM_PROXY_MAX_BYTES') */
  max_size_bytes_from_env?: string;
  
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

  /**
   * Optional allowlist of host patterns for cross-origin downloads when skip_auth=true.
   *
   * Why: When metadata contains a pre-signed or unauthenticated download URL, following it without
   * restrictions can enable SSRF. Use this to restrict which hosts the proxy may contact.
   *
   * Supported patterns:
   * - Exact hostname: "cdn.example.com"
   * - Wildcard subdomain: "*.example.com" (matches "a.example.com", not "example.com")
   * - Exact IP literal: "203.0.113.10" or "2001:db8::1"
   */
  allowed_hosts?: string[];

  /**
   * Allow downloads to private/loopback/link-local IP literals and localhost when skip_auth=true.
   *
   * Default is false to reduce SSRF risk. Set to true only when you explicitly need internal hosts.
   */
  allow_private_network?: boolean;
}

/**
 * Extended operation definition supporting proxy_download
 */
export type OperationDefinition = string | ProxyDownloadOperation;

export interface InterceptorConfig {
  auth?: AuthInterceptor | AuthInterceptor[]; // Single or multiple auth methods
  base_url?: BaseUrlConfig;
  cache?: CacheConfig;
  rate_limit?: RateLimitConfig;
  retry?: RetryConfig;
  array_format?: 'brackets' | 'indices' | 'repeat' | 'comma'; // default: 'repeat'
  timeout_ms?: number; // Request timeout in milliseconds
  redirect_auth_policy?: 'same-origin' | 'never'; // default: 'same-origin'
}

export interface CacheConfig {
  enabled?: boolean; // default: true
  backend?: 'memory' | 'redis'; // default: 'memory'
  scope?: 'auto' | 'public' | 'private' | 'session'; // default: auto (private when auth configured, else public)
  allow_shared_with_auth?: boolean; // default: false; allow explicit public caching for auth-protected but shared content
  ttl_seconds?: number; // default: 300
  max_entries?: number; // default: 1000
  max_memory_bytes?: number; // default: 67108864 (64MB)
  max_memory_bytes_from_env?: string; // optional env override for max_memory_bytes
  methods?: ('GET' | 'HEAD')[];
  vary_headers?: string[]; // default: ['accept', 'accept-language']
}

/**
 * Auth interceptor configuration
 * 
 * - bearer: Standard HTTP Bearer token (Authorization: Bearer <token>)
 * - query: API key in query string (?api_key=<token>)
 * - custom-header: Custom header name (e.g., X-API-Key: <token>)
 * - session-cookie: Form login that exchanges credentials for a maintained session cookie
 * - oauth: OAuth 2.0 Authorization Code Flow with PKCE (HTTP transport only)
 * 
 * Multi-auth support:
 * - When multiple auth methods are provided as array, they are tried in order
 * - priority field determines the order (lower = higher priority)
 * - First successful authentication is used
 * 
 * Token validation (optional):
 * - validation_endpoint: API endpoint to verify token validity (e.g., "/api/v4/user")
 * - validation_allowed_hosts: optional host allowlist for absolute validation_endpoint URLs
 * - Validates token during initialization to fail fast with invalid tokens
 * - Improves UX by rejecting bad tokens immediately, not after first tool call
 */
export interface AuthInterceptor {
  type: 'bearer' | 'query' | 'custom-header' | 'session-cookie' | 'oauth';
  
  // Priority for multi-auth (lower = higher priority, default: 0)
  priority?: number;
  
  // For bearer/query/custom-header
  header_name?: string;  // Required for custom-header
  query_param?: string;  // Required for query
  value_from_env?: string; // Required for bearer/query/custom-header, not used for oauth/session-cookie

  // For oauth type
  oauth_config?: OAuthConfig;

  // For session-cookie type
  session_cookie_config?: SessionCookieConfig;
  
  // OAuth rate limiting (only for oauth type)
  // Overrides default OAuth rate limits (10 requests per 1 minute)
  oauth_rate_limit?: {
    max_requests: number;  // Max requests per window (default: 10)
    window_ms: number;     // Window in milliseconds (default: 60 * 1000 = 1 minute)
  };
  
  // Optional token validation
  validation_endpoint?: string;  // API endpoint to verify token (e.g., "/api/v4/user")
  validation_method?: 'GET' | 'HEAD';  // HTTP method for validation (default: GET)
  validation_timeout_ms?: number;  // Timeout in milliseconds (default: 5000)
  validation_allowed_hosts?: string[]; // Optional allowlist for absolute validation endpoint hosts
}

/**
 * Session cookie authentication configuration
 *
 * Supports direct server-to-server login flows where the API exchanges
 * username/password for a session cookie instead of issuing API tokens.
 */
export interface SessionCookieConfig {
  /**
   * Login endpoint path or absolute URL.
   * Relative paths are resolved against the profile base_url.
   */
  login_endpoint: string;

  /**
   * HTTP method for login. Currently only POST is supported.
   */
  login_method?: 'POST';

  /**
   * Login payload content type.
   */
  login_content_type?: 'application/json' | 'application/x-www-form-urlencoded';

  /**
   * Login form field name for username/login identifier.
   */
  username_field: string;

  /**
   * Environment variable containing the login username.
   */
  username_from_env: string;

  /**
   * Login form field name for password.
   */
  password_field: string;

  /**
   * Environment variable containing the login password.
   */
  password_from_env: string;

  /**
   * Optional extra headers to send with the login request.
   */
  login_static_headers?: Record<string, string>;

  /**
   * Optional extra fields to include in the login request body.
   */
  login_static_body?: Record<string, string>;

  /**
   * Allowed session cookie names accepted from Set-Cookie.
   * At least one matching cookie must be returned by login.
   */
  cookie_names: string[];

  /**
   * Optional allowlist for absolute login endpoints beyond the profile base URL host.
   * Supports exact hosts and *.example.com wildcards.
   */
  login_allowed_hosts?: string[];

  /**
   * HTTP status codes that should trigger relogin and a single replay attempt.
   */
  reauth_on_statuses?: number[];

  /**
   * Backoff applied after failed login/relogin to avoid login storms.
   */
  failure_backoff_ms?: number;

  /**
   * Treat cookies expiring within this skew window as expired.
   */
  expiry_skew_ms?: number;
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

  /**
   * Optional: Allow authorize requests for OAuth client IDs that are not registered
   * on the current instance, but only when redirect_uri matches an approved rule.
   * Disabled by default.
   */
  allow_unregistered_clients?: boolean;

  /**
   * Optional: Approved redirect URI rules for unregistered OAuth clients.
   * Examples:
   * - "http://localhost"
   * - "http://127.0.0.1"
   * - "cursor://"
   * - "cursor://anysphere.cursor-mcp"
   */
  allowed_unregistered_redirect_uris?: string[];
}

export interface EnterpriseAuthorizationConfig {
  enabled: boolean;
  mode?: 'required' | 'optional';
  mode_from_env?: string;
  resource?: string;
  audience?: string | string[];
  audience_from_env?: string;
  issuer: EnterpriseIssuerConfig;
  token_exchange: EnterpriseTokenExchangeConfig;
  access_policy?: EnterpriseAccessPolicyConfig;
  metadata?: EnterpriseMetadataConfig;
}

export interface EnterpriseIssuerConfig {
  issuer: string;
  issuer_from_env?: string;
  jwks_uri?: string;
  jwks_uri_from_env?: string;
  allowed_algs?: Array<'RS256' | 'RS384' | 'RS512' | 'ES256' | 'ES384' | 'ES512'>;
  allowed_algs_from_env?: string;
  allowed_kids?: string[];
  clock_skew_seconds?: number;
  require_signed_assertions?: boolean;
  trust_mode?: 'discovery' | 'explicit';
}

export interface EnterpriseTokenExchangeConfig {
  grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer';
  subject_token_type?: 'urn:ietf:params:oauth:token-type:id_token';
  required_typ?: string[];
  required_claims?: string[];
  max_assertion_ttl_seconds?: number;
  max_assertion_size_bytes?: number;
  replay_protection_ttl_seconds?: number;
  allowed_client_ids?: string[];
}

export interface EnterpriseAccessPolicyConfig {
  claim_mappings?: {
    subject?: string;
    email?: string;
    groups?: string;
    tenant_id?: string;
    client_id?: string;
  };
  claim_mappings_from_env?: string;
  scopes_supported?: string[];
  default_scopes?: string[];
  default_scopes_from_env?: string;
  required_scopes?: string[];
  required_scopes_from_env?: string;
  allowed_tool_categories?: Array<'list' | 'read' | 'modify' | 'admin'>;
  allowed_tool_categories_from_env?: string;
  allow_dynamic_client_registration?: boolean;
}

export interface EnterpriseMetadataConfig {
  authorization_servers?: string[];
  documentation_url?: string;
  display_name?: string;
  extensions?: Record<string, string | boolean | number | string[]>;
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
