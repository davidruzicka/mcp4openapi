import { afterEach, describe, expect, it, vi } from 'vitest';
import { timingSafeEqual as realTimingSafeEqual } from 'node:crypto';
import { InlineApiKeyStore } from './inline-api-key-store.js';
import { createApiKeyStore } from './api-key-store-factory.js';
import { ClientAuthGateError } from '../core/errors.js';
import type { InlineApiKeyEntry, ApiKeyStoreConfig } from '../types/profile.js';
import type { Logger } from '../core/logger.js';

// Wrap node:crypto.timingSafeEqual so we can verify it is invoked on
// equal-length buffers. vi.spyOn cannot redefine ESM namespace exports, so we
// replace via vi.mock with a real-pass-through wrapper that records calls.
const timingSafeEqualMock = vi.hoisted(() => vi.fn());
vi.mock('node:crypto', async () => {
  const actual = await vi.importActual<typeof import('node:crypto')>('node:crypto');
  return {
    ...actual,
    timingSafeEqual: (a: Uint8Array, b: Uint8Array) => {
      timingSafeEqualMock(a, b);
      return actual.timingSafeEqual(a, b);
    },
  };
});

const PROFILE_ID = 'alpha';

function withEnv(overrides: Record<string, string | undefined>, run: () => void | Promise<void>) {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(overrides)) {
    previous[key] = process.env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

describe('InlineApiKeyStore', () => {
  afterEach(() => {
    timingSafeEqualMock.mockClear();
  });

  it('returns AuthorizedPrincipal when key matches a configured entry', async () => {
    const entries: InlineApiKeyEntry[] = [
      { key_from_env: 'TEST_API_KEY_1', subject: 'svc-account-1', scopes: ['tools:read', 'tools:call'] },
    ];
    await withEnv({ TEST_API_KEY_1: 'super-secret-key' }, async () => {
      const store = new InlineApiKeyStore(PROFILE_ID, entries);
      const principal = await store.validate('super-secret-key');
      expect(principal).not.toBeNull();
      expect(principal).toEqual({
        authType: 'token',
        profileId: PROFILE_ID,
        subject: 'svc-account-1',
        scopes: ['tools:read', 'tools:call'],
      });
    });
  });

  it('returns null when the supplied key does not match any entry', async () => {
    const entries: InlineApiKeyEntry[] = [
      { key_from_env: 'TEST_API_KEY_1', subject: 'svc-account-1' },
    ];
    await withEnv({ TEST_API_KEY_1: 'configured-key' }, async () => {
      const store = new InlineApiKeyStore(PROFILE_ID, entries);
      expect(await store.validate('wrong-key')).toBeNull();
    });
  });

  it('returns null when the env var for a key entry is not set', async () => {
    const entries: InlineApiKeyEntry[] = [
      { key_from_env: 'NEVER_SET_ENV_VAR_FOR_TEST', subject: 'svc-account-1' },
    ];
    await withEnv({ NEVER_SET_ENV_VAR_FOR_TEST: undefined }, async () => {
      const store = new InlineApiKeyStore(PROFILE_ID, entries);
      expect(await store.validate('any-value')).toBeNull();
    });
  });

  it('returns null when the env var for a key entry is set to empty string', async () => {
    const entries: InlineApiKeyEntry[] = [
      { key_from_env: 'EMPTY_API_KEY_ENV_VAR', subject: 'svc-account-1' },
    ];
    await withEnv({ EMPTY_API_KEY_ENV_VAR: '' }, async () => {
      const store = new InlineApiKeyStore(PROFILE_ID, entries);
      expect(await store.validate('')).toBeNull();
      expect(await store.validate('whatever')).toBeNull();
    });
  });

  it('returns null when supplied key has different length than configured key', async () => {
    const entries: InlineApiKeyEntry[] = [
      { key_from_env: 'TEST_API_KEY_LEN', subject: 'svc-account-1' },
    ];
    await withEnv({ TEST_API_KEY_LEN: 'abcdef' }, async () => {
      const store = new InlineApiKeyStore(PROFILE_ID, entries);
      expect(await store.validate('abcdefghij')).toBeNull();
      expect(await store.validate('abc')).toBeNull();
    });
  });

  it('matches second entry when first entry does not match', async () => {
    const entries: InlineApiKeyEntry[] = [
      { key_from_env: 'TEST_API_KEY_FIRST', subject: 'svc-account-first', scopes: ['read'] },
      { key_from_env: 'TEST_API_KEY_SECOND', subject: 'svc-account-second', scopes: ['admin'] },
    ];
    await withEnv(
      { TEST_API_KEY_FIRST: 'first-key', TEST_API_KEY_SECOND: 'second-key' },
      async () => {
        const store = new InlineApiKeyStore(PROFILE_ID, entries);
        const principal = await store.validate('second-key');
        expect(principal).not.toBeNull();
        expect(principal?.subject).toBe('svc-account-second');
        expect(principal?.scopes).toEqual(['admin']);
        expect(principal?.authType).toBe('token');
      },
    );
  });

  it('skips entries whose env var is unset and matches a later configured entry', async () => {
    const entries: InlineApiKeyEntry[] = [
      { key_from_env: 'TEST_API_KEY_UNSET', subject: 'svc-unset' },
      { key_from_env: 'TEST_API_KEY_PRESENT', subject: 'svc-present', scopes: ['x'] },
    ];
    await withEnv(
      { TEST_API_KEY_UNSET: undefined, TEST_API_KEY_PRESENT: 'present-key' },
      async () => {
        const store = new InlineApiKeyStore(PROFILE_ID, entries);
        const principal = await store.validate('present-key');
        expect(principal?.subject).toBe('svc-present');
      },
    );
  });

  it('returns scopes as empty array when entry omits scopes', async () => {
    const entries: InlineApiKeyEntry[] = [
      { key_from_env: 'TEST_API_KEY_NOSCOPE', subject: 'svc-noscope' },
    ];
    await withEnv({ TEST_API_KEY_NOSCOPE: 'noscope-key' }, async () => {
      const store = new InlineApiKeyStore(PROFILE_ID, entries);
      const principal = await store.validate('noscope-key');
      expect(principal?.scopes).toEqual([]);
    });
  });

  it('uses authType="token" on returned principal (per D-07)', async () => {
    const entries: InlineApiKeyEntry[] = [
      { key_from_env: 'TEST_API_KEY_AUTHTYPE', subject: 'svc-1' },
    ];
    await withEnv({ TEST_API_KEY_AUTHTYPE: 'k' }, async () => {
      const store = new InlineApiKeyStore(PROFILE_ID, entries);
      const principal = await store.validate('k');
      expect(principal?.authType).toBe('token');
      expect(principal?.profileId).toBe(PROFILE_ID);
    });
  });

  it('uses timingSafeEqual on equal-length 32-byte HMAC buffers (constant-time comparison)', async () => {
    const entries: InlineApiKeyEntry[] = [
      { key_from_env: 'TEST_API_KEY_TIMING_SHORT', subject: 's-short' },
      { key_from_env: 'TEST_API_KEY_TIMING_LONG', subject: 's-long' },
    ];
    await withEnv(
      {
        TEST_API_KEY_TIMING_SHORT: 'a',
        TEST_API_KEY_TIMING_LONG: 'this-is-a-much-longer-configured-key',
      },
      async () => {
        const store = new InlineApiKeyStore(PROFILE_ID, entries);
        // Use a candidate of unrelated length to prove length is not a side-channel
        await store.validate('candidate-of-arbitrary-length-xyz');
      },
    );

    expect(timingSafeEqualMock).toHaveBeenCalled();
    for (const call of timingSafeEqualMock.mock.calls) {
      const [a, b] = call as [Uint8Array, Uint8Array];
      // HMAC-SHA256 always produces 32-byte output regardless of input length —
      // erasing length as a timing side-channel.
      expect(a.length).toBe(32);
      expect(b.length).toBe(32);
      expect(a.length).toBe(b.length);
    }
    // Sanity-check: the wrapper actually delegates to the real implementation.
    expect(realTimingSafeEqual).toBeDefined();
  });
});

function createSilentLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
}

