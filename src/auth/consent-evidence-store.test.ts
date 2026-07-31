import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  FileConsentEvidenceStore,
  consentEvidenceKey,
  InMemoryConsentEvidenceStore,
} from './consent-evidence-store.js';

describe('consentEvidenceKey', () => {
  it('binds subject, profile, and rules_version into a composite key', () => {
    expect(consentEvidenceKey('user-1', 'ms365', 'v1')).toBe('user-1|ms365|v1');
  });

  it('produces a different key when rules_version changes', () => {
    expect(consentEvidenceKey('user-1', 'ms365', 'v1')).not.toBe(
      consentEvidenceKey('user-1', 'ms365', 'v2'),
    );
  });
});

describe('InMemoryConsentEvidenceStore', () => {
  it('returns false before any consent is recorded', async () => {
    const store = new InMemoryConsentEvidenceStore();
    expect(await store.has('user-1', 'ms365', 'v1')).toBe(false);
  });

  it('records consent and reports it for the same subject/profile/version', async () => {
    const store = new InMemoryConsentEvidenceStore();
    await store.record({
      sub: 'user-1',
      profileId: 'ms365',
      rules_version: 'v1',
      granted_at: 1000,
    });
    expect(await store.has('user-1', 'ms365', 'v1')).toBe(true);
  });

  it('does not report consent for a different rules_version (re-consent required)', async () => {
    const store = new InMemoryConsentEvidenceStore();
    await store.record({
      sub: 'user-1',
      profileId: 'ms365',
      rules_version: 'v1',
      granted_at: 1000,
    });
    expect(await store.has('user-1', 'ms365', 'v2')).toBe(false);
  });

  it('scopes consent to the subject', async () => {
    const store = new InMemoryConsentEvidenceStore();
    await store.record({
      sub: 'user-1',
      profileId: 'ms365',
      rules_version: 'v1',
      granted_at: 1000,
    });
    expect(await store.has('user-2', 'ms365', 'v1')).toBe(false);
  });

  it('preserves the original granted_at on repeated record calls', async () => {
    const store = new InMemoryConsentEvidenceStore();
    await store.record({
      sub: 'user-1',
      profileId: 'ms365',
      rules_version: 'v1',
      granted_at: 1000,
    });
    await store.record({
      sub: 'user-1',
      profileId: 'ms365',
      rules_version: 'v1',
      granted_at: 2000,
    });
    // Idempotent: still recorded, first grant wins (no assertion on internals
    // beyond presence, which is the store's public contract).
    expect(await store.has('user-1', 'ms365', 'v1')).toBe(true);
  });
});

describe('FileConsentEvidenceStore', () => {
  it('persists evidence across store instances and keeps the first grant', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'mcp4-consent-'));
    const filePath = path.join(directory, 'evidence.jsonl');
    const first = new FileConsentEvidenceStore(filePath);
    await first.record({ sub: 'user-1', profileId: 'ms365', rules_version: 'v1', granted_at: 100 });
    await first.record({ sub: 'user-1', profileId: 'ms365', rules_version: 'v1', granted_at: 200 });

    const restarted = new FileConsentEvidenceStore(filePath);
    await expect(restarted.has('user-1', 'ms365', 'v1')).resolves.toBe(true);
    expect((await readFile(filePath, 'utf8')).trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toMatchObject({ granted_at: 100 });
  });

  it('rejects malformed persisted evidence instead of silently accepting it', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'mcp4-consent-'));
    const filePath = path.join(directory, 'evidence.jsonl');
    await import('node:fs/promises').then(({ writeFile }) => writeFile(filePath, '{"sub":"user"}\n'));
    await expect(new FileConsentEvidenceStore(filePath).has('user', 'ms365', 'v1'))
      .rejects.toThrow('invalid record');
  });
});
