import { describe, expect, it } from 'vitest';
import { buildAuthHeaders } from './upstream-credential-store.js';
import type { UpstreamMcpServerConfig } from '../types/profile.js';

const makeProvider = (
  auth?: UpstreamMcpServerConfig['auth'],
): UpstreamMcpServerConfig => ({
  name: 'test-provider',
  transport: { type: 'http-streamable', url: 'https://example.com/mcp' },
  auth,
});

describe('buildAuthHeaders', () => {
  it('returns Bearer header for bearer auth with token', () => {
    const provider = makeProvider({ type: 'bearer', value_from_env: 'TOK_ENV' });
    expect(buildAuthHeaders(provider, 'mytoken')).toEqual({ Authorization: 'Bearer mytoken' });
  });

  it('returns custom header for custom-header auth with token', () => {
    const provider = makeProvider({
      type: 'custom-header',
      value_from_env: 'TOK_ENV',
      header_name: 'X-Api-Key',
    });
    expect(buildAuthHeaders(provider, 'mytoken')).toEqual({ 'X-Api-Key': 'mytoken' });
  });

  it('returns empty object for query auth type (URL-level auth)', () => {
    const provider = makeProvider({
      type: 'query',
      value_from_env: 'TOK_ENV',
      query_param: 'api_key',
    });
    expect(buildAuthHeaders(provider, 'mytoken')).toEqual({});
  });

  it('returns empty object when token is undefined', () => {
    const provider = makeProvider({ type: 'bearer', value_from_env: 'TOK_ENV' });
    expect(buildAuthHeaders(provider, undefined)).toEqual({});
  });

  it('returns empty object when provider has no auth config', () => {
    const provider = makeProvider(undefined);
    expect(buildAuthHeaders(provider, 'mytoken')).toEqual({});
  });
});
