/**
 * Profile admin-description env var parser + resolver.
 *
 * Why: MCP4_PROFILES_DESCRIPTION lets server admins attach an HTML description
 * to each profile (rendered in the HTML index detail card) without editing the
 * profile JSON. Parsed once at startup, fail-fast on bad input.
 *
 * Locked decisions: D-01..D-09 in 03.2-CONTEXT.md.
 */

import { ConfigurationError } from '../core/errors.js';
import type { ListedProfileDetails } from './profile-resolver.js';

export const PROFILES_DESCRIPTION_ENV_VAR = 'MCP4_PROFILES_DESCRIPTION';

/**
 * Parse `MCP4_PROFILES_DESCRIPTION` raw value into a key → description map.
 *
 * Returns `undefined` when the env var is unset or empty (D-08).
 * Throws `ConfigurationError` on invalid JSON (D-07), non-object payload (D-02),
 * or a non-string value (D-02 / D-03).
 *
 * Conflict detection (D-05) is intentionally NOT done here — keys are not
 * required to match profiles; that resolution happens in
 * `resolveProfileAdminDescriptions` once profiles have been loaded.
 *
 * Note: `JSON.parse` collapses literal duplicate keys (e.g. `{"a":1,"a":2}` → `{a:2}`)
 * silently per the JSON spec; this is NOT what D-05 means by "conflict" — D-05
 * is about distinct keys resolving to the same profile.
 *
 * Empty string values are allowed at parse time and are treated as
 * "no description rendered" at render time (Pitfall §6 in research).
 */
export function parseProfilesDescriptionEnv(
  raw: string | undefined
): Map<string, string> | undefined {
  if (!raw || raw.trim().length === 0) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ConfigurationError('MCP4_PROFILES_DESCRIPTION is not valid JSON', {
      envVar: PROFILES_DESCRIPTION_ENV_VAR,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // Reject anything that is not a plain JSON object. typeof null === 'object'
  // and Array.isArray covers the array case explicitly; both must be excluded.
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConfigurationError('MCP4_PROFILES_DESCRIPTION must be a JSON object', {
      envVar: PROFILES_DESCRIPTION_ENV_VAR,
      receivedType: Array.isArray(parsed) ? 'array' : parsed === null ? 'null' : typeof parsed,
    });
  }

  const map = new Map<string, string>();
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== 'string') {
      throw new ConfigurationError('MCP4_PROFILES_DESCRIPTION values must be strings', {
        envVar: PROFILES_DESCRIPTION_ENV_VAR,
        key,
        receivedType: value === null ? 'null' : typeof value,
      });
    }
    if (value.length > 10_000) {
      throw new ConfigurationError(
        'MCP4_PROFILES_DESCRIPTION values must not exceed 10000 characters',
        { envVar: PROFILES_DESCRIPTION_ENV_VAR, key, receivedLength: value.length }
      );
    }
    map.set(key, value);
  }
  return map;
}

/**
 * Resolve a parsed description map against a list of profiles.
 *
 * Each map key is matched against every profile's `profileId`, `profileName`,
 * and every entry of `profileAliases` (D-04). Two distinct keys resolving to the
 * same profile is a `ConfigurationError` (D-05). Keys matching no profile are
 * silently ignored (D-09 — admin may have stale entries for retired profiles).
 *
 * Returns `Map<profileId, description>`. Empty map when input is undefined / empty.
 */
export function resolveProfileAdminDescriptions(
  descriptions: Map<string, string> | undefined,
  profiles: ListedProfileDetails[]
): Map<string, string> {
  const result = new Map<string, string>();
  if (!descriptions || descriptions.size === 0) {
    return result;
  }

  // profileId -> first key that matched; lets us include both keys in the error.
  const firstKeyByProfile = new Map<string, string>();

  for (const [key, description] of descriptions.entries()) {
    for (const profile of profiles) {
      const matches =
        profile.profileId === key ||
        profile.profileName === key ||
        profile.profileAliases.includes(key);
      if (!matches) {
        continue;
      }

      const existingKey = firstKeyByProfile.get(profile.profileId);
      // existingKey !== key guards against a false D-05 conflict when one key
      // matches a profile through multiple attributes simultaneously (e.g.
      // profileId === profileName === key satisfies both conditions for the same key).
      if (existingKey !== undefined && existingKey !== key) {
        throw new ConfigurationError(
          'MCP4_PROFILES_DESCRIPTION has multiple keys resolving to the same profile',
          {
            envVar: PROFILES_DESCRIPTION_ENV_VAR,
            profileId: profile.profileId,
            profileName: profile.profileName,
            conflictingKeys: [existingKey, key].sort(),
          }
        );
      }

      firstKeyByProfile.set(profile.profileId, key);
      result.set(profile.profileId, description);
    }
  }
  return result;
}
