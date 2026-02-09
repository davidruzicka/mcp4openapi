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
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { OpenAPIParser } from '../openapi/openapi-parser.js';
import { ProfileLoader } from '../profile/profile-loader.js';
import { ToolGenerator } from '../tooling/tool-generator.js';
import { applyParameterDefaults, normalizeArguments } from '../validation/argument-normalizer.js';
import { CompositeExecutor } from '../tooling/composite-executor.js';
import { ProxyDownloadExecutor } from '../tooling/proxy-executor.js';
import { enforceFiltering, parseFilteringHeader, type FilteringRules } from '../core/filtering.js';
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
import type { Profile, ToolDefinition, AuthInterceptor, OAuthConfig, ProxyDownloadOperation } from '../types/profile.js';
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
  type SessionToolFilterCompat as SessionToolFilter,
  type SessionToolFilterRequest,
} from '../tool-filter/index.js';
import type { HttpProfileContext } from '../types/http-transport.js';
import type { HttpTransport } from '../transport/http-transport.js';
import { buildHttpTransportBaseConfig } from '../transport/http-transport-config.js';

export class MCPServer {
  private server: Server;
  private parser: OpenAPIParser;
  private profile?: Profile;
  private toolGenerator: ToolGenerator;
  private httpClientFactory = new HttpClientFactory();
  private compositeExecutor?: CompositeExecutor;
  private schemaValidator: SchemaValidator;
  private logger: Logger;
  private httpTransport: HttpTransport | null = null;
  private stdioFiltering?: FilteringRules;
  private toolFilterService?: ToolFilterService;
  private globalToolFilterSummary?: {
    originalCount: number;
    allowedCount: number;
    removedCount: number;
    patternCounts: Record<string, number>;
  };

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
        },
      }
    );

    this.parser = new OpenAPIParser();
    this.toolGenerator = new ToolGenerator(this.parser);
    
    this.setupHandlers();
  }

  async initialize(specPath: string, profilePath?: string): Promise<void> {
    // Load OpenAPI spec
    await this.parser.load(specPath);
    this.logger.info('Loaded OpenAPI spec', { specPath });

    // Load or create MCP profile
    if (profilePath) {
      const loader = new ProfileLoader();
      this.profile = await loader.load(profilePath);
      this.logger.info('Loaded profile', {
        profile: this.profile.profile_name,
        toolCount: this.profile.tools.length,
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
    const envVarName = envAuthConfig?.value_from_env;
    const envToken = envVarName ? process.env[envVarName] : undefined;

    if ((envAuthConfig && envToken) || authConfigs.length === 0) {
      // Token available in env (stdio) or no auth required - create global client
      const httpClient = this.httpClientFactory.createGlobalClient({
        profile: this.profile,
        baseUrl,
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
      baseUrl,
      rateLimitOAuthMax: oauthRateLimit.max,
      rateLimitOAuthWindowMs: oauthRateLimit.windowMs,
      resourceName: this.profile.resource_name || resourceMetadata.name || 'MCP Server',
      resourceDocumentation: this.profile.resource_documentation || resourceMetadata.documentation,
      parser: this.parser,
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

    // Create or get session client using factory
    return this.httpClientFactory.getOrCreateSessionClient(sessionId, {
      profile: this.profile,
      baseUrl: this.getBaseUrl(),
      sessionToken: authToken,
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

        const tools = this.profile.tools.map(toolDef =>
          this.toolGenerator.generateTool(toolDef)
        );

        return { tools };
      } catch (err) {
        // Generate correlation ID only on error (lazy)
        const correlationId = generateCorrelationId();
        this.logger.error('ListTools handler error', err as Error, { correlationId });
        // Always return generic error to clients
        throw new Error(`Internal error (correlation ID: ${correlationId})`);
      }
    });

    // Execute tool
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        if (!this.profile || !this.compositeExecutor) {
          throw new ConfigurationError('Server not initialized. Call initialize() first.');
        }

        const toolDef = this.profile.tools.find(t => t.name === request.params.name);
        if (!toolDef) {
          throw new OperationNotFoundError(request.params.name);
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

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (err) {
        // Generate correlation ID only on error (lazy)
        const correlationId = generateCorrelationId();
        this.logger.error('CallTool handler error', err as Error, { 
          correlationId,
          toolName: request.params.name,
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
      resourceName: profileContext.resourceName,
      resourceDocumentation: profileContext.resourceDocumentation,
      parser: profileContext.parser,
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
      this.stdioFiltering = parsed.filtering;
    }

    if (this.httpTransport && sessionId) {
      this.applySessionToolFiltering(sessionId, profileId);
    }

    const result: {
      protocolVersion: string;
      serverInfo: { name: string; version: string };
      capabilities: { tools: Record<string, never> };
      sessionId?: string;
    } = {
      protocolVersion: '2025-03-26',
      serverInfo: {
        name: 'mcp4openapi',
        version: '0.1.0',
      },
      capabilities: {
        tools: {},
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

    // Check OAuth authentication for tool operations
    if (this.httpTransport && this.httpTransport.hasOAuthProvider(profileId)) {
      const authToken = await this.getAuthTokenFromSession(sessionId || '', profileId);
      if (!authToken) {
        // Return OAuth required error with WWW-Authenticate header
        // This should trigger the OAuth flow in the client
        const errorResponse = {
          jsonrpc: '2.0',
          id: req.id,
          error: {
            code: -32001, // Application error
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

    let args: Record<string, unknown> = rawArgs;

    try {
      // Find tool definition
      const toolDef = this.profile?.tools.find(t => t.name === toolName);
      if (!toolDef) {
        throw new ResourceNotFoundError(toolName, 'Tool');
      }
      args = applyParameterDefaults(toolDef, rawArgs);

      const toolFilter = this.getToolFilterForSession(sessionId, profileId);
      if (toolFilter && !toolFilter.allowedToolNames.has(toolName)) {
        this.recordToolFilterRejection(toolName, 'session');
        const reason = toolFilter.reasons.get(toolName)?.[0];
        const reasonSuffix = reason ? ` Blocked by: ${reason}.` : '';
        throw new AuthorizationError(
          `Tool '${toolName}' not allowed by X-Mcp4-Tools filter.${reasonSuffix}`
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
      let errorCode = -32603; // Internal error (default)
      if (error instanceof AuthenticationError) {
        errorCode = -32001; // Authentication error
      } else if (error instanceof AuthorizationError) {
        errorCode = -32002; // Authorization error
      } else if (error instanceof ValidationError) {
        errorCode = -32602; // Invalid params
      } else if (error instanceof RateLimitError) {
        errorCode = -32003; // Rate limit error
      } else if (error instanceof OperationNotFoundError) {
        errorCode = -32601; // Method not found
      } else if (error instanceof ResourceNotFoundError) {
        errorCode = -32601; // Method not found
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

  private getFilteringForSession(sessionId?: string, profileId?: string): FilteringRules | undefined {
    if (this.httpTransport && sessionId) {
      const effectiveProfileId = profileId || this.getProfileIdValue();
      return this.httpTransport.getSessionFiltering(effectiveProfileId, sessionId);
    }
    return this.stdioFiltering;
  }

  private getToolFilterForSession(sessionId?: string, profileId?: string): SessionToolFilter | undefined {
    if (this.httpTransport && sessionId && typeof this.httpTransport.getSessionToolFilter === 'function') {
      const effectiveProfileId = profileId || this.getProfileIdValue();
      return this.httpTransport.getSessionToolFilter(effectiveProfileId, sessionId);
    }
    return undefined;
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
            code: -32001, // Application error
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
      const sessionFilter = this.getToolFilterForSession(sessionId, profileId);
      const allowedSet = sessionFilter?.allowedToolNames;
      const tools = this.profile?.tools
        .filter(toolDef => !allowedSet || allowedSet.has(toolDef.name))
        .map(toolDef => this.toolGenerator!.generateTool(toolDef)) || [];

      return {
        jsonrpc: '2.0',
        id: req.id,
        result: {
          tools,
        },
      };
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
    const resolver = this.buildToolFilterResolver();
    const sessionFilter = applySessionToolFilter(this.profile.tools, request, resolver);
    const allowedCount = sessionFilter.allowedToolNames.size;

    if (allowedCount === originalCount) {
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
