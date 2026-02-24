import { describe, expect, it, vi } from 'vitest';
import type { CachePolicy, CacheStore } from './cache-store.js';
import type { RequestContext, ResponseContext } from './interceptors.js';
import { ResponseCacheInterceptor } from './response-cache-interceptor.js';

const basePolicy: CachePolicy = {
  backend: 'memory',
  scope: 'private',
  ttlSeconds: 300,
  methods: new Set(['GET']),
  varyHeaders: new Set(['accept']),
  maxEntries: 100,
  maxMemoryBytes: 1024 * 1024,
};

function createStore(overrides: Partial<CacheStore> = {}): CacheStore {
  return {
    get: () => undefined,
    set: () => {},
    delete: () => false,
    clear: () => {},
    ...overrides,
  };
}

function createCtx(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    method: 'GET',
    url: 'https://api.example.com/items',
    headers: {},
    operationId: 'listItems',
    ...overrides,
  };
}

function createResponse(overrides: Partial<ResponseContext> = {}): ResponseContext {
  return {
    status: 200,
    headers: { 'cache-control': 'max-age=60' },
    body: { ok: true },
    ...overrides,
  };
}

describe('ResponseCacheInterceptor', () => {
  it('returns revalidation miss response when conditional request returns non-304', async () => {
    const cached = createResponse({
      headers: {
        'cache-control': 'no-cache, max-age=0',
        etag: '"v1"',
      },
      body: { value: 'cached' },
    });
    const store = createStore({
      get: () => cached,
      set: vi.fn(),
    });
    const events: string[] = [];
    const interceptor = new ResponseCacheInterceptor(
      basePolicy,
      store,
      { build: () => 'k1' } as any,
      new Set(['authorization']),
      (event) => events.push(event)
    );

    const result = await interceptor.asInterceptor()(createCtx(), async () => createResponse({
      status: 200,
      headers: { 'cache-control': 'max-age=10' },
      body: { value: 'origin' },
    }));

    expect(result.body).toEqual({ value: 'origin' });
    expect(events).toContain('revalidate_miss');
  });

  it('emits skip when cache store write throws', async () => {
    const store = createStore({
      get: () => undefined,
      set: () => {
        throw new Error('write failed');
      },
    });
    const events: string[] = [];
    const interceptor = new ResponseCacheInterceptor(
      basePolicy,
      store,
      { build: () => 'k1' } as any,
      new Set(['authorization']),
      (event) => events.push(event)
    );

    await interceptor.asInterceptor()(createCtx(), async () => createResponse());

    expect(events).toContain('skip');
  });

  it('does not clear cache for unsafe mutation with non-success response', async () => {
    const clearSpy = vi.fn();
    const store = createStore({
      clear: clearSpy,
    });
    const events: string[] = [];
    const interceptor = new ResponseCacheInterceptor(
      { ...basePolicy, methods: new Set(['GET', 'POST']) },
      store,
      { build: () => 'k1' } as any,
      new Set(['authorization']),
      (event) => events.push(event)
    );

    await interceptor.asInterceptor()(
      createCtx({ method: 'POST', body: { change: true } }),
      async () => createResponse({ status: 500 })
    );

    expect(clearSpy).not.toHaveBeenCalled();
    expect(events).not.toContain('invalidate_unsafe_method');
  });

  it('falls back to generic skip event for unknown skip reason mapping', () => {
    const interceptor = new ResponseCacheInterceptor(
      basePolicy,
      createStore(),
      { build: () => 'k1' } as any,
      new Set(['authorization']),
      vi.fn()
    );
    const eventSpy = vi.fn();
    (interceptor as any).onEvent = eventSpy;

    (interceptor as any).recordSkipReason('unknown_reason', 'listItems');

    expect(eventSpy).toHaveBeenCalledWith('skip', 'listItems');
  });
});
