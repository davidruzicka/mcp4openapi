/**
 * Main MCP server implementation
 * 
 * Why: Coordinates OpenAPI parser, profile loader, tool generator, and request execution.
 * Single entry point for tool registration and invocation.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  CompleteRequestSchema,
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type CompleteRequest,
} from '@modelcontextprotocol/sdk/types.js';

import { OpenAPIParser } from '../openapi/openapi-parser.js';
import { createLoadedProfileAppsModel, extractTemplateVariables, getNestedValue, type LoadedProfileAppsModel, type LoadedResourceFetchStrategy, type LoadedTemplateResource, type LoadedCompletionVariable } from '../profile/profile-apps.js';
import { ProfileLoader } from '../profile/profile-loader.js';
import { composeToolDescriptor } from '../tooling/tool-app-descriptor.js';
import { ToolGenerator } from '../tooling/tool-generator.js';
import { applyParameterDefaults, normalizeArguments } from '../validation/argument-normalizer.js';
import { CompositeExecutor } from '../tooling/composite-executor.js';
import { ProxyDownloadExecutor } from '../tooling/proxy-executor.js';
import {
  enforceFiltering,
  mergeFilteringRules,
  parseFilteringHeader,
  type FilteringRules,
} from '../core/filtering.js';
import { 
  ConfigurationError, 
  OperationNotFoundError, 
  ResourceNotFoundError,
  ValidationError, 
  AuthenticationError,
  AuthorizationError,
  RateLimitError,
  NetworkError,
  generateCorrelationId
} from '../core/errors.js';
import { OAUTH_RATE_LIMIT } from '../core/constants.js';
import { HttpClient } from '../transport/interceptors.js';
import { HttpClientFactory } from '../transport/http-client-factory.js';
import { SchemaValidator } from '../validation/schema-validator.js';
import type { Profile, ToolDefinition, AuthInterceptor, OAuthConfig, ProxyDownloadOperation, UpstreamMcpServerConfig } from '../types/profile.js';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { sanitizeToolList, isValidUpstreamToolName, applyProviderToolPolicy, isToolAllowedByProviderPolicy } from '../upstream/upstream-tool-sanitizer.js';
import { UpstreamConnectionManager } from '../upstream/upstream-connection-manager.js';
import {
  UpstreamConnectionError,
  UpstreamTimeoutError,
  UpstreamAuthError,
  UpstreamMalformedResponseError,
} from '../upstream/upstream-errors.js';
import type { Logger } from '../core/logger.js';
import { ConsoleLogger, JsonLogger, LogLevel } from '../core/logger.js';
import type { OperationInfo, SchemaInfo } from '../types/openapi.js';
import { isInitializeRequest, isToolCallRequest } from '../validation/jsonrpc-validator.js';
import { generateNameWarnings, type NameWarningOptions } from '../core/naming-warnings.js';
import { NamingStrategy, type OperationForNaming } from '../core/naming.js';
import { isSafePropertyName } from '../validation/validation-utils.js';
import {
  ToolFilterService,
  EnvConfigParser,
  HeaderConfigParser,
  RegexCompiler,
  RegexValidator,
  OperationClassifier,
  OpenAPIOperationResolver,
  OperationDetector,
  applySessionToolFilter,
  matchesSessionFilterByName,
  type SessionToolFilterCompat as SessionToolFilter,
  type SessionToolFilterRequest,
} from '../tool-filter/index.js';
import type { HttpProfileContext } from '../types/http-transport.js';
import type { HttpTransport } from '../transport/http-transport.js';
import { buildHttpTransportBaseConfig } from '../transport/http-transport-config.js';
import { renderPrompt } from '../prompt/prompt-renderer.js';
import type { MetricsCollector, MetricsContextLabels } from '../core/metrics.js';

type EnterpriseToolCategory = 'list' | 'read' | 'modify' | 'admin';

/** MCP SDK RequestTimeout code (-32001); used for upstream timeout responses */
const UPSTREAM_TIMEOUT_ERROR_CODE = ErrorCode.RequestTimeout;

const UPSTREAM_ERROR_MAPPINGS: ReadonlyArray<[new (...args: never[]) => Error, number, string]> = [
  [UpstreamConnectionError, ErrorCode.InternalError, 'Upstream connection failed'],
  [UpstreamTimeoutError, UPSTREAM_TIMEOUT_ERROR_CODE, 'Upstream request timed out'],
  [UpstreamAuthError, ErrorCode.InvalidRequest, 'Upstream authentication failed'],
  [UpstreamMalformedResponseError, ErrorCode.InternalError, 'Upstream returned malformed response'],
];

/**
 * Map an upstream error to a client-facing MCP error object.
 * Provider name is placed in data only - never leaked into the client-facing message string.
 */
function mapUpstreamErrorToMcpError(
  error: unknown,
  providerName: string,
): { code: number; message: string; data?: unknown } {

  const correlationId =
    error instanceof Error && 'details' in error
      ? ((error as Record<string, unknown>).details as Record<string, unknown> | undefined)
          ?.correlationId as string | undefined
      : undefined;

  for (const [ErrorClass, code, messagePrefix] of UPSTREAM_ERROR_MAPPINGS) {
    if (error instanceof ErrorClass) {
      return {
        code,
        message: correlationId ? `${messagePrefix} (correlation: ${correlationId})` : messagePrefix,
        data: { correlationId, providerName },
      };
    }
  }

  return {
    code: ErrorCode.InternalError,
    message: correlationId ? `Upstream error (correlation: ${correlationId})` : 'Upstream error',
    data: { correlationId, providerName },
  };
}

export class MCPServer {
  private server: Server;
  private parser: OpenAPIParser;
  private profile?: Profile;
  private appsModel?: LoadedProfileAppsModel;
  private toolGenerator: ToolGenerator;
  private httpClientFactory = new HttpClientFactory();
  private compositeExecutor?: CompositeExecutor;
  private appsFetchCache = new Map<string, { expiresAt: number; value: string }>();
  private schemaValidator: SchemaValidator;
  private logger: Logger;
  private httpTransport: HttpTransport | null = null;
  private stdioFiltering?: FilteringRules;
  private globalFiltering?: FilteringRules;
  private toolFilterService?: ToolFilterService;
  private globalToolFilterSummary?: {
    originalCount: number;
    allowedCount: number;
    removedCount: number;
    patternCounts: Record<string, number>;
  };

  /** Callback injected by HttpTransport to obtain a connected upstream MCP Client. HTTP-only. */
  private getUpstreamClientFn:
    | ((sessionId: string, provider: UpstreamMcpServerConfig, token: string | undefined) => Promise<Client>)
    | null = null;

  /** Prevents the stdio upstream_mcp misconfiguration warning from repeating on every request. */
  private upstreamStdioWarnLogged = false;

  /**
   * Cache of sanitized+policy-filtered tool names per session and provider.
   * Populated by handleUpstreamToolsList; consulted by handleToolCall to prevent
   * tools dropped by sanitization (bad description/inputSchema) from being invoked
   * directly via tools/call with a valid name (sanitization bypass, D-05).
   * Outer key: sessionId, inner key: providerName.
   */
  private readonly sanitizedAndPolicyFilteredToolNames = new Map<string, Map<string, Set<string>>>();

  /**
   * Execute a tools/call request via the JSON-RPC handler.
   * Intended for internal use and tests to avoid accessing private methods.
   */
  async callToolRpc(
    name: string,
    args: Record<string, unknown>,
    sessionId?: string,
    requestId: string | number = 1
  ): Promise<unknown> {
    const message = {
      jsonrpc: '2.0',
      id: requestId,
      method: 'tools/call',
      params: {
        name,
        arguments: args,
      },
    };

    return this.handleToolCall(message, sessionId);
  }

  /**
   * Filter response payload to include only specified fields.
   *
   * Supports YouTrack-style field selectors like:
   * - "author(id,login)"
   * - "comments(id,text,author(id,login))"
   *
   * Recurses into nested objects and arrays when subfields are specified.
   */
  private filterFields(data: unknown, fields: string[]): unknown {
    const selection = this.parseFieldSelection(fields);
    return this.applyFieldSelection(data, selection);
  }

  private parseFieldSelection(fields: string[]): Record<string, true | Record<string, unknown>> {
    const root: Record<string, true | Record<string, unknown>> = Object.create(null);

    for (const field of fields) {
      const trimmed = field.trim();
      if (!trimmed) continue;
      this.mergeFieldSelector(root, trimmed);
    }

    return root;
  }

  private mergeFieldSelector(
    target: Record<string, true | Record<string, unknown>>,
    selector: string
  ): void {
    const parsed = this.parseFieldSelector(selector);
    const baseName = parsed.baseName;
    if (!baseName) return;
    if (!isSafePropertyName(baseName)) return;
    if (!parsed.inner) {
      target[baseName] = true;
      return;
    }

    const inner = parsed.inner;
    const subSelectors = this.splitTopLevel(inner);
    const subTree: Record<string, true | Record<string, unknown>> = Object.create(null);
    for (const sub of subSelectors) {
      this.mergeFieldSelector(subTree, sub);
    }

    const existing = target[baseName];
    if (existing === true) return;
    if (!existing) {
      target[baseName] = subTree;
      return;
    }

    this.mergeSelectionTrees(existing as Record<string, true | Record<string, unknown>>, subTree);
  }

  private parseFieldSelector(selector: string): { baseName: string; inner?: string } {
    const trimmed = selector.trim();
    if (!trimmed) return { baseName: '' };

    if (trimmed.startsWith('"')) {
      const parsedQuoted = this.parseQuotedBase(trimmed);
      if (parsedQuoted) {
        const { baseName, rest } = parsedQuoted;
        const remaining = rest.trim();
        if (!remaining) {
          return { baseName };
        }
        if (remaining.startsWith('(') && remaining.endsWith(')')) {
          const inner = remaining.slice(1, -1).trim();
          return inner ? { baseName, inner } : { baseName };
        }
        return { baseName };
      }
    }

    const openParen = trimmed.indexOf('(');
    if (openParen === -1) {
      return { baseName: trimmed };
    }

    const closeParen = trimmed.lastIndexOf(')');
    if (closeParen === -1 || closeParen <= openParen) {
      return { baseName: trimmed.slice(0, openParen).trim() };
    }

    const baseName = trimmed.slice(0, openParen).trim();
    const inner = trimmed.slice(openParen + 1, closeParen).trim();
    return inner ? { baseName, inner } : { baseName };
  }

  private parseQuotedBase(input: string): { baseName: string; rest: string } | undefined {
    let escaped = false;
    let base = '';

    for (let i = 1; i < input.length; i += 1) {
      const ch = input[i];
      if (escaped) {
        base += ch;
        escaped = false;
        continue;
      }

      if (ch === '\\') {
        escaped = true;
        continue;
      }

      if (ch === '"') {
        const rest = input.slice(i + 1);
        return { baseName: base, rest };
      }

      base += ch;
    }

    return undefined;
  }

  private mergeSelectionTrees(
    target: Record<string, true | Record<string, unknown>>,
    incoming: Record<string, true | Record<string, unknown>>
  ): void {
    for (const [key, val] of Object.entries(incoming)) {
      if (!isSafePropertyName(key)) continue;
      const existing = target[key];
      if (!existing) {
        target[key] = val;
        continue;
      }
      if (existing === true || val === true) {
        target[key] = true;
        continue;
      }
      this.mergeSelectionTrees(
        existing as Record<string, true | Record<string, unknown>>,
        val as Record<string, true | Record<string, unknown>>
      );
    }
  }

  private splitTopLevel(input: string): string[] {
    const result: string[] = [];
    let depth = 0;
    let current = '';
    let inQuote = false;
    let escaped = false;

    for (const ch of input) {
      if (escaped) {
        current += ch;
        escaped = false;
        continue;
      }

      if (ch === '\\' && inQuote) {
        current += ch;
        escaped = true;
        continue;
      }

      if (ch === '"') {
        inQuote = !inQuote;
        current += ch;
        continue;
      }

      if (!inQuote) {
        if (ch === '(') depth += 1;
        if (ch === ')') depth = Math.max(0, depth - 1);
      }

      if (!inQuote && ch === ',' && depth === 0) {
        const trimmed = current.trim();
        if (trimmed) result.push(trimmed);
        current = '';
        continue;
      }

      current += ch;
    }

    const last = current.trim();
    if (last) result.push(last);
    return result;
  }

