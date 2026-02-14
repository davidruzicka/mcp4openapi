/**
 * Profile resolver
 *
 * Why: Allow selecting profiles by ID or alias without hardcoding paths.
 */

import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigurationError } from '../core/errors.js';

export interface ResolvedProfile {
  profileId: string;
  profileName: string;
  profileAliases?: string[];
  profilePath: string;
  specPath: string;
}

export interface ListedProfile {
  profileId: string;
  profileName: string;
  profileAliases: string[];
}

export interface ListedProfileDetails {
  profileId: string;
  profileName: string;
  profileAliases: string[];
  description?: string;
  envVars: string[];
  oauthEnvVars?: string[];
  authMethods: ProfileAuthMethod[];
  apiBaseUrl?: ProfileApiBaseUrl;
}

export interface ProfileApiBaseUrl {
  valueFromEnv?: string;
  defaultValue?: string;
}

export interface ProfileAuthMethod {
  type: 'bearer' | 'query' | 'custom-header' | 'oauth';
  headerName?: string;
  queryParam?: string;
  valueFromEnv?: string;
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
  if (path.isAbsolute(base)) return base;

  if (base !== DEFAULT_PROFILES_DIR) {
    return path.resolve(process.cwd(), base);
  }

  const cwdProfiles = path.resolve(process.cwd(), DEFAULT_PROFILES_DIR);
  if (fs.existsSync(cwdProfiles)) return cwdProfiles;

  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const packageRoot = findPackageRoot(moduleDir);
  if (packageRoot) {
    const packageProfiles = path.join(packageRoot, DEFAULT_PROFILES_DIR);
    if (fs.existsSync(packageProfiles)) return packageProfiles;
  }

  return cwdProfiles;
}

