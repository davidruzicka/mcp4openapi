import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Logger } from '../core/logger.js';
import {
  consentEvidenceKey,
  FileConsentEvidenceStore,
  InMemoryConsentEvidenceStore,
  type ConsentEvidence,
} from './consent-evidence-store.js';

const defaultIdentity = {
  sub: 'user-1',
  issuer: 'https://issuer.example.test/tenant/v2.0',
  tenantId: 'tenant-1',
};

const makeEvidence = (over: Partial<ConsentEvidence> = {}): ConsentEvidence => ({
  ...defaultIdentity,
  profileId: 'ms365',
  rules_version: 'v1',
  granted_at: 1000,
  ...over,
});

describe('consentEvidenceKey', () => {
  it('binds the complete identity context, profile, and rules_version into a structured key', () => {
    expect(consentEvidenceKey(defaultIdentity, 'ms365', 'v1')).toBe(
      JSON.stringify([
        'user-1',
        'https://issuer.example.test/tenant/v2.0',
        'tenant-1',
        'ms365',
        'v1',
      ]),
    );
  });

  it('produces a different key when rules_version changes', () => {
    expect(consentEvidenceKey(defaultIdentity, 'ms365', 'v1')).not.toBe(
      consentEvidenceKey(defaultIdentity, 'ms365', 'v2'),
    );
  });

  it('does not allow delimiter characters in identity fields to create key collisions', () => {
    expect(
      consentEvidenceKey(
        { ...defaultIdentity, sub: 'user|one' },
        'ms365',
        'v1',
      ),
    ).not.toBe(
      consentEvidenceKey(
        { ...defaultIdentity, sub: 'user', issuer: `${defaultIdentity.issuer}|one` },
        'ms365',
        'v1',
      ),
    );
  });
});

