/**
 * Tests for HTTP interceptors (auth, rate-limit, retry)
 * 
 * Why: Validates auth types (bearer, query, custom-header), rate limiting, and retry logic
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HttpClient, InterceptorChain } from './interceptors.js';
import { createTestHttpClient, setupFetchMock, setupErrorFetchMock, restoreFetch } from '../testing/test-http-utils.js';
import type { InterceptorConfig } from '../types/profile.js';
import { AuthenticationError, AuthorizationError, RateLimitError, NetworkError } from '../core/errors.js';
import { MetricsCollector } from '../core/metrics.js';
import type { SSRFValidator } from '../security/ssrf-validator.js';

const mockSSRFValidator = {
  validate: async () => {},
} as unknown as SSRFValidator;

describe('HttpClient - Auth Interceptors', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should add Bearer token for bearer auth type', async () => {
    process.env.MCP4_API_TOKEN = 'test-bearer-token';

    const config: InterceptorConfig = {
      auth: {
        type: 'bearer',
        value_from_env: 'MCP4_API_TOKEN',
      },
    };

    const client = createTestHttpClient('https://api.example.com', config);
    const { capturedHeaders } = setupFetchMock();

    await client.request('GET', '/test');

    expect(capturedHeaders['Authorization']).toBe('Bearer test-bearer-token');
  });

  it('should add custom header for custom-header auth type', async () => {
    process.env.API_KEY = 'test-api-key';

    const config: InterceptorConfig = {
      auth: {
        type: 'custom-header',
        header_name: 'X-API-Key',
        value_from_env: 'API_KEY',
      },
    };

    const interceptors = new InterceptorChain(config);
    const client = new HttpClient('https://api.example.com', interceptors, null, undefined, mockSSRFValidator);

    let capturedHeaders: Record<string, string> = {};
    global.fetch = async (_url: RequestInfo | URL, _init?: RequestInit) => {
      capturedHeaders = _init?.headers as Record<string, string>;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    await client.request('GET', '/test');

    expect(capturedHeaders['X-API-Key']).toBe('test-api-key');
  });

  it('should reject prototype pollution attempts in custom header name', async () => {
    process.env.API_KEY = 'test-api-key';

    const config: InterceptorConfig = {
      auth: {
        type: 'custom-header',
        header_name: '__proto__',
        value_from_env: 'API_KEY',
      },
    };

    const interceptors = new InterceptorChain(config);
    const client = new HttpClient('https://api.example.com', interceptors, null, undefined, mockSSRFValidator);

    global.fetch = async () => {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    await expect(client.request('GET', '/test')).rejects.toThrow('Invalid header name: __proto__');
  });

  it('should reject constructor pollution attempts in custom header name', async () => {
    process.env.API_KEY = 'test-api-key';

    const config: InterceptorConfig = {
      auth: {
        type: 'custom-header',
        header_name: 'constructor',
        value_from_env: 'API_KEY',
      },
    };

    const interceptors = new InterceptorChain(config);
    const client = new HttpClient('https://api.example.com', interceptors);

    global.fetch = async () => {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    await expect(client.request('GET', '/test')).rejects.toThrow('Invalid header name: constructor');
  });

  it('should add query param for query auth type', async () => {
    process.env.MCP4_API_TOKEN = 'test-query-token';

    const config: InterceptorConfig = {
      auth: {
        type: 'query',
        query_param: 'api_key',
        value_from_env: 'MCP4_API_TOKEN',
      },
    };

    const interceptors = new InterceptorChain(config);
    const client = new HttpClient('https://api.example.com', interceptors, null, undefined, mockSSRFValidator);

    let capturedUrl = '';
    global.fetch = async (url: RequestInfo | URL, _init?: RequestInit) => {
      capturedUrl = url.toString();
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    await client.request('GET', '/test');

    expect(capturedUrl).toContain('api_key=test-query-token');
  });

  it('should throw error if auth token env var is missing', () => {
    delete process.env.MISSING_TOKEN;

    const config: InterceptorConfig = {
      auth: {
        type: 'bearer',
        value_from_env: 'MISSING_TOKEN',
      },
    };

    expect(() => new InterceptorChain(config)).toThrow(
      'Auth token not found. Expected in environment variable: MISSING_TOKEN or passed to constructor'
    );
  });

  it('should throw error for OAuth auth type', () => {
    const config: InterceptorConfig = {
      auth: {
        type: 'oauth',
        issuer: 'https://auth.example.com',
        client_id: 'test-client',
      } as any,
    };

    expect(() => new InterceptorChain(config)).toThrow(
      'Only OAuth authentication configured. OAuth requires HTTP transport for the authorization flow'
    );
  });

  it('should throw specific error when selected auth config resolves to oauth type', () => {
    let reads = 0;
    const flakyTypeAuthConfig = {
      get type() {
        reads += 1;
        return reads === 1 ? 'bearer' : 'oauth';
      },
      value_from_env: 'MCP4_API_TOKEN',
    } as any;

    const config: InterceptorConfig = {
      auth: [flakyTypeAuthConfig],
    };

    process.env.MCP4_API_TOKEN = 'test-token';

    expect(() => new InterceptorChain(config)).toThrow(
      'OAuth authentication not supported in InterceptorChain (use HTTP transport OAuth flow)'
    );
  });

  it('should work without auth if not configured', async () => {
    const config: InterceptorConfig = {};

    const client = createTestHttpClient('https://api.example.com', config);
    const { capturedHeaders } = setupFetchMock();

    await client.request('GET', '/test');

    expect(capturedHeaders['Authorization']).toBeUndefined();
    expect(capturedHeaders['X-API-Key']).toBeUndefined();
  });
});

describe('HttpClient - accessors', () => {
  it('should expose baseUrl and interceptor config for diagnostics', () => {
    const config: InterceptorConfig = {
      array_format: 'indices',
      rate_limit: { max_requests_per_minute: 60 },
    };

    const chain = new InterceptorChain(config);
    const client = new HttpClient('https://example.test', chain, null, undefined, mockSSRFValidator);

    expect(client.getBaseUrl()).toBe('https://example.test');
    expect(client.getInterceptorsConfig()).toEqual(config);
  });

  it('should fail fast for unsupported redis cache backend', () => {
    const config: InterceptorConfig = {
      cache: {
        backend: 'redis',
      },
    };

    expect(() => new InterceptorChain(config)).toThrow('cache.backend=redis is not implemented yet');
  });
});

describe('InterceptorChain - getAuthCredentials', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should return bearer token in headers', () => {
    process.env.MCP4_API_TOKEN = 'test-bearer-token';

    const config: InterceptorConfig = {
      auth: {
        type: 'bearer',
        value_from_env: 'MCP4_API_TOKEN',
      },
    };

    const chain = new InterceptorChain(config);
    const credentials = chain.getAuthCredentials();

    expect(credentials.headers).toEqual({ Authorization: 'Bearer test-bearer-token' });
    expect(credentials.queryParams).toBeUndefined();
  });

  it('should return custom header in headers', () => {
    process.env.API_KEY = 'test-api-key';

    const config: InterceptorConfig = {
      auth: {
        type: 'custom-header',
        header_name: 'X-API-Key',
        value_from_env: 'API_KEY',
      },
    };

    const chain = new InterceptorChain(config);
    const credentials = chain.getAuthCredentials();

    expect(credentials.headers).toEqual({ 'X-API-Key': 'test-api-key' });
    expect(credentials.queryParams).toBeUndefined();
  });

  it('should return query param credentials', () => {
    process.env.MCP4_API_TOKEN = 'test-query-token';

    const config: InterceptorConfig = {
      auth: {
        type: 'query',
        query_param: 'api_key',
        value_from_env: 'MCP4_API_TOKEN',
      },
    };

    const chain = new InterceptorChain(config);
    const credentials = chain.getAuthCredentials();

    expect(credentials.headers).toEqual({});
    expect(credentials.queryParams).toEqual({ key: 'api_key', value: 'test-query-token' });
  });

  it('should prefer session token over environment variable', () => {
    process.env.MCP4_API_TOKEN = 'env-token';
    const sessionToken = 'session-token';

    const config: InterceptorConfig = {
      auth: {
        type: 'bearer',
        value_from_env: 'MCP4_API_TOKEN',
      },
    };

    const chain = new InterceptorChain(config, sessionToken);
    const credentials = chain.getAuthCredentials();

    expect(credentials.headers).toEqual({ Authorization: 'Bearer session-token' });
  });

  it('should return multi-auth with bearer priority over query', () => {
    process.env.BEARER_TOKEN = 'bearer-token';
    process.env.API_KEY = 'api-key';

    const config: InterceptorConfig = {
      auth: [
        {
          type: 'bearer',
          value_from_env: 'BEARER_TOKEN',
          priority: 0, // Higher priority (lower number)
        },
        {
          type: 'query',
          query_param: 'api_key',
          value_from_env: 'API_KEY',
          priority: 1,
        },
      ],
    };

    const chain = new InterceptorChain(config);
    const credentials = chain.getAuthCredentials();

    // Should use bearer (priority 0) not query (priority 1)
    expect(credentials.headers).toEqual({ Authorization: 'Bearer bearer-token' });
    expect(credentials.queryParams).toBeUndefined();
  });

  it('should handle multi-auth with custom-header priority over query', () => {
    process.env.CUSTOM_HEADER_TOKEN = 'header-token';
    process.env.API_KEY = 'api-key';

    const config: InterceptorConfig = {
      auth: [
        {
          type: 'query',
          query_param: 'api_key',
          value_from_env: 'API_KEY',
          priority: 1,
        },
        {
          type: 'custom-header',
          header_name: 'X-Auth-Token',
          value_from_env: 'CUSTOM_HEADER_TOKEN',
          priority: 0, // Higher priority
        },
      ],
    };

    const chain = new InterceptorChain(config);
    const credentials = chain.getAuthCredentials();

    expect(credentials.headers).toEqual({ 'X-Auth-Token': 'header-token' });
    expect(credentials.queryParams).toBeUndefined();
  });

  it('should return empty credentials if no auth configured', () => {
    const config: InterceptorConfig = {};

    const chain = new InterceptorChain(config);
    const credentials = chain.getAuthCredentials();

    expect(credentials.headers).toEqual({});
    expect(credentials.queryParams).toBeUndefined();
  });

  it('should return empty credentials if token env var missing', () => {
    delete process.env.MISSING_TOKEN;

    // Don't create chain with missing token - that throws immediately in buildChain
    // Instead, create chain without auth and test the logic
    const config: InterceptorConfig = {};

    const chain = new InterceptorChain(config);
    const credentials = chain.getAuthCredentials();

    expect(credentials.headers).toEqual({});
    expect(credentials.queryParams).toBeUndefined();
  });

  it('should return empty credentials for OAuth (handled separately)', () => {
    process.env.OAUTH_TOKEN = 'oauth-token';

    const config: InterceptorConfig = {
      auth: [
        {
          type: 'oauth',
          issuer: 'https://auth.example.com',
          client_id: 'test-client',
          priority: 0,
        } as any,
        {
          type: 'bearer',
          value_from_env: 'OAUTH_TOKEN',
          priority: 1,
        },
      ],
    };

    const chain = new InterceptorChain(config);
    const credentials = chain.getAuthCredentials();

    // Should skip OAuth and use bearer (next in priority)
    expect(credentials.headers).toEqual({ Authorization: 'Bearer oauth-token' });
  });

  it('should return empty credentials if unsafe header name', () => {
    process.env.API_KEY = 'test-key';

    const config: InterceptorConfig = {
      auth: {
        type: 'custom-header',
        header_name: '__proto__',
        value_from_env: 'API_KEY',
      },
    };

    const chain = new InterceptorChain(config);
    const credentials = chain.getAuthCredentials();

    // Should reject unsafe header name
    expect(credentials.headers).toEqual({});
    expect(credentials.queryParams).toBeUndefined();
  });

  it('should return empty credentials when value_from_env is missing in getAuthCredentials', () => {
    const config: InterceptorConfig = {
      auth: {
        type: 'bearer',
        // value_from_env missing
      } as any,
    };

    // Create chain without throwing (bypass constructor validation)
    const chain = new InterceptorChain({});
    (chain as any).config = config;
    (chain as any).authToken = undefined;

    const credentials = chain.getAuthCredentials();
    expect(credentials.headers).toEqual({});
    expect(credentials.queryParams).toBeUndefined();
  });

  it('should return empty credentials when token is not found in getAuthCredentials', () => {
    delete process.env.MISSING_TOKEN;

    const config: InterceptorConfig = {
      auth: {
        type: 'bearer',
        value_from_env: 'MISSING_TOKEN',
      },
    };

    // Create chain without throwing (bypass constructor validation)
    const chain = new InterceptorChain({});
    (chain as any).config = config;
    (chain as any).authToken = undefined;

    const credentials = chain.getAuthCredentials();
    expect(credentials.headers).toEqual({});
    expect(credentials.queryParams).toBeUndefined();
  });

  it('HttpClient should expose getAuthCredentials via pass-through', () => {
    process.env.MCP4_API_TOKEN = 'test-token';

    const config: InterceptorConfig = {
      auth: {
        type: 'bearer',
        value_from_env: 'MCP4_API_TOKEN',
      },
    };

    const client = createTestHttpClient('https://api.example.com', config);
    const credentials = client.getAuthCredentials();

    expect(credentials.headers).toEqual({ Authorization: 'Bearer test-token' });
  });
});

describe('HttpClient - Rate Limiting', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should create rate limit interceptor when configured', () => {
    const config: InterceptorConfig = {
      rate_limit: {
        max_requests_per_minute: 60,
      },
    };

    const interceptors = new InterceptorChain(config);

    // Just verify it initializes without error
    expect(interceptors).toBeDefined();
    expect(interceptors.config.rate_limit).toEqual({ max_requests_per_minute: 60 });
  });

  it('should support per-endpoint rate limiting overrides', () => {
    const config: InterceptorConfig = {
      rate_limit: {
        max_requests_per_minute: 100,
        overrides: {
          'searchOperation': { max_requests_per_minute: 10 },
          'createOperation': { max_requests_per_minute: 5 },
        },
      },
    };

    const interceptors = new InterceptorChain(config);

    expect(interceptors.config.rate_limit!.max_requests_per_minute).toBe(100);
    expect(interceptors.config.rate_limit!.overrides!['searchOperation']).toEqual({ max_requests_per_minute: 10 });
    expect(interceptors.config.rate_limit!.overrides!['createOperation']).toEqual({ max_requests_per_minute: 5 });
  });

  it('should enforce global rate limit for unknown operationId', async () => {
    const config: InterceptorConfig = {
      rate_limit: {
        max_requests_per_minute: 2, // 2 req/min
      },
    };

    const interceptors = new InterceptorChain(config);

    // První 2 requesty by měly projít okamžitě
    await interceptors.execute(
      { method: 'GET', url: 'http://example.com', headers: {}, operationId: 'unknownOp' },
      async () => ({ status: 200, headers: {}, body: 'ok' })
    );
    await interceptors.execute(
      { method: 'GET', url: 'http://example.com', headers: {}, operationId: 'unknownOp' },
      async () => ({ status: 200, headers: {}, body: 'ok' })
    );

    // Třetí request by měl čekat (2 req/min = 30s na token)
    const thirdRequest = interceptors.execute(
      { method: 'GET', url: 'http://example.com', headers: {}, operationId: 'unknownOp' },
      async () => ({ status: 200, headers: {}, body: 'ok' })
    );

    // Ověř, že se vytvořil timer (čekání)
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    // Posuň čas o 30 sekund
    vi.advanceTimersByTime(30000);

    // Teď by request měl projít
    await expect(thirdRequest).resolves.toEqual({
      status: 200,
      headers: {},
      body: 'ok'
    });
  });

  it('should enforce per-endpoint rate limits', async () => {
    const config: InterceptorConfig = {
      rate_limit: {
        max_requests_per_minute: 60, // High global limit
        overrides: {
          'searchOp': { max_requests_per_minute: 2 }, // 2 req/min for search
          'createOp': { max_requests_per_minute: 1 }, // 1 req/min for create
        },
      },
    };

    const interceptors = new InterceptorChain(config);

    // Test search operation (2 req/min)
    // První 2 requesty projdou okamžitě
    await interceptors.execute(
      { method: 'GET', url: 'http://example.com', headers: {}, operationId: 'searchOp' },
      async () => ({ status: 200, headers: {}, body: 'ok' })
    );
    await interceptors.execute(
      { method: 'GET', url: 'http://example.com', headers: {}, operationId: 'searchOp' },
      async () => ({ status: 200, headers: {}, body: 'ok' })
    );

    // Třetí request by měl čekat
    const searchRequest = interceptors.execute(
      { method: 'GET', url: 'http://example.com', headers: {}, operationId: 'searchOp' },
      async () => ({ status: 200, headers: {}, body: 'ok' })
    );

    expect(vi.getTimerCount()).toBeGreaterThan(0);
    vi.advanceTimersByTime(30000); // 30s
    await expect(searchRequest).resolves.toEqual({
      status: 200,
      headers: {},
      body: 'ok'
    });

    // Test create operation (1 req/min)
    // První request projde okamžitě
    await interceptors.execute(
      { method: 'GET', url: 'http://example.com', headers: {}, operationId: 'createOp' },
      async () => ({ status: 200, headers: {}, body: 'ok' })
    );

    // Druhý request by měl čekat 60s
    const createRequest = interceptors.execute(
      { method: 'GET', url: 'http://example.com', headers: {}, operationId: 'createOp' },
      async () => ({ status: 200, headers: {}, body: 'ok' })
    );

    expect(vi.getTimerCount()).toBeGreaterThan(0);
    vi.advanceTimersByTime(60000); // 60s
    await expect(createRequest).resolves.toEqual({
      status: 200,
      headers: {},
      body: 'ok'
    });
  });

  it('should use global limit when operationId has no override', async () => {
    const config: InterceptorConfig = {
      rate_limit: {
        max_requests_per_minute: 4, // 4 req/min global limit
        overrides: {
          'specialOp': { max_requests_per_minute: 2 }, // 2 req/min for special op
        },
      },
    };

    const interceptors = new InterceptorChain(config);

    // Test global limit (4 req/min) - první 4 projdou okamžitě
    for (let i = 0; i < 4; i++) {
      await interceptors.execute(
        { method: 'GET', url: 'http://example.com', headers: {}, operationId: 'normalOp' },
        async () => ({ status: 200, headers: {}, body: 'ok' })
      );
    }

    // Pátý request by měl čekat (4 req/min = 15s na token)
    const fifthRequest = interceptors.execute(
      { method: 'GET', url: 'http://example.com', headers: {}, operationId: 'normalOp' },
      async () => ({ status: 200, headers: {}, body: 'ok' })
    );

    expect(vi.getTimerCount()).toBeGreaterThan(0);
    vi.advanceTimersByTime(15000); // 15s
    await expect(fifthRequest).resolves.toEqual({
      status: 200,
      headers: {},
      body: 'ok'
    });
  });

  it('should maintain separate token buckets for different endpoints', async () => {
    const config: InterceptorConfig = {
      rate_limit: {
        max_requests_per_minute: 60, // High global limit
        overrides: {
          'fastOp': { max_requests_per_minute: 60 }, // Same as global
          'slowOp': { max_requests_per_minute: 1 }, // 1 req/min
        },
      },
    };

    const interceptors = new InterceptorChain(config);

    // Fast operation should complete quickly (just 1 request, no rate limiting)
    const fastRequest = interceptors.execute(
      { method: 'GET', url: 'http://example.com', headers: {}, operationId: 'fastOp' },
      async () => ({ status: 200, headers: {}, body: 'ok' })
    );

    expect(vi.getTimerCount()).toBe(0); // No timers should be created
    await expect(fastRequest).resolves.toEqual({
      status: 200,
      headers: {},
      body: 'ok'
    });

    // Slow operation should be rate limited
    // První request projde okamžitě
    await interceptors.execute(
      { method: 'GET', url: 'http://example.com', headers: {}, operationId: 'slowOp' },
      async () => ({ status: 200, headers: {}, body: 'ok' })
    );

    // Druhý request by měl čekat 60s
    const slowRequest = interceptors.execute(
      { method: 'GET', url: 'http://example.com', headers: {}, operationId: 'slowOp' },
      async () => ({ status: 200, headers: {}, body: 'ok' })
    );

    expect(vi.getTimerCount()).toBeGreaterThan(0);
    vi.advanceTimersByTime(60000); // 60s
    await expect(slowRequest).resolves.toEqual({
      status: 200,
      headers: {},
      body: 'ok'
    });
  });

  it('should work without overrides (backward compatibility)', async () => {
    const config: InterceptorConfig = {
      rate_limit: {
        max_requests_per_minute: 3, // 3 req/min
      },
    };

    const interceptors = new InterceptorChain(config);

    // První 3 requesty projdou okamžitě
    for (let i = 0; i < 3; i++) {
      await interceptors.execute(
        { method: 'GET', url: 'http://example.com', headers: {}, operationId: 'anyOp' },
        async () => ({ status: 200, headers: {}, body: 'ok' })
      );
    }

    // Čtvrtý request by měl čekat (3 req/min = 20s na token)
    const fourthRequest = interceptors.execute(
      { method: 'GET', url: 'http://example.com', headers: {}, operationId: 'anyOp' },
      async () => ({ status: 200, headers: {}, body: 'ok' })
    );

    expect(vi.getTimerCount()).toBeGreaterThan(0);
    vi.advanceTimersByTime(20000); // 20s
    await expect(fourthRequest).resolves.toEqual({
      status: 200,
      headers: {},
      body: 'ok'
    });
  });
});

describe('HttpClient - Retry Logic', () => {
  it('should retry on 429 status with exponential backoff', async () => {
    const config: InterceptorConfig = {
      retry: {
        max_attempts: 3,
        backoff_ms: [100, 200, 400],
        retry_on_status: [429],
      },
    };

    const interceptors = new InterceptorChain(config);
    const client = new HttpClient('https://api.example.com', interceptors, null, undefined, mockSSRFValidator);

    let attemptCount = 0;
    global.fetch = async () => {
      attemptCount++;
      if (attemptCount < 3) {
        return new Response(null, { status: 429 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    const result = await client.request('GET', '/test');

    expect(attemptCount).toBe(3);
    expect(result.status).toBe(200);
  });

  it('should throw after max retry attempts', async () => {
    const config: InterceptorConfig = {
      retry: {
        max_attempts: 2,
        backoff_ms: [50, 100],
        retry_on_status: [502],
      },
    };

    const client = createTestHttpClient('https://api.example.com', config);

    setupErrorFetchMock(502);

    // Now throws NetworkError instead of plain Error with 'HTTP 502'
    await expect(
      client.request('GET', '/test')
    ).rejects.toThrow(NetworkError);
  });
});

describe('HttpClient - Array Serialization', () => {
  beforeEach(() => {
    process.env.MCP4_API_TOKEN = 'test-token';
  });

  it('should serialize arrays with brackets format', async () => {
    const config: InterceptorConfig = {
      auth: { type: 'bearer', value_from_env: 'MCP4_API_TOKEN' },
      array_format: 'brackets',
    };

    const interceptors = new InterceptorChain(config);
    const client = new HttpClient('https://api.example.com', interceptors, null, undefined, mockSSRFValidator);

    let capturedUrl = '';
    global.fetch = async (url: RequestInfo | URL) => {
      capturedUrl = url.toString();
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    await client.request('GET', '/test', {
      params: { scope: ['a', 'b'] },
    });

    expect(decodeURIComponent(capturedUrl)).toContain('scope[]=a');
    expect(decodeURIComponent(capturedUrl)).toContain('scope[]=b');
  });

  it('should serialize arrays with comma format', async () => {
    const config: InterceptorConfig = {
      auth: { type: 'bearer', value_from_env: 'MCP4_API_TOKEN' },
      array_format: 'comma',
    };

    const interceptors = new InterceptorChain(config);
    const client = new HttpClient('https://api.example.com', interceptors, null, undefined, mockSSRFValidator);

    let capturedUrl = '';
    global.fetch = async (url: RequestInfo | URL) => {
      capturedUrl = url.toString();
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    await client.request('GET', '/test', {
      params: { scope: ['a', 'b', 'c'] },
    });

    expect(decodeURIComponent(capturedUrl)).toContain('scope=a,b,c');
  });

  it('should serialize arrays with indices format', async () => {
    const config: InterceptorConfig = {
      auth: { type: 'bearer', value_from_env: 'MCP4_API_TOKEN' },
      array_format: 'indices',
    };

    const interceptors = new InterceptorChain(config);
    const client = new HttpClient('https://api.example.com', interceptors, null, undefined, mockSSRFValidator);

    let capturedUrl = '';
    global.fetch = async (url: RequestInfo | URL) => {
      capturedUrl = url.toString();
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    await client.request('GET', '/test', {
      params: { items: ['x', 'y'] },
    });

    expect(decodeURIComponent(capturedUrl)).toContain('items[0]=x');
    expect(decodeURIComponent(capturedUrl)).toContain('items[1]=y');
  });

  it('should serialize arrays with repeat format', async () => {
    const config: InterceptorConfig = {
      auth: { type: 'bearer', value_from_env: 'MCP4_API_TOKEN' },
      array_format: 'repeat',
    };

    const interceptors = new InterceptorChain(config);
    const client = new HttpClient('https://api.example.com', interceptors, null, undefined, mockSSRFValidator);

    let capturedUrl = '';
    global.fetch = async (url: RequestInfo | URL) => {
      capturedUrl = url.toString();
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    await client.request('GET', '/test', {
      params: { tag: ['a', 'b'] },
    });

    // 'repeat' format: tag=a&tag=b
    const url = new URL(capturedUrl);
    expect(url.searchParams.getAll('tag')).toEqual(['a', 'b']);
  });
});

describe('HttpClient - Structured Error Handling', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.MCP4_API_TOKEN = 'test-token';
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should throw AuthenticationError on 401 status', async () => {
    const config: InterceptorConfig = {
      auth: { type: 'bearer', value_from_env: 'MCP4_API_TOKEN' },
    };

    const client = createTestHttpClient('https://api.example.com', config);

    global.fetch = async () => {
      return new Response(
        JSON.stringify({ 
          error: 'invalid_token',
          error_description: 'Token is expired. You can either do re-authorization or...'
        }),
        {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    };

    await expect(client.request('GET', '/test'))
      .rejects
      .toThrow(AuthenticationError);

    await expect(client.request('GET', '/test'))
      .rejects
      .toThrow('Token is expired');
  });

  it('should throw AuthorizationError on 403 status', async () => {
    const config: InterceptorConfig = {
      auth: { type: 'bearer', value_from_env: 'MCP4_API_TOKEN' },
    };

    const client = createTestHttpClient('https://api.example.com', config);

    global.fetch = async () => {
      return new Response(
        JSON.stringify({ message: 'Insufficient permissions' }),
        {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    };

    await expect(client.request('GET', '/test'))
      .rejects
      .toThrow(AuthorizationError);

    await expect(client.request('GET', '/test'))
      .rejects
      .toThrow('Insufficient permissions');
  });

  it('should throw RateLimitError on 429 status', async () => {
    const config: InterceptorConfig = {
      auth: { type: 'bearer', value_from_env: 'MCP4_API_TOKEN' },
    };

    const client = createTestHttpClient('https://api.example.com', config);

    global.fetch = async () => {
      return new Response(
        JSON.stringify({ message: 'Rate limit exceeded' }),
        {
          status: 429,
          headers: { 
            'Content-Type': 'application/json',
            'Retry-After': '60'
          },
        }
      );
    };

    try {
      await client.request('GET', '/test');
      expect.fail('Should have thrown RateLimitError');
    } catch (error) {
      expect(error).toBeInstanceOf(RateLimitError);
      expect((error as RateLimitError).details?.retryAfter).toBe(60);
    }
  });

  it('should return 304 response without throwing', async () => {
    const config: InterceptorConfig = {
      auth: { type: 'bearer', value_from_env: 'MCP4_API_TOKEN' },
    };

    const client = createTestHttpClient('https://api.example.com', config);

    global.fetch = async () => {
      return new Response(null, {
        status: 304,
        headers: {
          ETag: '"v1"',
          Date: 'Tue, 24 Feb 2026 00:01:00 GMT',
        },
      });
    };

    const response = await client.request('GET', '/test');
    expect(response.status).toBe(304);
    expect(response.headers.etag).toBe('"v1"');
  });

  it('should throw NetworkError on 404 status', async () => {
    const config: InterceptorConfig = {
      auth: { type: 'bearer', value_from_env: 'MCP4_API_TOKEN' },
    };

    const client = createTestHttpClient('https://api.example.com', config);

    global.fetch = async () => {
      return new Response(
        JSON.stringify({ message: 'Not found' }),
        {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    };

    await expect(client.request('GET', '/test'))
      .rejects
      .toThrow(NetworkError);

    await expect(client.request('GET', '/test'))
      .rejects
      .toThrow('Resource not found');
  });

  it('should throw NetworkError on 500 status with body included', async () => {
    const config: InterceptorConfig = {
      auth: { type: 'bearer', value_from_env: 'MCP4_API_TOKEN' },
    };

    const client = createTestHttpClient('https://api.example.com', config);

    global.fetch = async () => {
      return new Response(
        JSON.stringify({ error: 'Internal server error', details: 'Database connection failed' }),
        {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    };

    try {
      await client.request('GET', '/test');
      expect.fail('Should have thrown NetworkError');
    } catch (error) {
      expect(error).toBeInstanceOf(NetworkError);
      expect((error as NetworkError).details?.statusCode).toBe(500);
      expect((error as NetworkError).details?.body).toBeDefined();
    }
  });

  it('should extract error_description from response body', async () => {
    const config: InterceptorConfig = {
      auth: { type: 'bearer', value_from_env: 'MCP4_API_TOKEN' },
    };

    const client = createTestHttpClient('https://api.example.com', config);

    global.fetch = async () => {
      return new Response(
        JSON.stringify({ 
          error: 'invalid_grant',
          error_description: 'The provided authorization grant is invalid'
        }),
        {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    };

    await expect(client.request('GET', '/test'))
      .rejects
      .toThrow('The provided authorization grant is invalid');
  });

  it('should extract error field from response body', async () => {
    const config: InterceptorConfig = {
      auth: { type: 'bearer', value_from_env: 'MCP4_API_TOKEN' },
    };

    const client = createTestHttpClient('https://api.example.com', config);

    global.fetch = async () => {
      return new Response(
        JSON.stringify({ error: 'Bad Request' }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    };

    await expect(client.request('GET', '/test'))
      .rejects
      .toThrow('Bad Request');
  });

  it('should extract message field from response body', async () => {
    const config: InterceptorConfig = {
      auth: { type: 'bearer', value_from_env: 'MCP4_API_TOKEN' },
    };

    const client = createTestHttpClient('https://api.example.com', config);

    global.fetch = async () => {
      return new Response(
        JSON.stringify({ message: 'Validation failed' }),
        {
          status: 422,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    };

    await expect(client.request('GET', '/test'))
      .rejects
      .toThrow('Validation failed');
  });

  it('should use plain text body as error message', async () => {
    const config: InterceptorConfig = {
      auth: { type: 'bearer', value_from_env: 'MCP4_API_TOKEN' },
    };

    const client = createTestHttpClient('https://api.example.com', config);

    global.fetch = async () => {
      return new Response(
        'Plain text error message',
        {
          status: 500,
          headers: { 'Content-Type': 'text/plain' },
        }
      );
    };

    await expect(client.request('GET', '/test'))
      .rejects
      .toThrow('Plain text error message');
  });
});

describe('HttpClient - Multipart Support', () => {
  beforeEach(() => {
    process.env.MCP4_API_TOKEN = 'test-token';
  });

  it('should not stringify FormData body', async () => {
    const config: InterceptorConfig = {
      auth: { type: 'bearer', value_from_env: 'MCP4_API_TOKEN' },
    };

    const client = createTestHttpClient('https://api.example.com', config);

    const formData = new FormData();
    formData.append('file', new Blob(['test content']), 'test.txt');

    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve({ id: '123', name: 'test.txt' }),
      text: () => Promise.resolve(''),
    });

    global.fetch = mockFetch;

    await client.request('POST', '/upload', { body: formData });

    const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(options.body).toBeInstanceOf(FormData);
    expect(options.headers).not.toHaveProperty('Content-Type');
  });

  it('should stringify JSON body', async () => {
    const config: InterceptorConfig = {
      auth: { type: 'bearer', value_from_env: 'MCP4_API_TOKEN' },
    };

    const client = createTestHttpClient('https://api.example.com', config);

    const jsonBody = { name: 'test', value: 123 };

    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve({ id: '123' }),
      text: () => Promise.resolve(''),
    });

    global.fetch = mockFetch;

    await client.request('POST', '/create', { body: jsonBody });

    const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(options.body).toBe(JSON.stringify(jsonBody));
    expect(options.headers).toHaveProperty('Content-Type', 'application/json');
  });

  it('should handle Blob body as binary', async () => {
    const config: InterceptorConfig = {
      auth: { type: 'bearer', value_from_env: 'MCP4_API_TOKEN' },
    };

    const client = createTestHttpClient('https://api.example.com', config);

    const blob = new Blob(['binary content'], { type: 'application/octet-stream' });

    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve({ status: 'ok' }),
      text: () => Promise.resolve(''),
    });

    global.fetch = mockFetch;

    await client.request('POST', '/binary', { body: blob });

    const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(options.body).toBe(blob);
  });

  it('should preserve custom Content-Type for binary data', async () => {
    const config: InterceptorConfig = {
      auth: { type: 'bearer', value_from_env: 'MCP4_API_TOKEN' },
    };

    const client = createTestHttpClient('https://api.example.com', config);

    const blob = new Blob(['pdf content'], { type: 'application/pdf' });

    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve({ status: 'ok' }),
      text: () => Promise.resolve(''),
    });

    global.fetch = mockFetch;

    await client.request('POST', '/pdf', 
      { 
        body: blob,
        headers: { 'Content-Type': 'application/pdf' }
      }
    );

    const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(options.headers).toHaveProperty('Content-Type', 'application/pdf');
  });

  it('should set default Content-Type for Blob without Content-Type', async () => {
    process.env.MCP4_API_TOKEN = 'test-token';

    const config: InterceptorConfig = {
      auth: { type: 'bearer', value_from_env: 'MCP4_API_TOKEN' },
    };

    const client = createTestHttpClient('https://api.example.com', config);

    const blob = new Blob(['binary data']);

    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve({ status: 'ok' }),
      text: () => Promise.resolve(''),
    });

    global.fetch = mockFetch;

    // Pass empty string for Content-Type to trigger default
    await client.request('POST', '/binary', { 
      body: blob,
      headers: { 'Content-Type': '' } 
    });

    const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(options.headers).toHaveProperty('Content-Type', 'application/octet-stream');
  });
});

describe('HttpClient - Redirect auth header policy', () => {
  beforeEach(() => {
    process.env.MCP4_API_TOKEN = 'redirect-test-token';
  });

  afterEach(() => {
    restoreFetch();
    delete process.env.MCP4_API_TOKEN;
  });

  it('strips sensitive headers on cross-origin redirect by default', async () => {
    const config: InterceptorConfig = {
      auth: { type: 'bearer', value_from_env: 'MCP4_API_TOKEN' },
    };
    const client = createTestHttpClient('https://api.example.com', config);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: 'https://evil.example/collect' },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      );
    global.fetch = fetchMock;

    await client.request('GET', '/start');

    const [, redirectedOptions] = fetchMock.mock.calls[1] as [string, RequestInit];
    const redirectedHeaders = redirectedOptions.headers as Record<string, string>;
    expect(redirectedHeaders.Authorization).toBeUndefined();
  });

  it('keeps sensitive headers on same-origin redirect with same-origin policy', async () => {
    const config: InterceptorConfig = {
      auth: { type: 'bearer', value_from_env: 'MCP4_API_TOKEN' },
      redirect_auth_policy: 'same-origin',
    };
    const client = createTestHttpClient('https://api.example.com', config);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: '/next' },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      );
    global.fetch = fetchMock;

    await client.request('GET', '/start');

    const [, redirectedOptions] = fetchMock.mock.calls[1] as [string, RequestInit];
    const redirectedHeaders = redirectedOptions.headers as Record<string, string>;
    expect(redirectedHeaders.Authorization).toBe('Bearer redirect-test-token');
  });

  it('strips sensitive headers even on same-origin redirect with never policy', async () => {
    const config: InterceptorConfig = {
      auth: { type: 'bearer', value_from_env: 'MCP4_API_TOKEN' },
      redirect_auth_policy: 'never',
    };
    const client = createTestHttpClient('https://api.example.com', config);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: '/next' },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      );
    global.fetch = fetchMock;

    await client.request('GET', '/start');

    const [, redirectedOptions] = fetchMock.mock.calls[1] as [string, RequestInit];
    const redirectedHeaders = redirectedOptions.headers as Record<string, string>;
    expect(redirectedHeaders.Authorization).toBeUndefined();
  });
});

describe('HttpClient - API metrics', () => {
  afterEach(() => {
    restoreFetch();
  });

  it('records API call metrics on success', async () => {
    const metrics = new MetricsCollector({ enabled: true, prefix: 'test_' });
    const interceptors = new InterceptorChain({});
    const client = new HttpClient(
      'https://api.example.com',
      interceptors,
      metrics,
      undefined,
      mockSSRFValidator,
      { profileId: 'grafana', tenantId: 'team-a' }
    );

    setupFetchMock({ ok: true }, { status: 200, headers: { 'Content-Type': 'application/json' } });

    await client.request('GET', '/test', { operationId: 'get_test' });

    const output = await metrics.getMetrics();
    expect(output).toContain('test_api_calls_total');
    expect(output).toContain('operation="get_test"');
    expect(output).toContain('status="2xx"');
    expect(output).toContain('profile_id="grafana"');
    expect(output).toContain('tenant_id="team-a"');
  });

  it('records API call error metrics on failure', async () => {
    const metrics = new MetricsCollector({ enabled: true, prefix: 'test_' });
    const interceptors = new InterceptorChain({});
    const client = new HttpClient('https://api.example.com', interceptors, metrics, undefined, mockSSRFValidator);

    setupErrorFetchMock(500, 'boom');

    await expect(client.request('GET', '/test', { operationId: 'get_test' }))
      .rejects
      .toThrow(NetworkError);

    const output = await metrics.getMetrics();
    expect(output).toContain('test_api_calls_total');
    expect(output).toContain('status="5xx"');
    expect(output).toContain('test_api_call_errors_total');
    expect(output).toContain('error_type="NetworkError"');
    expect(output).toContain('profile_id="unknown"');
    expect(output).toContain('tenant_id="none"');
  });

  it('records UnknownError for non-Error failures', async () => {
    const metrics = new MetricsCollector({ enabled: true, prefix: 'test_' });
    const interceptors = new InterceptorChain({});
    const client = new HttpClient('https://api.example.com', interceptors, metrics, undefined, mockSSRFValidator);

    global.fetch = async () => {
      throw 'boom';
    };

    await expect(client.request('GET', '/test', { operationId: 'get_test' }))
      .rejects
      .toEqual('boom');

    const output = await metrics.getMetrics();
    expect(output).toContain('test_api_calls_total');
    expect(output).toContain('status="unknown"');
    expect(output).toContain('test_api_call_errors_total');
    expect(output).toContain('error_type="UnknownError"');
  });
});
