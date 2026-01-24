import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { ProfileRegistry } from './profile-registry.js';
import { resolveStartupProfile } from './startup-profile.js';

async function writeJson(filePath: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

async function createTempDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'mcp4-startup-'));
}

describe('startup profile resolution', () => {
  it('prefers profile openapi_spec_path over explicit spec path override', async () => {
    const root = await createTempDir();
    const profilePath = path.join(root, 'profile.json');
    const profileSpecPath = path.join(root, 'openapi.yaml');
    const overrideSpecPath = path.join(root, 'override.yaml');

    await writeJson(profilePath, {
      profile_name: 'override-test',
      openapi_spec_path: './openapi.yaml',
      tools: [],
    });
    await fs.writeFile(profileSpecPath, 'openapi: 3.1.0', 'utf-8');

    const resolved = await resolveStartupProfile({
      specPathEnv: overrideSpecPath,
      profilePath,
    });

    expect(resolved.specPath).toBe(profileSpecPath);
    expect(resolved.specPath).not.toBe(overrideSpecPath);
  });

  it('preserves explicit spec override for HTTP profile routing', async () => {
    const root = await createTempDir();
    const profilesDir = path.join(root, 'profiles');
    const defaultProfilePath = path.join(profilesDir, 'default.json');
    const otherProfilePath = path.join(profilesDir, 'other.json');
    const defaultSpecPath = path.join(profilesDir, 'default-openapi.yaml');
    const overrideSpecPath = path.join(root, 'override-openapi.yaml');

    await writeJson(defaultProfilePath, {
      profile_name: 'default',
      profile_id: 'default',
      openapi_spec_path: './default-openapi.yaml',
      tools: [],
    });
    await writeJson(otherProfilePath, {
      profile_name: 'other',
      profile_id: 'other',
      tools: [],
    });
    await fs.writeFile(defaultSpecPath, 'openapi: 3.1.0', 'utf-8');
    await fs.writeFile(overrideSpecPath, 'openapi: 3.1.0', 'utf-8');

    const resolved = await resolveStartupProfile({
      specPathEnv: overrideSpecPath,
      profilePath: defaultProfilePath,
      profilesDir,
    });

    const registry = new ProfileRegistry({
      profilesDir,
      defaultProfile: resolved.defaultProfile,
      specPathOverride: resolved.hasExplicitSpecPath ? overrideSpecPath : undefined,
    });

    const otherProfile = await registry.resolveProfile('other');
    expect(otherProfile.specPath).toBe(overrideSpecPath);
  });
});