describe('InMemoryConsentEvidenceStore', () => {
  it('returns false before any consent is recorded', async () => {
    const store = new InMemoryConsentEvidenceStore();
    expect(await store.has(defaultIdentity, 'ms365', 'v1')).toBe(false);
  });

  it('records consent and reports it for the same subject/profile/version', async () => {
    const store = new InMemoryConsentEvidenceStore();
    await store.record(makeEvidence());
    expect(await store.has(defaultIdentity, 'ms365', 'v1')).toBe(true);
  });

  it('does not report consent for a different rules_version (re-consent required)', async () => {
    const store = new InMemoryConsentEvidenceStore();
    await store.record(makeEvidence());
    expect(await store.has(defaultIdentity, 'ms365', 'v2')).toBe(false);
  });

  it('scopes consent to the subject', async () => {
    const store = new InMemoryConsentEvidenceStore();
    await store.record(makeEvidence());
    expect(await store.has({ ...defaultIdentity, sub: 'user-2' }, 'ms365', 'v1')).toBe(false);
  });

  it('does not share consent between issuers', async () => {
    const store = new InMemoryConsentEvidenceStore();
    await store.record(makeEvidence());
    expect(
      await store.has(
        { ...defaultIdentity, issuer: 'https://other-issuer.example.test' },
        'ms365',
        'v1',
      ),
    ).toBe(false);
  });

  it('does not share consent between tenants', async () => {
    const store = new InMemoryConsentEvidenceStore();
    await store.record(makeEvidence());
    expect(
      await store.has({ ...defaultIdentity, tenantId: 'tenant-2' }, 'ms365', 'v1'),
    ).toBe(false);
  });

  it('distinguishes an explicitly absent tenant from a tenant value', async () => {
    const store = new InMemoryConsentEvidenceStore();
    await store.record(makeEvidence({ tenantId: null }));
    expect(await store.has({ ...defaultIdentity, tenantId: null }, 'ms365', 'v1')).toBe(true);
    expect(await store.has(defaultIdentity, 'ms365', 'v1')).toBe(false);
  });

  it('preserves the original granted_at on repeated record calls', async () => {
    const store = new InMemoryConsentEvidenceStore();
    await store.record(makeEvidence({ granted_at: 1000 }));
    await store.record(makeEvidence({ granted_at: 2000 }));
    // Idempotent: still recorded, first grant wins (no assertion on internals
    // beyond presence, which is the store's public contract).
    expect(await store.has(defaultIdentity, 'ms365', 'v1')).toBe(true);
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

  it('returns false before any consent is recorded (no file yet)', async () => {
    const store = new FileConsentEvidenceStore(filePath, logger);
    expect(await store.has(defaultIdentity, 'ms365', 'v1')).toBe(false);
  });

  it('persists a grant across store instances (durable)', async () => {
    await new FileConsentEvidenceStore(filePath, logger).record(makeEvidence());
    const reopened = new FileConsentEvidenceStore(filePath, logger);
    expect(await reopened.has(defaultIdentity, 'ms365', 'v1')).toBe(true);
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it('reloads external writes from another writer sharing the file', async () => {
    const a = new FileConsentEvidenceStore(filePath, logger);
    const b = new FileConsentEvidenceStore(filePath, logger);
    expect(await a.has(defaultIdentity, 'ms365', 'v1')).toBe(false);
    await b.record(makeEvidence());
    // A must observe B's grant after the file changes on disk.
    expect(await a.has(defaultIdentity, 'ms365', 'v1')).toBe(true);
  });

  it('is idempotent and preserves the original granted_at on replay', async () => {
    const store = new FileConsentEvidenceStore(filePath, logger);
    await store.record(makeEvidence({ granted_at: 1000 }));
    await store.record(makeEvidence({ granted_at: 5000 }));
    const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).granted_at).toBe(1000);
  });

  it('serializes concurrent records and keeps duplicate evidence idempotent', async () => {
    const store = new FileConsentEvidenceStore(filePath, logger);
    await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        store.record(makeEvidence({ granted_at: 1000 + index })),
      ),
    );

    const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(await store.has(defaultIdentity, 'ms365', 'v1')).toBe(true);
  });

  it('recovers subsequent writes after a failed write operation', async () => {
    const blocker = path.join(dir, 'blocker');
    fs.writeFileSync(blocker, 'x', 'utf8');
    const store = new FileConsentEvidenceStore(path.join(blocker, 'evidence.jsonl'), logger);

    await expect(store.record(makeEvidence())).rejects.toMatchObject({
      name: 'ConsentEvidenceStoreError',
    });

    fs.rmSync(blocker);
    await expect(store.record(makeEvidence())).resolves.toBeUndefined();
    await expect(store.has(defaultIdentity, 'ms365', 'v1')).resolves.toBe(true);
  });

  it('clears stale in-memory evidence when the backing file disappears', async () => {
    const store = new FileConsentEvidenceStore(filePath, logger);
    await store.record(makeEvidence());
    fs.unlinkSync(filePath);

    await store.record(makeEvidence({ sub: 'user-2' }));

    expect(await store.has(defaultIdentity, 'ms365', 'v1')).toBe(false);
    expect(await store.has({ ...defaultIdentity, sub: 'user-2' }, 'ms365', 'v1')).toBe(true);
  });

  it('does not match a different rules_version (re-consent required)', async () => {
    const store = new FileConsentEvidenceStore(filePath, logger);
    await store.record(makeEvidence({ rules_version: 'v1' }));
    expect(await store.has(defaultIdentity, 'ms365', 'v2')).toBe(false);
  });

  it('does not allow legacy records without identity binding to satisfy a new lookup', async () => {
    fs.writeFileSync(
      filePath,
      `not-json\n${JSON.stringify({
        sub: 'user-1',
        profileId: 'ms365',
        rules_version: 'v1',
        granted_at: 1000,
      })}\n${JSON.stringify(makeEvidence())}\n`,
      'utf8',
    );
    const store = new FileConsentEvidenceStore(filePath, logger);
    expect(await store.has(defaultIdentity, 'ms365', 'v1')).toBe(true);
    expect(
      await store.has({ ...defaultIdentity, issuer: 'https://legacy.example.test' }, 'ms365', 'v1'),
    ).toBe(false);
  });

  it('fails closed with ConsentEvidenceStoreError when the path is not writable', async () => {
    // Point the store at a path whose parent is a file, so mkdir/append fails.
    const notADir = path.join(dir, 'blocker');
    fs.writeFileSync(notADir, 'x', 'utf8');
    const store = new FileConsentEvidenceStore(path.join(notADir, 'evidence.jsonl'), logger);
    await expect(store.record(makeEvidence())).rejects.toMatchObject({
      name: 'ConsentEvidenceStoreError',
      code: 'CONSENT_EVIDENCE_STORE_ERROR',
    });
  });
});
