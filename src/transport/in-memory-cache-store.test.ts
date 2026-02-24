import { describe, it, expect } from 'vitest';
import { ValidationError } from '../core/errors.js';
import { InMemoryCacheStore } from './in-memory-cache-store.js';
import type { ResponseContext } from './interceptors.js';

function createResponse(payload: string): ResponseContext {
  return {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: { payload },
  };
}

describe('InMemoryCacheStore', () => {
  it('stores and returns cached responses', () => {
    const store = new InMemoryCacheStore({ maxEntries: 10, maxMemoryBytes: 10_000 });

    store.set('key-a', createResponse('hello'), 60, 0);

    const cached = store.get('key-a', 0);
    expect(cached?.body).toEqual({ payload: 'hello' });
    expect(store.getStats().entries).toBe(1);
  });

  it('expires entries by TTL', () => {
    const store = new InMemoryCacheStore({ maxEntries: 10, maxMemoryBytes: 10_000 });

    store.set('key-a', createResponse('hello'), 1, 0);

    expect(store.get('key-a', 999)).toBeDefined();
    expect(store.get('key-a', 1_001)).toBeUndefined();
  });

  it('evicts oldest entries when maxEntries is exceeded', () => {
    const store = new InMemoryCacheStore({ maxEntries: 1, maxMemoryBytes: 10_000 });

    store.set('key-a', createResponse('a'), 60, 0);
    store.set('key-b', createResponse('b'), 60, 0);

    expect(store.get('key-a', 0)).toBeUndefined();
    expect(store.get('key-b', 0)).toBeDefined();
    expect(store.getStats().entries).toBe(1);
  });

  it('evicts oldest entries when memory budget is exceeded', () => {
    const responseA = createResponse('a'.repeat(256));
    const responseB = createResponse('b'.repeat(256));

    const probeStore = new InMemoryCacheStore({ maxEntries: 10, maxMemoryBytes: 100_000 });
    probeStore.set('key-a', responseA, 60, 0);
    const firstEntryBytes = probeStore.getStats().memoryBytes;

    const store = new InMemoryCacheStore({
      maxEntries: 10,
      maxMemoryBytes: firstEntryBytes + 16,
    });

    store.set('key-a', responseA, 60, 0);
    store.set('key-b', responseB, 60, 0);

    expect(store.get('key-a', 0)).toBeUndefined();
    expect(store.get('key-b', 0)).toBeDefined();
    expect(store.getStats().memoryBytes).toBeLessThanOrEqual(firstEntryBytes + 16);
  });

  it('rejects entries larger than maxMemoryBytes', () => {
    const store = new InMemoryCacheStore({ maxEntries: 10, maxMemoryBytes: 300 });

    expect(() => {
      store.set('too-big', createResponse('x'.repeat(5_000)), 60, 0);
    }).toThrow(ValidationError);
  });

  it('rejects invalid config values', () => {
    expect(() => new InMemoryCacheStore({ maxEntries: 0, maxMemoryBytes: 1000 })).toThrow(ValidationError);
    expect(() => new InMemoryCacheStore({ maxEntries: 10, maxMemoryBytes: 0 })).toThrow(ValidationError);
  });

  it('ignores writes with non-positive ttl', () => {
    const store = new InMemoryCacheStore({ maxEntries: 10, maxMemoryBytes: 10_000 });

    store.set('key-a', createResponse('hello'), 0, 0);

    expect(store.get('key-a', 0)).toBeUndefined();
  });

  it('returns false when deleting missing key', () => {
    const store = new InMemoryCacheStore({ maxEntries: 10, maxMemoryBytes: 10_000 });
    expect(store.delete('missing')).toBe(false);
  });

  it('removes expired entries during set sweep', () => {
    const store = new InMemoryCacheStore({ maxEntries: 10, maxMemoryBytes: 50_000 });
    store.set('stale', createResponse('a'), 1, 0);

    store.set('fresh', createResponse('b'), 60, 2_000);

    expect(store.get('stale', 2_000)).toBeUndefined();
    expect(store.get('fresh', 2_000)).toBeDefined();
  });

  it('falls back to default size estimate when JSON serialization fails', () => {
    const store = new InMemoryCacheStore({ maxEntries: 10, maxMemoryBytes: 50_000 });
    const originalStringify = JSON.stringify;

    JSON.stringify = (() => {
      throw new Error('boom');
    }) as unknown as typeof JSON.stringify;

    try {
      store.set('key-a', createResponse('hello'), 60, 0);
      expect(store.get('key-a', 0)).toBeDefined();
    } finally {
      JSON.stringify = originalStringify;
    }
  });

  it('breaks eviction loop safely when accounting is inconsistent', () => {
    const store = new InMemoryCacheStore({ maxEntries: 10, maxMemoryBytes: 1_000 });

    // Simulate corrupted memory accounting to exercise defensive break path.
    (store as any).memoryBytes = 2_000;
    (store as any).evictUntilWithinBudget();

    expect(store.getStats().entries).toBe(0);
  });
});
