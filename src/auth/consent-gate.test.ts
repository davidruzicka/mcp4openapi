import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ConsentGate } from './consent-gate.js';
import { ConsentEvidenceStoreError, ConsentRequiredError } from '../core/errors.js';
import { computeRulesHash } from './consent-rules-hash.js';
import {
  FileConsentEvidenceStore,
  InMemoryConsentEvidenceStore,
  type ConsentEvidence,
  type ConsentEvidenceStore,
} from './consent-evidence-store.js';
import type { AuthorizedPrincipal } from './inbound-auth-principal.js';
import type { ConsentGateConfig } from '../types/profile.js';
import type { Logger } from '../core/logger.js';

const makeLogger = (): Logger =>
  ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }) as unknown as Logger;

const consentUrlFor = (profileId: string): string =>
  `https://mcp.example.test/consent/${profileId}`;

const ISSUER = 'https://issuer.example.test/tenant/v2.0';

const makePrincipal = (
  subject: string,
  overrides: Partial<AuthorizedPrincipal> = {},
): AuthorizedPrincipal => ({
  authType: 'oauth',
  profileId: 'ms365',
  subject,
  issuer: ISSUER,
  tenantId: 'tenant-1',
  scopes: [],
  ...overrides,
});

const requiredConfig: ConsentGateConfig = {
  required: true,
  rules_version: 'v1',
  education_resource: 'https://kb.example.test/ms365',
  rules_summary: 'Do not exfiltrate customer data.',
  identity_source: 'profile_oauth',
};

const RULES_HASH = computeRulesHash(requiredConfig);

const makeEvidence = (over: Partial<ConsentEvidence> = {}): ConsentEvidence => ({
  sub: 'user-1',
  issuer: ISSUER,
  tenantId: 'tenant-1',
  profileId: 'ms365',
  rules_version: 'v1',
  rules_hash: RULES_HASH,
  granted_at: Date.now(),
  ...over,
});

/** Assert the gate denied with a specific cause, not merely that it threw. */
const expectDenied = async (promise: Promise<void>, reason: string): Promise<void> => {
  await expect(promise).rejects.toBeInstanceOf(ConsentRequiredError);
  await promise.catch((error: unknown) => {
    expect((error as ConsentRequiredError).reason).toBe(reason);
  });
};

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

const storeFactories: [string, () => ConsentEvidenceStore][] = [
  ['InMemoryConsentEvidenceStore', () => new InMemoryConsentEvidenceStore()],
  [
    'FileConsentEvidenceStore',
    () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'consent-gate-'));
      tempDirs.push(dir);
      return new FileConsentEvidenceStore(path.join(dir, 'evidence.jsonl'), makeLogger());
    },
  ],
];

