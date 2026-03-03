/**
 * HTTP interceptors for auth, rate limiting, retry, etc.
 * 
 * Why interceptor pattern: Separates cross-cutting concerns (auth, retry)
 * from business logic (API calls). Each interceptor is independently testable.
 */

import { randomUUID } from 'node:crypto';
import type { InterceptorConfig } from '../types/profile.js';
import { TIME, HTTP_STATUS, TIMEOUTS } from '../core/constants.js';
import { MetricsCollector } from '../core/metrics.js';
import type { MetricsContextLabels } from '../core/metrics.js';
import {
  AuthenticationError,
  AuthorizationError,
  ConfigurationError,
  NetworkError,
  RateLimitError,
} from '../core/errors.js';
import { isSafePropertyName } from '../validation/validation-utils.js';
import { SSRFValidator } from '../security/ssrf-validator.js';
import { Logger, ConsoleLogger } from '../core/logger.js';
import { CachePolicyResolver } from './cache-policy-resolver.js';
import { CacheStoreFactory } from './cache-store-factory.js';
import { CacheKeyBuilder } from './cache-key-builder.js';
import { ResponseCacheInterceptor } from './response-cache-interceptor.js';
import type { AuthRuntimeProvider } from './auth-runtime.js';

export interface RequestContext {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
  operationId?: string; // For per-endpoint rate limiting
}

export interface ResponseContext {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

export interface AuthCredentials {
  headers: Record<string, string>;
  queryParams?: { key: string; value: string };
}

export type InterceptorFn = (
  ctx: RequestContext,
  next: () => Promise<ResponseContext>
) => Promise<ResponseContext>;

export class InterceptorChain {
  private interceptors: InterceptorFn[] = [];
  private metrics: MetricsCollector | null = null;
  private metricsContext: MetricsContextLabels = { profileId: 'unknown', tenantId: 'none' };
  private readonly cacheSessionPartitionId = randomUUID();
  private authToken?: string;
  private authRuntime?: AuthRuntimeProvider;

  constructor(public config: InterceptorConfig, authRuntimeOrToken?: string | AuthRuntimeProvider) {
    if (typeof authRuntimeOrToken === 'string' || authRuntimeOrToken === undefined) {
      this.authToken = authRuntimeOrToken;
    } else {
      this.authRuntime = authRuntimeOrToken;
    }
    this.buildChain();
  }

  private buildChain(): void {
    if (this.config.auth) {
      this.interceptors.push(this.createAuthInterceptor());
    }

    if (this.config.cache?.enabled !== false && this.config.cache) {
      this.interceptors.push(this.createCacheInterceptor());
    }
    
    if (this.config.rate_limit) {
      this.interceptors.push(this.createRateLimitInterceptor());
    }
    
    if (this.config.retry) {
      this.interceptors.push(this.createRetryInterceptor());
    }
  }

  private createCacheInterceptor(): InterceptorFn {
    const policy = CachePolicyResolver.resolve({
      cacheConfig: this.config.cache!,
      hasAuth: !!this.config.auth,
    });
    const recordEvent = (event: string, operation: string) => this.recordCacheEvent(operation, event);
    const sensitiveHeaders = this.getSensitiveCacheHeaders();
    const keyBuilder = new CacheKeyBuilder(policy, sensitiveHeaders, this.cacheSessionPartitionId);
    const store = CacheStoreFactory.create(policy, {
      onEvict: (reason) => recordEvent(reason === 'max_entries' ? 'evict_max_entries' : 'evict_max_memory', 'unknown'),
    });
    const cacheInterceptor = new ResponseCacheInterceptor(
      policy,
      store,
      keyBuilder,
      sensitiveHeaders,
      recordEvent
    );

    return cacheInterceptor.asInterceptor();
  }

  setMetricsCollector(metrics: MetricsCollector | null, context?: MetricsContextLabels): void {
    this.metrics = metrics;
    if (context) {
      this.metricsContext = context;
    }
  }

