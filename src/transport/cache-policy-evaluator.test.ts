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

  it('rejects request caching for pragma: no-cache', () => {
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
      canReadFromCache: false,
      canStoreResponse: false,
      skipReason: 'req_pragma_no_cache',
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
});

describe('cache-policy-evaluator response decisions', () => {
  it('does not cache response cache-control: no-cache', () => {
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
});
