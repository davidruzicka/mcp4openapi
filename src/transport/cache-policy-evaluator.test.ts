import { describe, expect, it } from 'vitest';
import type { CachePolicy } from './cache-store.js';
import {
  evaluateRequestCacheDecision,
  evaluateResponseCacheDecision,
} from './cache-policy-evaluator.js';

function createPolicy(overrides: Partial<CachePolicy> = {}): CachePolicy {
  return {
    backend: 'memory',
    scope: 'private',
    allowSharedWithAuth: false,
    ttlSeconds: 300,
    methods: new Set(['GET']),
    varyHeaders: new Set(['accept', 'accept-language']),
    maxEntries: 100,
    maxMemoryBytes: 1024 * 1024,
    ...overrides,
  };
}

describe('cache-policy-evaluator request decisions', () => {
  it('rejects request caching for cache-control: no-store', () => {
    const decision = evaluateRequestCacheDecision({
      ctx: {
        method: 'GET',
        url: 'https://api.example.com/items',
        headers: { 'Cache-Control': 'no-store' },
      },
      policy: createPolicy(),
      sensitiveHeaders: new Set(['authorization', 'cookie']),
    });

    expect(decision).toMatchObject({
      canReadFromCache: false,
      canStoreResponse: false,
      skipReason: 'req_no_store',
    });
  });

  it('requires revalidation for request cache-control: no-cache', () => {
    const decision = evaluateRequestCacheDecision({
      ctx: {
        method: 'GET',
        url: 'https://api.example.com/items',
        headers: { 'Cache-Control': 'no-cache' },
      },
      policy: createPolicy(),
      sensitiveHeaders: new Set(['authorization', 'cookie']),
    });

    expect(decision).toMatchObject({
      canReadFromCache: true,
      canStoreResponse: true,
      requiresRevalidation: true,
    });
  });

  it('requires revalidation for request pragma: no-cache', () => {
    const decision = evaluateRequestCacheDecision({
      ctx: {
        method: 'GET',
        url: 'https://api.example.com/items',
        headers: { Pragma: 'foo, no-cache' },
      },
      policy: createPolicy(),
      sensitiveHeaders: new Set(['authorization', 'cookie']),
    });

    expect(decision).toMatchObject({
      canReadFromCache: true,
      canStoreResponse: true,
      requiresRevalidation: true,
    });
  });

  it('blocks public scope cache when sensitive request headers are present', () => {
    const decision = evaluateRequestCacheDecision({
      ctx: {
        method: 'GET',
        url: 'https://api.example.com/items',
        headers: { Authorization: 'Bearer token' },
      },
      policy: createPolicy({ scope: 'public' }),
      sensitiveHeaders: new Set(['authorization', 'cookie']),
    });

    expect(decision).toMatchObject({
      canReadFromCache: false,
      canStoreResponse: false,
      skipReason: 'req_public_scope_auth',
    });
  });

  it('marks mutation methods as unsafe for post-request invalidation', () => {
    const decision = evaluateRequestCacheDecision({
      ctx: {
        method: 'POST',
        url: 'https://api.example.com/items',
        headers: {},
      },
      policy: createPolicy(),
      sensitiveHeaders: new Set(['authorization', 'cookie']),
    });

    expect(decision.canReadFromCache).toBe(false);
    expect(decision.canStoreResponse).toBe(false);
    expect(decision.isUnsafeMutationMethod).toBe(true);
  });

  it('does not cache requests with a body payload', () => {
    const decision = evaluateRequestCacheDecision({
      ctx: {
        method: 'GET',
        url: 'https://api.example.com/items',
        headers: {},
        body: { probe: true },
      },
      policy: createPolicy(),
      sensitiveHeaders: new Set(['authorization', 'cookie']),
    });

    expect(decision).toMatchObject({
      canReadFromCache: false,
      canStoreResponse: false,
      isUnsafeMutationMethod: false,
    });
  });

  it('ignores empty sensitive header values in public scope checks', () => {
    const decision = evaluateRequestCacheDecision({
      ctx: {
        method: 'GET',
        url: 'https://api.example.com/items',
        headers: {
          Authorization: '',
        },
      },
      policy: createPolicy({ scope: 'public' }),
      sensitiveHeaders: new Set(['authorization', 'cookie']),
    });

    expect(decision).toMatchObject({
      canReadFromCache: true,
      canStoreResponse: true,
    });
  });

  it('allows explicit public cache with auth headers when override is enabled', () => {
    const decision = evaluateRequestCacheDecision({
      ctx: {
        method: 'GET',
        url: 'https://api.example.com/items',
        headers: { Cookie: 'sid=token' },
      },
      policy: createPolicy({ scope: 'public', allowSharedWithAuth: true }),
      sensitiveHeaders: new Set(['authorization', 'cookie']),
    });

    expect(decision).toMatchObject({
      canReadFromCache: true,
      canStoreResponse: true,
    });
  });
});

