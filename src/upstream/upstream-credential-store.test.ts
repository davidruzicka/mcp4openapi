import { describe, expect, it } from 'vitest';
import { buildAuthHeaders, buildAuthUrl, createAuthStrategy } from './upstream-credential-store.js';
import type { AuthTokenConfig, UpstreamMcpServerConfig } from '../types/profile.js';

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

describe('createAuthStrategy', () => {
  const makeAuth = (overrides: Partial<AuthTokenConfig> & { type: AuthTokenConfig['type'] }): AuthTokenConfig =>
    overrides;

  describe('NOOP strategy — undefined auth', () => {
    it('returns empty headers', () => {
      expect(createAuthStrategy(undefined).buildHeaders('tok')).toEqual({});
    });
    it('returns url unchanged', () => {
      const url = new URL('https://example.com');
      expect(createAuthStrategy(undefined).buildUrl(url, 'tok').toString()).toBe(url.toString());
    });
    it('returns message unchanged', () => {
      expect(createAuthStrategy(undefined).sanitize('tok', 'some message')).toBe('some message');
    });
  });

  describe('bearer strategy', () => {
    const strategy = createAuthStrategy(makeAuth({ type: 'bearer' }));

    it('buildHeaders returns Authorization Bearer', () => {
      expect(strategy.buildHeaders('mytoken')).toEqual({ Authorization: 'Bearer mytoken' });
    });

    it('buildUrl returns url unchanged', () => {
      const url = new URL('https://example.com');
      expect(strategy.buildUrl(url, 'tok').toString()).toBe(url.toString());
    });

    it('sanitize redacts literal token', () => {
      const tok = 'supersecrettoken123';
      expect(strategy.sanitize(tok, `error with ${tok} here`)).toBe('error with [REDACTED] here');
    });

    it('sanitize replaces all occurrences', () => {
      const tok = 'supersecrettoken123';
      expect(strategy.sanitize(tok, `${tok} and again ${tok}`)).toBe('[REDACTED] and again [REDACTED]');
    });

    it('sanitize does nothing for token shorter than 8 chars', () => {
      expect(strategy.sanitize('short', 'msg with short')).toBe('msg with short');
    });

    it('sanitize handles token with regex special chars', () => {
      const tok = 'tok.en+val*ue?foo';
      const strategy2 = createAuthStrategy(makeAuth({ type: 'bearer' }));
      expect(strategy2.sanitize(tok, `error ${tok} here`)).toBe('error [REDACTED] here');
    });
  });

  describe('custom-header strategy', () => {
    const strategy = createAuthStrategy(makeAuth({ type: 'custom-header', header_name: 'X-Api-Key' }));

    it('buildHeaders returns custom header', () => {
      expect(strategy.buildHeaders('mytoken')).toEqual({ 'X-Api-Key': 'mytoken' });
    });

    it('buildUrl returns url unchanged', () => {
      const url = new URL('https://example.com');
      expect(strategy.buildUrl(url, 'tok').toString()).toBe(url.toString());
    });

    it('sanitize redacts literal token', () => {
      const tok = 'supersecrettoken123';
      expect(strategy.sanitize(tok, `header value ${tok} found`)).toBe('header value [REDACTED] found');
    });

    it('sanitize redacts contextual header pattern', () => {
      expect(strategy.sanitize('', 'request: x-api-key: supersecrettoken123 failed')).toBe(
        'request: x-api-key: [REDACTED] failed',
      );
    });

    it('sanitize redacts both literal and contextual pattern', () => {
      const tok = 'supersecrettoken123';
      expect(strategy.sanitize(tok, `X-Api-Key: ${tok}`)).toBe('X-Api-Key: [REDACTED]');
    });

    it('sanitize handles header_name with regex special chars', () => {
      const strategy2 = createAuthStrategy(makeAuth({ type: 'custom-header', header_name: 'X-My.Key' }));
      expect(strategy2.sanitize('', 'request X-My.Key: supersecrettoken123')).toBe(
        'request X-My.Key: [REDACTED]',
      );
    });

    it('returns NOOP strategy when header_name is missing', () => {
      const s = createAuthStrategy(makeAuth({ type: 'custom-header' }));
      expect(s.buildHeaders('tok')).toEqual({});
      expect(s.sanitize('tok', 'msg')).toBe('msg');
    });

    it('returns NOOP strategy when header_name is invalid (CRLF injection)', () => {
      const s = createAuthStrategy(makeAuth({ type: 'custom-header', header_name: "X-Key\r\nX-Inject: evil" }));
      expect(s.buildHeaders('tok')).toEqual({});
      expect(s.sanitize('tok', 'msg')).toBe('msg');
    });
  });

  describe('query strategy', () => {
    const strategy = createAuthStrategy(makeAuth({ type: 'query', query_param: 'api_key' }));
    const base = new URL('https://example.com/mcp');

    it('buildHeaders returns empty', () => {
      expect(strategy.buildHeaders('tok')).toEqual({});
    });

    it('buildUrl appends query param', () => {
      const result = strategy.buildUrl(base, 'secret');
      expect(result.searchParams.get('api_key')).toBe('secret');
    });

    it('buildUrl does not mutate original url', () => {
      strategy.buildUrl(base, 'secret');
      expect(base.searchParams.has('api_key')).toBe(false);
    });

    it('sanitize redacts literal token', () => {
      const tok = 'supersecrettoken123';
      expect(strategy.sanitize(tok, `url?api_key=${tok}&other=1`)).toBe('url?api_key=[REDACTED]&other=1');
    });

    it('sanitize redacts contextual query pattern', () => {
      expect(strategy.sanitize('', 'request failed: url?foo=1&api_key=supersecrettoken123')).toBe(
        'request failed: url?foo=1&api_key=[REDACTED]',
      );
    });

    it('sanitize handles query_param with regex special chars', () => {
      const strategy2 = createAuthStrategy(makeAuth({ type: 'query', query_param: 'api.key' }));
      expect(strategy2.sanitize('', 'url?api.key=supersecrettoken123&other=1')).toBe(
        'url?api.key=[REDACTED]&other=1',
      );
    });

    it('returns NOOP strategy when query_param is missing', () => {
      const s = createAuthStrategy(makeAuth({ type: 'query' }));
      expect(s.buildHeaders('tok')).toEqual({});
      expect(s.sanitize('tok', 'msg')).toBe('msg');
    });
  });

  describe('unknown auth type', () => {
    it('returns NOOP strategy', () => {
      const s = createAuthStrategy({ type: 'unknown-type' } as unknown as AuthTokenConfig);
      expect(s.buildHeaders('tok')).toEqual({});
      expect(s.sanitize('tok', 'msg')).toBe('msg');
    });
  });

  describe('AuthInterceptor duck-type compatibility', () => {
    it('accepts AuthInterceptor-shaped object with extra fields', () => {
      const authInterceptorShape = {
        type: 'bearer' as const,
        value_from_env: 'TOK_ENV',
        priority: 1,
        validation_endpoint: '/api/user',
      };
      const s = createAuthStrategy(authInterceptorShape);
      expect(s.buildHeaders('mytoken')).toEqual({ Authorization: 'Bearer mytoken' });
    });
  });
});
