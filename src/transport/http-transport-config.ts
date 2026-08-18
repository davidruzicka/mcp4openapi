/**
 * Build base HTTP transport configuration from environment variables.
 */

import { TIMEOUTS } from '../core/constants.js';
import { ConfigurationError } from '../core/errors.js';
import { deriveLegacySha256TokenKey, deriveTokenKey } from '../auth/token-envelope.js';
import type { PostgresConsentDbConfig } from '../auth/postgres-consent-evidence-store.js';
import {
  PROFILE_INDEX_REDIRECT_STATUSES,
  type HttpTransportConfig,
  type ProfileIndexRedirectStatus,
} from '../types/http-transport.js';

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

function parseProfileIndexRedirectStatus(redirectUrl?: string): ProfileIndexRedirectStatus | undefined {
  if (!redirectUrl) return undefined;
  const configuredStatus = process.env.MCP4_HTTP_PROFILE_INDEX_REDIRECT_STATUS?.trim();
  if (!configuredStatus) return 302;
  const status = Number(configuredStatus);
  if (
    Number.isInteger(status)
    && configuredStatus === String(status)
    && PROFILE_INDEX_REDIRECT_STATUSES.includes(status as ProfileIndexRedirectStatus)
  ) {
    return status as ProfileIndexRedirectStatus;
  }
  throw new ConfigurationError(
    `Invalid MCP4_HTTP_PROFILE_INDEX_REDIRECT_STATUS: expected ${PROFILE_INDEX_REDIRECT_STATUSES.join(' or ')}`
  );
}

/**
 * Resolve `MCP_CONSENTS_DB_*` into a Postgres consent-store config.
 *
 * All-or-nothing: with none of the variables set the backend is not selected;
 * a partial set is a hard configuration error rather than a silent fallback to
 * a weaker store. `MCP_CONSENTS_DB_PORT` (default 5432) and
 * `MCP_CONSENTS_DB_SSL` (default true — pgaas expects TLS) are optional.
 */
export function parseConsentDbEnv(
  env: NodeJS.ProcessEnv = process.env,
): PostgresConsentDbConfig | undefined {
  const values = {
    host: env.MCP_CONSENTS_DB_HOST?.trim(),
    database: env.MCP_CONSENTS_DB_NAME?.trim(),
    user: env.MCP_CONSENTS_DB_USER?.trim(),
    password: env.MCP_CONSENTS_DB_PASSWORD?.trim(),
  };
  const port = env.MCP_CONSENTS_DB_PORT?.trim();
  const sslRaw = env.MCP_CONSENTS_DB_SSL?.trim();
  const missing = Object.entries(values)
    .filter(([, value]) => !value)
    .map(([key]) => key);
  // Optional vars participate in the partial-set detection: SSL-only (or
  // SSL+partial) must fail startup loudly instead of being silently ignored.
  if (missing.length === 4 && !port && !sslRaw) return undefined;
  if (missing.length > 0) {
    throw new ConfigurationError(
      `Incomplete MCP_CONSENTS_DB_* configuration: missing ${missing
        .map(key => `MCP_CONSENTS_DB_${key === 'database' ? 'NAME' : key.toUpperCase()}`)
        .join(', ')}`,
    );
  }
  const parsedPort = port ? Number.parseInt(port, 10) : 5432;
  if (!Number.isInteger(parsedPort) || parsedPort <= 0 || parsedPort > 65535 || (port && String(parsedPort) !== port)) {
    throw new ConfigurationError('Invalid MCP_CONSENTS_DB_PORT: expected a TCP port number');
  }
  if (sslRaw !== undefined && sslRaw !== 'true' && sslRaw !== 'false') {
    throw new ConfigurationError("Invalid MCP_CONSENTS_DB_SSL: expected 'true' or 'false'");
  }
  return {
    host: values.host!,
    port: parsedPort,
    database: values.database!,
    user: values.user!,
    password: values.password!,
    ssl: sslRaw !== 'false',
  };
}