  private recordCacheEvent(operation: string, event: string): void {
    this.metrics?.recordApiCacheEvent(operation, event, this.metricsContext);
  }

  private getSensitiveCacheHeaders(): Set<string> {
    const sensitiveHeaders = new Set(['authorization', 'proxy-authorization', 'cookie']);
    const authConfigRaw = this.config.auth;

    if (!authConfigRaw) {
      return sensitiveHeaders;
    }

    const authConfigs = Array.isArray(authConfigRaw) ? authConfigRaw : [authConfigRaw];
    for (const authConfig of authConfigs) {
      if (authConfig.type === 'custom-header' && authConfig.header_name) {
        sensitiveHeaders.add(authConfig.header_name.toLowerCase());
      }
    }

    return sensitiveHeaders;
  }

  private getSelectedAuthConfig() {
    const authConfigRaw = this.config.auth;
    if (!authConfigRaw) {
      return undefined;
    }

    const authConfigs = Array.isArray(authConfigRaw) ? authConfigRaw : [authConfigRaw];
    const sortedConfigs = [...authConfigs].sort((a, b) => (a.priority || 0) - (b.priority || 0));
    return sortedConfigs.find((config) => config.type !== 'oauth');
  }

  private applyAuthCredentials(ctx: RequestContext, credentials: AuthCredentials): void {
    for (const [headerName, value] of Object.entries(credentials.headers)) {
      if (!isSafePropertyName(headerName)) {
        throw new ConfigurationError(`Invalid header name: ${headerName}`);
      }
      // nosemgrep: javascript.express.security.audit.remote-property-injection.remote-property-injection
      ctx.headers[headerName] = value;
    }

    if (credentials.queryParams) {
      const url = new URL(ctx.url);
      url.searchParams.set(credentials.queryParams.key, credentials.queryParams.value);
      ctx.url = url.toString();
    }
  }

  private ensureStaticAuthReady(): void {
    const authConfig = this.getSelectedAuthConfig();
    if (!authConfig) {
      throw new ConfigurationError(
        'Only OAuth authentication configured. OAuth requires HTTP transport for the authorization flow (redirects, callbacks). Add a token-based auth config or use HTTP transport.'
      );
    }

    if (authConfig.type === 'oauth') {
      throw new ConfigurationError(
        'OAuth authentication not supported in InterceptorChain (use HTTP transport OAuth flow)'
      );
    }

    const envVarName = authConfig.value_from_env;
    const token = this.authToken || (envVarName ? process.env[envVarName] : undefined);
    if (!token && !envVarName) {
      throw new ConfigurationError(
        'Auth configuration requires value_from_env or a session token provided during HTTP initialization'
      );
    }

    if (!token) {
      const sourceHint = envVarName
        ? `in environment variable: ${envVarName} or from HTTP session initialization (Authorization/X-API-Token/custom auth header)`
        : 'from HTTP session initialization (Authorization/X-API-Token/custom auth header)';
      throw new AuthenticationError(
        `Auth token not found. Expected token ${sourceHint}`
      );
    }
  }

  private resolveStaticAuthCredentials(): AuthCredentials {
    const authConfig = this.getSelectedAuthConfig();
    if (!authConfig || authConfig.type === 'oauth') {
      return { headers: {} };
    }

    const envVarName = authConfig.value_from_env;
    const token = this.authToken || (envVarName ? process.env[envVarName] : undefined);
    if (!token) {
      return { headers: {} };
    }

    const credentials: AuthCredentials = { headers: {} };
    if (authConfig.type === 'bearer') {
      credentials.headers.Authorization = `Bearer ${token}`;
    } else if (authConfig.type === 'custom-header' && authConfig.header_name) {
      if (!isSafePropertyName(authConfig.header_name)) {
        return { headers: {} };
      }
      credentials.headers[authConfig.header_name] = token;
    } else if (authConfig.type === 'query' && authConfig.query_param) {
      credentials.queryParams = {
        key: authConfig.query_param,
        value: token,
      };
    }

    return credentials;
  }