function findPackageRoot(startDir: string): string | null {
  let current = startDir;
  while (true) {
    if (fs.existsSync(path.join(current, 'package.json'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function isProfileJson(data: unknown): data is { profile_name: string; tools: unknown[] } {
  if (!data || typeof data !== 'object') return false;
  const obj = data as Record<string, unknown>;
  return typeof obj.profile_name === 'string' && Array.isArray(obj.tools);
}

function collectEnvVarsFromString(value: string, envVars: Set<string>): void {
  const regex = /\$\{env:([A-Za-z0-9_]+)\}/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(value)) !== null) {
    envVars.add(match[1]);
  }
}

function collectEnvVarsFromAuth(auth: Record<string, unknown>, envVars: Set<string>): void {
  if (typeof auth.value_from_env === 'string' && auth.value_from_env.trim().length > 0) {
    envVars.add(auth.value_from_env.trim());
  }

  const oauthConfig = auth.oauth_config;
  if (oauthConfig && typeof oauthConfig === 'object') {
    for (const value of Object.values(oauthConfig)) {
      if (typeof value === 'string') {
        collectEnvVarsFromString(value, envVars);
      }
    }
  }
}

function extractEnvVars(profile: Record<string, unknown>): string[] {
  const envVars = new Set<string>();
  const interceptors = profile.interceptors;
  if (interceptors && typeof interceptors === 'object') {
    const interceptorsRecord = interceptors as Record<string, unknown>;
    const auth = interceptorsRecord.auth;
    if (Array.isArray(auth)) {
      for (const entry of auth) {
        if (entry && typeof entry === 'object') {
          collectEnvVarsFromAuth(entry as Record<string, unknown>, envVars);
        }
      }
    } else if (auth && typeof auth === 'object') {
      collectEnvVarsFromAuth(auth as Record<string, unknown>, envVars);
    }

    const baseUrl = interceptorsRecord.base_url;
    if (baseUrl && typeof baseUrl === 'object') {
      const baseUrlValueFromEnv = (baseUrl as Record<string, unknown>).value_from_env;
      if (typeof baseUrlValueFromEnv === 'string' && baseUrlValueFromEnv.trim().length > 0) {
        envVars.add(baseUrlValueFromEnv.trim());
      }
    }
  }

  return Array.from(envVars).sort((a, b) => a.localeCompare(b));
}

function extractOauthEnvVars(profile: Record<string, unknown>): string[] {
  const envVars = new Set<string>();
  const interceptors = profile.interceptors;
  if (!interceptors || typeof interceptors !== 'object') {
    return [];
  }

  const auth = (interceptors as Record<string, unknown>).auth;
  const entries = Array.isArray(auth) ? auth : auth ? [auth] : [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    if (record.type !== 'oauth') continue;
    const oauthConfig = record.oauth_config;
    if (!oauthConfig || typeof oauthConfig !== 'object') continue;
    for (const value of Object.values(oauthConfig)) {
      if (typeof value === 'string') {
        collectEnvVarsFromString(value, envVars);
      }
    }
  }

  return Array.from(envVars).sort((a, b) => a.localeCompare(b));
}

function extractApiBaseUrl(profile: Record<string, unknown>): ProfileApiBaseUrl | undefined {
  const interceptors = profile.interceptors;
  if (!interceptors || typeof interceptors !== 'object') {
    return undefined;
  }

  const baseUrl = (interceptors as Record<string, unknown>).base_url;
  if (!baseUrl || typeof baseUrl !== 'object') {
    return undefined;
  }

  const baseUrlRecord = baseUrl as Record<string, unknown>;
  const valueFromEnv = typeof baseUrlRecord.value_from_env === 'string' && baseUrlRecord.value_from_env.trim().length > 0
    ? baseUrlRecord.value_from_env.trim()
    : undefined;
  const defaultValue = typeof baseUrlRecord.default === 'string' && baseUrlRecord.default.trim().length > 0
    ? baseUrlRecord.default.trim()
    : undefined;

  if (!valueFromEnv && !defaultValue) {
    return undefined;
  }

  return {
    valueFromEnv,
    defaultValue,
  };
}

function extractAuthMethods(profile: Record<string, unknown>): ProfileAuthMethod[] {
  const methods: ProfileAuthMethod[] = [];
  const interceptors = profile.interceptors;
  if (!interceptors || typeof interceptors !== 'object') {
    return methods;
  }
  const auth = (interceptors as Record<string, unknown>).auth;
  const entries = Array.isArray(auth) ? auth : auth ? [auth] : [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const type = record.type;
    if (type !== 'bearer' && type !== 'query' && type !== 'custom-header' && type !== 'oauth') {
      continue;
    }
    methods.push({
      type,
      headerName: typeof record.header_name === 'string' ? record.header_name : undefined,
      queryParam: typeof record.query_param === 'string' ? record.query_param : undefined,
      valueFromEnv: typeof record.value_from_env === 'string' ? record.value_from_env : undefined,
    });
  }
  return methods;
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
  const raw = await fsPromises.readFile(profilePath, 'utf-8');
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

async function loadProfileDetails(profilePath: string): Promise<ListedProfileDetails | null> {
  const raw = await fsPromises.readFile(profilePath, 'utf-8');
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
  const description = typeof profile.description === 'string' ? profile.description : undefined;

  return {
    profileId,
    profileName,
    profileAliases: aliases,
    description,
    envVars: extractEnvVars(profile),
    oauthEnvVars: extractOauthEnvVars(profile),
    authMethods: extractAuthMethods(profile),
    apiBaseUrl: extractApiBaseUrl(profile),
  };
}

async function collectProfileFiles(dir: string): Promise<string[]> {
  const entries = await fsPromises.readdir(dir, { withFileTypes: true });
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
    profileAliases: match.aliases,
    profilePath: match.profilePath,
    specPath,
  };
}

export async function listProfiles(profilesDir?: string): Promise<ListedProfile[]> {
  const resolvedDir = normalizeProfilesDir(profilesDir);
  const profiles = await buildProfileIndex(resolvedDir);
  return profiles.map(profile => ({
    profileId: profile.profileId,
    profileName: profile.profileName,
    profileAliases: profile.aliases,
  }));
}

export async function listProfilesDetailed(profilesDir?: string): Promise<ListedProfileDetails[]> {
  const resolvedDir = normalizeProfilesDir(profilesDir);
  let entries: string[];
  try {
    entries = await collectProfileFiles(resolvedDir);
  } catch (error) {
    throw new ConfigurationError('Profiles directory not found', {
      profilesDir: resolvedDir,
      error: String(error),
    });
  }

  const profiles: ListedProfileDetails[] = [];
  for (const filePath of entries) {
    const entry = await loadProfileDetails(filePath);
    if (entry) profiles.push(entry);
  }

  return profiles;
}

export async function resolveProfileDetailsFromPath(profilePath: string): Promise<ListedProfileDetails | null> {
  const resolvedPath = path.isAbsolute(profilePath) ? profilePath : path.resolve(process.cwd(), profilePath);
  return loadProfileDetails(resolvedPath);
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
    profileAliases: entry.aliases,
    profilePath: resolvedPath,
    specPath,
  };
}
