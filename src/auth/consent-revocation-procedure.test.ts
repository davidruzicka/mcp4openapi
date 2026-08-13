/**
 * Lock-in for the operator revocation procedure documented in
 * docs/HTTP-TRANSPORT.md ("Revoking one subject's consent").
 *
 * There is no CLI or admin endpoint yet, so the documented path is appending a
 * revocation line to the evidence file by hand. If that stops working, the
 * documentation becomes a lie and an operator has no way to revoke.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ConsentGate } from './consent-gate.js';
import { computeRulesHash } from './consent-rules-hash.js';
import { FileConsentEvidenceStore } from './consent-evidence-store.js';
import type { AuthorizedPrincipal } from './inbound-auth-principal.js';
import type { ConsentGateConfig } from '../types/profile.js';
import type { Logger } from '../core/logger.js';

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

const ISSUER = 'https://login.microsoftonline.com/tenant-1/v2.0';
const CONFIG: ConsentGateConfig = {
  required: true,
  rules_version: 'v1',
  identity_source: 'profile_oauth',
};

const principal: AuthorizedPrincipal = {
  authType: 'oauth',
  profileId: 'softeria-sharepoint',
  subject: 'entra-oid-1',
  issuer: ISSUER,
  tenantId: 'tenant-1',
  scopes: [],
};

describe('operator revocation procedure', () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'consent-revoke-'));
    filePath = path.join(dir, 'evidence.jsonl');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const buildGate = (store: FileConsentEvidenceStore): ConsentGate =>
    new ConsentGate(
      'softeria-sharepoint',
      CONFIG,
      store,
      (id) => `https://gateway.example/profile/${id}/consent`,
      logger,
      ISSUER,
    );

  it('blocks dispatch after a hand-appended revocation line, and allows a later re-grant', async () => {
    const store = new FileConsentEvidenceStore(filePath, logger);
    const gate = buildGate(store);

    await store.record({
      sub: principal.subject!,
      issuer: ISSUER,
      tenantId: 'tenant-1',
      profileId: 'softeria-sharepoint',
      rules_version: 'v1',
      rules_hash: computeRulesHash(CONFIG),
      granted_at: 1_000,
    });
    await expect(gate.assertConsent(principal)).resolves.toBeUndefined();

    // Exactly the line shape the runbook tells an operator to append.
    fs.appendFileSync(
      filePath,
      `${JSON.stringify({
        type: 'revocation',
        sub: principal.subject,
        issuer: ISSUER,
        tenantId: 'tenant-1',
        profileId: 'softeria-sharepoint',
        revoked_at: 2_000,
        reason: 'offboarded',
      })}\n`,
      'utf8',
    );

    // No cached result, so the next dispatch already sees it.
    await expect(gate.assertConsent(principal)).rejects.toMatchObject({
      name: 'ConsentRequiredError',
      reason: 'revoked',
    });

    // A grant recorded after the revocation wins: the user can consent again
    // through the browser flow without anyone editing the file.
    await store.record({
      sub: principal.subject!,
      issuer: ISSUER,
      tenantId: 'tenant-1',
      profileId: 'softeria-sharepoint',
      rules_version: 'v1',
      rules_hash: computeRulesHash(CONFIG),
      granted_at: 3_000,
    });
    await expect(gate.assertConsent(principal)).resolves.toBeUndefined();
  });

  it('ignores a revocation whose identity does not match the grant exactly', async () => {
    const store = new FileConsentEvidenceStore(filePath, logger);
    const gate = buildGate(store);

    await store.record({
      sub: principal.subject!,
      issuer: ISSUER,
      tenantId: 'tenant-1',
      profileId: 'softeria-sharepoint',
      rules_version: 'v1',
      rules_hash: computeRulesHash(CONFIG),
      granted_at: 1_000,
    });

    // Wrong tenant: the runbook warns that every identity field must match.
    fs.appendFileSync(
      filePath,
      `${JSON.stringify({
        type: 'revocation',
        sub: principal.subject,
        issuer: ISSUER,
        tenantId: 'other-tenant',
        profileId: 'softeria-sharepoint',
        revoked_at: 2_000,
      })}\n`,
      'utf8',
    );

    await expect(gate.assertConsent(principal)).resolves.toBeUndefined();
  });

  it('rejects a malformed revocation line instead of applying it partially', async () => {
    const store = new FileConsentEvidenceStore(filePath, logger);
    const gate = buildGate(store);

    await store.record({
      sub: principal.subject!,
      issuer: ISSUER,
      tenantId: 'tenant-1',
      profileId: 'softeria-sharepoint',
      rules_version: 'v1',
      rules_hash: computeRulesHash(CONFIG),
      granted_at: 1_000,
    });

    // Missing revoked_at: skipped as malformed, so consent still stands. The
    // operator must notice the warning rather than assume the revoke landed.
    fs.appendFileSync(
      filePath,
      `${JSON.stringify({
        type: 'revocation',
        sub: principal.subject,
        issuer: ISSUER,
        tenantId: 'tenant-1',
        profileId: 'softeria-sharepoint',
      })}\n`,
      'utf8',
    );

    await expect(gate.assertConsent(principal)).resolves.toBeUndefined();
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      'Skipped malformed consent evidence lines',
      expect.objectContaining({ skipped: 1 }),
    );
  });
});
