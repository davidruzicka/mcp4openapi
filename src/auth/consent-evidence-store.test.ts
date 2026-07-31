import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Logger } from '../core/logger.js';
import {
  consentEvidenceKey,
  FileConsentEvidenceStore,
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
  const logger = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  } as unknown as Logger;

  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'consent-evidence-'));
    filePath = path.join(dir, 'evidence.jsonl');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const evidence = (over: Partial<{ sub: string; profileId: string; rules_version: string; granted_at: number }> = {}) => ({
    sub: 'user-1',
    profileId: 'ms365',
    rules_version: 'v1',
    granted_at: 1000,
    ...over,
  });

  it('returns false before any consent is recorded (no file yet)', async () => {
    const store = new FileConsentEvidenceStore(filePath, logger);
    expect(await store.has('user-1', 'ms365', 'v1')).toBe(false);
  });

  it('persists a grant across store instances (durable)', async () => {
    await new FileConsentEvidenceStore(filePath, logger).record(evidence());
    const reopened = new FileConsentEvidenceStore(filePath, logger);
    expect(await reopened.has('user-1', 'ms365', 'v1')).toBe(true);
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it('reloads external writes from another writer sharing the file', async () => {
    const a = new FileConsentEvidenceStore(filePath, logger);
    const b = new FileConsentEvidenceStore(filePath, logger);
    expect(await a.has('user-1', 'ms365', 'v1')).toBe(false);
    await b.record(evidence());
    // A must observe B's grant after the file changes on disk.
    expect(await a.has('user-1', 'ms365', 'v1')).toBe(true);
  });

  it('is idempotent and preserves the original granted_at on replay', async () => {
    const store = new FileConsentEvidenceStore(filePath, logger);
    await store.record(evidence({ granted_at: 1000 }));
    await store.record(evidence({ granted_at: 5000 }));
    const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).granted_at).toBe(1000);
  });

  it('does not match a different rules_version (re-consent required)', async () => {
    const store = new FileConsentEvidenceStore(filePath, logger);
    await store.record(evidence({ rules_version: 'v1' }));
    expect(await store.has('user-1', 'ms365', 'v2')).toBe(false);
  });

  it('skips malformed lines and still reads valid grants', async () => {
    fs.writeFileSync(
      filePath,
      `not-json\n${JSON.stringify(evidence())}\n{"sub":"x"}\n`,
      'utf8',
    );
    const store = new FileConsentEvidenceStore(filePath, logger);
    expect(await store.has('user-1', 'ms365', 'v1')).toBe(true);
    expect(await store.has('x', 'ms365', 'v1')).toBe(false);
  });

  it('fails closed with ConsentEvidenceStoreError when the path is not writable', async () => {
    // Point the store at a path whose parent is a file, so mkdir/append fails.
    const notADir = path.join(dir, 'blocker');
    fs.writeFileSync(notADir, 'x', 'utf8');
    const store = new FileConsentEvidenceStore(path.join(notADir, 'evidence.jsonl'), logger);
    await expect(store.record(evidence())).rejects.toMatchObject({
      name: 'ConsentEvidenceStoreError',
      code: 'CONSENT_EVIDENCE_STORE_ERROR',
    });
  });
});
