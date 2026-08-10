import { describe, expect, it, vi } from 'vitest';

import { ConsentGate } from './consent-gate.js';
import { ConsentRequiredError } from '../core/errors.js';
import { InMemoryConsentEvidenceStore } from './consent-evidence-store.js';
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

const makePrincipal = (
  subject: string,
  overrides: Partial<AuthorizedPrincipal> = {},
): AuthorizedPrincipal => ({
  authType: 'oauth',
  profileId: 'ms365',
  subject,
  issuer: 'https://issuer.example.test/tenant/v2.0',
  tenantId: 'tenant-1',
  scopes: [],
  ...overrides,
});

const requiredConfig: ConsentGateConfig = {
  required: true,
  rules_version: 'v1',
  education_resource: 'https://kb.example.test/ms365',
};

describe('ConsentGate.assertConsent', () => {
  it('passes when consent is not required', async () => {
    const gate = new ConsentGate(
      'ms365',
      { required: false, rules_version: 'v1' },
      new InMemoryConsentEvidenceStore(),
      consentUrlFor,
      makeLogger(),
    );
    await expect(gate.assertConsent(makePrincipal('user-1'))).resolves.toBeUndefined();
  });

  it('passes when consent was already recorded for the subject + rules_version', async () => {
    const store = new InMemoryConsentEvidenceStore();
    await store.record({
      sub: 'user-1',
      issuer: 'https://issuer.example.test/tenant/v2.0',
      tenantId: 'tenant-1',
      profileId: 'ms365',
      rules_version: 'v1',
      granted_at: Date.now(),
    });
    const gate = new ConsentGate('ms365', requiredConfig, store, consentUrlFor, makeLogger());
    await expect(gate.assertConsent(makePrincipal('user-1'))).resolves.toBeUndefined();
  });

  it('throws ConsentRequiredError with machine-readable payload when consent is missing', async () => {
    const gate = new ConsentGate(
      'ms365',
      requiredConfig,
      new InMemoryConsentEvidenceStore(),
      consentUrlFor,
      makeLogger(),
    );

    await expect(gate.assertConsent(makePrincipal('user-1'))).rejects.toMatchObject({
      name: 'ConsentRequiredError',
      code: 'CONSENT_REQUIRED',
      details: {
        profileId: 'ms365',
        rules_version: 'v1',
        consent_url: 'https://mcp.example.test/consent/ms365',
        education_resource: 'https://kb.example.test/ms365',
      },
    });
  });

  it('throws ConsentRequiredError for an anonymous session (no principal)', async () => {
    const gate = new ConsentGate(
      'ms365',
      requiredConfig,
      new InMemoryConsentEvidenceStore(),
      consentUrlFor,
      makeLogger(),
    );
    await expect(gate.assertConsent(null)).rejects.toBeInstanceOf(ConsentRequiredError);
  });

  it('rejects a principal without a verified issuer even when subject consent exists', async () => {
    const store = new InMemoryConsentEvidenceStore();
    await store.record({
      sub: 'user-1',
      issuer: 'https://issuer.example.test/tenant/v2.0',
      tenantId: 'tenant-1',
      profileId: 'ms365',
      rules_version: 'v1',
      granted_at: Date.now(),
    });
    const gate = new ConsentGate('ms365', requiredConfig, store, consentUrlFor, makeLogger());
    await expect(
      gate.assertConsent(makePrincipal('user-1', { issuer: undefined })),
    ).rejects.toBeInstanceOf(ConsentRequiredError);
  });

  it('does not reuse consent from another issuer or tenant', async () => {
    const store = new InMemoryConsentEvidenceStore();
    await store.record({
      sub: 'user-1',
      issuer: 'https://issuer.example.test/tenant/v2.0',
      tenantId: 'tenant-1',
      profileId: 'ms365',
      rules_version: 'v1',
      granted_at: Date.now(),
    });
    const gate = new ConsentGate('ms365', requiredConfig, store, consentUrlFor, makeLogger());

    await expect(
      gate.assertConsent(makePrincipal('user-1', { issuer: 'https://other-issuer.example.test' })),
    ).rejects.toBeInstanceOf(ConsentRequiredError);
    await expect(
      gate.assertConsent(makePrincipal('user-1', { tenantId: 'tenant-2' })),
    ).rejects.toBeInstanceOf(ConsentRequiredError);
  });

  it('blocks after a rules_version bump even if the old version was consented', async () => {
    const store = new InMemoryConsentEvidenceStore();
    await store.record({
      sub: 'user-1',
      issuer: 'https://issuer.example.test/tenant/v2.0',
      tenantId: 'tenant-1',
      profileId: 'ms365',
      rules_version: 'v1',
      granted_at: Date.now(),
    });
    const gate = new ConsentGate(
      'ms365',
      { ...requiredConfig, rules_version: 'v2' },
      store,
      consentUrlFor,
      makeLogger(),
    );
    await expect(gate.assertConsent(makePrincipal('user-1'))).rejects.toBeInstanceOf(
      ConsentRequiredError,
    );
  });
});
