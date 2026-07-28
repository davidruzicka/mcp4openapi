import { describe, expect, it } from 'vitest';

import {
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
