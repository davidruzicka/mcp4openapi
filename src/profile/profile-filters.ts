/**
 * Profile allowlist and hidden-profiles helpers for HTTP profile routing.
 */

import { ConfigurationError } from '../core/errors.js';

export interface ProfileAllowlistConfig {
  allowNames: Set<string>;
  allowNameRegex?: RegExp;
}

export interface ProfileIdentity {
  profileId: string;
  profileName: string;
  profileAliases?: string[];
}

function splitCsv(value?: string): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(',')
    .map(entry => entry.trim())
    .filter(entry => entry.length > 0);
}

export function parseProfileAllowlistConfig(options: {
  allowNames?: string;
  allowNameRegex?: string;
}): ProfileAllowlistConfig | null {
  const allowNames = splitCsv(options.allowNames);
  const rawRegex = options.allowNameRegex?.trim();

  let allowNameRegex: RegExp | undefined;
  if (rawRegex && rawRegex.length > 0) {
    try {
      // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp - Finding 692560306: operator-controlled startup config (MCP4_ALLOW_PROFILES_REGEX), not user input.
      // Constructed without flags (no g/y), so lastIndex is always 0 and .test() is stateless.
      allowNameRegex = new RegExp(rawRegex);
    } catch (error) {
      throw new ConfigurationError('Invalid profile allow regex', {
        value: rawRegex,
        error: String(error),
      });
    }
  }

  if (allowNames.length === 0 && !allowNameRegex) {
    return null;
  }

  return {
    allowNames: new Set(allowNames),
    allowNameRegex,
  };
}

function collectProfileNames(profile: ProfileIdentity): string[] {
  const names = new Set<string>();
  names.add(profile.profileId);
  names.add(profile.profileName);
  if (profile.profileAliases) {
    for (const alias of profile.profileAliases) {
      names.add(alias);
    }
  }
  return Array.from(names);
}

export function isProfileAllowed(profile: ProfileIdentity, config: ProfileAllowlistConfig | null): boolean {
  if (!config) {
    return true;
  }

  const candidates = collectProfileNames(profile);
  if (config.allowNames.size > 0) {
    if (candidates.some(name => config.allowNames.has(name))) {
      return true;
    }
  }

  if (config.allowNameRegex) {
    if (candidates.some(name => config.allowNameRegex!.test(name))) {
      return true;
    }
  }

  return false;
}

export function parseHiddenProfilesConfig(hideNames?: string): Set<string> {
  return new Set(splitCsv(hideNames));
}

export function isProfileHidden(profile: ProfileIdentity, hiddenProfiles: ReadonlySet<string>): boolean {
  if (hiddenProfiles.size === 0) {
    return false;
  }
  return collectProfileNames(profile).some(name => hiddenProfiles.has(name));
}
