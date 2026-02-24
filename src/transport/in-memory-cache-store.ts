import { ValidationError } from '../core/errors.js';
import type { ResponseContext } from './interceptors.js';
import type { CacheEvictionReason, CacheStore } from './cache-store.js';

export interface InMemoryCacheStoreConfig {
  maxEntries: number;
  maxMemoryBytes: number;
  onEvict?: (reason: CacheEvictionReason) => void;
}

interface CacheEntry {
  response: ResponseContext;
  expiresAtMs: number;
  sizeBytes: number;
}

export interface InMemoryCacheStoreStats {
  entries: number;
  maxEntries: number;
  memoryBytes: number;
  maxMemoryBytes: number;
}

/**
 * In-memory LRU cache with TTL and memory budget guardrails.
 *
 * Why this exists: plain Map-based caches can grow without bound and exhaust memory.
 */
export class InMemoryCacheStore implements CacheStore {
  private entries = new Map<string, CacheEntry>();
  private memoryBytes = 0;

  constructor(private readonly config: InMemoryCacheStoreConfig) {
    if (!Number.isInteger(config.maxEntries) || config.maxEntries <= 0) {
      throw new ValidationError('cache.max_entries must be a positive integer', {
        maxEntries: config.maxEntries,
      });
    }

    if (!Number.isInteger(config.maxMemoryBytes) || config.maxMemoryBytes <= 0) {
      throw new ValidationError('cache.max_memory_bytes must be a positive integer', {
        maxMemoryBytes: config.maxMemoryBytes,
      });
    }
  }

  get(key: string, nowMs = Date.now()): ResponseContext | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      return undefined;
    }

    if (entry.expiresAtMs <= nowMs) {
      this.delete(key);
      return undefined;
    }

    this.touch(key, entry);
    return structuredClone(entry.response);
  }

  set(key: string, response: ResponseContext, ttlSeconds: number, nowMs = Date.now()): void {
    if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
      return;
    }

    const expiresAtMs = nowMs + ttlSeconds * 1000;
    const nextEntry: CacheEntry = {
      response: structuredClone(response),
      expiresAtMs,
      sizeBytes: this.estimateEntrySize(key, response, expiresAtMs),
    };

    if (nextEntry.sizeBytes > this.config.maxMemoryBytes) {
      throw new ValidationError('Response is too large for cache.max_memory_bytes budget', {
        key,
        entrySizeBytes: nextEntry.sizeBytes,
        maxMemoryBytes: this.config.maxMemoryBytes,
      });
    }

    const existing = this.entries.get(key);
    if (existing) {
      this.removeEntry(key, existing);
    }

    this.removeExpired(nowMs);

    this.entries.set(key, nextEntry);
    this.memoryBytes += nextEntry.sizeBytes;

    this.evictUntilWithinBudget();
  }

  delete(key: string): boolean {
    const entry = this.entries.get(key);
    if (!entry) {
      return false;
    }

    this.removeEntry(key, entry);
    return true;
  }

  clear(): void {
    this.entries.clear();
    this.memoryBytes = 0;
  }

  getStats(): InMemoryCacheStoreStats {
    return {
      entries: this.entries.size,
      maxEntries: this.config.maxEntries,
      memoryBytes: this.memoryBytes,
      maxMemoryBytes: this.config.maxMemoryBytes,
    };
  }

  private touch(key: string, entry: CacheEntry): void {
    this.entries.delete(key);
    this.entries.set(key, entry);
  }

  private removeExpired(nowMs: number): void {
    for (const [key, entry] of this.entries.entries()) {
      if (entry.expiresAtMs <= nowMs) {
        this.removeEntry(key, entry);
      }
    }
  }

  private evictUntilWithinBudget(): void {
    while (
      this.entries.size > this.config.maxEntries ||
      this.memoryBytes > this.config.maxMemoryBytes
    ) {
      const reason: CacheEvictionReason = this.entries.size > this.config.maxEntries
        ? 'max_entries'
        : 'max_memory';
      const oldest = this.entries.entries().next().value as [string, CacheEntry] | undefined;
      if (!oldest) {
        break;
      }
      this.removeEntry(oldest[0], oldest[1]);
      this.config.onEvict?.(reason);
    }
  }

  private removeEntry(key: string, entry: CacheEntry): void {
    this.entries.delete(key);
    this.memoryBytes = Math.max(0, this.memoryBytes - entry.sizeBytes);
  }

  private estimateEntrySize(key: string, response: ResponseContext, expiresAtMs: number): number {
    try {
      return Buffer.byteLength(
        JSON.stringify({
          key,
          response,
          expiresAtMs,
        }),
        'utf8'
      );
    } catch {
      return Buffer.byteLength(key, 'utf8') + 1024;
    }
  }
}
