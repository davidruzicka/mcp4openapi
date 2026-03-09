import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CachePolicyResolver } from './cache-policy-resolver.js';
import { ConfigurationError } from '../core/errors.js';

describe('CachePolicyResolver', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('defaults scope to public when auth is not configured', () => {
    const policy = CachePolicyResolver.resolve({
      cacheConfig: {},
      hasAuth: false,
    });

    expect(policy.scope).toBe('public');
    expect(policy.backend).toBe('memory');
    expect(policy.allowSharedWithAuth).toBe(false);
    expect(policy.maxMemoryBytes).toBe(64 * 1024 * 1024);
  });

  it('defaults scope to private when auth is configured', () => {
    const policy = CachePolicyResolver.resolve({
      cacheConfig: {},
      hasAuth: true,
    });

    expect(policy.scope).toBe('private');
  });

  it('uses max_memory_bytes_from_env when provided', () => {
    process.env.CUSTOM_CACHE_LIMIT = '4096';

    const policy = CachePolicyResolver.resolve({
      cacheConfig: {
        max_memory_bytes: 1024,
        max_memory_bytes_from_env: 'CUSTOM_CACHE_LIMIT',
      },
      hasAuth: false,
    });

    expect(policy.maxMemoryBytes).toBe(4096);
  });

  it('preserves explicit allow_shared_with_auth override', () => {
    const policy = CachePolicyResolver.resolve({
      cacheConfig: {
        scope: 'public',
        allow_shared_with_auth: true,
      },
      hasAuth: true,
    });

    expect(policy.scope).toBe('public');
    expect(policy.allowSharedWithAuth).toBe(true);
  });

  it('throws on invalid max_memory_bytes_from_env value', () => {
    process.env.CUSTOM_CACHE_LIMIT = 'invalid';

    let error: Error | undefined;
    try {
      CachePolicyResolver.resolve({
        cacheConfig: {
          max_memory_bytes_from_env: 'CUSTOM_CACHE_LIMIT',
        },
        hasAuth: false,
      });
    } catch (e) {
      error = e as Error;
    }
    expect(error).toBeInstanceOf(ConfigurationError);
    expect(error?.message).not.toContain('invalid');
  });

  it('throws on partially numeric max_memory_bytes_from_env value', () => {
    process.env.CUSTOM_CACHE_LIMIT = '4096mb';

    expect(() => CachePolicyResolver.resolve({
      cacheConfig: {
        max_memory_bytes_from_env: 'CUSTOM_CACHE_LIMIT',
      },
      hasAuth: false,
    })).toThrow(ConfigurationError);
  });

  it('throws on out-of-range max_memory_bytes_from_env value', () => {
    process.env.CUSTOM_CACHE_LIMIT = '9007199254740992';

    expect(() => CachePolicyResolver.resolve({
      cacheConfig: {
        max_memory_bytes_from_env: 'CUSTOM_CACHE_LIMIT',
      },
      hasAuth: false,
    })).toThrow(ConfigurationError);
  });
});
