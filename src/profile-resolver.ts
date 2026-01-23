/**
 * Profile resolver
 *
 * Why: Allow selecting profiles by ID or alias without hardcoding paths.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { ConfigurationError } from './errors.js';

export interface ResolvedProfile {
  profileId: string;
  profileName: string;
  profilePath: string;
  specPath: string;
}

interface ProfileIndexEntry {
  profileId: string;
  profileName: string;
  aliases: string[];
  profilePath: string;
  specPathRaw?: string;
}

const DEFAULT_PROFILES_DIR = 'profiles';

function normalizeProfilesDir(profilesDir?: string): string {
  const base = profilesDir && profilesDir.trim().length > 0 ? profilesDir : DEFAULT_PROFILES_DIR;
  return path.isAbsolute(base) ? base : path.resolve(process.cwd(), base);
}

function isProfileJson(data: unknown): data is { profile_name: string; tools: unknown[] } {
  if (!data || typeof data !== 'object') return false;
  const obj = data as Record<string, unknown>;
  return typeof obj.profile_name === 'string' && Array.isArray(obj.tools);
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function normalizeSpecPath(value?: string): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function resolveSpecPath(profilePath: string, specPathRaw?: string, overrideSpecPath?: string): string {
  const trimmed = normalizeSpecPath(specPathRaw);
  if (!trimmed) {
    const override = normalizeSpecPath(overrideSpecPath);
    if (override) {
      return override;
    }
    throw new ConfigurationError('Profile is missing openapi_spec_path', { profilePath });
  }
  if (isHttpUrl(trimmed)) {
    return trimmed;
  }
  return path.isAbsolute(trimmed) ? trimmed : path.resolve(path.dirname(profilePath), trimmed);
}

async function loadProfileIndexEntry(profilePath: string): Promise<ProfileIndexEntry | null> {
  const raw = await fs.readFile(profilePath, 'utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ConfigurationError('Failed to parse profile JSON', {
      profilePath,
      error: String(error),
    });
  }

  if (!isProfileJson(parsed)) {
    return null;
  }

  const profile = parsed as Record<string, unknown>;
  const profileName = profile.profile_name as string;
  const profileId = typeof profile.profile_id === 'string' && profile.profile_id.trim().length > 0
    ? profile.profile_id
    : profileName;
  const aliases = Array.isArray(profile.profile_aliases)
    ? profile.profile_aliases.filter((alias): alias is string => typeof alias === 'string')
    : [];

  return {
    profileId,
    profileName,
    aliases,
    profilePath,
    specPathRaw: typeof profile.openapi_spec_path === 'string' ? profile.openapi_spec_path : undefined,
  };
}

async function collectProfileFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectProfileFiles(fullPath));
      continue;
    }
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.json')) continue;
    if (entry.name.endsWith('.test.json')) continue;
    files.push(fullPath);
  }

  return files;
}

async function buildProfileIndex(profilesDir: string): Promise<ProfileIndexEntry[]> {
  let entries: string[];
  try {
    entries = await collectProfileFiles(profilesDir);
  } catch (error) {
    throw new ConfigurationError('Profiles directory not found', {
      profilesDir,
      error: String(error),
    });
  }

  const profiles: ProfileIndexEntry[] = [];
  for (const filePath of entries) {
    const entry = await loadProfileIndexEntry(filePath);
    if (entry) profiles.push(entry);
  }

  return profiles;
}

function matchProfiles(profileId: string, profiles: ProfileIndexEntry[]): ProfileIndexEntry[] {
  return profiles.filter(profile => {
    if (profile.profileId === profileId) return true;
    if (profile.profileName === profileId) return true;
    return profile.aliases.includes(profileId);
  });
}

export async function resolveProfileById(
  profileId: string,
  profilesDir?: string,
  options?: { specPathOverride?: string }
): Promise<ResolvedProfile> {
  const resolvedDir = normalizeProfilesDir(profilesDir);
  const profiles = await buildProfileIndex(resolvedDir);
  const matches = matchProfiles(profileId, profiles);

  if (matches.length === 0) {
    throw new ConfigurationError('Profile not found', { profileId, profilesDir: resolvedDir });
  }

  if (matches.length > 1) {
    throw new ConfigurationError('Profile ID or alias is not unique', {
      profileId,
      matches: matches.map(m => ({ profileName: m.profileName, profilePath: m.profilePath })),
    });
  }

  const match = matches[0];
  const specPath = resolveSpecPath(match.profilePath, match.specPathRaw, options?.specPathOverride);

  return {
    profileId: match.profileId,
    profileName: match.profileName,
    profilePath: match.profilePath,
    specPath,
  };
}

export async function resolveProfileFromPath(
  profilePath: string,
  options?: { specPathOverride?: string }
): Promise<ResolvedProfile> {
  const resolvedPath = path.isAbsolute(profilePath) ? profilePath : path.resolve(process.cwd(), profilePath);
  const entry = await loadProfileIndexEntry(resolvedPath);

  if (!entry) {
    throw new ConfigurationError('Profile file does not look like a valid profile', { profilePath: resolvedPath });
  }

  const specPath = resolveSpecPath(resolvedPath, entry.specPathRaw, options?.specPathOverride);

  return {
    profileId: entry.profileId,
    profileName: entry.profileName,
    profilePath: resolvedPath,
    specPath,
  };
}