describe('cache-policy-evaluator response decisions', () => {
  it('does not cache response cache-control: no-cache without validators', () => {
    const decision = evaluateResponseCacheDecision({
      response: {
        status: 200,
        headers: { 'Cache-Control': 'no-cache' },
        body: { ok: true },
      },
      policy: createPolicy(),
    });

    expect(decision).toEqual({
      cacheable: false,
      skipReason: 'resp_no_cache',
    });
  });

  it('does not cache non-success responses', () => {
    const decision = evaluateResponseCacheDecision({
      response: {
        status: 503,
        headers: {},
        body: { ok: false },
      },
      policy: createPolicy(),
    });

    expect(decision).toEqual({
      cacheable: false,
      skipReason: 'resp_non_success',
    });
  });

  it('caches response cache-control: no-cache when validators are present', () => {
    const decision = evaluateResponseCacheDecision({
      response: {
        status: 200,
        headers: {
          'Cache-Control': 'no-cache, max-age=0',
          ETag: '"v1"',
        },
        body: { ok: true },
      },
      policy: createPolicy({ ttlSeconds: 120 }),
    });

    expect(decision).toEqual({
      cacheable: true,
      ttlSeconds: 120,
      requiresRevalidation: true,
    });
  });

  it('does not cache when vary is wildcard', () => {
    const decision = evaluateResponseCacheDecision({
      response: {
        status: 200,
        headers: { Vary: '*' },
        body: { ok: true },
      },
      policy: createPolicy(),
    });

    expect(decision).toEqual({
      cacheable: false,
      skipReason: 'resp_vary_star',
    });
  });

  it('does not cache when vary uses unsupported request header', () => {
    const decision = evaluateResponseCacheDecision({
      response: {
        status: 200,
        headers: { Vary: 'x-request-id' },
        body: { ok: true },
      },
      policy: createPolicy(),
    });

    expect(decision).toEqual({
      cacheable: false,
      skipReason: 'resp_vary_unsupported',
    });
  });

  it('treats malformed max-age directive as invalid', () => {
    const decision = evaluateResponseCacheDecision({
      response: {
        status: 200,
        headers: { 'Cache-Control': 'max-age=abc' },
        body: { ok: true },
      },
      policy: createPolicy(),
    });

    expect(decision).toEqual({
      cacheable: false,
      skipReason: 'resp_invalid_directive',
    });
  });

  it('uses s-maxage over max-age for public cache scope', () => {
    const decision = evaluateResponseCacheDecision({
      response: {
        status: 200,
        headers: { 'Cache-Control': 'max-age=10, s-maxage=120' },
        body: { ok: true },
      },
      policy: createPolicy({ scope: 'public' }),
    });

    expect(decision).toEqual({
      cacheable: true,
      ttlSeconds: 120,
    });
  });

  it('does not cache private responses in public scope', () => {
    const decision = evaluateResponseCacheDecision({
      response: {
        status: 200,
        headers: { 'Cache-Control': 'private, max-age=60' },
        body: { ok: true },
      },
      policy: createPolicy({ scope: 'public' }),
    });

    expect(decision).toEqual({
      cacheable: false,
      skipReason: 'resp_private',
    });
  });

  it('does not cache set-cookie responses in public scope', () => {
    const decision = evaluateResponseCacheDecision({
      response: {
        status: 200,
        headers: {
          'Cache-Control': 'max-age=60',
          'Set-Cookie': 'sid=abc',
        },
        body: { ok: true },
      },
      policy: createPolicy({ scope: 'public' }),
    });

    expect(decision).toEqual({
      cacheable: false,
      skipReason: 'resp_set_cookie_shared',
    });
  });

  it('allows set-cookie responses in public scope when explicit auth sharing override is enabled', () => {
    const decision = evaluateResponseCacheDecision({
      response: {
        status: 200,
        headers: {
          'Cache-Control': 'max-age=60',
          'Set-Cookie': 'sid=abc',
        },
        body: { ok: true },
      },
      policy: createPolicy({ scope: 'public', allowSharedWithAuth: true }),
    });

    expect(decision).toEqual({
      cacheable: true,
      ttlSeconds: 60,
    });
  });

  it('does not cache non-revalidated responses with non-positive ttl', () => {
    const decision = evaluateResponseCacheDecision({
      response: {
        status: 200,
        headers: { 'Cache-Control': 'max-age=0' },
        body: { ok: true },
      },
      policy: createPolicy(),
    });

    expect(decision).toEqual({
      cacheable: false,
      skipReason: 'resp_ttl_non_positive',
    });
  });

  it('treats valueless s-maxage and max-age directives as invalid', () => {
    const publicDecision = evaluateResponseCacheDecision({
      response: {
        status: 200,
        headers: { 'Cache-Control': 's-maxage' },
        body: { ok: true },
      },
      policy: createPolicy({ scope: 'public' }),
    });
    expect(publicDecision).toEqual({
      cacheable: false,
      skipReason: 'resp_invalid_directive',
    });

    const privateDecision = evaluateResponseCacheDecision({
      response: {
        status: 200,
        headers: { 'Cache-Control': 'max-age' },
        body: { ok: true },
      },
      policy: createPolicy(),
    });
    expect(privateDecision).toEqual({
      cacheable: false,
      skipReason: 'resp_invalid_directive',
    });
  });

  it('derives ttl from expires/date/age headers', () => {
    const decision = evaluateResponseCacheDecision({
      response: {
        status: 200,
        headers: {
          Expires: 'Tue, 24 Feb 2026 00:05:00 GMT',
          Date: 'Tue, 24 Feb 2026 00:00:00 GMT',
          Age: '60',
        },
        body: { ok: true },
      },
      policy: createPolicy(),
      nowMs: Date.parse('Tue, 24 Feb 2026 00:00:00 GMT'),
    });

    expect(decision).toEqual({
      cacheable: true,
      ttlSeconds: 240,
    });
  });

  it('ignores invalid expires and age headers', () => {
    const invalidExpires = evaluateResponseCacheDecision({
      response: {
        status: 200,
        headers: {
          Expires: 'not-a-date',
          Date: 'Tue, 24 Feb 2026 00:00:00 GMT',
        },
        body: { ok: true },
      },
      policy: createPolicy({ ttlSeconds: 123 }),
    });
    expect(invalidExpires).toEqual({
      cacheable: true,
      ttlSeconds: 123,
    });

    const invalidAge = evaluateResponseCacheDecision({
      response: {
        status: 200,
        headers: {
          Expires: 'Tue, 24 Feb 2026 00:05:00 GMT',
          Date: 'Tue, 24 Feb 2026 00:00:00 GMT',
          Age: 'abc',
        },
        body: { ok: true },
      },
      policy: createPolicy(),
    });
    expect(invalidAge).toEqual({
      cacheable: true,
      ttlSeconds: 300,
    });
  });
});
