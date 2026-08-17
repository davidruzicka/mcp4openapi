/**
 * Consent gate profile validator.
 *
 * Turns a misconfigured `consent_gate` into an actionable startup error instead
 * of a silent runtime failure. Mirrors the two-level shape of
 * `client-auth-gate-validator`:
 *
 * - `resolveConsentGateConfig` - config-level: validates `rules_version`,
 *   `identity_source`, and `max_age_days`. Safe to call from any construction
 *   site (no Profile required).
 * - `validateConsentGateProfile` - profile-level: reads `profile.consent_gate`,
 *   validates the OAuth login block including `${env:...}` references, the
 *   upstream MCP requirement, and tenant OAuth compatibility. Called by the
 *   profile loader.
 */

import { ConsentGateConfigurationError } from '../core/errors.js';
import { loadRawTenantsConfigFromEnv } from '../transport/http-tenant-config.js';
import type { AuthInterceptor, ConsentGateConfig, Profile } from '../types/profile.js';

/** Exact-match `${env:VAR}` reference, same pattern as `oauth-provider.ts`. */
const ENV_REF_PATTERN = /^\$\{env:([^}]+)\}$/;

/** Mandatory template placeholder replaced with the server-owned consent block. */
export const CONSENT_BODY_PLACEHOLDER = '{{consent_body}}';

/** OAuth fields required for the consent login flow (must be present and resolvable). */
const REQUIRED_OAUTH_FIELDS = ['issuer', 'client_id', 'redirect_uri'] as const;
/** Optional OAuth fields whose `${env:...}` reference must still resolve when declared. */
const OPTIONAL_OAUTH_FIELDS = ['client_secret'] as const;

function getProfileOAuth(profile: Profile): AuthInterceptor | undefined {
  const auth = profile.interceptors?.auth;
  const configs = auth ? (Array.isArray(auth) ? auth : [auth]) : [];
  return configs.find((config) => config.type === 'oauth');
}

/**
 * Validate and normalize a raw `ConsentGateConfig`.
 *
 * Checks: `required` boolean, `rules_version` non-empty, `identity_source`
 * supported, `max_age_days` a positive integer when set.
 */
export function resolveConsentGateConfig(config: ConsentGateConfig): ConsentGateConfig {
  if (typeof config.required !== 'boolean') {
    throw new ConsentGateConfigurationError(
      "consent_gate.required must be a boolean",
      { path: 'consent_gate.required', value: config.required },
    );
  }

  if (typeof config.rules_version !== 'string' || !config.rules_version.trim()) {
    throw new ConsentGateConfigurationError(
      'consent_gate.rules_version is required and must be a non-empty string',
      { path: 'consent_gate.rules_version' },
    );
  }

  if (config.identity_source !== 'profile_oauth') {
    throw new ConsentGateConfigurationError(
      "consent_gate.identity_source must be 'profile_oauth'",
      { path: 'consent_gate.identity_source' },
    );
  }

  // 0 would silently mean "never expires" and a negative value "always
  // expired" in ConsentGate; both invert or break the admin intent.
  if (
    config.max_age_days !== undefined &&
    (!Number.isInteger(config.max_age_days) || config.max_age_days <= 0)
  ) {
    throw new ConsentGateConfigurationError(
      'consent_gate.max_age_days must be a positive integer number of days',
      { path: 'consent_gate.max_age_days', value: config.max_age_days },
    );
  }

  for (const key of ['accept', 'submit'] as const) {
    const label = config.labels?.[key];
    if (label !== undefined && (typeof label !== 'string' || !label.trim())) {
      throw new ConsentGateConfigurationError(
        `consent_gate.labels.${key} must be a non-empty string when set`,
        { path: `consent_gate.labels.${key}` },
      );
    }
  }

  if (config.template_path !== undefined && (typeof config.template_path !== 'string' || !config.template_path.trim())) {
    throw new ConsentGateConfigurationError(
      'consent_gate.template_path must be a non-empty string when set',
      { path: 'consent_gate.template_path' },
    );
  }

  // The placeholder is where the server injects the security-owned block
  // (approval form / info / expired). A template without it would render a
  // consent page with no way to consent.
  if (config.template !== undefined && !config.template.includes(CONSENT_BODY_PLACEHOLDER)) {
    throw new ConsentGateConfigurationError(
      `consent_gate.template must contain the ${CONSENT_BODY_PLACEHOLDER} placeholder`,
      { path: 'consent_gate.template' },
    );
  }

  // Spread so a newly added ConsentGateConfig field cannot be silently dropped:
  // ProfileLoader writes this result back onto the profile, so a missing field
  // disables the policy it configures with no error.
  return { ...config };
}

