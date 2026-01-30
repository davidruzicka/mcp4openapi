import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { loadTestDefinitionSync, validateTestAgainstProfile } from './test-loader.js';
import { ProfileLoader } from '../profile/profile-loader.js';

const profilesDir = path.join(process.cwd(), 'profiles');

function isProfileJsonFile(fileName: string): boolean {
  return (
    fileName.endsWith('.json') &&
    !fileName.endsWith('.test.json') &&
    !fileName.endsWith('schema.json') &&
    !fileName.endsWith('package.json') &&
    !fileName.endsWith('openapi.json')
  );
}

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

function findMissingTestFiles(rootDir: string): string[] {
  const dirs = listProfileDirectories(rootDir);
  const missing: string[] = [];

  for (const dir of dirs) {
    const entries = fs.readdirSync(dir);
    const profileJsonFiles = entries.filter(isProfileJsonFile);
    for (const profileJson of profileJsonFiles) {
      const expectedTest = `${profileJson.slice(0, -'.json'.length)}.test.json`;
      if (!entries.includes(expectedTest)) {
        missing.push(path.join(dir, expectedTest));
      }
    }
  }

  return missing;
}

function resolveProfilePath(testFile: string): string {
  const dir = path.dirname(testFile);
  const testFileName = path.basename(testFile);
  let profileJsonName = testFileName.replace('.test.json', '.json');

  const files = fs.readdirSync(dir);
  if (!files.includes(profileJsonName)) {
    const candidate = files.find((file) => isProfileJsonFile(file));
    if (!candidate) {
      throw new Error(`Could not find corresponding profile JSON for ${testFile}`);
    }
    profileJsonName = candidate;
  }

  return path.join(dir, profileJsonName);
}

describe('Profile test coverage gate', () => {
  it('requires a test definition for each profile JSON', () => {
    const missing = findMissingTestFiles(profilesDir);
    expect(missing).toEqual([]);
  });

  it('detects missing tests when multiple profiles share a directory', () => {
    const tempRoot = fs.mkdtempSync(path.join(process.cwd(), 'tmp-profile-tests-'));
    const profileDir = path.join(tempRoot, 'example');
    fs.mkdirSync(profileDir);
    fs.writeFileSync(path.join(profileDir, 'profile.json'), JSON.stringify({}));
    fs.writeFileSync(path.join(profileDir, 'profile.test.json'), JSON.stringify({}));
    fs.writeFileSync(path.join(profileDir, 'profile-minimal.json'), JSON.stringify({}));

    try {
      const missing = findMissingTestFiles(tempRoot);
      expect(missing).toEqual([path.join(profileDir, 'profile-minimal.test.json')]);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('accepts a test definition per profile JSON in the same directory', () => {
    const tempRoot = fs.mkdtempSync(path.join(process.cwd(), 'tmp-profile-tests-'));
    const profileDir = path.join(tempRoot, 'example');
    fs.mkdirSync(profileDir);
    fs.writeFileSync(path.join(profileDir, 'profile.json'), JSON.stringify({}));
    fs.writeFileSync(path.join(profileDir, 'profile.test.json'), JSON.stringify({}));
    fs.writeFileSync(path.join(profileDir, 'profile-minimal.json'), JSON.stringify({}));
    fs.writeFileSync(path.join(profileDir, 'profile-minimal.test.json'), JSON.stringify({}));

    try {
      const missing = findMissingTestFiles(tempRoot);
      expect(missing).toEqual([]);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
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