  private resolveStaticAuthCredentialsForRequest(): AuthCredentials {
    const authConfig = this.getSelectedAuthConfig();
    if (!authConfig || authConfig.type === 'oauth') {
      return { headers: {} };
    }

    const envVarName = authConfig.value_from_env;
    const token = this.authToken || (envVarName ? process.env[envVarName] : undefined);
    if (!token) {
      return { headers: {} };
    }

    if (authConfig.type === 'custom-header' && authConfig.header_name && !isSafePropertyName(authConfig.header_name)) {
      throw new ConfigurationError(`Invalid header name: ${authConfig.header_name}`);
    }

    return this.resolveStaticAuthCredentials();
  }

  /**
   * Auth interceptor: adds auth header/query from env or session token
   *
   * Why env-based: Keeps secrets out of config files. Config defines WHERE
   * to get the token, runtime provides the value.
   *
   * Supports:
   * - bearer: Standard HTTP Authorization: Bearer <token>
   * - query: API key in URL (?api_key=<token>)
   * - custom-header: Custom header (e.g., X-API-Key: <token>)
   * 
   * Note: For multi-auth, uses the primary (first/lowest priority) non-OAuth config.
   * OAuth is handled separately in HTTP transport, not in InterceptorChain.
    */
  private createAuthInterceptor(): InterceptorFn {
    if (!this.authRuntime) {
      this.ensureStaticAuthReady();
    }

    return async (ctx, next) => {
      const credentials = this.authRuntime
        ? await this.authRuntime.prepareRequest(ctx)
        : this.resolveStaticAuthCredentialsForRequest();
      this.applyAuthCredentials(ctx, credentials);
      return next();
    };
  }

  /**
   * Rate limiter: token bucket algorithm with per-endpoint overrides
   *
   * Why token bucket: Allows bursts while enforcing average rate. Better UX
   * than strict per-request delays.
   *
   * Supports per-endpoint overrides via operationId matching.
   */
  private createRateLimitInterceptor(): InterceptorFn {
    const config = this.config.rate_limit!;

    // Global token bucket state
    const globalTokensPerMs = config.max_requests_per_minute / TIME.MS_PER_MINUTE;
    let globalTokens = config.max_requests_per_minute;
    let globalLastRefill = Date.now();

    // Per-endpoint token buckets (operationId -> bucket state)
    const endpointBuckets = new Map<string, {
      tokensPerMs: number;
      tokens: number;
      lastRefill: number;
    }>();

    // Initialize per-endpoint buckets
    if (config.overrides) {
      for (const [operationId, override] of Object.entries(config.overrides)) {
        endpointBuckets.set(operationId, {
          tokensPerMs: override.max_requests_per_minute / TIME.MS_PER_MINUTE,
          tokens: override.max_requests_per_minute,
          lastRefill: Date.now(),
        });
      }
    }

    return async (ctx, next) => {
      const now = Date.now();

      // Choose appropriate bucket: per-endpoint override or global
      let bucket = {
        tokensPerMs: globalTokensPerMs,
        tokens: globalTokens,
        lastRefill: globalLastRefill,
      };

      if (ctx.operationId && endpointBuckets.has(ctx.operationId)) {
        bucket = endpointBuckets.get(ctx.operationId)!;
      }

      // Refill tokens for the chosen bucket
      const elapsed = now - bucket.lastRefill;
      const maxTokens = bucket.tokensPerMs * TIME.MS_PER_MINUTE; // Convert back to max tokens

      bucket.tokens = Math.min(maxTokens, bucket.tokens + elapsed * bucket.tokensPerMs);
      bucket.lastRefill = now;

      // Check if we need to wait
      if (bucket.tokens < 1) {
        const waitMs = (1 - bucket.tokens) / bucket.tokensPerMs;
        await new Promise(resolve => setTimeout(resolve, waitMs));
        bucket.tokens = 0;
      } else {
        bucket.tokens -= 1;
      }

      // Update global state if using global bucket
      if (!ctx.operationId || !endpointBuckets.has(ctx.operationId)) {
        globalTokens = bucket.tokens;
        globalLastRefill = bucket.lastRefill;
      }

      return next();
    };
  }

