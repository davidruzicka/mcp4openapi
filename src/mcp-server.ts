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

import { OpenAPIParser } from './openapi-parser.js';
import { ProfileLoader } from './profile-loader.js';
import { ToolGenerator } from './tool-generator.js';
import { CompositeExecutor } from './composite-executor.js';
import { ProxyDownloadExecutor } from './proxy-executor.js';
import { 
  ConfigurationError, 
  OperationNotFoundError, 
  ValidationError, 
  AuthenticationError,
  AuthorizationError,
  RateLimitError,
  NetworkError,
  generateCorrelationId,
  isMCPError
} from './errors.js';
import { TIMEOUTS, OAUTH_RATE_LIMIT } from './constants.js';
import { InterceptorChain, HttpClient } from './interceptors.js';
import { HttpClientFactory } from './http-client-factory.js';
import { SchemaValidator } from './schema-validator.js';
import type { Profile, ToolDefinition, AuthInterceptor, OAuthConfig, ProxyDownloadOperation } from './types/profile.js';
import type { Logger } from './logger.js';
import { ConsoleLogger, JsonLogger } from './logger.js';
import type { OperationInfo } from './types/openapi.js';
import { isInitializeRequest, isToolCallRequest } from './jsonrpc-validator.js';
import { generateNameWarnings, type NameWarningOptions } from './naming-warnings.js';
import { NamingStrategy, type OperationForNaming } from './naming.js';

export class MCPServer {
  private server: Server;
  private parser: OpenAPIParser;
  private profile?: Profile;
  private toolGenerator: ToolGenerator;
  private httpClientFactory = new HttpClientFactory();
  private compositeExecutor?: CompositeExecutor;
  private schemaValidator: SchemaValidator;
  private logger: Logger;
  private httpTransport: any = null;

