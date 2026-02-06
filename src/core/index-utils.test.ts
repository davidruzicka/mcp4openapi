import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fetchOAuthMetadata, deriveIssuerFromBaseUrl, resolveHttpHostPort } from './index.js';
import { SSRFValidator } from '../security/ssrf-validator.js';

const originalEnv = process.env;

describe('index helpers', () => {
  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.MCP4_TRUST_BOOTSTRAP_URLS = 'true';
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('fetchOAuthMetadata returns endpoints when response is ok', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        authorization_endpoint: 'https://issuer.example.com/auth',
        token_endpoint: 'https://issuer.example.com/token',
      }),
    }));

    const result = await fetchOAuthMetadata('https://issuer.example.com');

    expect(result).toEqual({
      authorization_endpoint: 'https://issuer.example.com/auth',
      token_endpoint: 'https://issuer.example.com/token',
    });
  });

  it('fetchOAuthMetadata returns null when response is not ok', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));

    const result = await fetchOAuthMetadata('https://issuer.example.com');

    expect(result).toBeNull();
  });

  it('fetchOAuthMetadata returns null on fetch error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')));

    const result = await fetchOAuthMetadata('https://issuer.example.com');

    expect(result).toBeNull();
  });

  it('fetchOAuthMetadata blocks localhost/private bootstrap URL by default', async () => {
    delete process.env.MCP4_TRUST_BOOTSTRAP_URLS;
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const result = await fetchOAuthMetadata('http://127.0.0.1');

    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fetchOAuthMetadata allows localhost/private bootstrap URL when trust override is enabled', async () => {
    process.env.MCP4_TRUST_BOOTSTRAP_URLS = 'true';
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        authorization_endpoint: 'http://127.0.0.1/auth',
        token_endpoint: 'http://127.0.0.1/token',
      }),
    });
    vi.stubGlobal('fetch', fetchSpy);

    const result = await fetchOAuthMetadata('http://127.0.0.1');

    expect(result).toEqual({
      authorization_endpoint: 'http://127.0.0.1/auth',
      token_endpoint: 'http://127.0.0.1/token',
    });
    expect(fetchSpy).toHaveBeenCalled();
  });

  it('fetchOAuthMetadata returns null when bootstrap SSRF validation fails (DNS/timeout path)', async () => {
    delete process.env.MCP4_TRUST_BOOTSTRAP_URLS;
    const validateSpy = vi
      .spyOn(SSRFValidator.prototype, 'validate')
      .mockRejectedValueOnce(new Error('DNS lookup timeout after 2000ms'));
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const result = await fetchOAuthMetadata('https://issuer.example.com');

    expect(result).toBeNull();
    expect(validateSpy).toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('deriveIssuerFromBaseUrl returns origin for valid URL', () => {
    expect(deriveIssuerFromBaseUrl('https://example.com/api/v4')).toBe('https://example.com');
  });

  it('deriveIssuerFromBaseUrl returns null for invalid URL', () => {
    expect(deriveIssuerFromBaseUrl('not a url')).toBeNull();
  });

  it('resolveHttpHostPort uses defaults when env is unset', () => {
    delete process.env.MCP4_HOST;
    delete process.env.MCP4_PORT;

    expect(resolveHttpHostPort()).toEqual({ host: '127.0.0.1', port: 3003 });
  });

  it('resolveHttpHostPort throws on invalid port', () => {
    process.env.MCP4_PORT = 'abc';

    expect(() => resolveHttpHostPort()).toThrow('Invalid MCP4_PORT');
  });

  it('resolveHttpHostPort uses custom host and port', () => {
    process.env.MCP4_HOST = '0.0.0.0';
    process.env.MCP4_PORT = '8080';

    expect(resolveHttpHostPort()).toEqual({ host: '0.0.0.0', port: 8080 });
  });
});
