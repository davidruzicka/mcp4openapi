import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import { buildHttpTransportBaseConfig, parseConsentDbEnv } from './http-transport-config.js';
import { TIMEOUTS } from '../core/constants.js';
import { ConfigurationError } from '../core/errors.js';

const ENV_KEYS = [
  'MCP4_SESSION_TIMEOUT_MS',
  'MCP4_HEARTBEAT_ENABLED',
  'MCP4_HEARTBEAT_INTERVAL_MS',
  'MCP4_METRICS_ENABLED',
  'MCP4_METRICS_PATH',
  'MCP4_ALLOWED_ORIGINS',
  'MCP4_HTTP_RATE_LIMIT_ENABLED',
  'MCP4_HTTP_RATE_LIMIT_WINDOW_MS',
  'MCP4_HTTP_RATE_LIMIT_MAX_REQUESTS',
  'MCP4_HTTP_RATE_LIMIT_METRICS_MAX',
  'MCP4_TOKEN_MAX_LENGTH',
  'MCP4_OAUTH_KEY',
  'MCP4_TRUST_PROXY',
  'MCP4_SSL_CERT_FILE',
  'MCP4_SSL_KEY_FILE',
  'MCP4_OAUTH_SESSION_TIMEOUT_MS',
  'MCP4_OAUTH_REFRESH_THRESHOLD_MS',
  'MCP4_HTTP_PROFILE_INDEX',
  'MCP4_HTTP_PROFILE_INDEX_REDIRECT_URL',
  'MCP4_HTTP_PROFILE_INDEX_REDIRECT_STATUS',
  'MCP4_ENTERPRISE_AUTHORIZATION_ENABLED',
  'MCP4_ENTERPRISE_MAX_CACHED_ISSUERS',
  'MCP4_ENTERPRISE_MAX_REPLAY_ENTRIES',
  'MCP4_ENTERPRISE_MAX_TOKENS',
  'MCP4_ENTERPRISE_JWKS_TIMEOUT_MS',
  'MCP4_ENTERPRISE_JWKS_BACKOFF_MS',
  'MCP4_ENTERPRISE_GRANT_RATE_LIMIT_MAX',
  'MCP4_ENTERPRISE_GRANT_RATE_LIMIT_WINDOW_MS',
  'MCP4_ENTERPRISE_GRANT_MAX_CONCURRENCY',
];