  /**
   * Retry interceptor: exponential backoff
   * 
   * Why exponential: Reduces server load during outages. Linear backoff
   * can cause thundering herd on recovery.
   */
  private createRetryInterceptor(): InterceptorFn {
    const config = this.config.retry!;

    return async (ctx, next) => {
      let lastError: Error | undefined;

      for (let attempt = 0; attempt < config.max_attempts; attempt++) {
        try {
          const response = await next();
          
          // Check if we should retry based on status
          if (config.retry_on_status.includes(response.status) && attempt < config.max_attempts - 1) {
            const backoffMs = config.backoff_ms[attempt] || config.backoff_ms[config.backoff_ms.length - 1];
            await new Promise(resolve => setTimeout(resolve, backoffMs));
            continue;
          }
          
          return response;
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
          
          if (attempt < config.max_attempts - 1) {
            const backoffMs = config.backoff_ms[attempt] || config.backoff_ms[config.backoff_ms.length - 1];
            await new Promise(resolve => setTimeout(resolve, backoffMs));
          }
        }
      }

      throw lastError || new Error('All retry attempts failed');
    };
  }

  async execute(ctx: RequestContext, finalHandler: () => Promise<ResponseContext>): Promise<ResponseContext> {
    let index = 0;

    const next = async (): Promise<ResponseContext> => {
      if (index >= this.interceptors.length) {
        return finalHandler();
      }
      
      const interceptor = this.interceptors[index++];
      return interceptor(ctx, next);
    };

    return next();
  }

  async handleResponse(response: ResponseContext): Promise<void> {
    if (this.authRuntime) {
      await this.authRuntime.onResponse(response);
    }
  }

  async handleAuthFailure(response: ResponseContext): Promise<boolean> {
    if (!this.authRuntime) {
      return false;
    }

    return this.authRuntime.handleAuthFailure(response);
  }

  /**
   * Extract auth credentials (headers + query params) without making a request
   * 
   * Why separate: ProxyDownloadExecutor needs auth for direct fetch calls,
   * but can't use InterceptorChain (fetch doesn't go through chain).
   * This extracts the same credentials the chain would apply.
   * 
   * Returns:
   * - Bearer auth: { headers: { Authorization: 'Bearer token' }, queryParams: undefined }
   * - Custom-header auth: { headers: { 'X-API-Key': 'token' }, queryParams: undefined }
   * - Query auth: { headers: {}, queryParams: { key: 'api_key', value: 'token' } }
   * - No auth: { headers: {}, queryParams: undefined }
   */
  getAuthCredentials(): AuthCredentials {
    if (!this.config.auth) {
      return { headers: {} };
    }

    if (this.authRuntime) {
      return this.authRuntime.getAuthCredentials();
    }

    return this.resolveStaticAuthCredentials();
  }
}

/**
 * HTTP client with interceptor support
 */
export class HttpClient {
  private baseUrl: string;
  private interceptors: InterceptorChain;
  private metrics: MetricsCollector | null;
  private metricsContext: MetricsContextLabels;
  private logger: Logger;
  private ssrfValidator: SSRFValidator;

