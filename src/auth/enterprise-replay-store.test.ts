import { describe, expect, it, vi } from 'vitest';
import { EnterpriseReplayStore } from './enterprise-replay-store.js';

describe('enterprise-replay-store', () => {
  it('rejects replayed jti values', () => {
    const store = new EnterpriseReplayStore({ maxEntries: 2 });
    store.register({ jti: 'one', assertion: 'a', ttlSeconds: 60, issuer: 'https://issuer.example' });
    expect(() => store.register({ jti: 'one', assertion: 'b', ttlSeconds: 60, issuer: 'https://issuer.example' })).toThrow('replay-detected');
  });

  it('uses assertion digest when jti is missing', () => {
    const store = new EnterpriseReplayStore({ maxEntries: 2 });

    const key = store.register({ assertion: 'assertion-a', ttlSeconds: 60, issuer: 'https://issuer.example' });

    expect(key).toBeTruthy();
    expect(() => store.register({ assertion: 'assertion-a', ttlSeconds: 60, issuer: 'https://issuer.example' })).toThrow('replay-detected');
  });

  it('evicts expired entries before new registrations', () => {
    const nowSpy = vi.spyOn(Date, 'now');
    nowSpy.mockReturnValue(1_000_000);
    const store = new EnterpriseReplayStore({ maxEntries: 2 });
    store.register({ jti: 'expired', assertion: 'a', ttlSeconds: 1, issuer: 'https://issuer.example' });

    nowSpy.mockReturnValue(1_002_000);
    store.register({ jti: 'fresh', assertion: 'b', ttlSeconds: 60, issuer: 'https://issuer.example' });

    expect(store.size()).toBe(1);
  });

  it('evicts oldest entries when bounded capacity is exceeded', () => {
    const store = new EnterpriseReplayStore({ maxEntries: 1 });
    store.register({ jti: 'one', assertion: 'a', ttlSeconds: 60, issuer: 'https://issuer.example' });
    store.register({ jti: 'two', assertion: 'b', ttlSeconds: 60, issuer: 'https://issuer.example' });
    expect(store.size()).toBe(1);
  });

  it('stops overflow eviction cleanly even when configured with a negative capacity', () => {
    const store = new EnterpriseReplayStore({ maxEntries: -1 });

    store.register({ jti: 'one', assertion: 'a', ttlSeconds: 60, issuer: 'https://issuer.example' });

    expect(store.size()).toBe(0);
  });
});