  private applyFieldSelection(
    data: unknown,
    selection: Record<string, true | Record<string, unknown>>
  ): unknown {
    if (!data || typeof data !== 'object') {
      return data;
    }

    if (Array.isArray(data)) {
      return data.map(item => this.applyFieldSelection(item, selection));
    }

    const obj = data as Record<string, unknown>;
    const filtered: Record<string, unknown> = Object.create(null);

    for (const [key, sel] of Object.entries(selection)) {
      if (!isSafePropertyName(key)) continue;
      if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
      const value = obj[key];
      if (sel === true) {
        filtered[key] = value;
      } else {
        filtered[key] = this.applyFieldSelection(value, sel as Record<string, true | Record<string, unknown>>);
      }
    }

    return filtered;
  }

  /**
   * Format error message for client with correlation ID
   * 
   * Why: Categorize errors as "safe" (4xx client errors) vs "unsafe" (5xx server errors)
   * Safe errors show API message to help user fix the issue
   * Unsafe errors show generic message to avoid leaking sensitive info
   */
  private formatErrorForClient(error: unknown, correlationId: string): string {
    // Authentication errors - safe to show (token expired, invalid credentials)
    if (error instanceof AuthenticationError) {
      return `Authentication failed: ${error.message} (correlation ID: ${correlationId})`;
    }

    // Authorization errors - safe to show (insufficient permissions)
    if (error instanceof AuthorizationError) {
      return `Authorization failed: ${error.message} (correlation ID: ${correlationId})`;
    }

    // Rate limit errors - safe to show (helps user understand backoff)
    if (error instanceof RateLimitError) {
      const retryInfo = error.details?.retryAfter 
        ? ` Retry after ${error.details.retryAfter} seconds.`
        : '';
      return `Rate limit exceeded: ${error.message}${retryInfo} (correlation ID: ${correlationId})`;
    }

    // Network errors with 4xx status - safe to show (client errors)
    if (error instanceof NetworkError && error.details?.statusCode) {
      const statusCode = error.details.statusCode as number;
      if (statusCode >= 400 && statusCode < 500) {
        return `Request failed: ${error.message} (correlation ID: ${correlationId})`;
      }
    }

    // Validation errors - safe to show (helps user fix input)
    if (error instanceof ValidationError) {
      return `Validation error: ${error.message} (correlation ID: ${correlationId})`;
    }

    // Operation not found - safe to show (configuration issue)
    if (error instanceof OperationNotFoundError) {
      return `Operation not found: ${error.message} (correlation ID: ${correlationId})`;
    }

    if (error instanceof ResourceNotFoundError) {
      return `${error.message} (correlation ID: ${correlationId})`;
    }

    // Configuration errors - safe to show (helps admin fix setup)
    if (error instanceof ConfigurationError) {
      return `Configuration error: ${error.message} (correlation ID: ${correlationId})`;
    }

    // Generic/unknown errors - hide details, show only correlation ID
    return `Internal error (correlation ID: ${correlationId})`;
  }

  constructor(logger?: Logger) {
    this.logger = logger || new ConsoleLogger();
    this.schemaValidator = new SchemaValidator();
    this.server = new Server(
      {
        name: 'mcp4openapi',
        version: '0.1.0',
      },
      {
        capabilities: {
          tools: {},
          prompts: {},
          resources: {},
          completions: {},
        },
      }
    );

    this.parser = new OpenAPIParser();
    this.toolGenerator = new ToolGenerator(this.parser);
    
    this.setupHandlers();
  }

  public setGlobalFiltering(filtering?: FilteringRules): void {
    this.globalFiltering = filtering && Object.keys(filtering).length > 0 ? filtering : undefined;
  }

  async initialize(specPath: string, profilePath?: string): Promise<void> {
    // Load OpenAPI spec
    await this.parser.load(specPath);
    this.logger.info('Loaded OpenAPI spec', { specPath });

    // Load or create MCP profile
    this.appsModel = undefined;
    this.appsFetchCache.clear();
    if (profilePath) {
      const loader = new ProfileLoader();
      this.profile = await loader.load(profilePath, this.parser);
      this.appsModel = await createLoadedProfileAppsModel(this.profile, { profilePath, parser: this.parser });
      this.logger.info('Loaded profile', {
        profile: this.profile.profile_name,
        toolCount: this.profile.tools.length,
        resourceCount: this.profile.resources?.length || 0,
      });
    } else {
      this.profile = ProfileLoader.createDefaultProfile('default', this.parser);
      this.logger.info('Using auto-generated default profile', {
        profile: this.profile.profile_name,
        toolCount: this.profile.tools.length,
      });
      
      // Check if we should warn about long names
      this.checkToolNameLengths();
    }

    this.applyGlobalToolFiltering();

    // Re-create logger with auth config for token redaction
    const authConfigs = this.getAuthConfigs();
    if (authConfigs.length > 0) {
      // Use first auth config for logger (primary)
      this.logger = this.createLoggerWithAuth(authConfigs[0]);
      this.logger.info('Logger re-configured with auth token redaction', {
        authMethods: authConfigs.length,
      });
    }

    // Setup HTTP client with interceptors
    // For stdio transport, create client with env token
    // For HTTP transport, clients are created per-session with user's token
    const baseUrl = this.getBaseUrl();
    const envAuthConfig = this.getEnvBackedAuthConfig();
    const primaryRuntimeAuthConfig = authConfigs.find(config => config.type !== 'oauth');
    const envVarName = envAuthConfig?.value_from_env;
    const envToken = envVarName ? process.env[envVarName] : undefined;

    if ((envAuthConfig && envToken) || authConfigs.length === 0 || primaryRuntimeAuthConfig?.type === 'session-cookie') {
      // Token available in env (stdio) or no auth required - create global client
      const httpClient = this.httpClientFactory.createGlobalClient({
        profile: this.profile,
        baseUrl,
        logger: this.logger,
        metricsContext: this.resolveMetricsContext(undefined, undefined),
      });
      this.compositeExecutor = new CompositeExecutor(this.parser, httpClient, this.profile.parameter_aliases);
    } else {
      // No env token or no auth - will use per-session clients (HTTP transport)
      this.compositeExecutor = new CompositeExecutor(this.parser, undefined, this.profile.parameter_aliases);
    }
    
    this.logger.info('MCP server initialized', {
      baseUrl,
      toolCount: this.profile.tools.length,
    });
  }

  /**
   * Create logger with auth configuration for token redaction
   * 
   * Why: Prevents sensitive tokens from appearing in logs
   */
  private createLoggerWithAuth(authConfig: AuthInterceptor): Logger {
    const logFormat = process.env.MCP4_LOG_FORMAT || 'console';
    const logLevel = this.logger instanceof ConsoleLogger || this.logger instanceof JsonLogger
      ? (this.logger as unknown as { level?: LogLevel }).level
      : undefined;
    
    return logFormat === 'json'
      ? new JsonLogger(logLevel, authConfig)
      : new ConsoleLogger(logLevel, authConfig);
  }

  /**
   * Check tool name lengths and warn if needed
   */
  private checkToolNameLengths(): void {
    const maxLength = parseInt(process.env.MCP4_TOOLNAME_MAX || '45', 10);
    const strategy = (process.env.MCP4_TOOLNAME_STRATEGY || 'none').toLowerCase() as NamingStrategy;
    const warnOnly = (process.env.MCP4_TOOLNAME_WARN_ONLY || 'true').toLowerCase() === 'true';
    
    // Only warn if strategy is 'none' or warn-only mode is enabled
    if (strategy !== NamingStrategy.None && !warnOnly) {
      return; // Names already shortened, no need to warn
    }
    
    // Get all operations as OperationForNaming
    const operations = this.parser.getAllOperations();
    const opsForNaming: OperationForNaming[] = operations.map(op => ({
      operationId: op.operationId,
      method: op.method,
      path: op.path,
      tags: op.tags,
    }));
    
    const warningOptions: NameWarningOptions = {
      maxLength,
      similarTopN: parseInt(process.env.MCP4_TOOLNAME_SIMILAR_TOP || '3', 10),
      similarityThreshold: parseFloat(process.env.MCP4_TOOLNAME_SIMILARITY_THRESHOLD || '0.75'),
      minParts: parseInt(process.env.MCP4_TOOLNAME_MIN_PARTS || '3', 10),
      minLength: parseInt(process.env.MCP4_TOOLNAME_MIN_LENGTH || '20', 10),
    };
    
    generateNameWarnings(opsForNaming, warningOptions, this.logger);
  }

  /**
   * Get base URL from profile config or OpenAPI spec
   */
  private getBaseUrl(): string {
    const baseUrlConfig = this.profile?.interceptors?.base_url;
    
    if (baseUrlConfig) {
      const envValue = process.env[baseUrlConfig.value_from_env];
      if (envValue) return envValue;
      if (baseUrlConfig.default) return baseUrlConfig.default;
    }

    return this.parser.getBaseUrl();
  }

  /**
   * Get auth configurations as array (supports single or multiple auth methods)
   * Returns array sorted by priority (lower = higher priority)
   */
  private getAuthConfigs(): AuthInterceptor[] {
    const auth = this.profile?.interceptors?.auth;
    if (!auth) return [];
    
    const configs = Array.isArray(auth) ? auth : [auth];
    
    // Sort by priority (lower = higher priority)
    return configs.sort((a, b) => (a.priority || 0) - (b.priority || 0));
  }

  /**
   * Get primary (highest priority) auth configuration
   */
  private getPrimaryAuthConfig(): AuthInterceptor | undefined {
    const configs = this.getAuthConfigs();
    return configs[0];
  }

  /**
   * Get highest priority auth configuration that reads token from environment
   */
  private getEnvBackedAuthConfig(): AuthInterceptor | undefined {
    const configs = this.getAuthConfigs();
    return configs.find(config => config.type !== 'oauth' && !!config.value_from_env);
  }

  /**
   * Get OAuth configuration from auth configs (if any)
   */
  private getOAuthConfig(): OAuthConfig | undefined {
    const configs = this.getAuthConfigs();
    const oauthConfig = configs.find(c => c.type === 'oauth');
    return oauthConfig?.oauth_config;
  }

  private buildOAuthConfigWithAllowedRedirectHosts(oauthConfig?: OAuthConfig): OAuthConfig | undefined {
    if (!oauthConfig) {
      return undefined;
    }

    return {
      ...oauthConfig,
      allowed_redirect_hosts: oauthConfig.allowed_redirect_hosts
        || (process.env.MCP4_ALLOWED_ORIGINS
          ? this.extractHostsFromOrigins(process.env.MCP4_ALLOWED_ORIGINS)
          : undefined),
    };
  }

  private getProfileIdValue(): string {
    if (!this.profile) {
      throw new ConfigurationError('Profile not initialized. Call initialize() first.');
    }
    const profileId = this.profile.profile_id?.trim() || this.profile.profile_name;
    if (!profileId) {
      throw new ConfigurationError('Profile is missing profile_id and profile_name.');
    }
    return profileId;
  }

  private getOAuthRateLimitConfig(): { max: number; windowMs: number } {
    const authConfigs = this.getAuthConfigs();
    const oauthAuthConfig = authConfigs.find(c => c.type === 'oauth');
    const oauthRateLimit = oauthAuthConfig?.oauth_rate_limit;

    const max = oauthRateLimit?.max_requests
      || parseInt(process.env.MCP4_OAUTH_RATE_LIMIT_MAX || String(OAUTH_RATE_LIMIT.MAX_REQUESTS), 10);
    const windowMs = oauthRateLimit?.window_ms
      || parseInt(process.env.MCP4_OAUTH_RATE_LIMIT_WINDOW_MS || String(OAUTH_RATE_LIMIT.WINDOW_MS), 10);

    return { max, windowMs };
  }

