import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ProfileRegistry } from './profile-registry.js';
import type { ResolvedProfile } from './profile-resolver.js';
import { parseProfileAllowlistConfig, parseProfileHidelistConfig } from './profile-filters.js';

async function writeJson(filePath: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

async function createTempDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'mcp4-profiles-'));
}

describe('ProfileRegistry', () => {
  it('adds default profile to index list when missing', async () => {
    const root = await createTempDir();
    const profilesDir = path.join(root, 'profiles');
    const listedProfilePath = path.join(profilesDir, 'listed.json');
    const defaultProfilePath = path.join(root, 'default.json');

    await writeJson(listedProfilePath, {
      profile_name: 'listed',
      profile_id: 'listed',
      openapi_spec_path: './openapi.yaml',
      tools: [],
    });

    await writeJson(defaultProfilePath, {
      profile_name: 'default',
      profile_id: 'default',
      openapi_spec_path: './openapi.yaml',
      tools: [],
    });

    const defaultProfile: ResolvedProfile = {
      profileId: 'default',
      profileName: 'default',
      profileAliases: [],
      profilePath: defaultProfilePath,
      specPath: './openapi.yaml',
    };

    const registry = new ProfileRegistry({ profilesDir, defaultProfile });
    const profiles = await registry.listProfilesForIndex();
    expect(profiles.map(p => p.profileId)).toEqual(['default', 'listed']);
  });

  it('does not duplicate default profile when already listed', async () => {
    const root = await createTempDir();
    const profilesDir = path.join(root, 'profiles');
    const profilePath = path.join(profilesDir, 'default.json');

    await writeJson(profilePath, {
      profile_name: 'default',
      profile_id: 'default',
      openapi_spec_path: './openapi.yaml',
      tools: [],
    });

    const defaultProfile: ResolvedProfile = {
      profileId: 'default',
      profileName: 'default',
      profileAliases: [],
      profilePath,
      specPath: './openapi.yaml',
    };

    const registry = new ProfileRegistry({ profilesDir, defaultProfile });
    const profiles = await registry.listProfilesForIndex();
    expect(profiles.map(p => p.profileId)).toEqual(['default']);
  });

  it('returns listed profiles when no default profile is configured', async () => {
    const root = await createTempDir();
    const profilesDir = path.join(root, 'profiles');

    await writeJson(path.join(profilesDir, 'listed.json'), {
      profile_name: 'listed',
      profile_id: 'listed',
      openapi_spec_path: './openapi.yaml',
      tools: [],
    });

    const registry = new ProfileRegistry({ profilesDir });
    const profiles = await registry.listProfilesForIndex();
    expect(profiles.map(p => p.profileId)).toEqual(['listed']);
  });

  it('returns listed profiles when default profile details cannot be loaded', async () => {
    const root = await createTempDir();
    const profilesDir = path.join(root, 'profiles');
    const listedProfilePath = path.join(profilesDir, 'listed.json');
    const defaultProfilePath = path.join(root, 'invalid.json');

    await writeJson(listedProfilePath, {
      profile_name: 'listed',
      profile_id: 'listed',
      openapi_spec_path: './openapi.yaml',
      tools: [],
    });

    await writeJson(defaultProfilePath, { profile_name: 'invalid' });

    const defaultProfile: ResolvedProfile = {
      profileId: 'invalid',
      profileName: 'invalid',
      profileAliases: [],
      profilePath: defaultProfilePath,
      specPath: './openapi.yaml',
    };

    const registry = new ProfileRegistry({ profilesDir, defaultProfile });
    const profiles = await registry.listProfilesForIndex();
    expect(profiles.map(p => p.profileId)).toEqual(['listed']);
  });

  it('filters profiles using allowlist names and regex', async () => {
    const root = await createTempDir();
    const profilesDir = path.join(root, 'profiles');

    await writeJson(path.join(profilesDir, 'allowed.json'), {
      profile_name: 'allowed',
      profile_id: 'allowed',
      profile_aliases: ['alias-ok'],
      openapi_spec_path: './openapi.yaml',
      tools: [],
    });

    await writeJson(path.join(profilesDir, 'regex.json'), {
      profile_name: 'regex-match',
      profile_id: 'regex-match',
      openapi_spec_path: './openapi.yaml',
      tools: [],
    });

    await writeJson(path.join(profilesDir, 'blocked.json'), {
      profile_name: 'blocked',
      profile_id: 'blocked',
      openapi_spec_path: './openapi.yaml',
      tools: [],
    });

    const allowlist = parseProfileAllowlistConfig({
      allowNames: 'alias-ok',
      allowNameRegex: '^regex-',
    });

    const registry = new ProfileRegistry({ profilesDir, allowlist });
    const profiles = await registry.listProfilesForIndex();
    expect(profiles.map(p => p.profileId).sort()).toEqual(['allowed', 'regex-match']);

    await expect(registry.resolveProfile('blocked')).rejects.toThrow('Profile not found');
  });

  it('applies allowlist and hidelist together: allowed+hidden profile excluded from index, blocked profile not resolvable', async () => {
    const root = await createTempDir();
    const profilesDir = path.join(root, 'profiles');

    await writeJson(path.join(profilesDir, 'public.json'), {
      profile_name: 'public',
      profile_id: 'public',
      openapi_spec_path: './openapi.yaml',
      tools: [],
    });

    await writeJson(path.join(profilesDir, 'internal.json'), {
      profile_name: 'internal',
      profile_id: 'internal',
      openapi_spec_path: './openapi.yaml',
      tools: [],
    });

    await writeJson(path.join(profilesDir, 'blocked.json'), {
      profile_name: 'blocked',
      profile_id: 'blocked',
      openapi_spec_path: './openapi.yaml',
      tools: [],
    });

    const allowlist = parseProfileAllowlistConfig({ allowNames: 'public,internal' });
    const hidelist = parseProfileHidelistConfig('internal');
    const registry = new ProfileRegistry({ profilesDir, allowlist, hidelist });

    const profiles = await registry.listProfilesForIndex();
    expect(profiles.map(p => p.profileId)).toEqual(['public']);

    const resolved = await registry.resolveProfile('internal');
    expect(resolved.profileId).toBe('internal');

    await expect(registry.resolveProfile('blocked')).rejects.toThrow('Profile not found');
  });

  it('does not duplicate default profile matched via listed profile alias including default name', async () => {
    const root = await createTempDir();
    const profilesDir = path.join(root, 'profiles');
    const defaultProfilePath = path.join(root, 'default.json');

    await writeJson(path.join(profilesDir, 'listed.json'), {
      profile_name: 'listed',
      profile_id: 'listed',
      profile_aliases: ['gitlab'],
      openapi_spec_path: './openapi.yaml',
      tools: [],
    });

    await writeJson(defaultProfilePath, {
      profile_name: 'gitlab',
      profile_id: 'gl',
      openapi_spec_path: './openapi.yaml',
      tools: [],
    });

    const defaultProfile: ResolvedProfile = {
      profileId: 'gl',
      profileName: 'gitlab',
      profileAliases: [],
      profilePath: defaultProfilePath,
      specPath: './openapi.yaml',
    };

    const registry = new ProfileRegistry({ profilesDir, defaultProfile });
    const profiles = await registry.listProfilesForIndex();
    expect(profiles.map(p => p.profileId)).toEqual(['listed']);
  });

  it('hides profiles in hidelist from index but keeps them resolvable', async () => {
    const root = await createTempDir();
    const profilesDir = path.join(root, 'profiles');

    await writeJson(path.join(profilesDir, 'visible.json'), {
      profile_name: 'visible',
      profile_id: 'visible',
      openapi_spec_path: './openapi.yaml',
      tools: [],
    });

    await writeJson(path.join(profilesDir, 'hidden.json'), {
      profile_name: 'hidden',
      profile_id: 'hidden',
      openapi_spec_path: './openapi.yaml',
      tools: [],
    });

    const hidelist = parseProfileHidelistConfig('hidden');
    const registry = new ProfileRegistry({ profilesDir, hidelist });

    const profiles = await registry.listProfilesForIndex();
    expect(profiles.map(p => p.profileId)).toEqual(['visible']);

    const resolved = await registry.resolveProfile('hidden');
    expect(resolved.profileId).toBe('hidden');
  });

  it('hides profile by alias from index', async () => {
    const root = await createTempDir();
    const profilesDir = path.join(root, 'profiles');

    await writeJson(path.join(profilesDir, 'legacy.json'), {
      profile_name: 'legacy',
      profile_id: 'legacy',
      profile_aliases: ['old-api'],
      openapi_spec_path: './openapi.yaml',
      tools: [],
    });

    const hidelist = parseProfileHidelistConfig('old-api');
    const registry = new ProfileRegistry({ profilesDir, hidelist });

    const profiles = await registry.listProfilesForIndex();
    expect(profiles).toHaveLength(0);

    const resolved = await registry.resolveProfile('legacy');
    expect(resolved.profileId).toBe('legacy');
  });

  it('hides default profile from index when in hidelist but keeps it functional', async () => {
    const root = await createTempDir();
    const profilesDir = path.join(root, 'profiles');
    const defaultProfilePath = path.join(root, 'default.json');

    await writeJson(path.join(profilesDir, 'other.json'), {
      profile_name: 'other',
      profile_id: 'other',
      openapi_spec_path: './openapi.yaml',
      tools: [],
    });

    await writeJson(defaultProfilePath, {
      profile_name: 'default',
      profile_id: 'default',
      openapi_spec_path: './openapi.yaml',
      tools: [],
    });

    const defaultProfile: ResolvedProfile = {
      profileId: 'default',
      profileName: 'default',
      profileAliases: [],
      profilePath: defaultProfilePath,
      specPath: './openapi.yaml',
    };

    const hidelist = parseProfileHidelistConfig('default');
    const registry = new ProfileRegistry({ profilesDir, defaultProfile, hidelist });

    const profiles = await registry.listProfilesForIndex();
    expect(profiles.map(p => p.profileId)).toEqual(['other']);

    const resolved = await registry.resolveProfile('default');
    expect(resolved.profileId).toBe('default');
  });

  it('resolves default profile via its alias', async () => {
    const root = await createTempDir();
    const defaultProfilePath = path.join(root, 'default.json');

    await writeJson(defaultProfilePath, {
      profile_name: 'my-api',
      profile_id: 'my-api',
      openapi_spec_path: './openapi.yaml',
      tools: [],
    });

    const defaultProfile: ResolvedProfile = {
      profileId: 'my-api',
      profileName: 'my-api',
      profileAliases: ['legacy', 'old-api'],
      profilePath: defaultProfilePath,
      specPath: './openapi.yaml',
    };

    const registry = new ProfileRegistry({ defaultProfile });

    const byAlias = await registry.resolveProfile('legacy');
    expect(byAlias.profileId).toBe('my-api');

    const byAlias2 = await registry.resolveProfile('old-api');
    expect(byAlias2.profileId).toBe('my-api');
  });

  it('deduplicates default profile when listed profile aliases default profileId', async () => {
    const root = await createTempDir();
    const profilesDir = path.join(root, 'profiles');
    const defaultProfilePath = path.join(root, 'default.json');

    await writeJson(path.join(profilesDir, 'wrapper.json'), {
      profile_name: 'wrapper',
      profile_id: 'wrapper',
      profile_aliases: ['my-api'],
      openapi_spec_path: './openapi.yaml',
      tools: [],
    });

    await writeJson(defaultProfilePath, {
      profile_name: 'my-api',
      profile_id: 'my-api',
      openapi_spec_path: './openapi.yaml',
      tools: [],
    });

    const defaultProfile: ResolvedProfile = {
      profileId: 'my-api',
      profileName: 'my-api',
      profileAliases: [],
      profilePath: defaultProfilePath,
      specPath: './openapi.yaml',
    };

    const registry = new ProfileRegistry({ profilesDir, defaultProfile });
    const profiles = await registry.listProfilesForIndex();
    expect(profiles.map(p => p.profileId)).toEqual(['wrapper']);
  });
});
