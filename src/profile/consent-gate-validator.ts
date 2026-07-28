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
import type { ConsentGateConfig, ConsentOAuthConfig, Profile } from '../types/profile.js';
import { isUri } from '../validation/validation-utils.js';

// OAuth endpoints carry the authorization-code exchange, so they must always be
// TLS-protected. `redirect_uri` may legitimately use a non-https scheme (custom
// scheme or http://localhost during development), so it is only checked for a
// valid, non-dangerous URL shape.
const HTTPS_URL_FIELDS: Array<keyof ConsentOAuthConfig> = [
  'authorization_endpoint',
  'token_endpoint',
];

function assertHttpsUrl(field: keyof ConsentOAuthConfig, value: string): void {
  if (!isUri(value) || new URL(value).protocol !== 'https:') {
    throw new ConsentGateConfigurationError(
      `consent_gate.oauth.${field} must be a valid https:// URL`,
      { path: `consent_gate.oauth.${field}` },
    );
  }
}

function validateConsentOAuth(oauth: ConsentOAuthConfig): ConsentOAuthConfig {
  const requiredFields: Array<keyof ConsentOAuthConfig> = [
    'authorization_endpoint',
    'token_endpoint',
    'client_id',
    'redirect_uri',
  ];
  for (const field of requiredFields) {
    const value = oauth[field];
    if (typeof value !== 'string' || !value.trim()) {
      throw new ConsentGateConfigurationError(
        `consent_gate.oauth.${field} is required and must be a non-empty string`,
        { path: `consent_gate.oauth.${field}` },
      );
    }
  }

  for (const field of HTTPS_URL_FIELDS) {
    assertHttpsUrl(field, oauth[field] as string);
  }

  if (!isUri(oauth.redirect_uri)) {
    throw new ConsentGateConfigurationError(
      'consent_gate.oauth.redirect_uri must be a valid URL',
      { path: 'consent_gate.oauth.redirect_uri' },
    );
  }

  // Fail-fast: if a client secret env var is referenced, it must be set at load
  // time so operators get an actionable error instead of a runtime OAuth failure.
  if (oauth.client_secret_from_env !== undefined) {
    if (!oauth.client_secret_from_env.trim()) {
      throw new ConsentGateConfigurationError(
        'consent_gate.oauth.client_secret_from_env must be a non-empty env var name when present',
        { path: 'consent_gate.oauth.client_secret_from_env' },
      );
    }
    if (!process.env[oauth.client_secret_from_env]?.trim()) {
      throw new ConsentGateConfigurationError(
        `consent_gate.oauth.client_secret_from_env: env var '${oauth.client_secret_from_env}' is not set`,
        {
          path: 'consent_gate.oauth.client_secret_from_env',
          envVar: oauth.client_secret_from_env,
        },
      );
    }
  }

  return oauth;
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

  // A required gate with no OAuth login can never be satisfied — the human has
  // no way to prove consent. Reject at load time.
  if (config.required && !config.oauth) {
    throw new ConsentGateConfigurationError(
      'consent_gate.oauth is required when consent_gate.required is true',
      { path: 'consent_gate.oauth' },
    );
  }

  const oauth = config.oauth ? validateConsentOAuth(config.oauth) : undefined;

  return {
    required: config.required,
    rules_version: config.rules_version,
    education_resource: config.education_resource,
    rules_summary: config.rules_summary,
    oauth,
  };
}

export function validateConsentGateProfile(profile: Profile): ConsentGateConfig | undefined {
  const config = profile.consent_gate;
  if (!config) return undefined;
  return resolveConsentGateConfig(config);
}
