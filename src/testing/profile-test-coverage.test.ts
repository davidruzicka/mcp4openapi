import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { loadTestDefinitionSync, validateTestAgainstProfile } from './test-loader.js';
import { ProfileLoader } from '../profile-loader.js';

const profilesDir = path.join(process.cwd(), 'profiles');

function listProfileDirectories(rootDir: string): string[] {
  if (!fs.existsSync(rootDir)) return [];
  return fs
    .readdirSync(rootDir)
    .map((entry) => path.join(rootDir, entry))
    .filter((entryPath) => fs.statSync(entryPath).isDirectory());
}

function findTestFiles(rootDir: string): string[] {
  const dirs = listProfileDirectories(rootDir);
  const files: string[] = [];

  for (const dir of dirs) {
    const entries = fs.readdirSync(dir);
    for (const entry of entries) {
      if (entry.endsWith('.test.json')) {
        files.push(path.join(dir, entry));
      }
    }
  }

  return files;
}

function resolveProfilePath(testFile: string): string {
  const dir = path.dirname(testFile);
  const testFileName = path.basename(testFile);
  let profileJsonName = testFileName.replace('.test.json', '.json');

  const files = fs.readdirSync(dir);
  if (!files.includes(profileJsonName)) {
    const candidate = files.find(
      (file) =>
        file.endsWith('.json') &&
        !file.endsWith('.test.json') &&
        !file.endsWith('schema.json') &&
        !file.endsWith('package.json')
    );
    if (!candidate) {
      throw new Error(`Could not find corresponding profile JSON for ${testFile}`);
    }
    profileJsonName = candidate;
  }

  return path.join(dir, profileJsonName);
}

describe('Profile test coverage gate', () => {
  it('ensures each profile directory has a test definition', () => {
    const profileDirs = listProfileDirectories(profilesDir);
    const missing: string[] = [];

    for (const dir of profileDirs) {
      const hasTest = fs.readdirSync(dir).some((file) => file.endsWith('.test.json'));
      if (!hasTest) {
        missing.push(path.basename(dir));
      }
    }

    expect(missing).toEqual([]);
  });

  it('requires full action coverage for each test definition', async () => {
    const testFiles = findTestFiles(profilesDir);
    expect(testFiles.length).toBeGreaterThan(0);

    const profileLoader = new ProfileLoader();

    for (const testFile of testFiles) {
      const testDef = loadTestDefinitionSync(testFile);
      expect(testDef.coverage?.require_all_actions).toBe(true);

      const profilePath = resolveProfilePath(testFile);
      const profile = await profileLoader.load(profilePath);

      expect(() => validateTestAgainstProfile(testDef, profile)).not.toThrow();
    }
  });
});
