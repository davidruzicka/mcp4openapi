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

  it('persists a renewal so re-consent after expiry survives a restart', async () => {
    // B2: a subject whose grant aged out re-consents. The renewal must reach
    // the durable file, otherwise a restart rebuilds the pre-renewal state and
    // the subject stays expired forever.
    const store = new FileConsentEvidenceStore(filePath, logger);
    await store.record(makeEvidence({ granted_at: 1000 }));
    await store.record(makeEvidence({ granted_at: 5000 }));

    const reopened = new FileConsentEvidenceStore(filePath, logger);
    await expect(reopened.lookup(defaultIdentity, 'ms365', 'v1')).resolves.toMatchObject({
      grant: { granted_at: 5000 },
    });
  });

  it('persists a re-acceptance of a rolled-back rules version so the gate passes after restart', async () => {
    // B2: profile rolled back from v2 to v1 and the subject re-accepted v1.
    // The re-acceptance must advance latestGrants durably, otherwise the gate
    // reports rules_rollback in a permanent loop after every restart.
    const store = new FileConsentEvidenceStore(filePath, logger);
    await store.record(makeEvidence({ rules_version: 'v1', granted_at: 1000 }));
    await store.record(
      makeEvidence({ rules_version: 'v2', rules_hash: 'hash-v2', granted_at: 2000 }),
    );
    await store.record(makeEvidence({ rules_version: 'v1', granted_at: 3000 }));

    const reopened = new FileConsentEvidenceStore(filePath, logger);
    const state = await reopened.lookup(defaultIdentity, 'ms365', 'v1');
    expect(state.grant?.granted_at).toBe(3000);
    expect(state.latestGrant?.rules_version).toBe('v1');
  });

  it('rebuilds the latest acceptance when the file holds lines out of order', async () => {
    // A shared file can hold lines in any order (peer appends, imports): the
    // latest acceptance drives policy regardless of line order, and the file
    // itself remains the full audit history.
    fs.writeFileSync(filePath, `${grantLine({ granted_at: 5000 })}${grantLine({ granted_at: 1000 })}`, 'utf8');

    const store = new FileConsentEvidenceStore(filePath, logger);
    await expect(store.lookup(defaultIdentity, 'ms365', 'v1')).resolves.toMatchObject({
      grant: { granted_at: 5000 },
    });
  });

  it('is idempotent for an exact replay and appends a renewal as a new audit line', async () => {
    const store = new FileConsentEvidenceStore(filePath, logger);
    await store.record(makeEvidence({ granted_at: 1000 }));
    await store.record(makeEvidence({ granted_at: 1000 }));
    expect(fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean)).toHaveLength(1);

    await store.record(makeEvidence({ granted_at: 5000 }));
    const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(lines.map((line) => JSON.parse(line).granted_at)).toEqual([1000, 5000]);
  });

  it('serializes concurrent records and keeps duplicate evidence idempotent', async () => {
    const store = new FileConsentEvidenceStore(filePath, logger);
    await Promise.all(
      Array.from({ length: 10 }, () => store.record(makeEvidence({ granted_at: 1000 }))),
    );

    const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    await expect(store.lookup(defaultIdentity, 'ms365', 'v1')).resolves.toMatchObject({
      grant: { granted_at: 1000 },
    });
  });

  it('breaks a latest-grant timestamp tie the same way after a rebuild from file', async () => {
    const store = new FileConsentEvidenceStore(filePath, logger);
    await store.record(makeEvidence({ granted_at: 1000, rules_version: 'v1' }));
    await store.record(
      makeEvidence({ granted_at: 1000, rules_version: 'v2', rules_hash: 'hash-v2' }),
    );
    await expect(store.lookup(defaultIdentity, 'ms365', 'v1')).resolves.toMatchObject({
      latestGrant: { rules_version: 'v2' },
    });

    // Rebuild applies the file lines in order, so the later line wins the tie
    // exactly as the later record call did in the live path.
    const reopened = new FileConsentEvidenceStore(filePath, logger);
    await expect(reopened.lookup(defaultIdentity, 'ms365', 'v1')).resolves.toMatchObject({
      latestGrant: { rules_version: 'v2' },
    });
  });

  it('reloads fully when the file is rewritten in place with different earlier bytes and a larger size', async () => {
    // Simulates an operator hand-edit: same inode, larger file, but the bytes
    // before the old watermark changed, so a tail read would be garbage.
    const store = new FileConsentEvidenceStore(filePath, logger);
    await store.record(makeEvidence({ sub: 'user-1' }));
    await expect(store.lookup(defaultIdentity, 'ms365', 'v1')).resolves.toMatchObject({
      grant: { sub: 'user-1' },
    });

    fs.writeFileSync(
      filePath,
      `${grantLine({ sub: 'user-2', granted_at: 1500 })}${grantLine({ sub: 'user-3', granted_at: 1600 })}`,
      'utf8',
    );

    await expect(store.lookup(defaultIdentity, 'ms365', 'v1')).resolves.toMatchObject({
      grant: null,
    });
    await expect(
      store.lookup({ ...defaultIdentity, sub: 'user-2' }, 'ms365', 'v1'),
    ).resolves.toMatchObject({ grant: { sub: 'user-2' } });
    await expect(
      store.lookup({ ...defaultIdentity, sub: 'user-3' }, 'ms365', 'v1'),
    ).resolves.toMatchObject({ grant: { sub: 'user-3' } });
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

  it('accounts the size limit in bytes, not UTF-16 code units', async () => {
    // Multi-byte content: each 'ž' is one code unit but two UTF-8 bytes, so a
    // code-unit count would let this line slip past the byte cap.
    const evidence = makeEvidence({ sub: `uzivatel-${'ž'.repeat(40)}` });
    const line = `${JSON.stringify({ type: 'grant', ...evidence })}\n`;
    const codeUnits = line.length;
    const bytes = Buffer.byteLength(line, 'utf8');
    expect(bytes).toBeGreaterThan(codeUnits);

    // Cap between the code-unit count and the byte count: must fail closed.
    const tight = new FileConsentEvidenceStore(filePath, logger, codeUnits);
    await expect(tight.record(evidence)).rejects.toMatchObject({
      name: 'ConsentEvidenceStoreError',
      code: 'CONSENT_EVIDENCE_STORE_ERROR',
    });
    expect(fs.existsSync(filePath)).toBe(false);

    // Cap at the exact byte count: must succeed.
    const exact = new FileConsentEvidenceStore(filePath, logger, bytes);
    await expect(exact.record(evidence)).resolves.toBeUndefined();
    expect(fs.statSync(filePath).size).toBe(bytes);
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

  it('appends a revocation even when the file reached its size limit', async () => {
    const store = new FileConsentEvidenceStore(filePath, logger, 200);
    await store.record(makeEvidence({ sub: 'user-1' }));
    await expect(store.record(makeEvidence({ sub: 'user-2' }))).rejects.toMatchObject({
      name: 'ConsentEvidenceStoreError',
    });
    // A revocation is exempt from the cap: rejecting it would keep consent
    // active (fail open) exactly when an operator needs to revoke.
    await expect(
      store.revoke({ ...defaultIdentity, profileId: 'ms365', revoked_at: 2000 }),
    ).resolves.toBeUndefined();
    await expect(store.lookup(defaultIdentity, 'ms365', 'v1')).resolves.toMatchObject({
      revokedAt: 2000,
    });
  });

  it('still bounds a single oversized revocation line', async () => {
    const store = new FileConsentEvidenceStore(filePath, logger, 200);
    await expect(
      store.revoke({
        ...defaultIdentity,
        profileId: 'ms365',
        revoked_at: 2000,
        reason: 'x'.repeat(70_000),
      }),
    ).rejects.toMatchObject({
      name: 'ConsentEvidenceStoreError',
      code: 'CONSENT_EVIDENCE_STORE_ERROR',
    });
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('never serves a transient false denial while a record is in flight', async () => {
    const store = new FileConsentEvidenceStore(filePath, logger);
    await store.record(makeEvidence({ granted_at: 1000 }));
    for (let i = 0; i < 25; i += 1) {
      // Rewrite the file in place so the next read is a full rebuild
      // (clear-then-reload), the window where an unserialized lookup could
      // observe the transient empty index and report a false denial.
      fs.writeFileSync(filePath, grantLine({ granted_at: 1000 + i }), 'utf8');
      const [, state] = await Promise.all([
        store.record(makeEvidence({ granted_at: 2000 + i })),
        store.lookup(defaultIdentity, 'ms365', 'v1'),
      ]);
      expect(state.grant).not.toBeNull();
    }
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

  it('fails closed when a revocation line is missing revoked_at', async () => {
    fs.writeFileSync(
      filePath,
      `${JSON.stringify({ type: 'revocation', ...defaultIdentity, profileId: 'ms365' })}\n`,
      'utf8',
    );

    // Skipping the line would fail open: the revocation would silently stop
    // applying and consent would stay active.
    const store = new FileConsentEvidenceStore(filePath, logger);
    await expect(store.lookup(defaultIdentity, 'ms365', 'v1')).rejects.toMatchObject({
      name: 'ConsentEvidenceStoreError',
      code: 'CONSENT_EVIDENCE_STORE_ERROR',
    });
  });

  it('fails closed on a line that is not valid JSON', async () => {
    // An unparseable line cannot be proven not to be a revocation.
    fs.writeFileSync(filePath, `not-json\n${grantLine()}`, 'utf8');

    const store = new FileConsentEvidenceStore(filePath, logger);
    await expect(store.lookup(defaultIdentity, 'ms365', 'v1')).rejects.toMatchObject({
      name: 'ConsentEvidenceStoreError',
      code: 'CONSENT_EVIDENCE_STORE_ERROR',
    });
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