/**
 * When an OAuth field carries a `${env:VAR}` reference, the env var must be
 * set: an unresolved reference would make the consent login flow fail at
 * runtime, producing a profile that can never grant consent.
 */
function assertOAuthEnvRefsResolvable(
  oauthConfig: Record<string, unknown>,
  fields: readonly string[],
): void {
  for (const field of fields) {
    const value = oauthConfig[field];
    if (typeof value !== 'string') continue;
    const envVarName = value.match(ENV_REF_PATTERN)?.[1];
    if (envVarName !== undefined && !process.env[envVarName]?.trim()) {
      throw new ConsentGateConfigurationError(
        `profile OAuth ${field} references env var '${envVarName}' which is not set`,
        { path: `interceptors.auth.oauth_config.${field}`, envVar: envVarName },
      );
    }
  }
}

/**
 * Consent identity verification is bound to the profile OAuth provider. A
 * tenant that overrides OAuth introduces a second identity provider with no
 * consent identity verifier, so every tool dispatch under that tenant would
 * block with a confusing denial. Reject the combination at load time.
 */
function assertNoTenantOAuthOverrides(profile: Profile): void {
  const tenantsConfig = loadRawTenantsConfigFromEnv();
  if (!tenantsConfig) return;

  const profileIds = new Set(
    [profile.profile_id, profile.profile_name, ...(profile.profile_aliases ?? [])].filter(
      (value): value is string => typeof value === 'string' && value.length > 0,
    ),
  );

  for (const tenant of tenantsConfig.tenants) {
    if (!Array.isArray(tenant.profile_ids)) continue;
    if (!tenant.profile_ids.some((id) => profileIds.has(id))) continue;

    const tenantAuths = tenant.auth ? (Array.isArray(tenant.auth) ? tenant.auth : [tenant.auth]) : [];
    if (tenant.auth_mode === 'oauth' && tenantAuths.some((auth) => auth.type === 'oauth')) {
      throw new ConsentGateConfigurationError(
        `consent_gate.required=true is incompatible with a tenant OAuth override (tenant '${tenant.tenant_id}'): ` +
        'consent identity verification is bound to the profile OAuth provider only',
        { path: 'consent_gate.required', tenantId: tenant.tenant_id },
      );
    }
  }
}

export function validateConsentGateProfile(profile: Profile): ConsentGateConfig | undefined {
  const config = profile.consent_gate;
  if (!config) return undefined;
  const resolved = resolveConsentGateConfig(config);
  if (!resolved.required) return resolved;

  const oauth = getProfileOAuth(profile);
  if (!oauth?.oauth_config) {
    throw new ConsentGateConfigurationError(
      'consent_gate with identity_source=profile_oauth requires a profile OAuth interceptor',
      { path: 'interceptors.auth' },
    );
  }
  if (!oauth.oauth_config.scopes?.includes('openid')) {
    throw new ConsentGateConfigurationError(
      "profile OAuth must request the 'openid' scope when consent_gate is required",
      { path: 'interceptors.auth.oauth_config.scopes' },
    );
  }
  for (const field of REQUIRED_OAUTH_FIELDS) {
    const value = oauth.oauth_config[field];
    if (typeof value !== 'string' || !value.trim()) {
      throw new ConsentGateConfigurationError(
        `profile OAuth ${field} is required when consent_gate is enabled`,
        { path: `interceptors.auth.oauth_config.${field}` },
      );
    }
  }
  assertOAuthEnvRefsResolvable(
    oauth.oauth_config as unknown as Record<string, unknown>,
    [...REQUIRED_OAUTH_FIELDS, ...OPTIONAL_OAUTH_FIELDS],
  );

  assertNoTenantOAuthOverrides(profile);

  if (!profile.upstream_mcp) {
    throw new ConsentGateConfigurationError(
      'consent_gate.required=true requires an effective upstream_mcp configuration',
      { path: 'consent_gate.required' },
    );
  }
  // Intentional redundancy with the loader's D-02 mutual-exclusion check
  // (profile-loader.ts): this validator runs before D-02 and yields the
  // clearer, consent-specific message for consent-gated profiles.
  if (profile.tools?.length) {
    throw new ConsentGateConfigurationError(
      'consent_gate with required=true supports upstream MCP tools only and cannot define local tools',
      { path: 'tools' },
    );
  }
  return resolved;
}
