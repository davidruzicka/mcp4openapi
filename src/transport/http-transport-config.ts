/**
 * Build base HTTP transport configuration from environment variables.
 */

import { TIMEOUTS } from '../core/constants.js';
import { ConfigurationError } from '../core/errors.js';
import type { HttpTransportConfig } from '../types/http-transport.js';

function parseTrustProxy(value: string): boolean | number | string {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  const numeric = Number.parseInt(value, 10);
  if (!Number.isNaN(numeric) && String(numeric) === value.trim()) {
    return numeric;
  }
  return value;
}

export function buildHttpTransportBaseConfig(host: string, port: number): HttpTransportConfig {
  return {
    host,
    port,
    sessionTimeoutMs: parseInt(process.env.MCP4_SESSION_TIMEOUT_MS || String(TIMEOUTS.SESSION_TIMEOUT_MS), 10),
    heartbeatEnabled: process.env.MCP4_HEARTBEAT_ENABLED === 'true',
    heartbeatIntervalMs: parseInt(process.env.MCP4_HEARTBEAT_INTERVAL_MS || String(TIMEOUTS.HEARTBEAT_INTERVAL_MS), 10),
    metricsEnabled: process.env.MCP4_METRICS_ENABLED === 'true',
    metricsPath: process.env.MCP4_METRICS_PATH || '/metrics',
    allowedOrigins: process.env.MCP4_ALLOWED_ORIGINS
      ? process.env.MCP4_ALLOWED_ORIGINS.split(',').map(o => o.trim())
      : undefined,
    rateLimitEnabled: process.env.MCP4_HTTP_RATE_LIMIT_ENABLED !== 'false', // default: true
    rateLimitWindowMs: parseInt(process.env.MCP4_HTTP_RATE_LIMIT_WINDOW_MS || String(TIMEOUTS.RATE_LIMIT_WINDOW_MS), 10),
    rateLimitMaxRequests: parseInt(process.env.MCP4_HTTP_RATE_LIMIT_MAX_REQUESTS || '100', 10),
    rateLimitMetricsMax: parseInt(process.env.MCP4_HTTP_RATE_LIMIT_METRICS_MAX || '10', 10),
    maxTokenLength: process.env.MCP4_TOKEN_MAX_LENGTH
      ? parseInt(process.env.MCP4_TOKEN_MAX_LENGTH, 10)
      : undefined,
    trustProxy: process.env.MCP4_TRUST_PROXY
      ? parseTrustProxy(process.env.MCP4_TRUST_PROXY)
      : undefined,
    sslCertFile: process.env.MCP4_SSL_CERT_FILE,
    sslKeyFile: process.env.MCP4_SSL_KEY_FILE,
    oauthSessionTimeoutMs: (() => {
      if (process.env.MCP4_OAUTH_SESSION_TIMEOUT_MS === undefined) return undefined;
      const parsed = parseInt(process.env.MCP4_OAUTH_SESSION_TIMEOUT_MS, 10);
      if (Number.isNaN(parsed)) {
        throw new ConfigurationError(
          `Invalid MCP4_OAUTH_SESSION_TIMEOUT_MS: expected integer milliseconds, got '${process.env.MCP4_OAUTH_SESSION_TIMEOUT_MS}'`
        );
      }
      return parsed;
    })(),
    oauthRefreshThresholdMs: (() => {
      if (process.env.MCP4_OAUTH_REFRESH_THRESHOLD_MS === undefined) return undefined;
      const parsed = parseInt(process.env.MCP4_OAUTH_REFRESH_THRESHOLD_MS, 10);
      if (Number.isNaN(parsed)) {
        throw new ConfigurationError(
          `Invalid MCP4_OAUTH_REFRESH_THRESHOLD_MS: expected integer milliseconds, got '${process.env.MCP4_OAUTH_REFRESH_THRESHOLD_MS}'`
        );
      }
      return parsed;
    })(),
  };
}
