import { describe, expect, it, vi } from 'vitest';
import { InboundAuthTokenStore } from './inbound-auth-token-store.js';
import type { AuthorizedPrincipal } from './inbound-auth-principal.js';

function createPrincipal(overrides?: Partial<AuthorizedPrincipal>): AuthorizedPrincipal {
  return {
    authType: 'enterprise',
    profileId: 'alpha',
    subject: 'user-1',
    scopes: ['api'],
    ...overrides,
  };
}

describe('InboundAuthTokenStore', () => {
  it('stores and retrieves active records', () => {
    const store = new InboundAuthTokenStore({ maxTokens: 2 });
    const record = store.store('token-1', createPrincipal({ expiresAt: Date.now() + 5_000 }));

    expect(store.get('token-1')).toEqual(record);
    expect(store.size()).toBe(1);
  });

  it('drops expired records on read and before storing new tokens', () => {
    const now = 1_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const store = new InboundAuthTokenStore({ maxTokens: 2 });
    store.store('expired', createPrincipal({ expiresAt: now - 1 }));

    expect(store.get('expired')).toBeUndefined();
    expect(store.size()).toBe(0);

    store.store('fresh', createPrincipal({ expiresAt: now + 100 }));
    expect(store.size()).toBe(1);
  });

  it('evicts the oldest token when capacity is exceeded', () => {
    const store = new InboundAuthTokenStore({ maxTokens: 1 });
    store.store('token-1', createPrincipal());
    store.store('token-2', createPrincipal({ subject: 'user-2' }));

    expect(store.get('token-1')).toBeUndefined();
    expect(store.get('token-2')?.principal.subject).toBe('user-2');
  });

  it('issues random tokens and supports explicit deletion', () => {
    const store = new InboundAuthTokenStore({ maxTokens: 2 });
    const record = store.issue(createPrincipal());

    expect(record.token).toBeTruthy();
    expect(store.get(record.token)?.principal.subject).toBe('user-1');

    store.delete(record.token);
    expect(store.get(record.token)).toBeUndefined();
  });
});
