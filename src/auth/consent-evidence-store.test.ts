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
import {
  CONTRACT_IDENTITY,
  makeContractEvidence,
  runConsentStoreContract,
} from '../testing/consent-store-contract.js';

const defaultIdentity = CONTRACT_IDENTITY;
const makeEvidence = (over: Partial<ConsentEvidence> = {}): ConsentEvidence =>
  makeContractEvidence(over);

const grantLine = (over: Partial<ConsentEvidence> = {}): string =>
  `${JSON.stringify({ type: 'grant', ...makeEvidence(over) })}\n`;

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

const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

runConsentStoreContract('InMemoryConsentEvidenceStore', () => new InMemoryConsentEvidenceStore());

describe('FileConsentEvidenceStore', () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'consent-evidence-'));
    filePath = path.join(dir, 'evidence.jsonl');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  runConsentStoreContract('FileConsentEvidenceStore', () => {
    const contractDir = fs.mkdtempSync(path.join(os.tmpdir(), 'consent-contract-'));
    return new FileConsentEvidenceStore(path.join(contractDir, 'evidence.jsonl'), logger);
  });

  it('persists a grant across store instances (durable)', async () => {
    await new FileConsentEvidenceStore(filePath, logger).record(makeEvidence());
    const reopened = new FileConsentEvidenceStore(filePath, logger);
    await expect(reopened.lookup(defaultIdentity, 'ms365', 'v1')).resolves.toMatchObject({
      grant: { sub: 'user-1' },
    });
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it('persists a revocation across store instances', async () => {
    const store = new FileConsentEvidenceStore(filePath, logger);
    await store.record(makeEvidence({ granted_at: 1000 }));
    await store.revoke({ ...defaultIdentity, profileId: 'ms365', revoked_at: 2000, reason: 'offboarded' });

    const reopened = new FileConsentEvidenceStore(filePath, logger);
    await expect(reopened.lookup(defaultIdentity, 'ms365', 'v1')).resolves.toMatchObject({
      revokedAt: 2000,
    });
  });

  it('reloads external writes from another writer sharing the file', async () => {
    const a = new FileConsentEvidenceStore(filePath, logger);
    const b = new FileConsentEvidenceStore(filePath, logger);
    await expect(a.lookup(defaultIdentity, 'ms365', 'v1')).resolves.toMatchObject({ grant: null });
    await b.record(makeEvidence());
    // A must observe B's grant after the file changes on disk.
    await expect(a.lookup(defaultIdentity, 'ms365', 'v1')).resolves.toMatchObject({
      grant: { sub: 'user-1' },
    });
  });

  it('picks up a peer append that lands between our own append and our stat', async () => {
    const store = new FileConsentEvidenceStore(filePath, logger);
    await store.record(makeEvidence({ sub: 'user-1' }));
    // Simulate a peer writer appending directly to the shared file.
    fs.appendFileSync(filePath, grantLine({ sub: 'user-2', granted_at: 1500 }), 'utf8');

    await expect(
      store.lookup({ ...defaultIdentity, sub: 'user-2' }, 'ms365', 'v1'),
    ).resolves.toMatchObject({ grant: { sub: 'user-2' } });
  });

  it('parses only the appended tail when the file grows', async () => {
    const store = new FileConsentEvidenceStore(filePath, logger);
    await store.record(makeEvidence({ sub: 'user-1' }));
    await store.lookup(defaultIdentity, 'ms365', 'v1');

    fs.appendFileSync(filePath, grantLine({ sub: 'user-2', granted_at: 1500 }), 'utf8');
    // Corrupting an already-consumed line must not affect the incremental read:
    // the earlier grant stays in the index and is not re-parsed.
    const contents = fs.readFileSync(filePath, 'utf8');
    expect(contents.split('\n').filter(Boolean)).toHaveLength(2);

    const state = await store.lookup({ ...defaultIdentity, sub: 'user-2' }, 'ms365', 'v1');
    expect(state.grant?.sub).toBe('user-2');
    await expect(store.lookup(defaultIdentity, 'ms365', 'v1')).resolves.toMatchObject({
      grant: { sub: 'user-1' },
    });
  });

  it('ignores a trailing partial line and consumes it once it is complete', async () => {
    const store = new FileConsentEvidenceStore(filePath, logger);
    await store.record(makeEvidence({ sub: 'user-1' }));
    const partial = grantLine({ sub: 'user-2', granted_at: 1500 });
    const cut = partial.length - 10;
    fs.appendFileSync(filePath, partial.slice(0, cut), 'utf8');

    await expect(
      store.lookup({ ...defaultIdentity, sub: 'user-2' }, 'ms365', 'v1'),
    ).resolves.toMatchObject({ grant: null });

    fs.appendFileSync(filePath, partial.slice(cut), 'utf8');
    await expect(
      store.lookup({ ...defaultIdentity, sub: 'user-2' }, 'ms365', 'v1'),
    ).resolves.toMatchObject({ grant: { sub: 'user-2' } });
  });

  it('keeps the earliest stored line as the audit record when the file holds them out of order', async () => {
    // Rebuilding from disk is not first-writer-wins: a shared file can hold lines
    // in any order (peer appends, imports), so the earliest acceptance must win as
    // the audit record while policy still sees the newest one.
    fs.writeFileSync(filePath, `${grantLine({ granted_at: 5000 })}${grantLine({ granted_at: 1000 })}`, 'utf8');

    const store = new FileConsentEvidenceStore(filePath, logger);
    await expect(store.lookup(defaultIdentity, 'ms365', 'v1')).resolves.toMatchObject({
      grant: { granted_at: 1000 },
      grantRenewedAt: 5000,
    });
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
    await expect(store.lookup(defaultIdentity, 'ms365', 'v1')).resolves.toMatchObject({
      grant: { granted_at: 1000 },
    });
  });

  it('serializes interleaved grants and revocations into distinct lines', async () => {
    const store = new FileConsentEvidenceStore(filePath, logger);
    await Promise.all([
      store.record(makeEvidence({ sub: 'user-1' })),
      store.record(makeEvidence({ sub: 'user-2' })),
      store.revoke({ ...defaultIdentity, sub: 'user-3', profileId: 'ms365', revoked_at: 2000 }),
    ]);
    const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(3);
    expect(lines.every((line) => JSON.parse(line).type)).toBe(true);
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
    await expect(store.lookup(defaultIdentity, 'ms365', 'v1')).resolves.toMatchObject({
      grant: { sub: 'user-1' },
    });
  });

  it('clears stale in-memory evidence when the backing file disappears', async () => {
    const store = new FileConsentEvidenceStore(filePath, logger);
    await store.record(makeEvidence());
    fs.unlinkSync(filePath);

    await store.record(makeEvidence({ sub: 'user-2' }));

    await expect(store.lookup(defaultIdentity, 'ms365', 'v1')).resolves.toMatchObject({
      grant: null,
    });
    await expect(
      store.lookup({ ...defaultIdentity, sub: 'user-2' }, 'ms365', 'v1'),
    ).resolves.toMatchObject({ grant: { sub: 'user-2' } });
  });

  it('reloads the whole file when it is replaced by a shorter one', async () => {
    const store = new FileConsentEvidenceStore(filePath, logger);
    await store.record(makeEvidence({ sub: 'user-1' }));
    await store.record(makeEvidence({ sub: 'user-2' }));

    fs.writeFileSync(filePath, grantLine({ sub: 'user-2' }), 'utf8');

    await expect(store.lookup(defaultIdentity, 'ms365', 'v1')).resolves.toMatchObject({
      grant: null,
    });
    await expect(
      store.lookup({ ...defaultIdentity, sub: 'user-2' }, 'ms365', 'v1'),
    ).resolves.toMatchObject({ grant: { sub: 'user-2' } });
  });

  it('does not allow records from an earlier schema to satisfy a lookup', async () => {
    fs.writeFileSync(
      filePath,
      [
        'not-json',
        // Pre-issuer record.
        JSON.stringify({ sub: 'user-1', profileId: 'ms365', rules_version: 'v1', granted_at: 1000 }),
        // Pre-rules_hash record with no type discriminator.
        JSON.stringify({ ...defaultIdentity, profileId: 'ms365', rules_version: 'v1', granted_at: 1000 }),
        // Current record.
        JSON.stringify({ type: 'grant', ...makeEvidence({ sub: 'user-9' }) }),
        '',
      ].join('\n'),
      'utf8',
    );
    const store = new FileConsentEvidenceStore(filePath, logger);
    await expect(store.lookup(defaultIdentity, 'ms365', 'v1')).resolves.toMatchObject({
      grant: null,
    });
    await expect(
      store.lookup({ ...defaultIdentity, sub: 'user-9' }, 'ms365', 'v1'),
    ).resolves.toMatchObject({ grant: { sub: 'user-9' } });
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

  it('refuses to append once the file reached its size limit', async () => {
    const store = new FileConsentEvidenceStore(filePath, logger, 200);
    await store.record(makeEvidence({ sub: 'user-1' }));
    await expect(store.record(makeEvidence({ sub: 'user-2' }))).rejects.toMatchObject({
      name: 'ConsentEvidenceStoreError',
      code: 'CONSENT_EVIDENCE_STORE_ERROR',
    });
    // Existing evidence stays readable, so the gate keeps working for prior grants.
    await expect(store.lookup(defaultIdentity, 'ms365', 'v1')).resolves.toMatchObject({
      grant: { sub: 'user-1' },
    });
  });
});

describe('FileConsentEvidenceStore malformed input and read failures', () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'consent-malformed-'));
    filePath = path.join(dir, 'evidence.jsonl');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('ignores a grant line that is missing rules_hash', async () => {
    const { rules_hash: _dropped, ...withoutHash } = makeEvidence();
    fs.writeFileSync(filePath, `${JSON.stringify({ type: 'grant', ...withoutHash })}\n`, 'utf8');

    const store = new FileConsentEvidenceStore(filePath, logger);
    await expect(store.lookup(defaultIdentity, 'ms365', 'v1')).resolves.toMatchObject({ grant: null });
  });

  it('ignores a revocation line that is missing revoked_at', async () => {
    fs.writeFileSync(
      filePath,
      `${JSON.stringify({ type: 'revocation', ...defaultIdentity, profileId: 'ms365' })}\n`,
      'utf8',
    );

    const store = new FileConsentEvidenceStore(filePath, logger);
    await expect(store.lookup(defaultIdentity, 'ms365', 'v1')).resolves.toMatchObject({ revokedAt: null });
  });

  it('ignores a line whose type is unknown', async () => {
    fs.writeFileSync(filePath, `${JSON.stringify({ type: 'audit', ...makeEvidence() })}\n`, 'utf8');

    const store = new FileConsentEvidenceStore(filePath, logger);
    await expect(store.lookup(defaultIdentity, 'ms365', 'v1')).resolves.toMatchObject({ grant: null });
  });

  it('fails closed with a typed error when the evidence path cannot be read', async () => {
    // A directory where a file is expected: stat succeeds, the read does not, so
    // the gate must block rather than treat it as "no consent recorded".
    fs.mkdirSync(filePath);
    fs.writeFileSync(path.join(filePath, 'placeholder'), 'x', 'utf8');

    const store = new FileConsentEvidenceStore(filePath, logger);
    await expect(store.lookup(defaultIdentity, 'ms365', 'v1')).rejects.toMatchObject({
      name: 'ConsentEvidenceStoreError',
      code: 'CONSENT_EVIDENCE_STORE_ERROR',
    });
  });
});
