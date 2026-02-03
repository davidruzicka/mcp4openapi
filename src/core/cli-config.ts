/**
 * CLI config helpers
 *
 * Why: Shared parsing and env override logic with tests.
 */

import { UnknownCliFlagError } from './errors.js';

export function flagToEnvVar(flag: string): string {
  return `MCP4_${flag.replace(/-/g, '_').toUpperCase()}`;
}

const KNOWN_ENV_VARS = new Set([
  'MCP4_API_TOKEN',
  'MCP4_PROFILE',
  'MCP4_PROFILES_DIR',
  'MCP4_PROFILE_PATH',
  'MCP4_OPENAPI_SPEC_PATH',
  'MCP4_TRANSPORT',
  'MCP4_API_BASE_URL',
  'MCP4_TOOL_FILTER_ALLOW_NAMES',
  'MCP4_TOOL_FILTER_ALLOW_NAME_REGEX',
  'MCP4_TOOL_FILTER_DENY_NAMES',
  'MCP4_TOOL_FILTER_DENY_NAME_REGEX',
  'MCP4_TOOL_FILTER_ALLOW_CATEGORIES',
  'MCP4_TOOL_FILTER_WARN_THRESHOLD_PCT',
  'MCP4_TOOL_FILTER_SESSION_MAX_TOOLS',
  'MCP4_AUTH_ENV_VAR',
  'MCP4_AUTH_FORCE',
  'MCP4_AUTH_TYPE',
  'MCP4_AUTH_HEADER_NAME',
  'MCP4_AUTH_QUERY_PARAM',
  'MCP4_PROXY_MAX_BYTES',
  'MCP4_TOOLNAME_MAX',
  'MCP4_TOOLNAME_STRATEGY',
  'MCP4_TOOLNAME_WARN_ONLY',
  'MCP4_TOOLNAME_SIMILAR_TOP',
  'MCP4_TOOLNAME_SIMILARITY_THRESHOLD',
  'MCP4_TOOLNAME_MIN_PARTS',
  'MCP4_TOOLNAME_MIN_LENGTH',
  'MCP4_HOST',
  'MCP4_PORT',
  'MCP4_ALLOWED_ORIGINS',
  'MCP4_SESSION_TIMEOUT_MS',
  'MCP4_OAUTH_SESSION_TIMEOUT_MS',
  'MCP4_OAUTH_REFRESH_THRESHOLD_MS',
  'MCP4_HEARTBEAT_ENABLED',
  'MCP4_HEARTBEAT_INTERVAL_MS',
  'MCP4_TOKEN_MAX_LENGTH',
  'MCP4_FILTER_MAX_VALUES',
  'MCP4_HTTP_PROFILE_ROUTING',
  'MCP4_HTTP_PROFILE_INDEX',
  'MCP4_ALLOW_PROFILES',
  'MCP4_ALLOW_PROFILES_REGEX',
  'MCP4_SSL_CERT_FILE',
  'MCP4_SSL_KEY_FILE',
  'MCP4_OAUTH_CLIENT_ID',
  'MCP4_OAUTH_CLIENT_SECRET',
  'MCP4_OAUTH_REDIRECT_URI',
  'MCP4_OAUTH_ISSUER',
  'MCP4_OAUTH_AUTHORIZATION_URL',
  'MCP4_OAUTH_TOKEN_URL',
  'MCP4_HTTP_RATE_LIMIT_ENABLED',
  'MCP4_HTTP_RATE_LIMIT_WINDOW_MS',
  'MCP4_HTTP_RATE_LIMIT_MAX_REQUESTS',
  'MCP4_HTTP_RATE_LIMIT_METRICS_MAX',
  'MCP4_OAUTH_RATE_LIMIT_MAX',
  'MCP4_OAUTH_RATE_LIMIT_WINDOW_MS',
  'MCP4_LOG_LEVEL',
  'MCP4_LOG_FORMAT',
  'MCP4_METRICS_ENABLED',
  'MCP4_METRICS_PATH',
]);

const NON_ENV_FLAGS = new Set([
  'list-profiles',
]);

export function parseCliArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-l') {
      args['list-profiles'] = 'true';
      continue;
    }
    if (!arg.startsWith('--')) continue;
    const raw = arg.slice(2);
    if (!raw) continue;
    const eqIndex = raw.indexOf('=');
    if (eqIndex !== -1) {
      const key = raw.slice(0, eqIndex);
      const value = raw.slice(eqIndex + 1);
      args[key] = value;
      continue;
    }
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      args[raw] = next;
      i += 1;
      continue;
    }
    args[raw] = 'true';
  }
  return args;
}

export function applyCliEnvOverrides(args: Record<string, string>): void {
  const entries = Object.entries(args);
  const unknown: string[] = [];
  for (const [key] of entries) {
    if (NON_ENV_FLAGS.has(key)) {
      continue;
    }
    const envVar = flagToEnvVar(key);
    if (!KNOWN_ENV_VARS.has(envVar)) {
      unknown.push(key);
    }
  }
  if (unknown.length > 0) {
    throw new UnknownCliFlagError(unknown);
  }
  for (const [key, value] of entries) {
    if (NON_ENV_FLAGS.has(key)) {
      continue;
    }
    const envVar = flagToEnvVar(key);
    process.env[envVar] = value;
  }
}
