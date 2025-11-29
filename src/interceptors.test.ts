/**
 * Tests for HTTP interceptors (auth, rate-limit, retry)
 * 
 * Why: Validates auth types (bearer, query, custom-header), rate limiting, and retry logic
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HttpClient, InterceptorChain } from './interceptors.js';
import { createTestHttpClient, setupFetchMock, setupErrorFetchMock, setupNetworkErrorFetchMock, setupRateLimitFetchMock } from './testing/test-http-utils.js';
import type { InterceptorConfig } from './types/profile.js';
import { AuthenticationError, AuthorizationError, RateLimitError, NetworkError } from './errors.js';

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
    const client = new HttpClient('https://api.example.com', interceptors);

    let capturedHeaders: Record<string, string> = {};
    global.fetch = async (url: RequestInfo | URL, init?: RequestInit) => {
      capturedHeaders = init?.headers as Record<string, string>;
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
    const client = new HttpClient('https://api.example.com', interceptors);

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
    const client = new HttpClient('https://api.example.com', interceptors);

    let capturedUrl = '';
    global.fetch = async (url: RequestInfo | URL, init?: RequestInit) => {
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

  it('should work without auth if not configured', async () => {
    const config: InterceptorConfig = {};

    const client = createTestHttpClient('https://api.example.com', config);
    const { capturedHeaders } = setupFetchMock();

    await client.request('GET', '/test');

    expect(capturedHeaders['Authorization']).toBeUndefined();
    expect(capturedHeaders['X-API-Key']).toBeUndefined();
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
      { method: 'GET', url: 'http://example.com', operationId: 'unknownOp' },
      async () => ({ status: 200, headers: {}, body: 'ok' })
    );
    await interceptors.execute(
      { method: 'GET', url: 'http://example.com', operationId: 'unknownOp' },
      async () => ({ status: 200, headers: {}, body: 'ok' })
    );

    // Třetí request by měl čekat (2 req/min = 30s na token)
    const thirdRequest = interceptors.execute(
      { method: 'GET', url: 'http://example.com', operationId: 'unknownOp' },
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
      { method: 'GET', url: 'http://example.com', operationId: 'searchOp' },
      async () => ({ status: 200, headers: {}, body: 'ok' })
    );
    await interceptors.execute(
      { method: 'GET', url: 'http://example.com', operationId: 'searchOp' },
      async () => ({ status: 200, headers: {}, body: 'ok' })
    );

    // Třetí request by měl čekat
    const searchRequest = interceptors.execute(
      { method: 'GET', url: 'http://example.com', operationId: 'searchOp' },
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
      { method: 'GET', url: 'http://example.com', operationId: 'createOp' },
      async () => ({ status: 200, headers: {}, body: 'ok' })
    );

    // Druhý request by měl čekat 60s
    const createRequest = interceptors.execute(
      { method: 'GET', url: 'http://example.com', operationId: 'createOp' },
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
        { method: 'GET', url: 'http://example.com', operationId: 'normalOp' },
        async () => ({ status: 200, headers: {}, body: 'ok' })
      );
    }

    // Pátý request by měl čekat (4 req/min = 15s na token)
    const fifthRequest = interceptors.execute(
      { method: 'GET', url: 'http://example.com', operationId: 'normalOp' },
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
      { method: 'GET', url: 'http://example.com', operationId: 'fastOp' },
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
      { method: 'GET', url: 'http://example.com', operationId: 'slowOp' },
      async () => ({ status: 200, headers: {}, body: 'ok' })
    );

    // Druhý request by měl čekat 60s
    const slowRequest = interceptors.execute(
      { method: 'GET', url: 'http://example.com', operationId: 'slowOp' },
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
        { method: 'GET', url: 'http://example.com', operationId: 'anyOp' },
        async () => ({ status: 200, headers: {}, body: 'ok' })
      );
    }

    // Čtvrtý request by měl čekat (3 req/min = 20s na token)
    const fourthRequest = interceptors.execute(
      { method: 'GET', url: 'http://example.com', operationId: 'anyOp' },
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
    const client = new HttpClient('https://api.example.com', interceptors);

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
    const client = new HttpClient('https://api.example.com', interceptors);

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
    const client = new HttpClient('https://api.example.com', interceptors);

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
});

