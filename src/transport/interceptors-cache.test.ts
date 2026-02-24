import { describe, it, expect, afterEach } from 'vitest';
import { createTestHttpClient, restoreFetch } from '../testing/test-http-utils.js';
import type { InterceptorConfig } from '../types/profile.js';

afterEach(() => {
  restoreFetch();
});

describe('HttpClient - Response cache interceptor', () => {
  it('reuses cached GET responses for the same request', async () => {
    const config: InterceptorConfig = {
      cache: {
        enabled: true,
        ttl_seconds: 300,
        max_entries: 100,
        max_memory_bytes: 5_000_000,
      },
    };

    const client = createTestHttpClient('https://api.example.com', config);
    let calls = 0;

    global.fetch = async () => {
      calls += 1;
      return new Response(JSON.stringify({ calls }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const first = await client.request('GET', '/types/nodes.json');
    const second = await client.request('GET', '/types/nodes.json');

    expect(calls).toBe(1);
    expect(first.body).toEqual({ calls: 1 });
    expect(second.body).toEqual({ calls: 1 });
  });

  it('normalizes query order in cache keys', async () => {
    const config: InterceptorConfig = {
      cache: {
        enabled: true,
        ttl_seconds: 300,
        max_entries: 100,
        max_memory_bytes: 5_000_000,
      },
    };

    const client = createTestHttpClient('https://api.example.com', config);
    let calls = 0;

    global.fetch = async () => {
      calls += 1;
      return new Response(JSON.stringify({ calls }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    await client.request('GET', '/items?b=2&a=1');
    const second = await client.request('GET', '/items?a=1&b=2');

    expect(calls).toBe(1);
    expect(second.body).toEqual({ calls: 1 });
  });

  it('does not cache when response has cache-control: no-store', async () => {
    const config: InterceptorConfig = {
      cache: {
        enabled: true,
        ttl_seconds: 300,
        max_entries: 100,
        max_memory_bytes: 5_000_000,
      },
    };

    const client = createTestHttpClient('https://api.example.com', config);
    let calls = 0;

    global.fetch = async () => {
      calls += 1;
      return new Response(JSON.stringify({ calls }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        },
      });
    };

    await client.request('GET', '/items');
    await client.request('GET', '/items');

    expect(calls).toBe(2);
  });

  it('does not cache when response has cache-control: no-cache', async () => {
    const config: InterceptorConfig = {
      cache: {
        enabled: true,
        ttl_seconds: 300,
        max_entries: 100,
        max_memory_bytes: 5_000_000,
      },
    };

    const client = createTestHttpClient('https://api.example.com', config);
    let calls = 0;

    global.fetch = async () => {
      calls += 1;
      return new Response(JSON.stringify({ calls }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache',
        },
      });
    };

    await client.request('GET', '/items');
    await client.request('GET', '/items');

    expect(calls).toBe(2);
  });

  it('revalidates cached no-cache response with ETag and reuses cached body on 304', async () => {
    const config: InterceptorConfig = {
      cache: {
        enabled: true,
        ttl_seconds: 300,
        max_entries: 100,
        max_memory_bytes: 5_000_000,
      },
    };

    const client = createTestHttpClient('https://api.example.com', config);
    let calls = 0;
    const seenIfNoneMatch: string[] = [];

    global.fetch = async (_url, init) => {
      calls += 1;
      const headers = (init?.headers as Record<string, string>) || {};
      seenIfNoneMatch.push(headers['If-None-Match'] || headers['if-none-match'] || '');

      if (calls === 1) {
        return new Response(JSON.stringify({ version: 1 }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-cache, max-age=0',
            ETag: '"v1"',
          },
        });
      }

      return new Response(null, {
        status: 304,
        headers: { Date: 'Tue, 24 Feb 2026 00:01:00 GMT' },
      });
    };

    const first = await client.request('GET', '/items');
    const second = await client.request('GET', '/items');

    expect(calls).toBe(2);
    expect(first.body).toEqual({ version: 1 });
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ version: 1 });
    expect(seenIfNoneMatch[1]).toBe('"v1"');
  });

  it('does not read or store cache when request has cache-control: no-store', async () => {
    const config: InterceptorConfig = {
      cache: {
        enabled: true,
        ttl_seconds: 300,
        max_entries: 100,
        max_memory_bytes: 5_000_000,
      },
    };

    const client = createTestHttpClient('https://api.example.com', config);
    let calls = 0;

    global.fetch = async () => {
      calls += 1;
      return new Response(JSON.stringify({ calls }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    await client.request('GET', '/items', { headers: { 'Cache-Control': 'no-store' } });
    await client.request('GET', '/items', { headers: { 'Cache-Control': 'no-store' } });

    expect(calls).toBe(2);
  });

  it('forces conditional revalidation when request has cache-control: no-cache', async () => {
    const config: InterceptorConfig = {
      cache: {
        enabled: true,
        ttl_seconds: 300,
        max_entries: 100,
        max_memory_bytes: 5_000_000,
      },
    };

    const client = createTestHttpClient('https://api.example.com', config);
    let calls = 0;
    const conditionalHeaders: string[] = [];

    global.fetch = async (_url, init) => {
      calls += 1;
      const headers = (init?.headers as Record<string, string>) || {};
      conditionalHeaders.push(headers['If-None-Match'] || headers['if-none-match'] || '');

      if (calls === 1) {
        return new Response(JSON.stringify({ version: 1 }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'max-age=120',
            ETag: '"v1"',
          },
        });
      }

      return new Response(null, { status: 304 });
    };

    const first = await client.request('GET', '/items');
    const second = await client.request('GET', '/items', {
      headers: { 'Cache-Control': 'no-cache' },
    });

    expect(calls).toBe(2);
    expect(first.body).toEqual({ version: 1 });
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ version: 1 });
    expect(conditionalHeaders[1]).toBe('"v1"');
  });

  it('bypasses cached body for request no-cache when validators are missing', async () => {
    const config: InterceptorConfig = {
      cache: {
        enabled: true,
        ttl_seconds: 300,
        max_entries: 100,
        max_memory_bytes: 5_000_000,
      },
    };

    const client = createTestHttpClient('https://api.example.com', config);
    let calls = 0;

    global.fetch = async () => {
      calls += 1;
      return new Response(JSON.stringify({ calls }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'max-age=120',
        },
      });
    };

    const first = await client.request('GET', '/items');
    const second = await client.request('GET', '/items', {
      headers: { 'Cache-Control': 'no-cache' },
    });

    expect(calls).toBe(2);
    expect(first.body).toEqual({ calls: 1 });
    expect(second.body).toEqual({ calls: 2 });
  });

  it('deduplicates concurrent in-flight GET requests', async () => {
    const config: InterceptorConfig = {
      cache: {
        enabled: true,
        ttl_seconds: 300,
        max_entries: 100,
        max_memory_bytes: 5_000_000,
      },
    };

    const client = createTestHttpClient('https://api.example.com', config);
    let calls = 0;

    global.fetch = async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return new Response(JSON.stringify({ calls }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const [first, second] = await Promise.all([
      client.request('GET', '/items'),
      client.request('GET', '/items'),
    ]);

    expect(calls).toBe(1);
    expect(first.body).toEqual({ calls: 1 });
    expect(second.body).toEqual({ calls: 1 });
  });

  it('does not cache when response has vary: *', async () => {
    const config: InterceptorConfig = {
      cache: {
        enabled: true,
        ttl_seconds: 300,
        max_entries: 100,
        max_memory_bytes: 5_000_000,
      },
    };

    const client = createTestHttpClient('https://api.example.com', config);
    let calls = 0;

    global.fetch = async () => {
      calls += 1;
      return new Response(JSON.stringify({ calls }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          Vary: '*',
        },
      });
    };

    await client.request('GET', '/items');
    await client.request('GET', '/items');

    expect(calls).toBe(2);
  });

  it('evicts cached entries when max_entries is reached', async () => {
    const config: InterceptorConfig = {
      cache: {
        enabled: true,
        ttl_seconds: 300,
        max_entries: 1,
        max_memory_bytes: 5_000_000,
      },
    };

    const client = createTestHttpClient('https://api.example.com', config);
    let calls = 0;

    global.fetch = async (input) => {
      calls += 1;
      return new Response(JSON.stringify({ calls, url: String(input) }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    await client.request('GET', '/first');
    await client.request('GET', '/second');
    await client.request('GET', '/first');

    expect(calls).toBe(3);
  });

  it('partitions cache by auth context in private scope', async () => {
    const config: InterceptorConfig = {
      cache: {
        enabled: true,
        scope: 'private',
        ttl_seconds: 300,
        max_entries: 10,
        max_memory_bytes: 5_000_000,
      },
    };

    const client = createTestHttpClient('https://api.example.com', config);
    let calls = 0;

    global.fetch = async () => {
      calls += 1;
      return new Response(JSON.stringify({ calls }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    await client.request('GET', '/private', {
      headers: { Authorization: 'Bearer token-a' },
    });
    await client.request('GET', '/private', {
      headers: { Authorization: 'Bearer token-b' },
    });

    expect(calls).toBe(2);
  });

  it('does not cache public scope requests with authorization header', async () => {
    const config: InterceptorConfig = {
      cache: {
        enabled: true,
        scope: 'public',
        ttl_seconds: 300,
        max_entries: 10,
        max_memory_bytes: 5_000_000,
      },
    };

    const client = createTestHttpClient('https://api.example.com', config);
    let calls = 0;

    global.fetch = async () => {
      calls += 1;
      return new Response(JSON.stringify({ calls }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    await client.request('GET', '/public', {
      headers: { Authorization: 'Bearer token' },
    });
    await client.request('GET', '/public', {
      headers: { Authorization: 'Bearer token' },
    });

    expect(calls).toBe(2);
  });

  it('invalidates cache after successful unsafe mutation', async () => {
    const config: InterceptorConfig = {
      cache: {
        enabled: true,
        ttl_seconds: 300,
        max_entries: 100,
        max_memory_bytes: 5_000_000,
      },
    };

    const client = createTestHttpClient('https://api.example.com', config);
    let calls = 0;

    global.fetch = async () => {
      calls += 1;
      return new Response(JSON.stringify({ calls }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const first = await client.request('GET', '/items');
    const second = await client.request('GET', '/items');
    await client.request('POST', '/items', { body: { name: 'new-item' } });
    const third = await client.request('GET', '/items');

    expect(first.body).toEqual({ calls: 1 });
    expect(second.body).toEqual({ calls: 1 });
    expect(third.body).toEqual({ calls: 3 });
    expect(calls).toBe(3);
  });

  it('partitions cache by custom-header auth from multi-auth config', async () => {
    process.env.CACHE_TEST_QUERY_TOKEN = 'query-token';
    process.env.CACHE_TEST_HEADER_TOKEN = 'header-token';

    const config: InterceptorConfig = {
      auth: [
        {
          type: 'query',
          query_param: 'api_key',
          value_from_env: 'CACHE_TEST_QUERY_TOKEN',
          priority: 1,
        },
        {
          type: 'custom-header',
          header_name: 'X-Tenant-Auth',
          value_from_env: 'CACHE_TEST_HEADER_TOKEN',
          priority: 0,
        },
      ],
      cache: {
        enabled: true,
        scope: 'private',
        ttl_seconds: 300,
        max_entries: 10,
        max_memory_bytes: 5_000_000,
      },
    };

    const client = createTestHttpClient('https://api.example.com', config);
    let calls = 0;

    global.fetch = async () => {
      calls += 1;
      return new Response(JSON.stringify({ calls }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    await client.request('GET', '/tenant', { headers: { 'X-Tenant-Auth': 'tenant-a' } });
    await client.request('GET', '/tenant', { headers: { 'X-Tenant-Auth': 'tenant-b' } });

    expect(calls).toBe(1);
  });
});