  /**
   * Filter response object to include only specified fields
   * Supports nested objects but keeps first level of arrays
   */
  private filterFields(data: unknown, fields: string[]): unknown {
    if (!data || typeof data !== 'object') {
      return data;
    }

    if (Array.isArray(data)) {
      return data.map(item => this.filterFields(item, fields));
    }

    const filtered: Record<string, unknown> = {};
    for (const field of fields) {
      // Handle YouTrack-style fields: "author(id,login)" -> "author"
      const baseFieldName = field.split('(')[0];
      
      if (baseFieldName in data) {
        filtered[baseFieldName] = (data as Record<string, unknown>)[baseFieldName];
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

    if (envAuthConfig && envToken) {
      // Token available in env - create global client (stdio transport)
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
      ? (this.logger as any).level
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
  private async getHttpClientForSession(sessionId?: string): Promise<HttpClient> {
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
    const authToken = await this.getAuthTokenFromSession(sessionId);

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
  private async getAuthTokenFromSession(sessionId: string): Promise<string | undefined> {
    // Early return if sessionId is missing/empty
    // Prevents misleading warn logs with empty sessionId
    if (!sessionId) {
      return undefined;
    }

    if (!this.httpTransport) {
      return undefined;
    }

    // Ensure token is valid (refresh if expired)
    const isValid = await this.httpTransport.ensureValidSessionToken(sessionId);
    if (!isValid) {
      this.logger.warn('Session token validation/refresh failed', { sessionId });
      // Still return token if available - let the API call fail with proper error
    }

    // Use public API instead of type casting
    return this.httpTransport.getSessionToken(sessionId);
  }

  /**
   * Cleanup HTTP client for destroyed session
   *
   * Why: Prevent memory leak - sessions expire but cached clients stay forever
   */
  private cleanupSessionClient(sessionId: string): void {
    const removed = this.httpClientFactory.cleanupSessionClient(sessionId);
    if (removed) {
      this.logger.info('Cleaned up session HTTP client', { sessionId });
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

        const args = request.params.arguments || {};
        
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
    sessionId?: string
  ): Promise<unknown> {
    this.logger.debug('Executing simple tool', {
      toolName: toolDef.name,
      action: args['action'],
      resourceType: args['resource_type'],
      sessionId
    });

    // Get operation definition (can be string or ProxyDownloadOperation)
    const operationDef = this.toolGenerator.getOperationDefinition(toolDef, args);
    
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
      return this.executeProxyDownload(operationDef, args, sessionId);
    }

    // Regular string operation
    const operationId = operationDef as string;
    const operation = this.parser.getOperation(operationId);
    if (!operation) {
      throw new OperationNotFoundError(operationId);
    }

    // Build request
    const path = this.resolvePath(operation.path, args);
    const queryParams = this.extractQueryParams(operation, args);
    const body = this.extractBody(operation, args, toolDef);

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
    const httpClient = await this.getHttpClientForSession(sessionId);
    
    // Set fields parameter if response_fields are configured for this action AND enabled
    const action = args.action as string | undefined;
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
      const action = args.action as string | undefined;
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
    sessionId?: string
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
    const httpClient = await this.getHttpClientForSession(sessionId);
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
  ): Record<string, unknown> | undefined {
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
    
    // Get body schema properties to check if path/query params should also be in body
    const bodySchemaProps = new Set<string>();
    if (operation.requestBody?.content) {
      // Check all content types (typically application/json)
      for (const mediaType of Object.values(operation.requestBody.content)) {
        if (mediaType.schema?.properties) {
          for (const propName of Object.keys(mediaType.schema.properties)) {
            bodySchemaProps.add(propName);
          }
        }
      }
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
    const { HttpTransport } = await import('./http-transport.js');
    
    // Get OAuth config from profile (supports multi-auth)
    const oauthConfig = this.getOAuthConfig();
    if (oauthConfig) {
      this.logger.info('OAuth authentication enabled for HTTP transport');
    }
    
    // Get auth configs for token validation
    const authConfigs = this.getAuthConfigs();
    const baseUrl = this.getBaseUrl();
    
    // Extract OAuth rate limit from profile (if configured)
    const oauthAuthConfig = authConfigs.find(c => c.type === 'oauth');
    const oauthRateLimit = oauthAuthConfig?.oauth_rate_limit;
    
    // Extract resource metadata from OpenAPI spec or profile
    const resourceMetadata = this.parser.getResourceMetadata();
    
    const config = {
      host,
      port,
      sessionTimeoutMs: parseInt(process.env.MCP4_SESSION_TIMEOUT_MS || String(TIMEOUTS.SESSION_TIMEOUT_MS), 10),
      heartbeatEnabled: process.env.MCP4_HEARTBEAT_ENABLED === 'true',
      heartbeatIntervalMs: parseInt(process.env.MCP4_HEARTBEAT_INTERVAL_MS || String(TIMEOUTS.HEARTBEAT_INTERVAL_MS), 10),
      metricsEnabled: process.env.MCP4_METRICS_ENABLED === 'true',
      metricsPath: process.env.MCP4_METRICS_PATH || '/metrics',
      allowedOrigins: process.env.MCP4_ALLOWED_ORIGINS
        ? process.env.MCP4_ALLOWED_ORIGINS.split(',').map(o => o.trim())
        : undefined,
      rateLimitEnabled: process.env.MCP4_HTTP_RATE_LIMIT_ENABLED !== 'false', // default: true
      rateLimitWindowMs: parseInt(process.env.MCP4_HTTP_RATE_LIMIT_WINDOW_MS || String(TIMEOUTS.RATE_LIMIT_WINDOW_MS), 10),
      rateLimitMaxRequests: parseInt(process.env.MCP4_HTTP_RATE_LIMIT_MAX_REQUESTS || '100', 10),
      rateLimitMetricsMax: parseInt(process.env.MCP4_HTTP_RATE_LIMIT_METRICS_MAX || '10', 10),
      // OAuth rate limiting (priority: profile > env vars > defaults)
      rateLimitOAuthMax: oauthRateLimit?.max_requests 
        || parseInt(process.env.MCP4_OAUTH_RATE_LIMIT_MAX || String(OAUTH_RATE_LIMIT.MAX_REQUESTS), 10),
      rateLimitOAuthWindowMs: oauthRateLimit?.window_ms 
        || parseInt(process.env.MCP4_OAUTH_RATE_LIMIT_WINDOW_MS || String(OAUTH_RATE_LIMIT.WINDOW_MS), 10),
      maxTokenLength: process.env.MCP4_TOKEN_MAX_LENGTH
        ? parseInt(process.env.MCP4_TOKEN_MAX_LENGTH, 10)
        : undefined, // Uses default from http-transport.ts if undefined
      // Pass OAuth config with allowed_redirect_hosts derived from MCP4_ALLOWED_ORIGINS
      oauthConfig: oauthConfig ? {
        ...oauthConfig,
        allowed_redirect_hosts: oauthConfig.allowed_redirect_hosts 
          || (process.env.MCP4_ALLOWED_ORIGINS
            ? this.extractHostsFromOrigins(process.env.MCP4_ALLOWED_ORIGINS)
            : undefined),
      } : undefined,
      baseUrl, // Pass base URL for token validation
      authConfigs, // Pass auth configs for token validation
      // OAuth resource metadata (priority: profile > OpenAPI > fallback)
      resourceName: this.profile?.resource_name || resourceMetadata.name || 'MCP Server',
      resourceDocumentation: this.profile?.resource_documentation || resourceMetadata.documentation,
      sslCertFile: process.env.MCP4_SSL_CERT_FILE,
      sslKeyFile: process.env.MCP4_SSL_KEY_FILE,
      oauthSessionTimeoutMs: (() => {
        if (process.env.MCP4_OAUTH_SESSION_TIMEOUT_MS === undefined) return undefined;
        const parsed = parseInt(process.env.MCP4_OAUTH_SESSION_TIMEOUT_MS, 10);
        if (Number.isNaN(parsed)) {
          throw new ConfigurationError(
            `Invalid MCP4_OAUTH_SESSION_TIMEOUT_MS: expected integer milliseconds, got '${process.env.MCP4_OAUTH_SESSION_TIMEOUT_MS}'`
          );
        }
        return parsed;
      })(),
      oauthRefreshThresholdMs: (() => {
        if (process.env.MCP4_OAUTH_REFRESH_THRESHOLD_MS === undefined) return undefined;
        const parsed = parseInt(process.env.MCP4_OAUTH_REFRESH_THRESHOLD_MS, 10);
        if (Number.isNaN(parsed)) {
          throw new ConfigurationError(
            `Invalid MCP4_OAUTH_REFRESH_THRESHOLD_MS: expected integer milliseconds, got '${process.env.MCP4_OAUTH_REFRESH_THRESHOLD_MS}'`
          );
        }
        return parsed;
      })(),
    };

    // Warn if binding to non-localhost without explicit MCP4_ALLOWED_ORIGINS
    const isLocalhost = host === 'localhost' || host === '127.0.0.1' || host === '::1';
    const hasAllowedOrigins = Array.isArray(config.allowedOrigins) && config.allowedOrigins.length > 0;
    if (!isLocalhost && !hasAllowedOrigins) {
      this.logger.warn('Binding to non-localhost with empty MCP4_ALLOWED_ORIGINS. Set MCP4_ALLOWED_ORIGINS or bind to localhost.');
    }

    this.httpTransport = new HttpTransport(config, this.logger);
    
    // Set message handler to process JSON-RPC messages
    this.httpTransport.setMessageHandler(async (message: unknown, sessionId?: string) => {
      return await this.handleJsonRpcMessage(message, sessionId);
    });

    // Register cleanup listener for session destruction (memory leak prevention)
    this.httpTransport.onSessionDestroyed((sessionId: string) => {
      this.cleanupSessionClient(sessionId);
    });

    await this.httpTransport.start();
    
    this.logger.info('MCP server running on HTTP', { host, port });
  }

  /**
   * Handle JSON-RPC message from HTTP transport
   *
   * Why: Unified message handling for both stdio and HTTP transports
   */
  private async handleJsonRpcMessage(message: unknown, sessionId?: string): Promise<unknown> {
    // Handle initialize
    if (isInitializeRequest(message)) {
      return this.handleInitialize(message, sessionId);
    }

    // Handle tool calls
    if (isToolCallRequest(message)) {
      return await this.handleToolCall(message, sessionId);
    }

    // Handle other JSON-RPC requests
    // (tools/list, prompts/list, etc.)
    return await this.handleOtherRequest(message, sessionId);
  }


  private handleInitialize(message: unknown, sessionId?: string): unknown {
    const req = message as Record<string, unknown>;

    const result: any = {
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

  private async handleToolCall(message: unknown, sessionId?: string): Promise<unknown> {
    const req = message as Record<string, unknown>;
    const params = req.params as Record<string, unknown>;
    const toolName = params.name as string;
    const args = params.arguments as Record<string, unknown>;

      // Check OAuth authentication for tool operations
      if (this.httpTransport && this.httpTransport.hasOAuthProvider()) {
        const authToken = await this.getAuthTokenFromSession(sessionId || '');
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
              resource_metadata: `${this.httpTransport.getServerUrl()}/.well-known/oauth-protected-resource/mcp`,
              scope: 'api'
            }
          }
        };
        return errorResponse;
      }
    }

    try {
      // Find tool definition
      const toolDef = this.profile?.tools.find(t => t.name === toolName);
      if (!toolDef) {
        throw new OperationNotFoundError(toolName);
      }

      // Execute tool (reuse existing execution logic)
      let result;
      if (toolDef.composite && toolDef.steps) {
        const httpClient = await this.getHttpClientForSession(sessionId);
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
        result = await this.executeSimpleTool(toolDef, args, sessionId);
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

  private async handleOtherRequest(message: unknown, sessionId?: string): Promise<unknown> {
    const req = message as Record<string, unknown>;

    // Check OAuth authentication for other operations (like tools/list)
    if (this.httpTransport && this.httpTransport.hasOAuthProvider()) {
      const authToken = await this.getAuthTokenFromSession(sessionId || '');
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
              resource_metadata: `${this.httpTransport.getServerUrl()}/.well-known/oauth-protected-resource/mcp`,
              scope: 'api'
            }
          }
        };
        return errorResponse;
      }
    }

    // Handle tools/list
    if (req.method === 'tools/list') {
      const tools = this.profile?.tools.map(toolDef =>
        this.toolGenerator!.generateTool(toolDef)
      ) || [];

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