describe('buildHttpTransportBaseConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    for (const key of ENV_KEYS) {
      delete process.env[key];
    }
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('uses defaults when env vars are not set', () => {
    const config = buildHttpTransportBaseConfig('127.0.0.1', 3003);

    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(3003);
    expect(config.sessionTimeoutMs).toBe(TIMEOUTS.SESSION_TIMEOUT_MS);
    expect(config.heartbeatEnabled).toBe(false);
    expect(config.heartbeatIntervalMs).toBe(TIMEOUTS.HEARTBEAT_INTERVAL_MS);
    expect(config.metricsEnabled).toBe(false);
    expect(config.metricsPath).toBe('/metrics');
    expect(config.allowedOrigins).toBeUndefined();
    expect(config.rateLimitEnabled).toBe(true);
    expect(config.rateLimitWindowMs).toBe(TIMEOUTS.RATE_LIMIT_WINDOW_MS);
    expect(config.rateLimitMaxRequests).toBe(100);
    expect(config.rateLimitMetricsMax).toBe(10);
    expect(config.maxTokenLength).toBeUndefined();
    expect(config.sslCertFile).toBeUndefined();
    expect(config.sslKeyFile).toBeUndefined();
    expect(config.oauthSessionTimeoutMs).toBeUndefined();
    expect(config.oauthRefreshThresholdMs).toBeUndefined();
    expect(config.profileIndexEnabled).toBe(false);
    expect(config.profileIndexRedirectUrl).toBeUndefined();
    expect(config.profileIndexRedirectStatus).toBeUndefined();
  });

  it('reads env overrides when provided', () => {
    process.env.MCP4_SESSION_TIMEOUT_MS = '9000';
    process.env.MCP4_HEARTBEAT_ENABLED = 'true';
    process.env.MCP4_HEARTBEAT_INTERVAL_MS = '45000';
    process.env.MCP4_METRICS_ENABLED = 'true';
    process.env.MCP4_METRICS_PATH = '/custom-metrics';
    process.env.MCP4_ALLOWED_ORIGINS = 'https://a.example.com, http://b.example.com';
    process.env.MCP4_HTTP_RATE_LIMIT_ENABLED = 'false';
    process.env.MCP4_HTTP_RATE_LIMIT_WINDOW_MS = '120000';
    process.env.MCP4_HTTP_RATE_LIMIT_MAX_REQUESTS = '250';
    process.env.MCP4_HTTP_RATE_LIMIT_METRICS_MAX = '15';
    process.env.MCP4_TOKEN_MAX_LENGTH = '2048';
    process.env.MCP4_TRUST_PROXY = 'loopback';
    process.env.MCP4_SSL_CERT_FILE = '/tmp/cert.pem';
    process.env.MCP4_SSL_KEY_FILE = '/tmp/key.pem';
    process.env.MCP4_OAUTH_SESSION_TIMEOUT_MS = '86400000';
    process.env.MCP4_OAUTH_REFRESH_THRESHOLD_MS = '120000';
    process.env.MCP4_HTTP_PROFILE_INDEX = 'true';
    process.env.MCP4_HTTP_PROFILE_INDEX_REDIRECT_URL = 'https://example.com/mcp';
    process.env.MCP4_ENTERPRISE_AUTHORIZATION_ENABLED = 'false';
    process.env.MCP4_ENTERPRISE_MAX_CACHED_ISSUERS = '12';
    process.env.MCP4_ENTERPRISE_MAX_REPLAY_ENTRIES = '34';
    process.env.MCP4_ENTERPRISE_MAX_TOKENS = '56';
    process.env.MCP4_ENTERPRISE_JWKS_TIMEOUT_MS = '78';
    process.env.MCP4_ENTERPRISE_JWKS_BACKOFF_MS = '90';
    process.env.MCP4_ENTERPRISE_GRANT_RATE_LIMIT_MAX = '11';
    process.env.MCP4_ENTERPRISE_GRANT_RATE_LIMIT_WINDOW_MS = '12000';
    process.env.MCP4_ENTERPRISE_GRANT_MAX_CONCURRENCY = '13';

    const config = buildHttpTransportBaseConfig('0.0.0.0', 8080);

    expect(config.host).toBe('0.0.0.0');
    expect(config.port).toBe(8080);
    expect(config.sessionTimeoutMs).toBe(9000);
    expect(config.heartbeatEnabled).toBe(true);
    expect(config.heartbeatIntervalMs).toBe(45000);
    expect(config.metricsEnabled).toBe(true);
    expect(config.metricsPath).toBe('/custom-metrics');
    expect(config.allowedOrigins).toEqual(['https://a.example.com', 'http://b.example.com']);
    expect(config.rateLimitEnabled).toBe(false);
    expect(config.rateLimitWindowMs).toBe(120000);
    expect(config.rateLimitMaxRequests).toBe(250);
    expect(config.rateLimitMetricsMax).toBe(15);
    expect(config.maxTokenLength).toBe(2048);
    expect(config.trustProxy).toBe('loopback');
    expect(config.sslCertFile).toBe('/tmp/cert.pem');
    expect(config.sslKeyFile).toBe('/tmp/key.pem');
    expect(config.oauthSessionTimeoutMs).toBe(86400000);
    expect(config.oauthRefreshThresholdMs).toBe(120000);
    expect(config.profileIndexEnabled).toBe(true);
    expect(config.profileIndexRedirectUrl).toBe('https://example.com/mcp');
    expect(config.profileIndexRedirectStatus).toBe(302);
    expect(config.enterpriseAuthorizationRuntimeConfig).toEqual({
      enabled: false,
      global_max_cached_issuers: 12,
      global_max_replay_entries: 34,
      global_max_enterprise_tokens: 56,
      jwks_refresh_timeout_ms: 78,
      jwks_refresh_backoff_ms: 90,
      enterprise_grant_rate_limit_max: 11,
      enterprise_grant_rate_limit_window_ms: 12000,
      enterprise_grant_max_concurrency_per_profile: 13,
    });
  });

  it('throws on invalid oauth session timeout', () => {
    process.env.MCP4_OAUTH_SESSION_TIMEOUT_MS = 'invalid';
    let error: Error | undefined;
    try {
      buildHttpTransportBaseConfig('127.0.0.1', 3003);
    } catch (e) {
      error = e as Error;
    }
    expect(error).toBeInstanceOf(ConfigurationError);
    expect(error?.message).not.toContain('invalid');
  });

  it('throws on invalid oauth refresh threshold', () => {
    process.env.MCP4_OAUTH_REFRESH_THRESHOLD_MS = 'invalid';
    let error: Error | undefined;
    try {
      buildHttpTransportBaseConfig('127.0.0.1', 3003);
    } catch (e) {
      error = e as Error;
    }
    expect(error).toBeInstanceOf(ConfigurationError);
    expect(error?.message).not.toContain('invalid');
  });

  it('parses trust proxy booleans and numeric values', () => {
    process.env.MCP4_TRUST_PROXY = 'true';
    expect(buildHttpTransportBaseConfig('127.0.0.1', 3003).trustProxy).toBe(true);

    process.env.MCP4_TRUST_PROXY = '2';
    expect(buildHttpTransportBaseConfig('127.0.0.1', 3003).trustProxy).toBe(2);

    process.env.MCP4_TRUST_PROXY = 'false';
    expect(buildHttpTransportBaseConfig('127.0.0.1', 3003).trustProxy).toBe(false);
  });

  it('uses an explicit 301 profile index redirect status', () => {
    process.env.MCP4_HTTP_PROFILE_INDEX_REDIRECT_URL = 'https://example.com/mcp';
    process.env.MCP4_HTTP_PROFILE_INDEX_REDIRECT_STATUS = '301';

    const config = buildHttpTransportBaseConfig('127.0.0.1', 3003);

    expect(config.profileIndexRedirectStatus).toBe(301);
  });

  it('throws on an invalid profile index redirect status', () => {
    process.env.MCP4_HTTP_PROFILE_INDEX_REDIRECT_URL = 'https://example.com/mcp';
    process.env.MCP4_HTTP_PROFILE_INDEX_REDIRECT_STATUS = '307';

    expect(() => buildHttpTransportBaseConfig('127.0.0.1', 3003)).toThrow(
      'expected 301 or 302',
    );
  });

  describe('MCP4_OAUTH_KEY', () => {
    it('returns undefined tokenKey when MCP4_OAUTH_KEY is unset', () => {
      const config = buildHttpTransportBaseConfig('127.0.0.1', 3003);
      expect(config.tokenKey).toBeUndefined();
    });

    it('returns undefined tokenKey when MCP4_OAUTH_KEY is empty string', () => {
      process.env.MCP4_OAUTH_KEY = '';
      const config = buildHttpTransportBaseConfig('127.0.0.1', 3003);
      expect(config.tokenKey).toBeUndefined();
    });

    it('returns undefined tokenKey when MCP4_OAUTH_KEY is only whitespace', () => {
      process.env.MCP4_OAUTH_KEY = '   ';
      const config = buildHttpTransportBaseConfig('127.0.0.1', 3003);
      expect(config.tokenKey).toBeUndefined();
    });

    it('derives tokenKey via hex decode for exactly-64-char hex string of all zeros', () => {
      process.env.MCP4_OAUTH_KEY = '0'.repeat(64);
      const config = buildHttpTransportBaseConfig('127.0.0.1', 3003);
      expect(Buffer.isBuffer(config.tokenKey)).toBe(true);
      expect(config.tokenKey?.length).toBe(32);
      expect(config.tokenKey?.equals(Buffer.alloc(32))).toBe(true);
    });

    it('derives tokenKey via scrypt for arbitrary passphrase', () => {
      process.env.MCP4_OAUTH_KEY = 'my-passphrase';
      const config = buildHttpTransportBaseConfig('127.0.0.1', 3003);
      const expected = crypto.scryptSync('my-passphrase', 'mcp4openapi:token-envelope:v1', 32);
      expect(Buffer.isBuffer(config.tokenKey)).toBe(true);
      expect(config.tokenKey?.length).toBe(32);
      expect(config.tokenKey?.equals(expected)).toBe(true);
    });

    it('trims whitespace from MCP4_OAUTH_KEY before deriving (k8s ConfigMap newline tolerance)', () => {
      process.env.MCP4_OAUTH_KEY = '  my-passphrase  ';
      const config = buildHttpTransportBaseConfig('127.0.0.1', 3003);
      const expected = crypto.scryptSync('my-passphrase', 'mcp4openapi:token-envelope:v1', 32);
      expect(config.tokenKey?.equals(expected)).toBe(true);
    });

    it('derives tokenKey via hex decode for 64-char hex string of all "a"s and yields 32-byte buffer', () => {
      process.env.MCP4_OAUTH_KEY = 'a'.repeat(64);
      const config = buildHttpTransportBaseConfig('127.0.0.1', 3003);
      expect(Buffer.isBuffer(config.tokenKey)).toBe(true);
      expect(config.tokenKey?.length).toBe(32);
      expect(config.tokenKey?.equals(Buffer.from('a'.repeat(64), 'hex'))).toBe(true);
    });

    it('derives legacyTokenKey via SHA-256 for passphrase (pre-scrypt envelope fallback)', () => {
      process.env.MCP4_OAUTH_KEY = 'my-passphrase';
      const config = buildHttpTransportBaseConfig('127.0.0.1', 3003);
      const expected = crypto.createHash('sha256').update('my-passphrase').digest();
      expect(config.legacyTokenKey?.equals(expected)).toBe(true);
    });

    it('leaves legacyTokenKey undefined for 64-char hex keys (both KDFs identical)', () => {
      process.env.MCP4_OAUTH_KEY = 'a'.repeat(64);
      const config = buildHttpTransportBaseConfig('127.0.0.1', 3003);
      expect(config.legacyTokenKey).toBeUndefined();
    });
  });
});

