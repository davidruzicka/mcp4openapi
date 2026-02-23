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
});