  public getHttpProfileContext(): HttpProfileContext {
    if (!this.profile) {
      throw new ConfigurationError('Profile not initialized. Call initialize() first.');
    }

    const authConfigs = this.getAuthConfigs();
    const baseUrl = this.getBaseUrl();
    const oauthConfig = this.buildOAuthConfigWithAllowedRedirectHosts(this.getOAuthConfig());
    const resourceMetadata = this.parser.getResourceMetadata();
    const oauthRateLimit = this.getOAuthRateLimitConfig();

    return {
      profileId: this.getProfileIdValue(),
      oauthConfig,
      authConfigs,
      enterpriseAuthorization: this.profile.enterprise_authorization,
      baseUrl,
      rateLimitOAuthMax: oauthRateLimit.max,
      rateLimitOAuthWindowMs: oauthRateLimit.windowMs,
      resourceName: this.profile.resource_name || resourceMetadata.name || 'MCP Server',
      resourceDocumentation: this.profile.resource_documentation || resourceMetadata.documentation,
      parser: this.parser,
      upstreamMcp: this.profile.upstream_mcp,
    };
  }

  /**
   * Extract hostnames from origin patterns for OAuth redirect validation
   * e.g., "http://localhost:*,https://app.example.com" -> ["localhost", "app.example.com"]
   * 
   * Filters out CIDR blocks (e.g., "127.0.0.1/8") which are valid for origin validation
   * but not for OAuth redirect URI validation
   */
  private extractHostsFromOrigins(origins: string): string[] {
    const hosts: string[] = [];
    for (const origin of origins.split(',')) {
      const trimmed = origin.trim();
      
      try {
        // Handle wildcard ports: http://localhost:* -> localhost
        const normalized = trimmed.replace(/:\*$/, ':80');
        const url = new URL(normalized);
        // Preserve wildcards in hostname
        if (trimmed.includes('*.')) {
          const match = trimmed.match(/\*\.[^:/]+/);
          if (match) {
            hosts.push(match[0]);
          }
        } else {
          hosts.push(url.hostname);
        }
      } catch {
        // If not a URL, treat as hostname/pattern directly
        // Skip CIDR blocks (e.g., 127.0.0.1/8, 10.0.0.0/8, 2a06:2140::/29)
        if (trimmed && !trimmed.includes(' ') && !trimmed.includes('/')) {
          hosts.push(trimmed);
        }
      }
    }
    return [...new Set(hosts)]; // Dedupe
  }

  /**
   * Get or create HTTP client for session
   */
  private async getHttpClientForSession(sessionId?: string, profileId?: string): Promise<HttpClient> {
    if (!sessionId) {
      // Fallback to global client for stdio transport
      if (!this.httpClientFactory.hasGlobalClient()) {
        const hasHttpTransport = !!this.httpTransport;
        const transport = hasHttpTransport ? 'http' : 'stdio';
        const envAuthConfig = this.getEnvBackedAuthConfig();
        const envVarName = envAuthConfig?.value_from_env || 'MCP4_API_TOKEN';
        const hasEnvToken = !!process.env[envVarName];

        throw new ConfigurationError(
          `HTTP client not initialized. ` +
          `Transport: ${transport}, ` +
          `HasEnvToken(${envVarName}): ${hasEnvToken}, ` +
          `Suggestion: ${hasHttpTransport
            ? 'Send token in Authorization header during initialization'
            : `Set ${envVarName} environment variable`}`,
          { transport, hasEnvToken, envVarName, hasHttpTransport }
        );
      }
      return this.httpClientFactory.getGlobalClient();
    }

    // Validate profile exists
    if (!this.profile) {
      throw new ConfigurationError('Profile not initialized. Call initialize() first.');
    }

    // Get auth token from session (ensures token is valid/refreshed)
    const authToken = await this.getAuthTokenFromSession(sessionId, profileId);
    const effectiveProfileId = profileId || this.getProfileIdValue();
    const tenantContext = this.httpTransport?.getSessionTenantContext(effectiveProfileId, sessionId);

    // Create or get session client using factory
    return this.httpClientFactory.getOrCreateSessionClient(sessionId, {
      profile: this.profile,
      baseUrl: tenantContext?.tenantBaseUrl || this.getBaseUrl(),
      authConfigs: tenantContext?.tenantAuthConfigs,
      sessionToken: authToken,
      logger: this.logger,
      metricsContext: this.resolveMetricsContext(effectiveProfileId, sessionId),
    });
  }

  /**
   * Get auth token from HTTP transport session
   * Ensures token is valid (refreshes if expired) before returning
   */
  private async getAuthTokenFromSession(sessionId: string, profileId?: string): Promise<string | undefined> {
    // Early return if sessionId is missing/empty
    // Prevents misleading warn logs with empty sessionId
    if (!sessionId) {
      return undefined;
    }

    if (!this.httpTransport) {
      return undefined;
    }

    // Ensure token is valid (refresh if expired)
    const effectiveProfileId = profileId || this.getProfileIdValue();
    const isValid = await this.httpTransport.ensureValidSessionToken(effectiveProfileId, sessionId);
    if (!isValid) {
      this.logger.warn('Session token validation/refresh failed', { profileId: effectiveProfileId, sessionId });
      // Still return token if available - let the API call fail with proper error
    }

    // Use public API instead of type casting
    return this.httpTransport.getSessionToken(effectiveProfileId, sessionId);
  }

  /**
   * Cleanup HTTP client for destroyed session
   *
   * Why: Prevent memory leak - sessions expire but cached clients stay forever
   */
  private cleanupSessionClient(profileId: string | undefined, sessionId: string): void {
    const removed = this.httpClientFactory.cleanupSessionClient(sessionId);
    if (removed) {
      this.logger.info('Cleaned up session HTTP client', { profileId, sessionId });
    }
    this.sanitizedAndPolicyFilteredToolNames.delete(sessionId);
  }

