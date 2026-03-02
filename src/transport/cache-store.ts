import type { ResponseContext } from './interceptors.js';

export type CacheBackend = 'memory' | 'redis';
export type CacheScope = 'auto' | 'public' | 'private' | 'session';

export type CacheEvictionReason = 'max_entries' | 'max_memory';

export interface CachePolicy {
  backend: CacheBackend;
  scope: Exclude<CacheScope, 'auto'>;
  allowSharedWithAuth: boolean;
  ttlSeconds: number;
  methods: Set<string>;
  varyHeaders: Set<string>;
  maxEntries: number;
  maxMemoryBytes: number;
}

export interface CacheStore {
  get(key: string, nowMs?: number): ResponseContext | undefined;
  set(key: string, response: ResponseContext, ttlSeconds: number, nowMs?: number): void;
  delete(key: string): boolean;
  clear(): void;
}

export interface CacheStoreFactoryOptions {
  onEvict?: (reason: CacheEvictionReason) => void;
}
