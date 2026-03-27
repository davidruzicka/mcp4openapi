import { describe, expect, it } from 'vitest';
import { UpstreamCredentialStore, buildAuthHeaders } from './upstream-credential-store.js';
import type { UpstreamMcpServerConfig } from '../types/profile.js';

describe('UpstreamCredentialStore', () => {
  it('stores and retrieves tokens by provider name', () => {
    const store = new UpstreamCredentialStore();
    store.setToken('provider-a', 'secret123');
    expect(store.getToken('provider-a')).toBe('secret123');
  });

  it('returns undefined for nonexistent provider', () => {
    const store = new UpstreamCredentialStore();
    expect(store.getToken('nonexistent')).toBeUndefined();
  });

  it('reports hasCredentials correctly', () => {
    const store = new UpstreamCredentialStore();
    expect(store.hasCredentials('provider-a')).toBe(false);
    store.setToken('provider-a', 'tok');
    expect(store.hasCredentials('provider-a')).toBe(true);
  });

  it('clear() removes all tokens', () => {
    const store = new UpstreamCredentialStore();
    store.setToken('a', 'tok1');
    store.setToken('b', 'tok2');
    store.clear();
    expect(store.getToken('a')).toBeUndefined();
    expect(store.getToken('b')).toBeUndefined();
    expect(store.hasCredentials('a')).toBe(false);
  });
});

describe('buildAuthHeaders', () => {
  const makeProvider = (
    auth?: UpstreamMcpServerConfig['auth'],
  ): UpstreamMcpServerConfig => ({
    name: 'test-provider',
    transport: { type: 'http-streamable', url: 'https://example.com/mcp' },
    auth,
  });

  it('returns Bearer header for bearer auth type', () => {
    const store = new UpstreamCredentialStore();
    store.setToken('test-provider', 'tok');
    const provider = makeProvider({ type: 'bearer', value_from_env: 'TOK_ENV' });
    expect(buildAuthHeaders(provider, store)).toEqual({ Authorization: 'Bearer tok' });
  });

  it('returns custom header for custom-header auth type', () => {
    const store = new UpstreamCredentialStore();
    store.setToken('test-provider', 'tok');
    const provider = makeProvider({
      type: 'custom-header',
      value_from_env: 'TOK_ENV',
      header_name: 'X-Api-Key',
    });
    expect(buildAuthHeaders(provider, store)).toEqual({ 'X-Api-Key': 'tok' });
  });

  it('returns empty object for query auth type', () => {
    const store = new UpstreamCredentialStore();
    store.setToken('test-provider', 'tok');
    const provider = makeProvider({
      type: 'query',
      value_from_env: 'TOK_ENV',
      query_param: 'api_key',
    });
    expect(buildAuthHeaders(provider, store)).toEqual({});
  });

  it('returns empty object when no auth config', () => {
    const store = new UpstreamCredentialStore();
    store.setToken('test-provider', 'tok');
    const provider = makeProvider(undefined);
    expect(buildAuthHeaders(provider, store)).toEqual({});
  });

  it('returns empty object when no token for provider', () => {
    const store = new UpstreamCredentialStore();
    const provider = makeProvider({ type: 'bearer', value_from_env: 'TOK_ENV' });
    expect(buildAuthHeaders(provider, store)).toEqual({});
  });
});
