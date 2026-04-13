import { describe, expect, it } from 'vitest';
import { buildAuthHeaders, buildAuthUrl } from './upstream-credential-store.js';
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

  it('returns empty object for custom-header auth without header_name', () => {
    const provider = makeProvider({
      type: 'custom-header',
      value_from_env: 'TOK_ENV',
    } as UpstreamMcpServerConfig['auth']);
    expect(buildAuthHeaders(provider, 'mytoken')).toEqual({});
  });

  it('returns empty object for unknown auth type', () => {
    const provider = makeProvider({
      type: 'unknown-type',
      value_from_env: 'TOK_ENV',
    } as unknown as UpstreamMcpServerConfig['auth']);
    expect(buildAuthHeaders(provider, 'mytoken')).toEqual({});
  });

  it('returns empty object for custom-header with CRLF in header_name (defensive injection guard)', () => {
    const provider = makeProvider({
      type: 'custom-header',
      value_from_env: 'TOK_ENV',
      header_name: "X-Header\r\nX-Inject: evil",
    } as unknown as UpstreamMcpServerConfig['auth']);
    expect(buildAuthHeaders(provider, 'mytoken')).toEqual({});
  });

  it('returns empty object for custom-header with space in header_name (defensive guard)', () => {
    const provider = makeProvider({
      type: 'custom-header',
      value_from_env: 'TOK_ENV',
      header_name: 'X Bad Header',
    } as unknown as UpstreamMcpServerConfig['auth']);
    expect(buildAuthHeaders(provider, 'mytoken')).toEqual({});
  });
});

describe('buildAuthUrl', () => {
  const base = new URL('https://example.com/mcp');

  it('appends query param for query auth with token', () => {
    const provider = makeProvider({ type: 'query', value_from_env: 'TOK', query_param: 'api_key' });
    const result = buildAuthUrl(provider, base, 'secret');
    expect(result.searchParams.get('api_key')).toBe('secret');
    expect(result.pathname).toBe('/mcp');
  });

  it('does not mutate the original URL', () => {
    const provider = makeProvider({ type: 'query', value_from_env: 'TOK', query_param: 'api_key' });
    buildAuthUrl(provider, base, 'secret');
    expect(base.searchParams.has('api_key')).toBe(false);
  });

  it('returns original URL unchanged for bearer auth', () => {
    const provider = makeProvider({ type: 'bearer', value_from_env: 'TOK' });
    const result = buildAuthUrl(provider, base, 'secret');
    expect(result.toString()).toBe(base.toString());
  });

  it('returns original URL unchanged for custom-header auth', () => {
    const provider = makeProvider({ type: 'custom-header', value_from_env: 'TOK', header_name: 'X-Key' });
    const result = buildAuthUrl(provider, base, 'secret');
    expect(result.toString()).toBe(base.toString());
  });

  it('returns original URL when token is undefined', () => {
    const provider = makeProvider({ type: 'query', value_from_env: 'TOK', query_param: 'api_key' });
    const result = buildAuthUrl(provider, base, undefined);
    expect(result.toString()).toBe(base.toString());
  });

  it('returns original URL when provider has no auth', () => {
    const provider = makeProvider(undefined);
    const result = buildAuthUrl(provider, base, 'secret');
    expect(result.toString()).toBe(base.toString());
  });

  it('returns original URL when query_param is missing', () => {
    const provider = makeProvider({ type: 'query', value_from_env: 'TOK' });
    const result = buildAuthUrl(provider, base, 'secret');
    expect(result.toString()).toBe(base.toString());
  });

  it('handles existing query params without clobbering them', () => {
    const url = new URL('https://example.com/mcp?version=2');
    const provider = makeProvider({ type: 'query', value_from_env: 'TOK', query_param: 'api_key' });
    const result = buildAuthUrl(provider, url, 'secret');
    expect(result.searchParams.get('version')).toBe('2');
    expect(result.searchParams.get('api_key')).toBe('secret');
  });
});
