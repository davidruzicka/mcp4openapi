import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

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
});
