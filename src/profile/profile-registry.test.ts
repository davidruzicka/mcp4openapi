import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ProfileRegistry } from './profile-registry.js';
import type { ResolvedProfile } from './profile-resolver.js';
import { parseProfileAllowlistConfig } from './profile-allowlist.js';

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
});