  /**
   * Setup MCP request handlers
   */
  private setupHandlers(): void {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      try {
        if (!this.profile) {
          throw new ConfigurationError('Server not initialized. Call initialize() first.');
        }

        const tools = this.profile.tools.map((toolDef) => this.buildToolDescriptor(toolDef));

        return { tools };
      } catch (err) {
        // Generate correlation ID only on error (lazy)
        const correlationId = generateCorrelationId();
        this.logger.error('ListTools handler error', err as Error, { correlationId });
        // Always return generic error to clients
        throw new Error(`Internal error (correlation ID: ${correlationId})`);
      }
    });

    this.server.setRequestHandler(ListPromptsRequestSchema, async () => {
      try {
        return {
          prompts: this.listPrompts(),
        };
      } catch (err) {
        const correlationId = generateCorrelationId();
        this.logger.error('ListPrompts handler error', err as Error, { correlationId });
        throw new Error(`Internal error (correlation ID: ${correlationId})`);
      }
    });

    this.server.setRequestHandler(GetPromptRequestSchema, async (request) => {
      try {
        if (!this.profile) {
          throw new ConfigurationError('Server not initialized. Call initialize() first.');
        }

        return this.renderPromptByName(request.params.name, request.params.arguments || {});
      } catch (err) {
        if (err instanceof ValidationError || err instanceof ResourceNotFoundError) {
          throw err;
        }

        const correlationId = generateCorrelationId();
        this.logger.error('GetPrompt handler error', err as Error, {
          correlationId,
          promptName: request.params.name,
        });
        throw new Error(`Internal error (correlation ID: ${correlationId})`);
      }
    });

    this.server.setRequestHandler(ListResourcesRequestSchema, async () => ({
      resources: this.listResources(),
    }));

    this.server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
      resourceTemplates: this.listResourceTemplates(),
    }));

    this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => (
      this.readResource(request.params.uri)
    ));

    this.server.setRequestHandler(CompleteRequestSchema, async (request) => (
      this.completeResourceArgument(request)
    ));

    // Execute tool
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const toolName = request.params.name;
      const startTime = Date.now();
      const metrics = this.getMetricsCollector();
      const metricsContext = this.resolveMetricsContext(undefined, undefined);
      try {
        if (!this.profile || !this.compositeExecutor) {
          throw new ConfigurationError('Server not initialized. Call initialize() first.');
        }

        const toolDef = this.profile.tools.find(t => t.name === toolName);
        if (!toolDef) {
          throw new OperationNotFoundError(toolName);
        }

        const rawArgs = request.params.arguments || {};
        const args = applyParameterDefaults(toolDef, rawArgs);
        
        // Validate arguments
        this.toolGenerator.validateArguments(toolDef, args);

        // Execute composite or simple tool
        let result: unknown;
        
        if (toolDef.composite && toolDef.steps) {
          const compositeResult = await this.compositeExecutor.execute(
            toolDef.steps,
            args,
            toolDef.partial_results || false
          );
          
          // Include metadata about completion
          result = {
            ...compositeResult.data,
            _metadata: {
              completed_steps: compositeResult.completed_steps,
              total_steps: compositeResult.total_steps,
              success: compositeResult.completed_steps === compositeResult.total_steps,
              errors: compositeResult.errors,
            },
          };
        } else {
          result = await this.executeSimpleTool(toolDef, args);
        }

        if (metrics) {
          const durationSeconds = (Date.now() - startTime) / 1000;
          metrics.recordToolCall(toolName, 'success', durationSeconds, metricsContext);
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (err) {
        if (metrics) {
          const durationSeconds = (Date.now() - startTime) / 1000;
          metrics.recordToolCall(toolName, 'error', durationSeconds, metricsContext);
          metrics.recordToolCallError(toolName, this.getMetricsErrorType(err), metricsContext);
        }
        // Generate correlation ID only on error (lazy)
        const correlationId = generateCorrelationId();
        this.logger.error('CallTool handler error', err as Error, { 
          correlationId,
          toolName,
          action: (request.params.arguments as Record<string, unknown>)?.action
        });
        
        // Return user-friendly error message with correlation ID
        const errorMessage = this.formatErrorForClient(err, correlationId);
        throw new Error(errorMessage);
      }
    });
  }

  /**
   * Execute simple (non-composite) tool
   *
   * Why separate: Simple tools map directly to single OpenAPI operation.
   * No result aggregation needed.
   */
  private async executeSimpleTool(
    toolDef: ToolDefinition,
    args: Record<string, unknown>,
    sessionId?: string,
    profileId?: string
  ): Promise<unknown> {
    const normalizedArgs = normalizeArguments(toolDef, args);

    this.logger.debug('Executing simple tool', {
      toolName: toolDef.name,
      action: normalizedArgs['action'],
      resourceType: normalizedArgs['resource_type'],
      sessionId
    });

    // Get operation definition (can be string or ProxyDownloadOperation)
    const operationDef = this.toolGenerator.getOperationDefinition(toolDef, normalizedArgs);
    
    if (!operationDef) {
      throw new ValidationError(
        `Could not map tool action to operation`,
        {
          toolName: toolDef.name,
          action: args['action'],
          resourceType: args['resource_type'],
          availableOperations: Object.keys(toolDef.operations || {})
        }
      );
    }

    // Check if this is a proxy download operation
    if (typeof operationDef === 'object' && operationDef.type === 'proxy_download') {
        return this.executeProxyDownload(operationDef, normalizedArgs, sessionId, profileId);
    }

    // Regular string operation
    const operationId = operationDef as string;
    const operation = this.parser.getOperation(operationId);
    if (!operation) {
      throw new OperationNotFoundError(operationId);
    }

    // Build request
    const path = this.resolvePath(operation.path, normalizedArgs);
    const queryParams = this.extractQueryParams(operation, normalizedArgs);
    const body = this.extractBody(operation, normalizedArgs, toolDef);

    this.logger.debug('Executing HTTP request', {
      operationId,
      method: operation.method,
      path,
      hasQueryParams: Object.keys(queryParams).length > 0,
      hasBody: !!body
    });

    // Validate request body against schema
    if (body && operation.requestBody) {
      const validationResult = this.schemaValidator.validateRequestBody(operation, body);
      
      if (!validationResult.valid && validationResult.errors) {
        const errorDetails = validationResult.errors
          .map(e => `  - ${e.path}: ${e.message}`)
          .join('\n');
        throw new ValidationError(
          `Request body validation failed:\n${errorDetails}`,
          { operationId, validationErrors: validationResult.errors }
        );
      }
    }

    // Execute with session-specific client
    const httpClient = await this.getHttpClientForSession(sessionId, profileId);
    
    // Set fields parameter if response_fields are configured for this action AND enabled
    const action = normalizedArgs.action as string | undefined;
    if (toolDef.send_response_fields_as_param && toolDef.response_fields && action && toolDef.response_fields[action]) {
      const fields = toolDef.response_fields[action];
      queryParams.fields = fields.join(',');
    }
    
    const response = await httpClient.request(operation.method, path, {
      params: queryParams,
      body,
      operationId: operationId,
    });

    // Apply response field filtering if configured
    let result = response.body;
    if (toolDef.response_fields) {
      const action = normalizedArgs.action as string | undefined;
      if (action && toolDef.response_fields[action]) {
        const fields = toolDef.response_fields[action];
        result = this.filterFields(result, fields);
      }
    }

    return result;
  }

  /**
   * Execute proxy download operation
   * 
   * Why: Some APIs return authenticated URLs that LLMs cannot fetch directly.
   * This proxies the download through the MCP server.
   */
  private async executeProxyDownload(
    operation: ProxyDownloadOperation,
    args: Record<string, unknown>,
    sessionId?: string,
    profileId?: string
  ): Promise<unknown> {
    this.logger.debug('Executing proxy download', {
      metadataEndpoint: operation.metadata_endpoint,
      urlField: operation.url_field,
      sessionId
    });

    // Get the metadata operation to build the path
    const metadataOp = this.parser.getOperation(operation.metadata_endpoint);
    if (!metadataOp) {
      throw new OperationNotFoundError(operation.metadata_endpoint);
    }

    // Build path for metadata endpoint
    const metadataPath = this.resolvePath(metadataOp.path, args);
    const metadataMethod = metadataOp.method;

    let directDownloadRequest: { path: string; method: string } | undefined;
    if (operation.download_endpoint) {
      const downloadOp = this.parser.getOperation(operation.download_endpoint);
      if (!downloadOp) {
        throw new OperationNotFoundError(operation.download_endpoint);
      }
      directDownloadRequest = {
        path: this.resolvePath(downloadOp.path, args),
        method: downloadOp.method,
      };
    }
    
    // Get auth credentials for download
    const httpClient = await this.getHttpClientForSession(sessionId, profileId);
    const authCredentials = httpClient.getAuthCredentials();

    // Execute proxy download
    const proxyExecutor = new ProxyDownloadExecutor(httpClient, this.logger);
    const result = await proxyExecutor.execute(
      operation,
      { path: metadataPath, method: metadataMethod },
      authCredentials,
      directDownloadRequest
    );

    this.logger.debug('Proxy download completed', {
      fileName: result.fileName,
      mimeType: result.mimeType,
      size: result.size
    });

    return result;
  }

  /**
   * Encode path segment if it contains special characters (like slashes)
   *
   * Why: GitLab and other APIs require path parameters (like project paths)
   * to be URL-encoded when used in URL path.
   */
  private encodePathSegment(value: unknown): string {
    const val = String(value);
    return val.includes('/') ? encodeURIComponent(val) : val;
  }

  /**
   * Resolve path parameters using profile aliases
   * 
   * Why aliases: Different tools may use different parameter names for same path param.
   * Example: GitLab uses "resource_id", "project_id", "group_id" all mapping to "{id}"
   */
  private resolvePath(template: string, args: Record<string, unknown>): string {
    const aliases = this.profile?.parameter_aliases || {};
    
    return template.replace(/\{(\w+)\}/g, (_, key) => {
      // Try direct match first
      if (args[key] !== undefined) {
        return this.encodePathSegment(args[key]);
      }

      // Try aliases from profile
      const possibleAliases = aliases[key] || [];
      for (const alias of possibleAliases) {
        if (args[alias] !== undefined) {
          return this.encodePathSegment(args[alias]);
        }
      }

      throw new ValidationError(
        `Missing path parameter: ${key}` +
        (possibleAliases.length > 0 ? `. Tried aliases: ${possibleAliases.join(', ')}` : ''),
        { paramName: key, possibleAliases }
      );
    });
  }

  /**
   * Extract query parameters from args
   * 
   * Why: Separate query params from body params. Array handling is done by HttpClient
   * based on profile's array_format setting.
   */
  private extractQueryParams(
    operation: OperationInfo,
    args: Record<string, unknown>
  ): Record<string, string | string[]> {
    const params: Record<string, string | string[]> = {};
    const aliases = this.profile?.parameter_aliases || {};

    for (const param of operation.parameters) {
      if (param.in === 'query') {
        let value = args[param.name];

        // If not found by direct name, check aliases
        if (value === undefined) {
          const possibleAliases = aliases[param.name] || [];
          for (const alias of possibleAliases) {
            if (args[alias] !== undefined) {
              value = args[alias];
              break;
            }
          }
        }

        if (value !== undefined) {
          // Pass arrays as-is, HttpClient will serialize based on array_format
          if (Array.isArray(value)) {
            params[param.name] = value.map(String);
          } else {
            params[param.name] = String(value);
          }
        }
      }
    }

    return params;
  }

  /**
   * Extract request body from args
   * 
   * Why: For create/update operations, collect non-metadata fields into body.
   * Metadata (action, resource_type, etc.) are not sent to API.
   * Path/query parameters are excluded from body UNLESS they're also in request body schema.
   * 
   * Uses metadata_params from tool definition, defaults to ['action', 'resource_type']
   */
  private extractBody(
    operation: OperationInfo,
    args: Record<string, unknown>,
    toolDef: ToolDefinition
  ): unknown | undefined {
    // Metadata fields from tool definition (or defaults)
    const metadataList = toolDef.metadata_params || ['action', 'resource_type'];
    const metadata = new Set(metadataList);
    
    // Collect parameter names that go in path or query
    const pathOrQuery = new Set<string>();
    for (const param of operation.parameters) {
      if (param.in === 'path' || param.in === 'query') {
        pathOrQuery.add(param.name);
      }
    }
    
    // Get body schema and properties to check if path/query params should also be in body
    let bodySchema: SchemaInfo | undefined;
    const bodySchemaProps = new Set<string>();
    if (operation.requestBody?.content) {
      // Prefer application/json but accept any schema present
      const jsonSchema = operation.requestBody.content['application/json']?.schema;
      bodySchema = jsonSchema;

      if (!bodySchema) {
        for (const mediaType of Object.values(operation.requestBody.content)) {
          if (mediaType.schema) {
            bodySchema = mediaType.schema;
            break;
          }
        }
      }

      if (bodySchema?.type === 'object' && bodySchema.properties) {
        for (const propName of Object.keys(bodySchema.properties)) {
          bodySchemaProps.add(propName);
        }
      }
    }

    // Root array body support
    if (bodySchema?.type === 'array') {
      const explicit = args['body'] ?? args['items'];
      if (explicit !== undefined) {
        return explicit;
      }

      const arrayCandidates: unknown[] = [];
      for (const [key, value] of Object.entries(args)) {
        if (metadata.has(key)) continue;
        if (pathOrQuery.has(key)) continue;
        if (Array.isArray(value)) {
          arrayCandidates.push(value);
        }
      }

      if (arrayCandidates.length === 1) {
        return arrayCandidates[0];
      }

      return undefined;
    }
    
    const body: Record<string, unknown> = {};
    let hasBody = false;

    for (const [key, value] of Object.entries(args)) {
      // Include field if:
      // - Not metadata
      // - Not in path/query OR is in path/query but also required in body schema
      // - Value is defined
      const isPathOrQuery = pathOrQuery.has(key);
      const isInBodySchema = bodySchemaProps.has(key);
      
      if (!metadata.has(key) && (!isPathOrQuery || isInBodySchema) && value !== undefined) {
        body[key] = value;
        hasBody = true;
      }
    }

    return hasBody ? body : undefined;
  }

  /**
   * Start server with stdio transport
   */
  async runStdio(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    this.logger.info('MCP server running on stdio');
  }

  /**
   * Start server with HTTP transport
   * 
   * Implements MCP Specification 2025-03-26 Streamable HTTP transport
   * 
   * Why: Enables remote MCP server access with SSE streaming, session management,
   * and resumability for reliable communication over HTTP.
   */
  async runHttp(host: string, port: number): Promise<void> {
    const { HttpTransport } = await import('../transport/http-transport.js');
    
    const profileContext = this.getHttpProfileContext();
    if (profileContext.oauthConfig) {
      this.logger.info('OAuth authentication enabled for HTTP transport');
    }
    
    const baseConfig = buildHttpTransportBaseConfig(host, port);
    const config = {
      ...baseConfig,
      profileRoutingEnabled: false,
      defaultProfileId: profileContext.profileId,
      // OAuth rate limiting (priority: profile > env vars > defaults)
      rateLimitOAuthMax: profileContext.rateLimitOAuthMax,
      rateLimitOAuthWindowMs: profileContext.rateLimitOAuthWindowMs,
      // OAuth config already merged with allowed_redirect_hosts
      oauthConfig: profileContext.oauthConfig,
      baseUrl: profileContext.baseUrl,
      authConfigs: profileContext.authConfigs,
      enterpriseAuthorization: profileContext.enterpriseAuthorization,
      resourceName: profileContext.resourceName,
      resourceDocumentation: profileContext.resourceDocumentation,
      parser: profileContext.parser,
      upstreamMcp: profileContext.upstreamMcp,
      globalFiltering: this.globalFiltering,
    };

    // Warn if binding to non-localhost without explicit MCP4_ALLOWED_ORIGINS
    const isLocalhost = host === 'localhost' || host === '127.0.0.1' || host === '::1';
    const hasAllowedOrigins = Array.isArray(config.allowedOrigins) && config.allowedOrigins.length > 0;
    if (!isLocalhost && !hasAllowedOrigins) {
      this.logger.warn('Binding to non-localhost with empty MCP4_ALLOWED_ORIGINS. Set MCP4_ALLOWED_ORIGINS or bind to localhost.');
    }

    this.httpTransport = new HttpTransport(config, this.logger);
    const metricsCollector = this.httpTransport.getMetricsCollector?.() || null;
    this.httpClientFactory.setMetricsCollector(metricsCollector);

    this.recordGlobalToolFilterMetrics();

    // Wire upstream connection manager so upstream_mcp profiles can proxy tool calls.
    // TODO(phase-3/auth-gate): upstream proxy is wired unconditionally here; once the client
    // authentication gate (Phase 3) lands, this wiring must be guarded so that upstream
    // resources are only reachable after inbound identity has been verified and attached to
    // the session. See .planning/phases/03-client-authentication-gate/ for the design.
    const upstreamManager = new UpstreamConnectionManager({ logger: this.logger });
    this.httpTransport.setUpstreamConnectionManager(upstreamManager);
    this.setGetUpstreamClient((s, p, t) => upstreamManager.getOrConnect(s, p, t));

    // Set message handler to process JSON-RPC messages
    this.httpTransport.setMessageHandler(async (message: unknown, sessionId?: string, profileId?: string) => {
      return await this.handleJsonRpcMessage(message, sessionId, profileId);
    });

    // Register cleanup listener for session destruction (memory leak prevention)
    this.httpTransport.onSessionDestroyed((profileId: string, sessionId: string) => {
      this.cleanupSessionClient(profileId, sessionId);
    });

    await this.httpTransport.start();
    
    this.logger.info('MCP server running on HTTP', { host, port });
  }

  public attachHttpTransport(transport: HttpTransport): void {
    this.httpTransport = transport;
    const metricsCollector = this.httpTransport.getMetricsCollector?.() || null;
    this.httpClientFactory.setMetricsCollector(metricsCollector);
  }

  /**
   * Inject the upstream MCP client factory callback.
   * Called by runHttp() after wiring the UpstreamConnectionManager.
   */
  public setGetUpstreamClient(
    fn: (sessionId: string, provider: UpstreamMcpServerConfig, token: string | undefined) => Promise<Client>,
  ): void {
    this.getUpstreamClientFn = fn;
  }

  public handleSessionDestroyed(profileId: string, sessionId: string): void {
    this.cleanupSessionClient(profileId, sessionId);
  }

  /**
   * Handle JSON-RPC message from HTTP transport
   *
   * Why: Unified message handling for both stdio and HTTP transports
   */
  private async handleJsonRpcMessage(message: unknown, sessionId?: string, profileId?: string): Promise<unknown> {
    // Handle initialize
    if (isInitializeRequest(message)) {
      return this.handleInitialize(message, sessionId, profileId);
    }

    // Handle tool calls
    if (isToolCallRequest(message)) {
      return await this.handleToolCall(message, sessionId, profileId);
    }

    // Handle other JSON-RPC requests
    // (tools/list, prompts/list, etc.)
    return await this.handleOtherRequest(message, sessionId, profileId);
  }

  public async handleHttpMessage(message: unknown, sessionId?: string, profileId?: string): Promise<unknown> {
    return this.handleJsonRpcMessage(message, sessionId, profileId);
  }


  private handleInitialize(message: unknown, sessionId?: string, profileId?: string): unknown {
    const req = message as Record<string, unknown>;
    const params = req.params as Record<string, unknown> | undefined;

    if (!this.httpTransport && params?.filtering !== undefined) {
      if (typeof params.filtering !== 'string') {
        throw new ValidationError('Invalid X-Mcp4-Params header. Expected comma-separated key=value pairs.');
      }
      const parsed = parseFilteringHeader(params.filtering);
      this.stdioFiltering = mergeFilteringRules(this.globalFiltering, parsed.filtering);
    }

    if (this.httpTransport && sessionId) {
      this.applySessionToolFiltering(sessionId, profileId);
    }

    const hasUpstream = !!(this.getUpstreamMcpConfig(profileId)?.length && this.getUpstreamClientFn);

    const result: {
      protocolVersion: string;
      serverInfo: { name: string; version: string };
      capabilities: {
        tools: Record<string, unknown>;
        prompts: { listChanged: boolean };
        resources: { listChanged: boolean; subscribe: boolean };
        completions: Record<string, never>;
      };
      sessionId?: string;
    } = {
      protocolVersion: '2025-03-26',
      serverInfo: {
        name: 'mcp4openapi',
        version: '0.1.0',
      },
      capabilities: {
        tools: hasUpstream ? { listChanged: true } : {},
        prompts: {
          listChanged: false,
        },
        resources: {
          listChanged: false,
          subscribe: false,
        },
        completions: {},
      },
    };

    // OAuth capability is communicated via 401 responses with WWW-Authenticate header
    // as per MCP Authorization specification

    // Include sessionId if available (for HTTP transport)
    if (sessionId) {
      result.sessionId = sessionId;
    }

    return {
      jsonrpc: '2.0',
      id: req.id,
      result,
    };
  }

  private async handleToolCall(message: unknown, sessionId?: string, profileId?: string): Promise<unknown> {
    const req = message as Record<string, unknown>;
    const params = req.params as Record<string, unknown>;
    const toolName = params.name as string;
    const rawArgs = (params.arguments as Record<string, unknown>) || {};
    const startTime = Date.now();
    const metrics = this.getMetricsCollector();
    const metricsContext = this.resolveMetricsContext(profileId, sessionId);

    // Check OAuth authentication for tool operations
    if (this.httpTransport && this.httpTransport.hasOAuthProvider(profileId)) {
      const authToken = await this.getAuthTokenFromSession(sessionId || '', profileId);
      if (!authToken) {
        if (metrics) {
          const durationSeconds = (Date.now() - startTime) / 1000;
          metrics.recordToolCall(toolName, 'error', durationSeconds, metricsContext);
          metrics.recordToolCallError(toolName, 'AuthenticationRequired', metricsContext);
        }
        // Return OAuth required error with WWW-Authenticate header
        // This should trigger the OAuth flow in the client
        const errorResponse = {
          jsonrpc: '2.0',
          id: req.id,
          error: {
            code: ErrorCode.InvalidRequest,
            message: 'Authentication required. Please authorize via OAuth.',
            data: {
              oauth_required: true,
              resource_metadata: this.httpTransport.getOAuthProtectedResourceUrl(profileId),
              scope: 'api'
            }
          }
        };
        return errorResponse;
      }
    }

    // D-01: When upstream_mcp is set, forward call to upstream (after OAuth check, before local dispatch)
    const upstreamMcpForCall = this.getUpstreamMcpConfig(profileId);
    if (upstreamMcpForCall?.length && this.getUpstreamClientFn) {
      // Runtime guard: params.name is cast to string above but a malformed request may send
      // a non-string (e.g. 123). Detect early so downstream .slice() calls never throw.
      if (typeof toolName !== 'string') {
        return {
          jsonrpc: '2.0', id: req.id, error: {
            code: -32002,
            message: `Tool name must be a string, got: '${String(params.name).slice(0, 100)}'`,
          },
        };
      }
      // Apply X-Mcp4-Tools filter as a pure name predicate (upstream tools have no OpenAPI metadata).
      // Uses matchesSessionFilterByName for consistency with the local-tools filter path.
      if (sessionId && typeof this.httpTransport?.getSessionToolFilterRequest === 'function') {
        const upstreamFilterRequest = this.httpTransport.getSessionToolFilterRequest(
          profileId || this.getProfileIdValue(), sessionId
        );
        if (upstreamFilterRequest?.hasRules && !matchesSessionFilterByName(upstreamFilterRequest, toolName)) {
          this.recordToolFilterRejection(toolName, 'session');
          return { jsonrpc: '2.0', id: req.id, error: { code: -32002, message: `Tool '${toolName}' not allowed by X-Mcp4-Tools filter.` } };
        }
      }
      // Apply enterprise policy - upstream tools don't have OpenAPI operations so default to 'modify'
      if (!this.isToolCategoryAllowedByEnterprisePolicy('modify', sessionId, profileId)) {
        const allowedCategories = this.getEnterpriseAllowedToolCategoriesForSession(sessionId, profileId);
        return {
          jsonrpc: '2.0', id: req.id, error: {
            code: -32002,
            message: `Tool '${toolName}' not allowed by enterprise authorization policy. ` +
              `Upstream tools require the 'modify' permission. ` +
              `Allowed categories: ${Array.from(allowedCategories || []).join(', ')}.`,
          },
        };
      }
      // Validate tool name against the same sanitization policy as tools/list (D-05)
      if (!isValidUpstreamToolName(toolName)) {
        return {
          jsonrpc: '2.0', id: req.id, error: {
            code: -32002,
            message: `Tool name '${toolName.slice(0, 100)}' is not allowed - upstream tool names must match [a-zA-Z0-9_-] and be at most 255 characters.`,
          },
        };
      }
      // Apply profile-level upstream tool allow/deny policy
      if (!isToolAllowedByProviderPolicy(toolName, upstreamMcpForCall[0].tools)) {
        return {
          jsonrpc: '2.0', id: req.id, error: {
            code: -32002,
            message: `Tool '${toolName}' not allowed by upstream provider tool policy.`,
          },
        };
      }
      // Enforce membership in the sanitized upstream tool set when cache is available.
      // Prevents invoking a tool dropped by sanitizeToolList (bad description/inputSchema)
      // via a direct tools/call with its valid name, bypassing the sanitization boundary.
      // Intentional gap: when tools/list was never called for this session the cache is absent
      // and the gate is skipped. The tool name still passes isValidUpstreamToolName() above,
      // but the bad description/inputSchema is not echoed back in tools/call responses, so the
      // injection risk is constrained to the metadata display path (tools/list). Clients that
      // skip tools/list bear responsibility for not seeing the sanitized view.
      // TODO(sec): consider seeding the cache on the first tools/call when absent, to close this
      // gap for clients that invoke tools/call directly without a prior tools/list round-trip.
      const sanitizedSet = sessionId
        ? this.sanitizedAndPolicyFilteredToolNames.get(sessionId)?.get(upstreamMcpForCall[0].name)
        : undefined;
      if (sanitizedSet !== undefined && !sanitizedSet.has(toolName)) {
        return {
          jsonrpc: '2.0', id: req.id, error: {
            code: -32002,
            message: `Tool '${toolName.slice(0, 100)}' is not in the upstream sanitized tool set - it may have been removed by sanitization policy.`,
          },
        };
      }
      return this.handleUpstreamToolCall(
        req,
        sessionId,
        profileId,
        upstreamMcpForCall[0],
        metrics ? { collector: metrics, startTime, context: metricsContext } : undefined,
      );
    }

    let args: Record<string, unknown> = rawArgs;

    try {
      // Find tool definition
      const toolDef = this.profile?.tools.find(t => t.name === toolName);
      if (!toolDef) {
        throw new ResourceNotFoundError(toolName, 'Tool');
      }
      args = applyParameterDefaults(toolDef, rawArgs);
      this.toolGenerator.validateArguments(toolDef, args);

      const toolFilter = this.getToolFilterForSession(sessionId, profileId);
      if (toolFilter && !toolFilter.allowedToolNames.has(toolName)) {
        this.recordToolFilterRejection(toolName, 'session');
        const reason = toolFilter.reasons.get(toolName)?.[0];
        const reasonSuffix = reason ? ` Blocked by: ${reason}.` : '';
        throw new AuthorizationError(
          `Tool '${toolName}' not allowed by X-Mcp4-Tools filter.${reasonSuffix}`
        );
      }

      if (!this.isToolAllowedByEnterprisePolicy(toolDef, sessionId, profileId)) {
        const allowedCategories = this.getEnterpriseAllowedToolCategoriesForSession(sessionId, profileId);
        throw new AuthorizationError(
          `Tool '${toolName}' not allowed by enterprise authorization policy. ` +
          `Required category: ${this.getToolCategory(toolDef)}. ` +
          `Allowed categories: ${Array.from(allowedCategories || []).join(', ')}.`
        );
      }

      const filtering = this.getFilteringForSession(sessionId, profileId);
      if (filtering) {
        const operation = this.getFilteringOperationInfo(toolDef, args);
        enforceFiltering({
          filtering,
          toolDef,
          args,
          parameterAliases: this.profile?.parameter_aliases,
          operation,
        });
      }

      // Execute tool (reuse existing execution logic)
      let result;
      if (toolDef.composite && toolDef.steps) {
        const httpClient = await this.getHttpClientForSession(sessionId, profileId);
        const compositeResult = await this.compositeExecutor!.execute(
          toolDef.steps,
          args,
          toolDef.partial_results || false,
          httpClient
        );
        result = {
          data: compositeResult.data,
          completed_steps: compositeResult.completed_steps,
          total_steps: compositeResult.total_steps,
          success: compositeResult.completed_steps === compositeResult.total_steps,
          errors: compositeResult.errors,
        };
      } else {
        result = await this.executeSimpleTool(toolDef, args, sessionId, profileId);
      }

      if (metrics) {
        const durationSeconds = (Date.now() - startTime) / 1000;
        metrics.recordToolCall(toolName, 'success', durationSeconds, metricsContext);
      }

      return {
        jsonrpc: '2.0',
        id: req.id,
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        },
      };
    } catch (error) {
      if (metrics) {
        const durationSeconds = (Date.now() - startTime) / 1000;
        metrics.recordToolCall(toolName, 'error', durationSeconds, metricsContext);
        metrics.recordToolCallError(toolName, this.getMetricsErrorType(error), metricsContext);
      }
      // Generate correlation ID only on error (lazy)
      const correlationId = generateCorrelationId();
      
      // Log internal error details with correlation ID
      this.logger.error('Tool call error', error as Error, {
        correlationId,
        toolName,
        action: args?.action,
        resourceType: args?.resource_type,
        sessionId
      });
      
      // Return user-friendly error message with correlation ID
      const errorMessage = this.formatErrorForClient(error, correlationId);
      
      // Map error type to JSON-RPC error code
      let errorCode: number = ErrorCode.InternalError;
      if (error instanceof AuthenticationError) {
        errorCode = ErrorCode.InvalidRequest;
      } else if (error instanceof AuthorizationError) {
        errorCode = -32002; // Custom: authorization error
      } else if (error instanceof ValidationError) {
        errorCode = ErrorCode.InvalidParams;
      } else if (error instanceof RateLimitError) {
        errorCode = -32003; // Custom: rate limit error
      } else if (error instanceof OperationNotFoundError) {
        errorCode = ErrorCode.MethodNotFound;
      } else if (error instanceof ResourceNotFoundError) {
        errorCode = ErrorCode.MethodNotFound;
      }
      
      return {
        jsonrpc: '2.0',
        id: req.id,
        error: {
          code: errorCode,
          message: errorMessage,
        },
      };
    }
  }

  /**
   * Return upstream_mcp config for the given profileId.
   * For HTTP transport, delegates to HttpTransport accessor.
   * For stdio, reads profile directly and warns when upstream_mcp is configured
   * but no upstream client is wired (upstream_mcp requires HTTP transport).
   */
  private getUpstreamMcpConfig(profileId?: string): UpstreamMcpServerConfig[] | undefined {
    if (this.httpTransport && profileId) {
      // In single-profile HTTP mode both paths should agree: runHttp() stores the profile under
      // defaultProfileId and JSON-RPC dispatch resolves the same key. The fallback to
      // this.profile?.upstream_mcp is a defensive safety net for any edge case where
      // profileId normalization diverges (e.g. during startup races), keeping the common
      // case fast and the error case auditable rather than silently broken.
      return this.httpTransport.getUpstreamMcpConfig(profileId) ?? this.profile?.upstream_mcp;
    }
    // stdio path: upstream_mcp cannot be used without a wired client
    if (!this.upstreamStdioWarnLogged && this.profile?.upstream_mcp?.length && !this.getUpstreamClientFn) {
      this.upstreamStdioWarnLogged = true;
      this.logger?.warn(
        'upstream_mcp configured but no upstream client wired - upstream_mcp requires HTTP transport',
        { profileId: profileId ?? this.profile?.profile_name },
      );
    }
    return this.profile?.upstream_mcp;
  }

  /**
   * Extract the auth token to use for upstream MCP calls.
   * Downstream client token takes precedence; value_from_env acts as local fallback
   * when the client sends no token (e.g. server-side deployments with a shared env secret).
   */
  private getUpstreamToken(sessionId: string | undefined, profileId: string | undefined, provider: UpstreamMcpServerConfig): string | undefined {
    if (this.httpTransport && sessionId && profileId) {
      const sessionToken = this.httpTransport.getSessionToken(profileId, sessionId);
      if (sessionToken) return sessionToken;
    }
    if (provider.auth?.value_from_env) {
      return process.env[provider.auth.value_from_env];
    }
    return undefined;
  }

  /**
   * Forward tools/list to upstream MCP server and return sanitized tool list.
   * Requires a session context (HTTP transport only).
   */
  private async handleUpstreamToolsList(
    req: Record<string, unknown>,
    sessionId: string | undefined,
    profileId: string | undefined,
    provider: UpstreamMcpServerConfig,
  ): Promise<unknown> {
    if (!sessionId) {
      throw new UpstreamConnectionError(
        'upstream_mcp requires a session context (HTTP transport only)',
        provider.name,
      );
    }
    if (provider.tool_prefix) {
      this.logger.warn('upstream_mcp tool_prefix is configured but has no effect in the current version', {
        provider: provider.name,
        tool_prefix: provider.tool_prefix,
      });
    }
    const token = this.getUpstreamToken(sessionId, profileId, provider);
    try {
      const client = await this.getUpstreamClientFn!(sessionId, provider, token);
      const result = await client.listTools();
      if (!Array.isArray(result.tools)) {
        throw new UpstreamMalformedResponseError(
          provider.name,
          `tools field is not an array (got ${result.tools === null ? 'null' : typeof result.tools})`,
        );
      }
      const rawTools = result.tools;
      const sanitized = sanitizeToolList(rawTools, this.logger);
      const policyFiltered = applyProviderToolPolicy(sanitized.tools, provider.tools);
      // Cache sanitized+policy-filtered tool names for tools/call gate enforcement.
      // Tools dropped here (bad description/inputSchema) must not be callable via tools/call.
      // sessionId is always defined here: the method throws at line 1832 when !sessionId.
      let sessionCache = this.sanitizedAndPolicyFilteredToolNames.get(sessionId);
      if (!sessionCache) {
        sessionCache = new Map();
        this.sanitizedAndPolicyFilteredToolNames.set(sessionId, sessionCache);
      }
      sessionCache.set(provider.name, new Set(policyFiltered.map(t => t.name)));
      // Apply X-Mcp4-Tools filter as a pure name predicate against upstream-discovered tools.
      // Uses matchesSessionFilterByName (same abstraction as the local-tools path) - no
      // pre-computation or storage needed for upstream proxy profiles.
      const effectiveProfileIdForFilter = profileId || this.getProfileIdValue();
      const upstreamFilterRequest = typeof this.httpTransport?.getSessionToolFilterRequest === 'function'
        ? this.httpTransport.getSessionToolFilterRequest(effectiveProfileIdForFilter, sessionId)
        : undefined;
      const nameFiltered = upstreamFilterRequest?.hasRules
        ? policyFiltered.filter(t => matchesSessionFilterByName(upstreamFilterRequest, t.name))
        : policyFiltered;
      // Apply enterprise category policy - upstream tools default to 'modify' (no OpenAPI metadata)
      const enterpriseFiltered = this.isToolCategoryAllowedByEnterprisePolicy('modify', sessionId, profileId)
        ? nameFiltered
        : [];
      if (enterpriseFiltered.length === 0 && nameFiltered.length > 0) {
        this.logger.warn(
          "All upstream tools blocked by enterprise policy - upstream tools require the 'modify' permission",
          { provider: provider.name, sessionId, blockedCount: nameFiltered.length },
        );
      }
      return {
        jsonrpc: '2.0',
        id: (req as Record<string, unknown>).id,
        result: { tools: enterpriseFiltered },
      };
    } catch (error) {
      return {
        jsonrpc: '2.0',
        id: (req as Record<string, unknown>).id,
        error: mapUpstreamErrorToMcpError(error, provider.name),
      };
    }
  }

  /**
   * Forward tools/call to upstream MCP server.
   * Forwards isError:true results as-is (tool-level errors are valid MCP results).
   * Maps thrown exceptions to typed MCP error codes.
   * Requires a session context (HTTP transport only).
   */
  private async handleUpstreamToolCall(
    req: Record<string, unknown>,
    sessionId: string | undefined,
    profileId: string | undefined,
    provider: UpstreamMcpServerConfig,
    metricsBundle?: { collector: MetricsCollector; startTime: number; context: MetricsContextLabels },
  ): Promise<unknown> {
    if (!sessionId) {
      throw new UpstreamConnectionError(
        'upstream_mcp requires a session context (HTTP transport only)',
        provider.name,
      );
    }
    const params = req.params as Record<string, unknown>;
    const toolName = params.name as string;
    const args = (params.arguments as Record<string, unknown>) || {};

    // Enforce name validation at the function boundary, not only at call sites.
    // Guards against future call paths that skip the outer isValidUpstreamToolName() check.
    if (!isValidUpstreamToolName(toolName)) {
      throw new UpstreamConnectionError(
        `Invalid tool name rejected by upstream proxy: '${String(toolName).slice(0, 100)}'`,
        provider.name,
      );
    }

    const token = this.getUpstreamToken(sessionId, profileId, provider);

    try {
      const client = await this.getUpstreamClientFn!(sessionId, provider, token);
      const result = await (provider.timeout_ms !== undefined
        ? client.callTool({ name: toolName, arguments: args }, undefined, { timeout: provider.timeout_ms })
        : client.callTool({ name: toolName, arguments: args }));
      if (metricsBundle) {
        const durationSeconds = (Date.now() - metricsBundle.startTime) / 1000;
        metricsBundle.collector.recordToolCall(toolName, 'success', durationSeconds, metricsBundle.context);
      }
      // Forward as-is including isError: true (tool-level errors are valid MCP responses)
      return {
        jsonrpc: '2.0',
        id: (req as Record<string, unknown>).id,
        result,
      };
    } catch (error) {
      if (metricsBundle) {
        const durationSeconds = (Date.now() - metricsBundle.startTime) / 1000;
        metricsBundle.collector.recordToolCall(toolName, 'error', durationSeconds, metricsBundle.context);
        metricsBundle.collector.recordToolCallError(toolName, this.getMetricsErrorType(error), metricsBundle.context);
      }
      return {
        jsonrpc: '2.0',
        id: (req as Record<string, unknown>).id,
        error: mapUpstreamErrorToMcpError(error, provider.name),
      };
    }
  }

  private getMetricsCollector(): MetricsCollector | null {
    return this.httpTransport?.getMetricsCollector?.() || null;
  }

  private resolveMetricsContext(profileId?: string, sessionId?: string): MetricsContextLabels {
    let resolvedProfileId = profileId;
    if (!resolvedProfileId && this.profile) {
      resolvedProfileId = this.getProfileIdValue();
    }

    let resolvedTenantId: string | undefined;
    if (this.httpTransport && resolvedProfileId && sessionId) {
      const tenantContext = this.httpTransport.getSessionTenantContext?.(resolvedProfileId, sessionId);
      resolvedTenantId = tenantContext?.tenantId;
    }

    return {
      profileId: resolvedProfileId || 'unknown',
      tenantId: resolvedTenantId || 'none',
    };
  }

  private getMetricsErrorType(error: unknown): string {
    if (error instanceof Error) {
      return error.name;
    }
    return 'UnknownError';
  }

  private getFilteringForSession(sessionId?: string, profileId?: string): FilteringRules | undefined {
    if (this.httpTransport && sessionId) {
      const effectiveProfileId = profileId || this.getProfileIdValue();
      return this.httpTransport.getSessionFiltering(effectiveProfileId, sessionId);
    }
    return this.stdioFiltering ?? this.globalFiltering;
  }

  private getToolFilterForSession(sessionId?: string, profileId?: string): SessionToolFilter | undefined {
    if (this.httpTransport && sessionId && typeof this.httpTransport.getSessionToolFilter === 'function') {
      const effectiveProfileId = profileId || this.getProfileIdValue();
      return this.httpTransport.getSessionToolFilter(effectiveProfileId, sessionId);
    }
    return undefined;
  }

  private getEnterpriseAllowedToolCategoriesForSession(
    sessionId?: string,
    profileId?: string,
  ): Set<EnterpriseToolCategory> | undefined {
    if (this.httpTransport && sessionId && typeof this.httpTransport.getSessionEnterpriseAllowedToolCategories === 'function') {
      const effectiveProfileId = profileId || this.getProfileIdValue();
      return this.httpTransport.getSessionEnterpriseAllowedToolCategories(effectiveProfileId, sessionId);
    }
    return undefined;
  }

  private getToolCategory(toolDef: ToolDefinition): Exclude<EnterpriseToolCategory, 'admin'> {
    const classifier = new OperationClassifier();

    if (toolDef.composite && toolDef.steps?.length) {
      let hasList = false;
      let hasRead = false;

      for (const step of toolDef.steps) {
        const [method, stepPath] = step.call.split(' ');
        const operation = method && stepPath ? this.parser.getPath(stepPath)?.operations[method.toLowerCase()] : undefined;
        if (!operation) {
          return 'modify';
        }

        const category = classifier.classify(operation);
        if (category === 'modify') {
          return 'modify';
        }
        if (category === 'list') {
          hasList = true;
          continue;
        }
        hasRead = true;
      }

      if (hasList && !hasRead) {
        return 'list';
      }
      if (hasRead && !hasList) {
        return 'read';
      }
      return 'modify';
    }

    if (!toolDef.operations) {
      return 'modify';
    }

    let hasList = false;
    let hasRead = false;

    for (const [action, operationDefinition] of Object.entries(toolDef.operations)) {
      if (typeof operationDefinition !== 'string') {
        return 'modify';
      }

      const operation = this.parser.getOperation(operationDefinition);
      const category = operation
        ? classifier.classify(operation)
        : this.getFallbackToolCategory(action);

      if (category === 'modify') {
        return 'modify';
      }
      if (category === 'list') {
        hasList = true;
        continue;
      }
      hasRead = true;
    }

    if (hasList && !hasRead) {
      return 'list';
    }
    if (hasRead && !hasList) {
      return 'read';
    }
    return 'modify';
  }

  private getFallbackToolCategory(action: string): Exclude<EnterpriseToolCategory, 'admin'> {
    const normalizedAction = action.toLowerCase();
    if (normalizedAction === 'list' || normalizedAction === 'search') {
      return 'list';
    }
    if (normalizedAction === 'get' || normalizedAction === 'read') {
      return 'read';
    }
    return 'modify';
  }

  private isToolAllowedByEnterprisePolicy(
    toolDef: ToolDefinition,
    sessionId?: string,
    profileId?: string,
  ): boolean {
    return this.isToolCategoryAllowedByEnterprisePolicy(this.getToolCategory(toolDef), sessionId, profileId);
  }

  /**
   * Check whether a given tool category is allowed by the enterprise policy for the session.
   * Used for both local tools (with a known ToolDefinition) and upstream tools (defaulted to 'modify').
   */
  private isToolCategoryAllowedByEnterprisePolicy(
    category: Exclude<EnterpriseToolCategory, 'admin'>,
    sessionId?: string,
    profileId?: string,
  ): boolean {
    const allowedCategories = this.getEnterpriseAllowedToolCategoriesForSession(sessionId, profileId);
    if (!allowedCategories || allowedCategories.size === 0) {
      return true;
    }
    return allowedCategories.has(category);
  }

  private getFilteringOperationInfo(
    toolDef: ToolDefinition,
    args: Record<string, unknown>
  ): OperationInfo | undefined {
    if (toolDef.composite) {
      return undefined;
    }
    const operationId = this.toolGenerator.mapActionToOperation(toolDef, args);
    if (!operationId) {
      return undefined;
    }
    return this.parser.getOperation(operationId);
  }

  private async handleOtherRequest(message: unknown, sessionId?: string, profileId?: string): Promise<unknown> {
    const req = message as Record<string, unknown>;

    // Check OAuth authentication for other operations (like tools/list)
    if (this.httpTransport && this.httpTransport.hasOAuthProvider(profileId)) {
      const authToken = await this.getAuthTokenFromSession(sessionId || '', profileId);
      if (!authToken) {
        // Return OAuth required error with WWW-Authenticate header
        // This should trigger the OAuth flow in the client
        const errorResponse = {
          jsonrpc: '2.0',
          id: req.id,
          error: {
            code: ErrorCode.InvalidRequest,
            message: 'Authentication required. Please authorize via OAuth.',
            data: {
              oauth_required: true,
              resource_metadata: this.httpTransport.getOAuthProtectedResourceUrl(profileId),
              scope: 'api'
            }
          }
        };
        return errorResponse;
      }
    }

    // Handle tools/list
    if (req.method === 'tools/list') {
      // D-01: When upstream_mcp is set, return upstream tools (not local profile tools)
      const upstreamMcpForList = this.getUpstreamMcpConfig(profileId);
      if (upstreamMcpForList?.length && this.getUpstreamClientFn) {
        return this.handleUpstreamToolsList(req, sessionId, profileId, upstreamMcpForList[0]);
      }

      const sessionFilter = this.getToolFilterForSession(sessionId, profileId);
      const allowedSet = sessionFilter?.allowedToolNames;
      const tools = this.profile?.tools
        .filter(toolDef => !allowedSet || allowedSet.has(toolDef.name))
        .filter(toolDef => this.isToolAllowedByEnterprisePolicy(toolDef, sessionId, profileId))
        .map(toolDef => this.buildToolDescriptor(toolDef)) || [];

      return {
        jsonrpc: '2.0',
        id: req.id,
        result: {
          tools,
        },
      };
    }

    if (req.method === 'prompts/list') {
      return {
        jsonrpc: '2.0',
        id: req.id,
        result: {
          prompts: this.listPrompts(),
        },
      };
    }

    if (req.method === 'prompts/get') {
      try {
        const params = (req.params || {}) as Record<string, unknown>;
        const name = params.name;
        if (typeof name !== 'string' || !name.trim()) {
          throw new ValidationError('prompts/get requires string parameter "name"');
        }

        const argumentsValue = params.arguments;
        if (argumentsValue !== undefined && (typeof argumentsValue !== 'object' || Array.isArray(argumentsValue) || argumentsValue === null)) {
          throw new ValidationError('prompts/get parameter "arguments" must be an object when provided');
        }

        const promptResult = this.renderPromptByName(
          name,
          (argumentsValue as Record<string, unknown>) || {}
        );

        return {
          jsonrpc: '2.0',
          id: req.id,
          result: promptResult,
        };
      } catch (error) {
        let code = -32603;
        if (error instanceof ValidationError) {
          code = -32602;
        } else if (error instanceof ResourceNotFoundError) {
          code = -32601;
        }

        return {
          jsonrpc: '2.0',
          id: req.id,
          error: {
            code,
            message: (error as Error).message,
          },
        };
      }
    }

    if (req.method === 'resources/list') {
      return {
        jsonrpc: '2.0',
        id: req.id,
        result: {
          resources: this.listResources(),
        },
      };
    }

    if (req.method === 'resources/templates/list') {
      return {
        jsonrpc: '2.0',
        id: req.id,
        result: {
          resourceTemplates: this.listResourceTemplates(),
        },
      };
    }

    if (req.method === 'resources/read') {
      try {
        const params = (req.params || {}) as Record<string, unknown>;
        if (typeof params.uri !== 'string' || !params.uri.trim()) {
          throw new ValidationError('resources/read requires string parameter "uri"');
        }
        return {
          jsonrpc: '2.0',
          id: req.id,
          result: await this.readResource(params.uri, sessionId, profileId),
        };
      } catch (error) {
        return {
          jsonrpc: '2.0',
          id: req.id,
          error: {
            code: error instanceof ValidationError ? -32602 : -32601,
            message: (error as Error).message,
          },
        };
      }
    }

    if (req.method === 'completion/complete') {
      try {
        return {
          jsonrpc: '2.0',
          id: req.id,
          result: await this.completeResourceArgument(req as CompleteRequest, sessionId, profileId),
        };
      } catch (error) {
        return {
          jsonrpc: '2.0',
          id: req.id,
          error: {
            code: error instanceof ValidationError ? -32602 : -32601,
            message: (error as Error).message,
          },
        };
      }
    }

    // Unknown method
    return {
      jsonrpc: '2.0',
      id: req.id,
      error: {
        code: -32601,
        message: `Method not found: ${req.method}`,
      },
    };
  }

  private buildToolDescriptor(toolDef: ToolDefinition) {
    return composeToolDescriptor(this.toolGenerator.generateTool(toolDef), toolDef, this.appsModel);
  }

  private listResources() {
    return this.appsModel?.fixedResources.map((resource) => ({
      uri: resource.uri,
      name: resource.name,
      title: resource.title,
      description: resource.description,
      mimeType: resource.mimeType,
      _meta: resource.appsMeta,
    })) || [];
  }

  private listResourceTemplates() {
    return this.appsModel?.templateResources.map((resource) => ({
      uriTemplate: resource.uriTemplate,
      name: resource.name,
      title: resource.title,
      description: resource.description,
      mimeType: resource.mimeType,
      _meta: resource.appsMeta,
    })) || [];
  }

  private async readResource(
    uri: string,
    sessionId?: string,
    profileId?: string,
  ): Promise<{ contents: Array<Record<string, unknown>> }> {
    const fixedResource = this.appsModel?.resourcesByUri.get(uri);
    if (fixedResource) {
      const text = fixedResource.text ?? await this.fetchResourceContent(fixedResource.fetchStrategy, {}, sessionId, profileId);
      return {
        contents: [{
          uri,
          mimeType: fixedResource.mimeType,
          _meta: fixedResource.appsMeta,
          text,
        }],
      };
    }

    const templateMatches = (this.appsModel?.templateResources || [])
      .map((resource) => ({ resource, variables: extractTemplateVariables(resource, uri) }))
      .filter((candidate): candidate is { resource: LoadedTemplateResource; variables: Record<string, string> } => !!candidate.variables);

    if (templateMatches.length === 0) {
      throw new ResourceNotFoundError(uri, 'Resource');
    }
    if (templateMatches.length > 1) {
      throw new ValidationError(`Ambiguous resource uri '${uri}'`, { uri });
    }

    const match = templateMatches[0];
    const text = match.resource.staticText
      ?? await this.fetchResourceContent(match.resource.fetchStrategy, match.variables, sessionId, profileId);
    if (text === undefined) {
      throw new ResourceNotFoundError(uri, 'Resource');
    }

    return {
      contents: [{
        uri,
        mimeType: match.resource.mimeType,
        _meta: match.resource.appsMeta,
        text,
      }],
    };
  }

  private async completeResourceArgument(
    request: CompleteRequest,
    sessionId?: string,
    profileId?: string,
  ) {
    const params = request.params as Record<string, unknown>;
    const ref = params.ref as { type?: string; uri?: string } | undefined;
    const argument = params.argument as { name?: string; value?: string } | undefined;
    const context = params.context as { arguments?: Record<string, string> } | undefined;

    if (ref?.type !== 'ref/resource' || typeof ref.uri !== 'string') {
      throw new ValidationError('completion/complete requires a resource ref');
    }
    if (!argument?.name || typeof argument.value !== 'string') {
      throw new ValidationError('completion/complete requires argument.name and argument.value');
    }

    const resourceUri = ref.uri;
    const resource = this.appsModel?.templateResourcesByUriTemplate.get(resourceUri)
      || this.appsModel?.templateResources.find((candidate) => !!extractTemplateVariables(candidate, resourceUri));
    if (!resource?.completion) {
      throw new ResourceNotFoundError(resourceUri, 'Resource template');
    }

    const completionVariable = resource.completion.variables[argument.name];
    if (!completionVariable) {
      throw new ValidationError(`No completion configured for variable '${argument.name}'`);
    }

    const contextArguments = context?.arguments || {};
    const values = await this.resolveCompletionValues(
      completionVariable,
      argument.value,
      contextArguments,
      sessionId,
      profileId,
    );
    return {
      completion: {
        values,
        total: values.length,
        hasMore: false,
      },
    };
  }

  private async fetchResourceContent(
    strategy: LoadedResourceFetchStrategy | undefined,
    variables: Record<string, string>,
    sessionId?: string,
    profileId?: string,
  ): Promise<string | undefined> {
    if (!strategy) {
      return undefined;
    }

    const input = this.buildMappedInput(variables, strategy.parameterMapping);
    const cacheKey = this.buildAppsFetchCacheKey(strategy, input, sessionId, profileId);
    if (cacheKey) {
      const cached = this.appsFetchCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        return cached.value;
      }
      this.appsFetchCache.delete(cacheKey);
    }

    const response = await this.executeAppsFetch(strategy, input, sessionId, profileId);
    const extracted = getNestedValue(response, strategy.resultPath);
    const text = typeof extracted === 'string'
      ? extracted
      : JSON.stringify(extracted === undefined ? response : extracted, null, 2);

    if (cacheKey && text !== undefined) {
      this.appsFetchCache.set(cacheKey, {
        expiresAt: Date.now() + strategy.cacheTtlSeconds! * 1000,
        value: text,
      });
    }

    return text;
  }

  private async resolveCompletionValues(
    variable: LoadedCompletionVariable,
    partialValue: string,
    contextArguments: Record<string, string>,
    sessionId?: string,
    profileId?: string,
  ): Promise<string[]> {
    const filterValues = (values: string[]) => values
      .filter((value) => value.toLowerCase().includes(partialValue.toLowerCase()))
      .slice(0, 100);

    if (variable.source === 'static') {
      return filterValues(variable.values || []);
    }

    const response = await this.executeAppsFetch(
      variable,
      this.buildMappedInput(contextArguments, variable.parameterMapping),
      sessionId,
      profileId,
    );
    const extracted = getNestedValue(response, variable.resultPath);
    const collection = Array.isArray(extracted) ? extracted : [];
    const values = collection
      .map((item) => this.extractCompletionValue(item, variable))
      .filter((value): value is string => typeof value === 'string' && value.length > 0);

    return filterValues(Array.from(new Set(values)));
  }

  private extractCompletionValue(item: unknown, variable: LoadedCompletionVariable): string | undefined {
    if (typeof item === 'string') {
      return item;
    }
    if (!item || typeof item !== 'object') {
      return undefined;
    }
    const value = getNestedValue(item, variable.valuePath || variable.labelPath);
    return typeof value === 'string' ? value : undefined;
  }

  private buildMappedInput(source: Record<string, string>, parameterMapping: Record<string, string>): Record<string, unknown> {
    if (Object.keys(parameterMapping).length === 0) {
      return { ...source };
    }

    return Object.entries(parameterMapping).reduce<Record<string, unknown>>((result, [targetKey, sourceKey]) => {
      if (source[sourceKey] !== undefined) {
        result[targetKey] = source[sourceKey];
      }
      return result;
    }, {});
  }

  private buildAppsFetchCacheKey(
    strategy: LoadedResourceFetchStrategy,
    args: Record<string, unknown>,
    sessionId?: string,
    profileId?: string,
  ): string | undefined {
    if (!strategy.cacheTtlSeconds || strategy.cacheTtlSeconds <= 0) {
      return undefined;
    }

    return JSON.stringify({
      source: strategy.source,
      operation: strategy.operation,
      compositeTool: strategy.compositeTool,
      resultPath: strategy.resultPath,
      args,
      sessionId,
      profileId,
    });
  }

  private async executeAppsFetch(
    strategy: LoadedResourceFetchStrategy | LoadedCompletionVariable,
    args: Record<string, unknown>,
    sessionId?: string,
    profileId?: string,
  ): Promise<unknown> {
    const task = strategy.source === 'operation'
      ? this.executeAppsOperation(strategy.operation!, args, sessionId, profileId)
      : this.executeAppsComposite(strategy.compositeTool!, args, sessionId, profileId);
    return await Promise.race([
      task,
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new ValidationError('Apps fetch timed out')), strategy.timeoutMs);
      }),
    ]);
  }

  private async executeAppsOperation(
    operationId: string,
    args: Record<string, unknown>,
    sessionId?: string,
    profileId?: string,
  ): Promise<unknown> {
    const operation = this.parser.getOperation(operationId);
    if (!operation) {
      throw new OperationNotFoundError(operationId);
    }
    const path = this.resolvePath(operation.path, args);
    const queryParams = this.extractQueryParams(operation, args);
    const httpClient = await this.getHttpClientForSession(sessionId, profileId);
    const response = await httpClient.request(operation.method, path, {
      params: queryParams,
      operationId,
    });
    return response.body;
  }

  private async executeAppsComposite(
    toolName: string,
    args: Record<string, unknown>,
    sessionId?: string,
    profileId?: string,
  ): Promise<unknown> {
    const toolDef = this.profile?.tools.find((tool) => tool.name === toolName);
    if (!toolDef?.steps) {
      throw new ResourceNotFoundError(toolName, 'Composite tool');
    }
    const compositeResult = await this.compositeExecutor?.execute(
      toolDef.steps,
      args,
      false,
      await this.getHttpClientForSession(sessionId, profileId),
    );
    return compositeResult?.data;
  }

  private listPrompts(): Array<{
    name: string;
    description?: string;
    arguments?: Array<{
      name: string;
      description?: string;
      required?: boolean;
    }>;
  }> {
    return (this.profile?.prompts || []).map((prompt) => ({
      name: prompt.name,
      description: prompt.description,
      arguments: prompt.arguments?.map((argument) => ({
        name: argument.name,
        description: argument.description,
        required: argument.required,
      })),
    }));
  }

  private renderPromptByName(name: string, args: Record<string, unknown>): {
    description?: string;
    messages: Array<{
      role: 'user' | 'assistant';
      content: {
        type: 'text';
        text: string;
      };
    }>;
  } {
    const prompt = this.profile?.prompts?.find((promptItem) => promptItem.name === name);
    if (!prompt) {
      throw new ResourceNotFoundError(name, 'Prompt');
    }

    const rendered = renderPrompt(prompt, args);
    return {
      description: rendered.description,
      messages: rendered.messages,
    };
  }

  private applyGlobalToolFiltering(): void {
    if (!this.profile) {
      return;
    }

    // Initialize ToolFilterService if not already done
    if (!this.toolFilterService) {
      const validator = new RegexValidator();
      const compiler = new RegexCompiler(validator);
      const envParser = new EnvConfigParser(compiler);
      const headerParser = new HeaderConfigParser(compiler);
      
      // Create OperationDetector for category filtering
      const classifier = new OperationClassifier();
      const resolver = new OpenAPIOperationResolver(this.parser);
      const detector = new OperationDetector(classifier, resolver);
      
      this.toolFilterService = new ToolFilterService(
        envParser,
        headerParser,
        this.logger,
        detector
      );
    }

    const originalTools = this.profile.tools;
    const originalCount = originalTools.length;

    // Apply filtering using new service
    const filteredTools = this.toolFilterService.applyGlobalFilter(originalTools, process.env);
    const allowedCount = filteredTools.length;
    const removedCount = originalCount - allowedCount;

    // Early return if no filtering config present (service returned same tools)
    if (filteredTools === originalTools) {
      return;
    }

    // Validation: check if filter has no effect
    if (originalCount > 0 && allowedCount === originalCount && removedCount === 0) {
      throw new ConfigurationError(
        `Tool filter configuration has no effect. Original tool count: ${originalCount}, filtered: ${allowedCount}. Check MCP4_TOOL_FILTER_* patterns.`
      );
    }

    // Validation: check if all tools filtered
    if (originalCount > 0 && allowedCount === 0) {
      throw new ConfigurationError(
        `All tools filtered out (original: ${originalCount}). Check MCP4_TOOL_FILTER_* settings.`
      );
    }

    // Validate composite tools against filtered operations
    const resolver = this.buildToolFilterResolver();
    this.validateCompositeToolsAgainstFilteredOperations(originalTools, filteredTools, resolver);

    // Update profile
    this.profile.tools = filteredTools;

    // Record summary for metrics
    this.globalToolFilterSummary = {
      originalCount,
      allowedCount,
      removedCount,
      patternCounts: {
        // Note: counts not available from new service, using simplified version
        filtered: removedCount
      }
    };

    // Warn if high percentage filtered
    const warnThreshold = this.getToolFilterWarnThresholdPct();
    if (originalCount > 0) {
      const percentFiltered = (removedCount / originalCount) * 100;
      if (percentFiltered >= warnThreshold) {
        this.logger.warn('Tool filter removed high percentage of tools', {
          original: originalCount,
          surviving: allowedCount,
          threshold_pct: warnThreshold,
          removed_count: removedCount
        });
      }
    }

    if (this.httpTransport) {
      this.recordGlobalToolFilterMetrics();
    }
  }

  private applySessionToolFiltering(sessionId: string, profileId?: string): void {
    if (!this.httpTransport || !this.profile) {
      return;
    }

    if (typeof this.httpTransport.getSessionToolFilterRequest !== 'function') {
      return;
    }
    const effectiveProfileId = profileId || this.getProfileIdValue();
    const request: SessionToolFilterRequest | undefined =
      this.httpTransport.getSessionToolFilterRequest(effectiveProfileId, sessionId);
    if (!request) {
      return;
    }

    const originalCount = this.profile.tools.length;

    // For upstream proxy profiles (tools[] is empty, upstream_mcp configured):
    // - Category rules require OpenAPI metadata unavailable for upstream tools - reject at init.
    // - Exact/regex rules are pure name predicates; evaluated inline at tools/list and tools/call.
    if (originalCount === 0 && this.getUpstreamMcpConfig(profileId)?.length) {
      if (request.allowCategories.size > 0) {
        throw new ValidationError(
          '_allow_list/_allow_read not supported for upstream proxy profiles. Use exact names or regex patterns instead.'
        );
      }
      // No pre-computation needed - predicate evaluated inline at tools/list and tools/call time.
      return;
    }

    const resolver = this.buildToolFilterResolver();
    const sessionFilter = applySessionToolFilter(this.profile.tools, request, resolver);
    const allowedCount = sessionFilter.allowedToolNames.size;

    if (originalCount > 0 && allowedCount === originalCount) {
      throw new ValidationError(
        `X-Mcp4-Tools filter has no effect for this session. Available tools: ${originalCount}, after filter: ${allowedCount}. Check patterns.`
      );
    }

    if (originalCount > 0 && allowedCount === 0) {
      const sources = request.rawEntries.length > 0 ? request.rawEntries.join(', ') : 'none';
      throw new ValidationError(
        `X-Mcp4-Tools filtered out all tools (original: ${originalCount}). Removed by: ${sources}. Check session filter configuration.`
      );
    }

    this.httpTransport.setSessionToolFilter(effectiveProfileId, sessionId, sessionFilter);
    this.logger.info('Session tool filter applied', {
      sessionId,
      originalCount,
      allowedCount,
      patterns: request.rawEntries,
    });

    this.recordSessionToolFilterMetrics(sessionId, allowedCount, request);
  }

  private buildToolFilterResolver() {
    return {
      getOperationById: (operationId: string) => this.parser.getOperation(operationId),
      getOperationForCall: (call: string) => {
        const [method, path] = call.split(' ');
        if (!method || !path) {
          return undefined;
        }
        const pathInfo = this.parser.getPath(path);
        return pathInfo?.operations[method.toLowerCase()];
      },
    };
  }

  private validateCompositeToolsAgainstFilteredOperations(
    originalTools: ToolDefinition[],
    allowedTools: ToolDefinition[],
    resolver: ReturnType<MCPServer['buildToolFilterResolver']>
  ): void {
    const operationToTools = new Map<string, string[]>();
    for (const tool of originalTools) {
      if (!tool.operations) {
        continue;
      }
      for (const operationId of Object.values(tool.operations)) {
        if (typeof operationId !== 'string') {
          continue;
        }
        const names = operationToTools.get(operationId) ?? [];
        names.push(tool.name);
        operationToTools.set(operationId, names);
      }
    }

    const allowedOperationIds = new Set<string>();
    for (const tool of allowedTools) {
      if (!tool.operations) {
        continue;
      }
      for (const operationId of Object.values(tool.operations)) {
        if (typeof operationId !== 'string') {
          continue;
        }
        allowedOperationIds.add(operationId);
      }
    }

    for (const tool of allowedTools) {
      if (!tool.composite || !tool.steps) {
        continue;
      }

      for (const step of tool.steps) {
        const operation = resolver.getOperationForCall(step.call);
        if (!operation) {
          continue;
        }
        if (allowedOperationIds.has(operation.operationId)) {
          continue;
        }
        const removedTools = operationToTools.get(operation.operationId);
        if (!removedTools || removedTools.length === 0) {
          continue;
        }
        const removedList = removedTools.join(', ');
        throw new ConfigurationError(
          `Composite tool '${tool.name}' step '${step.call}' calls filtered tool '${removedList}'. ` +
          `Add '${removedList}' to filter or include _allow_list or _allow_read if it is a list or read operation.`
        );
      }
    }
  }

  private getToolFilterWarnThresholdPct(): number {
    const raw = process.env.MCP4_TOOL_FILTER_WARN_THRESHOLD_PCT;
    if (raw === undefined) {
      return 90;
    }
    const parsed = Number(raw);
    if (Number.isNaN(parsed) || parsed <= 0) {
      throw new ConfigurationError(
        `Invalid MCP4_TOOL_FILTER_WARN_THRESHOLD_PCT: expected positive number, got '${raw}'.`
      );
    }
    return parsed;
  }

  private recordGlobalToolFilterMetrics(): void {
    if (!this.httpTransport || !this.globalToolFilterSummary) {
      return;
    }
    if (typeof this.httpTransport.recordGlobalToolFilterMetrics !== 'function') {
      return;
    }
    this.httpTransport.recordGlobalToolFilterMetrics(this.globalToolFilterSummary);
  }

  private recordSessionToolFilterMetrics(
    sessionId: string,
    allowedCount: number,
    request: SessionToolFilterRequest
  ): void {
    if (!this.httpTransport) {
      return;
    }
    if (typeof this.httpTransport.recordSessionToolFilterMetrics !== 'function') {
      return;
    }
    this.httpTransport.recordSessionToolFilterMetrics(sessionId, allowedCount, request);
  }

  private recordToolFilterRejection(toolName: string, source: 'env' | 'session'): void {
    if (!this.httpTransport) {
      return;
    }
    if (typeof this.httpTransport.recordToolFilterRejection !== 'function') {
      return;
    }
    this.httpTransport.recordToolFilterRejection(toolName, source);
  }

  /**
   * Stop the MCP server gracefully
   *
   * Why: Cleanup resources, close connections, allow graceful shutdown
   */
  async stop(): Promise<void> {
    if (this.httpTransport) {
      await this.httpTransport.stop();
    }
  }
}
