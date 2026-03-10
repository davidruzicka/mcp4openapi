import { describe, expect, it } from 'vitest';
import { EnterpriseReplayStore } from './enterprise-replay-store.js';

describe('enterprise-replay-store', () => {
  it('rejects replayed jti values', () => {
    const store = new EnterpriseReplayStore({ maxEntries: 2 });
    store.register({ jti: 'one', assertion: 'a', ttlSeconds: 60, issuer: 'https://issuer.example' });
    expect(() => store.register({ jti: 'one', assertion: 'b', ttlSeconds: 60, issuer: 'https://issuer.example' })).toThrow('replay-detected');
  });

  it('evicts oldest entries when bounded capacity is exceeded', () => {
    const store = new EnterpriseReplayStore({ maxEntries: 1 });
    store.register({ jti: 'one', assertion: 'a', ttlSeconds: 60, issuer: 'https://issuer.example' });
    store.register({ jti: 'two', assertion: 'b', ttlSeconds: 60, issuer: 'https://issuer.example' });
    expect(store.size()).toBe(1);
  });
});
