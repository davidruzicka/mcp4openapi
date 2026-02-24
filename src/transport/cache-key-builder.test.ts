import { describe, it, expect } from 'vitest';
import { CacheKeyBuilder } from './cache-key-builder.js';
import type { CachePolicy } from './cache-store.js';
import type { RequestContext } from './interceptors.js';

const basePolicy: CachePolicy = {
  backend: 'memory',
  scope: 'private',
  ttlSeconds: 300,
  methods: new Set(['GET']),
  varyHeaders: new Set(['accept']),
  maxEntries: 100,
  maxMemoryBytes: 1024 * 1024,
};

function buildContext(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    method: 'GET',
    url: 'https://api.example.com/items?b=2&a=1',
    headers: {
      accept: 'application/json',
      authorization: 'Bearer token-a',
    },
    ...overrides,
  };
}

describe('CacheKeyBuilder', () => {
  it('normalizes query order for deterministic key generation', () => {
    const builder = new CacheKeyBuilder(basePolicy, new Set(['authorization']), 'session-1');

    const keyA = builder.build(buildContext({ url: 'https://api.example.com/items?b=2&a=1' }));
    const keyB = builder.build(buildContext({ url: 'https://api.example.com/items?a=1&b=2' }));

    expect(keyA).toBe(keyB);
  });

  it('preserves order of duplicate query parameters in cache keys', () => {
    const builder = new CacheKeyBuilder(basePolicy, new Set(['authorization']), 'session-1');

    const keyA = builder.build(buildContext({ url: 'https://api.example.com/items?sort=created_at&sort=id' }));
    const keyB = builder.build(buildContext({ url: 'https://api.example.com/items?sort=id&sort=created_at' }));

    expect(keyA).not.toBe(keyB);
  });

  it('partitions private scope by sensitive auth headers', () => {
    const builder = new CacheKeyBuilder(basePolicy, new Set(['authorization']), 'session-1');

    const keyA = builder.build(buildContext({ headers: { accept: 'application/json', authorization: 'Bearer token-a' } }));
    const keyB = builder.build(buildContext({ headers: { accept: 'application/json', authorization: 'Bearer token-b' } }));

    expect(keyA).not.toBe(keyB);
  });

  it('partitions session scope by session id', () => {
    const sessionPolicy: CachePolicy = { ...basePolicy, scope: 'session' };
    const builderA = new CacheKeyBuilder(sessionPolicy, new Set(['authorization']), 'session-a');
    const builderB = new CacheKeyBuilder(sessionPolicy, new Set(['authorization']), 'session-b');

    const context = buildContext();
    expect(builderA.build(context)).not.toBe(builderB.build(context));
  });

  it('shares keys in public scope when request is the same', () => {
    const publicPolicy: CachePolicy = { ...basePolicy, scope: 'public' };
    const builder = new CacheKeyBuilder(publicPolicy, new Set(['authorization']), 'session-1');

    const keyA = builder.build(buildContext());
    const keyB = builder.build(buildContext());

    expect(keyA).toBe(keyB);
  });

  it('sorts multiple vary and sensitive headers deterministically', () => {
    const policy: CachePolicy = {
      ...basePolicy,
      varyHeaders: new Set(['accept', 'accept-language']),
    };
    const builder = new CacheKeyBuilder(policy, new Set(['authorization', 'x-api-key']), 'session-1');

    const keyA = builder.build(buildContext({
      headers: {
        'x-api-key': 'k1',
        authorization: 'Bearer token',
        'accept-language': 'en',
        accept: 'application/json',
      },
    }));

    const keyB = builder.build(buildContext({
      headers: {
        accept: 'application/json',
        'accept-language': 'en',
        authorization: 'Bearer token',
        'x-api-key': 'k1',
      },
    }));

    expect(keyA).toBe(keyB);
  });
});