export function buildHttpTransportBaseConfig(host: string, port: number): HttpTransportConfig {
  const profileIndexRedirectUrl = process.env.MCP4_HTTP_PROFILE_INDEX_REDIRECT_URL?.trim() || undefined;
  return {
    host,
    port,
    sessionTimeoutMs: parseInt(process.env.MCP4_SESSION_TIMEOUT_MS || String(TIMEOUTS.SESSION_TIMEOUT_MS), 10),
    heartbeatEnabled: process.env.MCP4_HEARTBEAT_ENABLED === 'true',
    heartbeatIntervalMs: parseInt(process.env.MCP4_HEARTBEAT_INTERVAL_MS || String(TIMEOUTS.HEARTBEAT_INTERVAL_MS), 10),
    metricsEnabled: process.env.MCP4_METRICS_ENABLED === 'true',
    metricsPath: process.env.MCP4_METRICS_PATH || '/metrics',
    profileIndexEnabled: process.env.MCP4_HTTP_PROFILE_INDEX === 'true',
    profileIndexRedirectUrl,
    profileIndexRedirectStatus: parseProfileIndexRedirectStatus(profileIndexRedirectUrl),
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
    tokenKey: (() => {
      const raw = process.env.MCP4_OAUTH_KEY;
      if (!raw || !raw.trim()) return undefined;
      return deriveTokenKey(raw.trim());
    })(),
    // Legacy SHA-256 fallback key for decrypting pre-scrypt envelopes.
    // Only relevant for the passphrase path: 64-hex keys derive identically
    // under both KDFs, so no fallback is needed there.
    legacyTokenKey: (() => {
      const raw = process.env.MCP4_OAUTH_KEY;
      if (!raw || !raw.trim()) return undefined;
      const trimmed = raw.trim();
      if (trimmed.length === 64 && /^[0-9a-fA-F]+$/.test(trimmed)) return undefined;
      return deriveLegacySha256TokenKey(trimmed);
    })(),
    consentEvidencePath: process.env.MCP4_CONSENT_EVIDENCE_PATH?.trim() || undefined,
    consentDb: parseConsentDbEnv(),
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
          `Invalid MCP4_OAUTH_SESSION_TIMEOUT_MS: expected integer milliseconds`
        );
      }
      return parsed;
    })(),
    oauthRefreshThresholdMs: (() => {
      if (process.env.MCP4_OAUTH_REFRESH_THRESHOLD_MS === undefined) return undefined;
      const parsed = parseInt(process.env.MCP4_OAUTH_REFRESH_THRESHOLD_MS, 10);
      if (Number.isNaN(parsed)) {
        throw new ConfigurationError(
          `Invalid MCP4_OAUTH_REFRESH_THRESHOLD_MS: expected integer milliseconds`
        );
      }
      return parsed;
    })(),
    enterpriseAuthorizationRuntimeConfig: {
      enabled: process.env.MCP4_ENTERPRISE_AUTHORIZATION_ENABLED === undefined
        ? undefined
        : process.env.MCP4_ENTERPRISE_AUTHORIZATION_ENABLED === 'true',
      global_max_cached_issuers: process.env.MCP4_ENTERPRISE_MAX_CACHED_ISSUERS
        ? parseInt(process.env.MCP4_ENTERPRISE_MAX_CACHED_ISSUERS, 10)
        : undefined,
      global_max_replay_entries: process.env.MCP4_ENTERPRISE_MAX_REPLAY_ENTRIES
        ? parseInt(process.env.MCP4_ENTERPRISE_MAX_REPLAY_ENTRIES, 10)
        : undefined,
      global_max_enterprise_tokens: process.env.MCP4_ENTERPRISE_MAX_TOKENS
        ? parseInt(process.env.MCP4_ENTERPRISE_MAX_TOKENS, 10)
        : undefined,
      jwks_refresh_timeout_ms: process.env.MCP4_ENTERPRISE_JWKS_TIMEOUT_MS
        ? parseInt(process.env.MCP4_ENTERPRISE_JWKS_TIMEOUT_MS, 10)
        : undefined,
      jwks_refresh_backoff_ms: process.env.MCP4_ENTERPRISE_JWKS_BACKOFF_MS
        ? parseInt(process.env.MCP4_ENTERPRISE_JWKS_BACKOFF_MS, 10)
        : undefined,
      enterprise_grant_rate_limit_max: process.env.MCP4_ENTERPRISE_GRANT_RATE_LIMIT_MAX
        ? parseInt(process.env.MCP4_ENTERPRISE_GRANT_RATE_LIMIT_MAX, 10)
        : undefined,
      enterprise_grant_rate_limit_window_ms: process.env.MCP4_ENTERPRISE_GRANT_RATE_LIMIT_WINDOW_MS
        ? parseInt(process.env.MCP4_ENTERPRISE_GRANT_RATE_LIMIT_WINDOW_MS, 10)
        : undefined,
      enterprise_grant_max_concurrency_per_profile: process.env.MCP4_ENTERPRISE_GRANT_MAX_CONCURRENCY
        ? parseInt(process.env.MCP4_ENTERPRISE_GRANT_MAX_CONCURRENCY, 10)
        : undefined,
    },
  };
}