describe.each(storeFactories)('ConsentGate.assertConsent over %s', (_name, createStore) => {
  const makeGate = (
    store: ConsentEvidenceStore,
    config: ConsentGateConfig = requiredConfig,
    expectedIssuer: string | undefined = ISSUER,
  ): ConsentGate =>
    new ConsentGate('ms365', config, store, consentUrlFor, makeLogger(), expectedIssuer);

  it('passes when consent is not required', async () => {
    const gate = makeGate(createStore(), {
      required: false,
      rules_version: 'v1',
      identity_source: 'profile_oauth',
    });
    await expect(gate.assertConsent(makePrincipal('user-1'))).resolves.toBeUndefined();
  });

  it('passes when consent was recorded for the current rules', async () => {
    const store = createStore();
    await store.record(makeEvidence());
    await expect(makeGate(store).assertConsent(makePrincipal('user-1'))).resolves.toBeUndefined();
  });

  it('blocks an anonymous session', async () => {
    await expectDenied(makeGate(createStore()).assertConsent(null), 'no_principal');
  });

  it('blocks when no evidence exists for the subject', async () => {
    await expectDenied(
      makeGate(createStore()).assertConsent(makePrincipal('user-1')),
      'no_evidence',
    );
  });

  it('blocks a principal without a verified issuer even when subject consent exists', async () => {
    const store = createStore();
    await store.record(makeEvidence());
    await expectDenied(
      makeGate(store).assertConsent(makePrincipal('user-1', { issuer: undefined })),
      'no_principal',
    );
  });

  it('rejects a non-OAuth principal carrying a matching subject and issuer', async () => {
    const store = createStore();
    await store.record(makeEvidence());
    const gate = makeGate(store);
    await expectDenied(
      gate.assertConsent(makePrincipal('user-1', { authType: 'enterprise' })),
      'auth_type_mismatch',
    );
    await expectDenied(
      gate.assertConsent(makePrincipal('user-1', { authType: 'token' })),
      'auth_type_mismatch',
    );
  });

  it('rejects a principal from another issuer', async () => {
    const store = createStore();
    await store.record(makeEvidence());
    await expectDenied(
      makeGate(store).assertConsent(
        makePrincipal('user-1', { issuer: 'https://other-issuer.example.test' }),
      ),
      'issuer_mismatch',
    );
  });

  it('treats a trailing-slash issuer as the same issuer at lookup time', async () => {
    const store = createStore();
    await store.record(makeEvidence());
    await expect(
      makeGate(store, requiredConfig, `${ISSUER}/`).assertConsent(
        makePrincipal('user-1', { issuer: `${ISSUER}/` }),
      ),
    ).resolves.toBeUndefined();
  });

  it('does not reuse consent from another tenant', async () => {
    const store = createStore();
    await store.record(makeEvidence());
    await expectDenied(
      makeGate(store).assertConsent(makePrincipal('user-1', { tenantId: 'tenant-2' })),
      'no_evidence',
    );
  });

  it('blocks after a rules_version bump even if the old version was consented', async () => {
    const store = createStore();
    await store.record(makeEvidence());
    const bumped = { ...requiredConfig, rules_version: 'v2' };
    await expectDenied(
      makeGate(store, bumped).assertConsent(makePrincipal('user-1')),
      'no_evidence',
    );
  });

  it('blocks when the rules text changed without a version bump', async () => {
    const store = createStore();
    await store.record(makeEvidence());
    const edited = { ...requiredConfig, rules_summary: 'Updated wording, same version.' };
    await expectDenied(
      makeGate(store, edited).assertConsent(makePrincipal('user-1')),
      'rules_changed',
    );
  });

  it('blocks a rules_version rollback from reactivating the older grant', async () => {
    const store = createStore();
    const v2Config = { ...requiredConfig, rules_version: 'v2' };
    await store.record(makeEvidence({ granted_at: 1000 }));
    await store.record(
      makeEvidence({
        rules_version: 'v2',
        rules_hash: computeRulesHash(v2Config),
        granted_at: 2000,
      }),
    );
    // Profile rolled back to v1: the v1 grant exists and its hash matches, but
    // the subject has since accepted v2, so v1 must not silently apply again.
    await expectDenied(
      makeGate(store).assertConsent(makePrincipal('user-1')),
      'rules_rollback',
    );
  });

  it('blocks after the grant was revoked', async () => {
    const store = createStore();
    await store.record(makeEvidence({ granted_at: 1000 }));
    await store.revoke({
      sub: 'user-1',
      issuer: ISSUER,
      tenantId: 'tenant-1',
      profileId: 'ms365',
      revoked_at: 2000,
      reason: 'operator revoke',
    });
    await expectDenied(makeGate(store).assertConsent(makePrincipal('user-1')), 'revoked');
  });

  it('accepts a grant recorded after an earlier revocation', async () => {
    const store = createStore();
    await store.revoke({
      sub: 'user-1',
      issuer: ISSUER,
      tenantId: 'tenant-1',
      profileId: 'ms365',
      revoked_at: 1000,
    });
    await store.record(makeEvidence({ granted_at: 2000 }));
    await expect(makeGate(store).assertConsent(makePrincipal('user-1'))).resolves.toBeUndefined();
  });

  it('blocks a grant older than max_age_days', async () => {
    const store = createStore();
    const config = { ...requiredConfig, max_age_days: 30 };
    await store.record(
      makeEvidence({
        rules_hash: computeRulesHash(config),
        granted_at: Date.now() - 31 * 24 * 60 * 60 * 1000,
      }),
    );
    await expectDenied(makeGate(store, config).assertConsent(makePrincipal('user-1')), 'expired');
  });

  it('accepts a grant inside max_age_days', async () => {
    const store = createStore();
    const config = { ...requiredConfig, max_age_days: 30 };
    await store.record(
      makeEvidence({
        rules_hash: computeRulesHash(config),
        granted_at: Date.now() - 29 * 24 * 60 * 60 * 1000,
      }),
    );
    await expect(
      makeGate(store, config).assertConsent(makePrincipal('user-1')),
    ).resolves.toBeUndefined();
  });

  it('reflects a revocation immediately, with no cached positive result', async () => {
    const store = createStore();
    await store.record(makeEvidence({ granted_at: 1000 }));
    const gate = makeGate(store);
    await expect(gate.assertConsent(makePrincipal('user-1'))).resolves.toBeUndefined();

    await store.revoke({
      sub: 'user-1',
      issuer: ISSUER,
      tenantId: 'tenant-1',
      profileId: 'ms365',
      revoked_at: 2000,
    });
    await expectDenied(gate.assertConsent(makePrincipal('user-1')), 'revoked');
  });
});

