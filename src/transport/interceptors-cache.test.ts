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
});
