import type { CachePolicy, CacheScope } from './cache-store.js';
import type { CacheConfig } from '../types/profile.js';
import { ConfigurationError } from '../core/errors.js';

const DEFAULT_CACHE_TTL_SECONDS = 300;
const DEFAULT_CACHE_MAX_ENTRIES = 1000;
const DEFAULT_CACHE_MAX_MEMORY_BYTES = 64 * 1024 * 1024;
const DEFAULT_CACHE_METHODS = ['GET'] as const;
const DEFAULT_CACHE_VARY_HEADERS = ['accept', 'accept-language'];

export interface CachePolicyResolverInput {
  cacheConfig: CacheConfig;
  hasAuth: boolean;
}

export class CachePolicyResolver {
  static resolve(input: CachePolicyResolverInput): CachePolicy {
    const { cacheConfig, hasAuth } = input;

    const maxMemoryBytes = this.resolveMaxMemoryBytes(cacheConfig);
    const backend = cacheConfig.backend || 'memory';

    return {
      backend,
      scope: this.resolveScope(cacheConfig.scope, hasAuth),
      ttlSeconds: cacheConfig.ttl_seconds ?? DEFAULT_CACHE_TTL_SECONDS,
      methods: new Set((cacheConfig.methods ?? [...DEFAULT_CACHE_METHODS]).map((method) => method.toUpperCase())),
      varyHeaders: new Set((cacheConfig.vary_headers ?? DEFAULT_CACHE_VARY_HEADERS).map((header) => header.toLowerCase())),
      maxEntries: cacheConfig.max_entries ?? DEFAULT_CACHE_MAX_ENTRIES,
      maxMemoryBytes,
    };
  }

  private static resolveScope(scope: CacheScope | undefined, hasAuth: boolean): Exclude<CacheScope, 'auto'> {
    if (!scope || scope === 'auto') {
      return hasAuth ? 'private' : 'public';
    }

    return scope;
  }

  private static resolveMaxMemoryBytes(cacheConfig: CacheConfig): number {
    const envVar = cacheConfig.max_memory_bytes_from_env;
    if (envVar) {
      const rawValue = process.env[envVar];
      if (rawValue !== undefined) {
        const trimmedValue = rawValue.trim();
        if (!/^[0-9]+$/.test(trimmedValue)) {
          throw new ConfigurationError(
            `Invalid ${envVar}: '${rawValue}' (must be positive integer for cache max_memory_bytes)`
          );
        }

        const parsed = Number(trimmedValue);
        if (!Number.isSafeInteger(parsed) || parsed <= 0) {
          throw new ConfigurationError(
            `Invalid ${envVar}: '${rawValue}' (must be positive integer for cache max_memory_bytes)`
          );
        }
        return parsed;
      }
    }

    return cacheConfig.max_memory_bytes ?? DEFAULT_CACHE_MAX_MEMORY_BYTES;
  }
}