  constructor(
    baseUrl: string,
    interceptors: InterceptorChain,
    metrics?: MetricsCollector | null,
    logger?: Logger,
    ssrfValidator?: SSRFValidator,
    metricsContext?: MetricsContextLabels
  ) {
    this.baseUrl = baseUrl;
    this.interceptors = interceptors;
    this.metrics = metrics || null;
    this.logger = logger || new ConsoleLogger();
    this.ssrfValidator = ssrfValidator || new SSRFValidator(this.logger);
    this.metricsContext = metricsContext || { profileId: 'unknown', tenantId: 'none' };
    this.interceptors.setMetricsCollector(this.metrics, this.metricsContext);
  }

  setMetricsCollector(metrics: MetricsCollector | null): void {
    this.metrics = metrics;
    this.interceptors.setMetricsCollector(metrics, this.metricsContext);
  }

  /**
   * Get base URL (for testing)
   */
  getBaseUrl(): string {
    return this.baseUrl;
  }

  /**
   * Get interceptors config (for testing)
   */
  getInterceptorsConfig(): InterceptorConfig {
    return this.interceptors.config;
  }

  /**
   * Get auth credentials (headers and query params) for direct HTTP calls
   * Used by ProxyDownloadExecutor for authenticated file downloads
   */
  getAuthCredentials(): AuthCredentials {
    return this.interceptors.getAuthCredentials();
  }

  /**
   * Serialize parameters including arrays
   * 
   * Why different formats: APIs use different conventions for array parameters.
   * Rails/GitLab: scope[]=value, PHP: scope[0]=value, Express: scope=value (repeat)
   */
  private serializeParams(
    params: Record<string, string | string[]>,
    format: 'brackets' | 'indices' | 'repeat' | 'comma'
  ): URLSearchParams {
    const searchParams = new URLSearchParams();
    
    for (const [key, value] of Object.entries(params)) {
      if (Array.isArray(value)) {
        switch (format) {
          case 'brackets':
            value.forEach(item => searchParams.append(`${key}[]`, String(item)));
            break;
          case 'indices':
            value.forEach((item, i) => searchParams.append(`${key}[${i}]`, String(item)));
            break;
          case 'repeat':
            value.forEach(item => searchParams.append(key, String(item)));
            break;
          case 'comma':
            searchParams.append(key, value.map(String).join(','));
            break;
        }
      } else {
        searchParams.append(key, String(value));
      }
    }
    
    return searchParams;
  }

  async request(method: string, path: string, options: {
    params?: Record<string, string | string[]>;
    body?: unknown;
    headers?: Record<string, string>;
    operationId?: string; // For per-endpoint rate limiting
    timeout_ms?: number;
  } = {}): Promise<ResponseContext> {
    return this.requestInternal(method, path, options, true);
  }

