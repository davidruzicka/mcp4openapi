import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildHttpTransportBaseConfig } from './http-transport-config.js';
import { TIMEOUTS } from './constants.js';
import { ConfigurationError } from './errors.js';

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
  'MCP4_SSL_CERT_FILE',
  'MCP4_SSL_KEY_FILE',
  'MCP4_OAUTH_SESSION_TIMEOUT_MS',
  'MCP4_OAUTH_REFRESH_THRESHOLD_MS',
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
    process.env.MCP4_SSL_CERT_FILE = '/tmp/cert.pem';
    process.env.MCP4_SSL_KEY_FILE = '/tmp/key.pem';
    process.env.MCP4_OAUTH_SESSION_TIMEOUT_MS = '86400000';
    process.env.MCP4_OAUTH_REFRESH_THRESHOLD_MS = '120000';

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
    expect(config.sslCertFile).toBe('/tmp/cert.pem');
    expect(config.sslKeyFile).toBe('/tmp/key.pem');
    expect(config.oauthSessionTimeoutMs).toBe(86400000);
    expect(config.oauthRefreshThresholdMs).toBe(120000);
  });

  it('throws on invalid oauth session timeout', () => {
    process.env.MCP4_OAUTH_SESSION_TIMEOUT_MS = 'invalid';
    expect(() => buildHttpTransportBaseConfig('127.0.0.1', 3003)).toThrow(ConfigurationError);
  });

  it('throws on invalid oauth refresh threshold', () => {
    process.env.MCP4_OAUTH_REFRESH_THRESHOLD_MS = 'invalid';
    expect(() => buildHttpTransportBaseConfig('127.0.0.1', 3003)).toThrow(ConfigurationError);
  });
});
