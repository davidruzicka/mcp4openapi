import {
  EnterpriseAuthorizationConfigurationError,
  ValidationError,
} from '../core/errors.js';
import type { EnterpriseAuthorizationConfig, Profile } from '../types/profile.js';

const HTTPS_PROTOCOL = 'https:';
const MAX_ASSERTION_TTL_SECONDS = 300;
const MAX_ASSERTION_SIZE_BYTES = 16384;
const MAX_REPLAY_TTL_SECONDS = 600;
const DEFAULT_CLOCK_SKEW_SECONDS = 60;
const DEFAULT_ALLOWED_ALGS = ['RS256', 'RS384', 'RS512', 'ES256', 'ES384', 'ES512'] as const;

function ensureHttpsUrl(value: string, path: string): void {
  const parsed = new URL(value);
  if (parsed.protocol !== HTTPS_PROTOCOL && process.env.NODE_ENV !== 'test') {
    throw new EnterpriseAuthorizationConfigurationError(`${path} must use https`, { path, value });
  }
}

function ensureUnique(values: string[] | undefined, path: string): void {
  if (!values) {
    return;
  }
  if (new Set(values).size !== values.length) {
    throw new EnterpriseAuthorizationConfigurationError(`${path} must contain unique values`, { path });
  }
}

export function validateEnterpriseAuthorizationProfile(profile: Profile): EnterpriseAuthorizationConfig | undefined {
  const config = profile.enterprise_authorization;
  if (!config) {
    return undefined;
  }
  if (!config.enabled) {
    return { ...config, enabled: false };
  }

  ensureHttpsUrl(config.issuer.issuer, 'enterprise_authorization.issuer.issuer');
  if (config.issuer.jwks_uri) {
    ensureHttpsUrl(config.issuer.jwks_uri, 'enterprise_authorization.issuer.jwks_uri');
  }
  ensureUnique(config.issuer.allowed_kids, 'enterprise_authorization.issuer.allowed_kids');
  ensureUnique(config.token_exchange.allowed_client_ids, 'enterprise_authorization.token_exchange.allowed_client_ids');
  ensureUnique(config.token_exchange.required_typ, 'enterprise_authorization.token_exchange.required_typ');
  ensureUnique(config.token_exchange.required_claims, 'enterprise_authorization.token_exchange.required_claims');

  const normalized: EnterpriseAuthorizationConfig = {
    ...config,
    mode: config.mode ?? (profile.interceptors?.auth ? 'optional' : 'required'),
    issuer: {
      ...config.issuer,
      allowed_algs: config.issuer.allowed_algs ? [...config.issuer.allowed_algs] : [...DEFAULT_ALLOWED_ALGS],
      clock_skew_seconds: config.issuer.clock_skew_seconds ?? DEFAULT_CLOCK_SKEW_SECONDS,
      require_signed_assertions: config.issuer.require_signed_assertions ?? true,
      trust_mode: config.issuer.trust_mode ?? (config.issuer.jwks_uri ? 'explicit' : 'discovery'),
    },
    token_exchange: {
      ...config.token_exchange,
      max_assertion_ttl_seconds: Math.min(config.token_exchange.max_assertion_ttl_seconds ?? MAX_ASSERTION_TTL_SECONDS, MAX_ASSERTION_TTL_SECONDS),
      max_assertion_size_bytes: Math.min(config.token_exchange.max_assertion_size_bytes ?? MAX_ASSERTION_SIZE_BYTES, MAX_ASSERTION_SIZE_BYTES),
      replay_protection_ttl_seconds: Math.min(config.token_exchange.replay_protection_ttl_seconds ?? MAX_REPLAY_TTL_SECONDS, MAX_REPLAY_TTL_SECONDS),
    },
    access_policy: {
      allow_dynamic_client_registration: config.access_policy?.allow_dynamic_client_registration ?? false,
      ...config.access_policy,
    },
  };

  if (normalized.token_exchange.grant_type !== 'urn:ietf:params:oauth:grant-type:jwt-bearer') {
    throw new ValidationError('enterprise_authorization.token_exchange.grant_type must be urn:ietf:params:oauth:grant-type:jwt-bearer');
  }
  if (normalized.access_policy?.scopes_supported && normalized.access_policy.default_scopes?.some((scope) => !normalized.access_policy?.scopes_supported?.includes(scope))) {
    throw new EnterpriseAuthorizationConfigurationError('enterprise_authorization.access_policy.default_scopes must be a subset of scopes_supported');
  }
  if (normalized.access_policy?.scopes_supported && normalized.access_policy.required_scopes?.some((scope) => !normalized.access_policy?.scopes_supported?.includes(scope))) {
    throw new EnterpriseAuthorizationConfigurationError('enterprise_authorization.access_policy.required_scopes must be a subset of scopes_supported');
  }
  if (normalized.access_policy?.claim_mappings) {
    const mappedClaims = Object.values(normalized.access_policy.claim_mappings).filter((value): value is string => typeof value === 'string');
    const requiredClaims = new Set(normalized.token_exchange.required_claims ?? []);
    for (const claim of mappedClaims) {
      requiredClaims.add(claim);
    }
    normalized.token_exchange.required_claims = [...requiredClaims];
  }
  if (normalized.metadata?.authorization_servers) {
    for (const url of normalized.metadata.authorization_servers) {
      ensureHttpsUrl(url, 'enterprise_authorization.metadata.authorization_servers');
    }
  }
  if (normalized.metadata?.documentation_url) {
    ensureHttpsUrl(normalized.metadata.documentation_url, 'enterprise_authorization.metadata.documentation_url');
  }
  if (normalized.resource && normalized.audience) {
    const audiences = Array.isArray(normalized.audience) ? normalized.audience : [normalized.audience];
    if (!audiences.includes(normalized.resource)) {
      throw new EnterpriseAuthorizationConfigurationError(
        'enterprise_authorization.resource must be included in audience when both are configured'
      );
    }
  }
  if (normalized.mode === 'required' && profile.interceptors?.auth) {
    const authConfigs = Array.isArray(profile.interceptors.auth) ? profile.interceptors.auth : [profile.interceptors.auth];
    if (authConfigs.some((auth) => auth.type === 'oauth')) {
      throw new EnterpriseAuthorizationConfigurationError(
        'enterprise_authorization.mode=required cannot be combined with profile oauth auth metadata'
      );
    }
  }
  if (normalized.access_policy?.allow_dynamic_client_registration === false && !(normalized.token_exchange.allowed_client_ids?.length)) {
    throw new EnterpriseAuthorizationConfigurationError(
      'enterprise_authorization.token_exchange.allowed_client_ids is required when dynamic client registration is disabled'
    );
  }
  return normalized;
}