describe('parseConsentDbEnv', () => {
  const FULL_ENV = {
    MCP_CONSENTS_DB_HOST: 'db.example',
    MCP_CONSENTS_DB_PORT: '7432',
    MCP_CONSENTS_DB_NAME: 'mcp_consents_db',
    MCP_CONSENTS_DB_USER: 'consents',
    MCP_CONSENTS_DB_PASSWORD: 'secret',
  };

  it('returns undefined when no MCP_CONSENTS_DB_* variable is set', () => {
    expect(parseConsentDbEnv({})).toBeUndefined();
  });

  it('parses a complete variable set with TLS on by default (pgaas expects it)', () => {
    expect(parseConsentDbEnv({ ...FULL_ENV })).toEqual({
      host: 'db.example',
      port: 7432,
      database: 'mcp_consents_db',
      user: 'consents',
      password: 'secret',
      ssl: true,
    });
  });

  it('allows opting out of TLS for local development', () => {
    expect(parseConsentDbEnv({ ...FULL_ENV, MCP_CONSENTS_DB_SSL: 'false' })?.ssl).toBe(false);
  });

  it('rejects an invalid MCP_CONSENTS_DB_SSL value', () => {
    expect(() => parseConsentDbEnv({ ...FULL_ENV, MCP_CONSENTS_DB_SSL: 'yes' })).toThrow(
      ConfigurationError,
    );
  });

  it('defaults the port to 5432 when only MCP_CONSENTS_DB_PORT is missing', () => {
    const { MCP_CONSENTS_DB_PORT: _omitted, ...rest } = FULL_ENV;
    expect(parseConsentDbEnv(rest)?.port).toBe(5432);
  });

  it('fails loudly on a partial variable set instead of silently falling back', () => {
    const { MCP_CONSENTS_DB_PASSWORD: _omitted, ...rest } = FULL_ENV;
    expect(() => parseConsentDbEnv(rest)).toThrow(ConfigurationError);
    expect(() => parseConsentDbEnv(rest)).toThrow('MCP_CONSENTS_DB_PASSWORD');
  });

  it('fails loudly when only the port is set', () => {
    expect(() => parseConsentDbEnv({ MCP_CONSENTS_DB_PORT: '5432' })).toThrow(ConfigurationError);
  });

  it('rejects a non-numeric port', () => {
    expect(() => parseConsentDbEnv({ ...FULL_ENV, MCP_CONSENTS_DB_PORT: 'not-a-port' })).toThrow(
      ConfigurationError,
    );
  });

  it('treats blank values as unset', () => {
    expect(() => parseConsentDbEnv({ ...FULL_ENV, MCP_CONSENTS_DB_HOST: '   ' })).toThrow(
      ConfigurationError,
    );
  });
});
