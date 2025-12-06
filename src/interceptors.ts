/**
 * HTTP interceptors for auth, rate limiting, retry, etc.
 * 
 * Why interceptor pattern: Separates cross-cutting concerns (auth, retry)
 * from business logic (API calls). Each interceptor is independently testable.
 */

import type { InterceptorConfig } from './types/profile.js';
import { TIME, HTTP_STATUS } from './constants.js';
import { AuthenticationError, AuthorizationError, NetworkError, RateLimitError } from './errors.js';
import { isSafePropertyName } from './validation-utils.js';

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

export type InterceptorFn = (
  ctx: RequestContext,
  next: () => Promise<ResponseContext>
) => Promise<ResponseContext>;

export class InterceptorChain {
  private interceptors: InterceptorFn[] = [];

  constructor(public config: InterceptorConfig, private authToken?: string) {
    this.buildChain();
  }

  private buildChain(): void {
    if (this.config.auth) {
      this.interceptors.push(this.createAuthInterceptor());
    }
    
    if (this.config.rate_limit) {
      this.interceptors.push(this.createRateLimitInterceptor());
    }
    
    if (this.config.retry) {
      this.interceptors.push(this.createRetryInterceptor());
    }
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
    const authConfigRaw = this.config.auth!;
    
    // Handle multi-auth: get primary non-OAuth config
    const authConfigs = Array.isArray(authConfigRaw) ? authConfigRaw : [authConfigRaw];
    const sortedConfigs = authConfigs.sort((a, b) => (a.priority || 0) - (b.priority || 0));
    
    // Find first non-OAuth config (OAuth handled by HTTP transport)
    const authConfig = sortedConfigs.find(c => c.type !== 'oauth');
    
    if (!authConfig) {
      throw new Error('Only OAuth authentication configured. OAuth requires HTTP transport for the authorization flow (redirects, callbacks). Add a token-based auth config or use HTTP transport.');
    }
    
    if (authConfig.type === 'oauth') {
      throw new Error('OAuth authentication not supported in InterceptorChain (use HTTP transport OAuth flow)');
    }
    
    const envVarName = authConfig.value_from_env;
    if (!envVarName) {
      throw new Error('Auth configuration missing value_from_env');
    }
    
    const token = this.authToken || process.env[envVarName];

    if (!token) {
      throw new Error(
        `Auth token not found. Expected in environment variable: ${envVarName} or passed to constructor`
      );
    }

    return async (ctx, next) => {
      if (authConfig.type === 'bearer') {
        ctx.headers['Authorization'] = `Bearer ${token}`;
      } else if (authConfig.type === 'query' && authConfig.query_param) {
        const url = new URL(ctx.url);
        url.searchParams.set(authConfig.query_param, token);
        ctx.url = url.toString();
      } else if (authConfig.type === 'custom-header' && authConfig.header_name) {
        if (!isSafePropertyName(authConfig.header_name)) {
          throw new Error(`Invalid header name: ${authConfig.header_name}`);
        }
        // nosemgrep: javascript.express.security.audit.remote-property-injection.remote-property-injection
        ctx.headers[authConfig.header_name] = token;
      }

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
}

/**
 * HTTP client with interceptor support
 */
export class HttpClient {
  constructor(
    private baseUrl: string,
    private interceptors: InterceptorChain
  ) {}

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
  } = {}): Promise<ResponseContext> {
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

    return this.interceptors.execute(ctx, async () => {
      // Why no body for GET/HEAD: HTTP spec forbids request body for these methods
      const fetchOptions: RequestInit = {
        method: ctx.method,
        headers: ctx.headers,
      };

      if (ctx.method !== 'GET' && ctx.method !== 'HEAD' && ctx.body) {
        fetchOptions.body = JSON.stringify(ctx.body);
      }

      const response = await fetch(ctx.url, fetchOptions);

      const body = response.headers.get('content-type')?.includes('application/json')
        ? await response.json()
        : await response.text();

      const responseContext = {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body,
      };

      // Why throw on non-2xx: Allows caller to handle errors with try/catch
      // Use structured errors for better client handling
      if (response.status < HTTP_STATUS.OK || response.status >= HTTP_STATUS.MULTIPLE_CHOICES) {
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
    });
  }
}