describe('ConsentGate max_age_days boundary semantics', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const NOW = new Date('2026-08-14T12:00:00Z').getTime();

  const makeGateWithGrant = async (
    maxAgeDays: number,
    grantedAt: number,
  ): Promise<ConsentGate> => {
    const config = { ...requiredConfig, max_age_days: maxAgeDays };
    const store = new InMemoryConsentEvidenceStore();
    await store.record(
      makeEvidence({ rules_hash: computeRulesHash(config), granted_at: grantedAt }),
    );
    return new ConsentGate('ms365', config, store, consentUrlFor, makeLogger(), ISSUER);
  };

  afterEach(() => {
    vi.useRealTimers();
  });

  it('treats a grant of exactly max_age_days as still valid (expiry is strictly greater-than)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const gate = await makeGateWithGrant(30, NOW - 30 * DAY_MS);
    await expect(gate.assertConsent(makePrincipal('user-1'))).resolves.toBeUndefined();
  });

  it('expires a grant one millisecond past max_age_days', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const gate = await makeGateWithGrant(30, NOW - 30 * DAY_MS - 1);
    await expectDenied(gate.assertConsent(makePrincipal('user-1')), 'expired');
  });

  it('does not treat max_age_days=0 as "never expires"', async () => {
    // The validator rejects 0, but the gate itself must not invert the intent
    // if such a config ever reaches it: 0 means immediate expiry, not disabled.
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const gate = await makeGateWithGrant(0, NOW - 1);
    await expectDenied(gate.assertConsent(makePrincipal('user-1')), 'expired');
  });
});

describe('ConsentGate rules hash', () => {
  it('exposes the hash a grant must carry, and it changes with the rules text', () => {
    const store = new InMemoryConsentEvidenceStore();
    const gate = new ConsentGate('ms365', requiredConfig, store, consentUrlFor, makeLogger(), ISSUER);
    expect(gate.rulesHash).toBe(computeRulesHash(requiredConfig));

    const edited = new ConsentGate(
      'ms365',
      { ...requiredConfig, rules_summary: 'Different wording.' },
      store,
      consentUrlFor,
      makeLogger(),
      ISSUER,
    );
    expect(edited.rulesHash).not.toBe(gate.rulesHash);
  });

  it('applies no issuer constraint when the profile provides none', async () => {
    const store = new InMemoryConsentEvidenceStore();
    await store.record(makeEvidence({ issuer: 'https://any-issuer.example.test' }));
    const gate = new ConsentGate('ms365', requiredConfig, store, consentUrlFor, makeLogger());

    await expect(
      gate.assertConsent(makePrincipal('user-1', { issuer: 'https://any-issuer.example.test' })),
    ).resolves.toBeUndefined();
  });
});

describe('ConsentGate store failure', () => {
  it('fails closed with the store error when lookup throws', async () => {
    // A broken evidence backend must block dispatch, never degrade to
    // "no consent recorded" or silently allow access.
    const store: ConsentEvidenceStore = {
      record: async () => {},
      revoke: async () => {},
      lookup: async () => {
        throw new ConsentEvidenceStoreError('backend unavailable');
      },
    };
    const gate = new ConsentGate('ms365', requiredConfig, store, consentUrlFor, makeLogger(), ISSUER);
    await expect(gate.assertConsent(makePrincipal('user-1'))).rejects.toBeInstanceOf(
      ConsentEvidenceStoreError,
    );
  });
});

describe('ConsentGate error payload', () => {
  it('carries the machine-readable consent details without leaking the denial cause', async () => {
    const gate = new ConsentGate(
      'ms365',
      requiredConfig,
      new InMemoryConsentEvidenceStore(),
      consentUrlFor,
      makeLogger(),
      ISSUER,
    );

    const error = await gate
      .assertConsent(makePrincipal('user-1', { issuer: 'https://other-issuer.example.test' }))
      .then(() => null)
      .catch((err: unknown) => err as ConsentRequiredError);

    expect(error).toBeInstanceOf(ConsentRequiredError);
    expect(error!.reason).toBe('issuer_mismatch');
    expect(error!.details).toEqual({
      profileId: 'ms365',
      rules_version: 'v1',
      consent_url: 'https://mcp.example.test/consent/ms365',
      education_resource: 'https://kb.example.test/ms365',
    });
    // The client-visible payload must not disclose which check failed.
    expect(JSON.stringify(error!.details)).not.toContain('issuer_mismatch');
  });

  it('logs the denial reason without raw identity values', async () => {
    const logger = makeLogger();
    const gate = new ConsentGate(
      'ms365',
      requiredConfig,
      new InMemoryConsentEvidenceStore(),
      consentUrlFor,
      logger,
      ISSUER,
    );

    await gate.assertConsent(makePrincipal('user-secret-subject')).catch(() => undefined);

    const debug = vi.mocked(logger.debug);
    expect(debug).toHaveBeenCalledTimes(1);
    const [, fields] = debug.mock.calls[0];
    expect(fields).toMatchObject({ reason: 'no_evidence', hasSubject: true, hasIssuer: true });
    const serialized = JSON.stringify(fields);
    expect(serialized).not.toContain('user-secret-subject');
    expect(serialized).not.toContain(ISSUER);
    expect(serialized).not.toContain('tenant-1');
  });
});