  private async requestInternal(
    method: string,
    path: string,
    options: {
      params?: Record<string, string | string[]>;
      body?: unknown;
      headers?: Record<string, string>;
      operationId?: string;
      timeout_ms?: number;
    },
    allowAuthRetry: boolean,
  ): Promise<ResponseContext> {
    let url = this.baseUrl + path;

    // Add query parameters with proper array handling
    if (options.params && Object.keys(options.params).length > 0) {
      const arrayFormat = this.interceptors.config.array_format || 'repeat';
      const searchParams = this.serializeParams(options.params, arrayFormat);
      url += '?' + searchParams.toString();
    }

    const ctx: RequestContext = {
      method,
      url,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
      body: options.body,
      operationId: options.operationId,
    };

    const metrics = this.metrics;
    const operation = options.operationId || 'unknown';
    const timeout = options.timeout_ms
      ?? this.interceptors.config.timeout_ms
      ?? TIMEOUTS.HTTP_REQUEST_TIMEOUT_MS;
    const redirectAuthPolicy = this.interceptors.config.redirect_auth_policy ?? 'same-origin';
    const sensitiveHeaders = this.getSensitiveRedirectHeaderNames();

    return this.interceptors.execute(ctx, async () => {
      const start = Date.now();
      let recorded = false;

      // Why no body for GET/HEAD: HTTP spec forbids request body for these methods
      const fetchOptions: RequestInit = {
        method: ctx.method,
        headers: ctx.headers,
        redirect: 'manual', // Handle redirects manually for SSRF protection
      };

      if (ctx.method !== 'GET' && ctx.method !== 'HEAD' && ctx.body) {
        if (ctx.body instanceof FormData) {
          // FormData: let fetch set Content-Type with boundary automatically
          delete ctx.headers['Content-Type'];
          fetchOptions.body = ctx.body;
        } else if (ctx.body instanceof Blob || ctx.body instanceof ArrayBuffer) {
          // Binary data: keep existing Content-Type or use octet-stream
          if (!ctx.headers['Content-Type']) {
            ctx.headers['Content-Type'] = 'application/octet-stream';
          }
          fetchOptions.body = ctx.body;
        } else {
          // JSON (default)
          fetchOptions.body = JSON.stringify(ctx.body);
        }
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);
      fetchOptions.signal = controller.signal;

      try {
        // SSRF: Validate initial URL
        await this.ssrfValidator.validate(ctx.url, {
          allowPrivateNetwork: process.env.MCP4_SSRF_ALLOW_PRIVATE_NETWORK === 'true',
        });

        let currentUrl = ctx.url;
        let currentMethod = fetchOptions.method ?? ctx.method;
        let currentBody = fetchOptions.body;
        let currentHeaders = { ...(fetchOptions.headers as Record<string, string>) };
        let response: Response | undefined;
        let redirectCount = 0;
        const maxRedirects = 5;

        // Redirect loop
        while (redirectCount <= maxRedirects) {
          const hopOptions: RequestInit = {
            ...fetchOptions,
            method: currentMethod,
            headers: currentHeaders,
          };

          if (currentBody !== undefined) {
            hopOptions.body = currentBody;
          } else {
            delete hopOptions.body;
          }

          response = await fetch(currentUrl, hopOptions);

          if (
            response.status >= 300
            && response.status < 400
            && response.status !== HTTP_STATUS.NOT_MODIFIED
          ) {
            const location = response.headers.get('location');
            if (!location) {
              throw new NetworkError(`Redirect without Location header: HTTP ${response.status}`);
            }

            // Resolve relative URLs
            const nextUrl = new URL(location, currentUrl).toString();

            // SSRF: Validate redirect target
            await this.ssrfValidator.validate(nextUrl, {
              allowPrivateNetwork: process.env.MCP4_SSRF_ALLOW_PRIVATE_NETWORK === 'true',
            });

            const shouldStripSensitiveHeaders = redirectAuthPolicy === 'never'
              || !this.isSameOrigin(currentUrl, nextUrl);
            if (shouldStripSensitiveHeaders) {
              currentHeaders = this.stripSensitiveHeaders(currentHeaders, sensitiveHeaders);
            }

            currentUrl = nextUrl;
            redirectCount++;

            // Handle method change on redirect (303, or 301/302 from POST)
            if (response.status === 303 || ((response.status === 301 || response.status === 302) && currentMethod === 'POST')) {
              currentMethod = 'GET';
              currentBody = undefined;
            }

            continue;
          }

          break; // Not a redirect
        }

        if (!response) {
          throw new NetworkError('Request failed: no response');
        }

        if (redirectCount > maxRedirects) {
          throw new NetworkError(`Too many redirects (max ${maxRedirects})`);
        }

        const body = response.headers.get('content-type')?.includes('application/json')
          ? await response.json()
          : await response.text();

        const durationSeconds = (Date.now() - start) / 1000;
        if (metrics) {
          metrics.recordApiCall(operation, response.status, durationSeconds, this.metricsContext);
          recorded = true;
        }

        const responseContext = {
          status: response.status,
          headers: Object.fromEntries(response.headers.entries()),
          body,
        };

        await this.interceptors.handleResponse(responseContext);

        if (
          allowAuthRetry
          && response.status !== HTTP_STATUS.NOT_MODIFIED
          && (response.status < HTTP_STATUS.OK || response.status >= HTTP_STATUS.MULTIPLE_CHOICES)
        ) {
          const recovered = await this.interceptors.handleAuthFailure(responseContext);
          if (recovered) {
            return this.requestInternal(method, path, options, false);
          }
        }

        // Why throw on non-2xx: Allows caller to handle errors with try/catch
        // Use structured errors for better client handling
        if (
          response.status !== HTTP_STATUS.NOT_MODIFIED
          && (response.status < HTTP_STATUS.OK || response.status >= HTTP_STATUS.MULTIPLE_CHOICES)
        ) {
          // Extract error message from response body (common formats)
          let errorMessage = `HTTP ${response.status}`;
          if (typeof body === 'object' && body !== null) {
            const errorObj = body as Record<string, unknown>;
            errorMessage = (errorObj.error_description || errorObj.error || errorObj.message || errorMessage) as string;
          } else if (typeof body === 'string' && body.length > 0) {
            errorMessage = body;
          }

          // Throw specific error types based on HTTP status
          if (response.status === HTTP_STATUS.UNAUTHORIZED) {
            throw new AuthenticationError(errorMessage, { statusCode: response.status });
          } else if (response.status === HTTP_STATUS.FORBIDDEN) {
            throw new AuthorizationError(errorMessage);
          } else if (response.status === HTTP_STATUS.TOO_MANY_REQUESTS) {
            const retryAfter = response.headers.get('retry-after');
            throw new RateLimitError(errorMessage, retryAfter ? parseInt(retryAfter, 10) : undefined);
          } else if (response.status === HTTP_STATUS.NOT_FOUND) {
            throw new NetworkError(`Resource not found: ${errorMessage}`, response.status);
          } else {
            // Generic network error for other status codes (includes 5xx)
            throw new NetworkError(errorMessage, response.status, { body });
          }
        }

        return responseContext;
      } catch (error) {
        if (metrics) {
          const durationSeconds = (Date.now() - start) / 1000;
          if (!recorded) {
            metrics.recordApiCall(operation, 0, durationSeconds, this.metricsContext);
          }
          metrics.recordApiCallError(operation, this.getErrorType(error), this.metricsContext);
        }

        if (error instanceof Error && error.name === 'AbortError') {
           throw new NetworkError(`Request timeout after ${timeout}ms`, 408);
        }

        throw error;
      } finally {
        clearTimeout(timeoutId);
      }
    });
  }