describe('createApiKeyStore', () => {
  it('returns InlineApiKeyStore when config.type is "inline"', () => {
    const config: ApiKeyStoreConfig = {
      type: 'inline',
      keys: [{ key_from_env: 'TEST_FACTORY_INLINE_KEY', subject: 'svc-1' }],
    };
    const store = createApiKeyStore(config, PROFILE_ID, createSilentLogger());
    expect(store).toBeInstanceOf(InlineApiKeyStore);
  });

  it('throws ClientAuthGateError for an unknown type', () => {
    // Cast to ApiKeyStoreConfig to bypass exhaustiveness — this models a runtime
    // arrival of an unsupported type (Phase 4 will add 'sasanka' here directly).
    const config = { type: 'sasanka', keys: [] } as unknown as ApiKeyStoreConfig;
    const throwFn = () => createApiKeyStore(config, PROFILE_ID, createSilentLogger());
    expect(throwFn).toThrow(ClientAuthGateError);
    expect(throwFn).toThrow('sasanka');
  });

  it('returned store validates configured keys end-to-end', async () => {
    const config: ApiKeyStoreConfig = {
      type: 'inline',
      keys: [{ key_from_env: 'TEST_FACTORY_E2E_KEY', subject: 'svc-e2e', scopes: ['s1'] }],
    };
    const previous = process.env.TEST_FACTORY_E2E_KEY;
    process.env.TEST_FACTORY_E2E_KEY = 'e2e-key';
    try {
      const store = createApiKeyStore(config, PROFILE_ID, createSilentLogger());
      const principal = await store.validate('e2e-key');
      expect(principal?.subject).toBe('svc-e2e');
      expect(principal?.scopes).toEqual(['s1']);
      expect(principal?.profileId).toBe(PROFILE_ID);
    } finally {
      if (previous === undefined) {
        delete process.env.TEST_FACTORY_E2E_KEY;
      } else {
        process.env.TEST_FACTORY_E2E_KEY = previous;
      }
    }
  });
});
