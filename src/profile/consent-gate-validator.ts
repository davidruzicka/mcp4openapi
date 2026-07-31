/**
 * Consent gate profile validator.
 *
 * Turns a misconfigured `consent_gate` into an actionable startup error instead
 * of a silent runtime failure. Mirrors the two-level shape of
 * `client-auth-gate-validator`:
 *
 * - `resolveConsentGateConfig` — config-level: validates `rules_version`, the
 *   OAuth login block, and referenced env vars. Safe to call from any
 *   construction site (no Profile required).
 * - `validateConsentGateProfile` — profile-level: reads `profile.consent_gate`
 *   and delegates. Called by the profile loader.
 */

import { ConsentGateConfigurationError } from '../core/errors.js';
import type { AuthInterceptor, ConsentGateConfig, Profile } from '../types/profile.js';

function getProfileOAuth(profile: Profile): AuthInterceptor | undefined {
  const auth = profile.interceptors?.auth;
  const configs = auth ? (Array.isArray(auth) ? auth : [auth]) : [];
  return configs.find((config) => config.type === 'oauth');
}

/**
 * Validate and normalize a raw `ConsentGateConfig`.
 *
 * Checks: `rules_version` non-empty; when `required`, an OAuth login block must
 * be present (otherwise consent could never be obtained); OAuth block shape and
 * env var presence.
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

  return {
    required: config.required,
    rules_version: config.rules_version,
    education_resource: config.education_resource,
    rules_summary: config.rules_summary,
    identity_source: config.identity_source,
  };
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
  for (const field of ['issuer', 'client_id', 'redirect_uri'] as const) {
    const value = oauth.oauth_config[field];
    if (typeof value !== 'string' || !value.trim()) {
      throw new ConsentGateConfigurationError(
        `profile OAuth ${field} is required when consent_gate is enabled`,
        { path: `interceptors.auth.oauth_config.${field}` },
      );
    }
  }
  return resolved;
}