  private getSensitiveRedirectHeaderNames(): Set<string> {
    const sensitiveHeaders = new Set(['authorization', 'proxy-authorization', 'cookie']);
    const authConfigRaw = this.interceptors.config.auth;

    if (!authConfigRaw) {
      return sensitiveHeaders;
    }

    const authConfigs = Array.isArray(authConfigRaw) ? authConfigRaw : [authConfigRaw];
    for (const authConfig of authConfigs) {
      if (authConfig.type === 'custom-header' && authConfig.header_name) {
        sensitiveHeaders.add(authConfig.header_name.toLowerCase());
      }
    }

    return sensitiveHeaders;
  }

  private stripSensitiveHeaders(
    headers: Record<string, string>,
    sensitiveHeaders: Set<string>
  ): Record<string, string> {
    const sanitizedHeaders: Record<string, string> = {};

    for (const [headerName, headerValue] of Object.entries(headers)) {
      if (!sensitiveHeaders.has(headerName.toLowerCase())) {
        sanitizedHeaders[headerName] = headerValue;
      }
    }

    return sanitizedHeaders;
  }

  private isSameOrigin(sourceUrl: string, targetUrl: string): boolean {
    return new URL(sourceUrl).origin === new URL(targetUrl).origin;
  }

  private getErrorType(error: unknown): string {
    if (error instanceof Error) {
      return error.name;
    }
    return 'UnknownError';
  }
}
