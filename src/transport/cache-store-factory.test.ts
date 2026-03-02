import { describe, it, expect } from 'vitest';
import { CacheStoreFactory } from './cache-store-factory.js';
import type { CachePolicy } from './cache-store.js';
import { ConfigurationError } from '../core/errors.js';

const basePolicy: CachePolicy = {
  backend: 'memory',
  scope: 'public',
  allowSharedWithAuth: false,
  ttlSeconds: 60,
  methods: new Set(['GET']),
  varyHeaders: new Set(['accept']),
  maxEntries: 10,
  maxMemoryBytes: 10_000,
};

describe('CacheStoreFactory', () => {
  it('creates memory cache store', () => {
    const store = CacheStoreFactory.create(basePolicy);

    store.set('k', { status: 200, headers: {}, body: { ok: true } }, 60);
    expect(store.get('k')).toBeDefined();
  });

  it('throws for redis backend placeholder', () => {
    expect(() => {
      CacheStoreFactory.create({ ...basePolicy, backend: 'redis' });
    }).toThrow(ConfigurationError);
  });

  it('throws for unsupported backend key at runtime', () => {
    expect(() => {
      CacheStoreFactory.create({ ...basePolicy, backend: 'unknown' as any });
    }).toThrow('Unsupported cache backend: unknown');
  });
});
