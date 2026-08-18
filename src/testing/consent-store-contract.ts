/**
 * Shared behavioral contract for `ConsentEvidenceStore` implementations.
 *
 * Every store must behave identically here, so policy evaluated by
 * `ConsentGate` (rules pinning, revocation, rollback, max age) sees the same
 * inputs regardless of backend. Run it from each implementation's test file.
 */
import { describe, expect, it } from 'vitest';
import type {
  ConsentEvidence,
  ConsentEvidenceStore,
} from '../auth/consent-evidence-store.js';

export const CONTRACT_IDENTITY = {
  sub: 'user-1',
  issuer: 'https://issuer.example.test/tenant/v2.0',
  tenantId: 'tenant-1' as string | null,
};

export const makeContractEvidence = (over: Partial<ConsentEvidence> = {}): ConsentEvidence => ({
  ...CONTRACT_IDENTITY,
  profileId: 'ms365',
  rules_version: 'v1',
  rules_hash: 'hash-v1',
  granted_at: 1000,
  ...over,
});

export function runConsentStoreContract(
  name: string,
  createStore: () => ConsentEvidenceStore,
): void {
  describe(`${name} (ConsentEvidenceStore contract)`, () => {
    it('reports no grant and no revocation before anything is recorded', async () => {
      const store = createStore();
      await expect(store.lookup(CONTRACT_IDENTITY, 'ms365', 'v1')).resolves.toEqual({
        grant: null,
        latestGrant: null,
        revokedAt: null,
      });
    });

    it('returns the grant for the same identity, profile and rules version', async () => {
      const store = createStore();
      await store.record(makeContractEvidence());
      const state = await store.lookup(CONTRACT_IDENTITY, 'ms365', 'v1');
      expect(state.grant).toMatchObject({ sub: 'user-1', rules_version: 'v1', rules_hash: 'hash-v1' });
      expect(state.revokedAt).toBeNull();
    });

    it('does not return a grant for a different rules version but still reports the latest grant', async () => {
      const store = createStore();
      await store.record(makeContractEvidence());
      const state = await store.lookup(CONTRACT_IDENTITY, 'ms365', 'v2');
      expect(state.grant).toBeNull();
      expect(state.latestGrant?.rules_version).toBe('v1');
    });

    it('reports the newest grant as latestGrant so a version rollback is detectable', async () => {
      const store = createStore();
      await store.record(makeContractEvidence({ granted_at: 1000, rules_version: 'v1' }));
      await store.record(makeContractEvidence({ granted_at: 2000, rules_version: 'v2', rules_hash: 'hash-v2' }));
      const state = await store.lookup(CONTRACT_IDENTITY, 'ms365', 'v1');
      expect(state.grant?.rules_version).toBe('v1');
      expect(state.latestGrant?.rules_version).toBe('v2');
    });

    it('scopes consent to the subject', async () => {
      const store = createStore();
      await store.record(makeContractEvidence());
      const state = await store.lookup({ ...CONTRACT_IDENTITY, sub: 'user-2' }, 'ms365', 'v1');
      expect(state.grant).toBeNull();
      expect(state.latestGrant).toBeNull();
    });

    it('does not share consent between issuers', async () => {
      const store = createStore();
      await store.record(makeContractEvidence());
      const state = await store.lookup(
        { ...CONTRACT_IDENTITY, issuer: 'https://other-issuer.example.test' },
        'ms365',
        'v1',
      );
      expect(state.grant).toBeNull();
    });

    it('does not share consent between tenants', async () => {
      const store = createStore();
      await store.record(makeContractEvidence());
      const state = await store.lookup({ ...CONTRACT_IDENTITY, tenantId: 'tenant-2' }, 'ms365', 'v1');
      expect(state.grant).toBeNull();
    });

    it('distinguishes an explicitly absent tenant from a tenant value', async () => {
      const store = createStore();
      await store.record(makeContractEvidence({ tenantId: null }));
      await expect(
        store.lookup({ ...CONTRACT_IDENTITY, tenantId: null }, 'ms365', 'v1'),
      ).resolves.toMatchObject({ grant: { tenantId: null } });
      await expect(store.lookup(CONTRACT_IDENTITY, 'ms365', 'v1')).resolves.toMatchObject({
        grant: null,
      });
    });

    it('does not share consent between profiles', async () => {
      const store = createStore();
      await store.record(makeContractEvidence());
      await expect(store.lookup(CONTRACT_IDENTITY, 'other-profile', 'v1')).resolves.toMatchObject({
        grant: null,
      });
    });

    it('returns the latest acceptance on repeated record calls', async () => {
      const store = createStore();
      await store.record(makeContractEvidence({ granted_at: 1000 }));
      await store.record(makeContractEvidence({ granted_at: 5000 }));
      const state = await store.lookup(CONTRACT_IDENTITY, 'ms365', 'v1');
      // Policy always evaluates the newest acceptance; the durable backend, not
      // the lookup result, keeps earlier acceptances as the audit history.
      expect(state.grant?.granted_at).toBe(5000);
    });

    it('does not move the renewal backwards when a replay arrives out of order', async () => {
      const store = createStore();
      await store.record(makeContractEvidence({ granted_at: 5000 }));
      await store.record(makeContractEvidence({ granted_at: 1000 }));

      const state = await store.lookup(CONTRACT_IDENTITY, 'ms365', 'v1');
      // The latest acceptance never moves backwards: otherwise a revocation
      // between the two timestamps would silently stop applying.
      expect(state.grant?.granted_at).toBe(5000);
    });

    it('accepts a grant recorded after a revocation and reports it as the renewal', async () => {
      const store = createStore();
      await store.record(makeContractEvidence({ granted_at: 1000 }));
      await store.revoke({ ...CONTRACT_IDENTITY, profileId: 'ms365', revoked_at: 2000 });
      await store.record(makeContractEvidence({ granted_at: 3000 }));

      const state = await store.lookup(CONTRACT_IDENTITY, 'ms365', 'v1');
      // The re-acceptance supersedes the revocation and becomes the grant. A
      // backend may report the superseded revocation timestamp (file/in-memory)
      // or drop it entirely (the insertion-ordered Postgres backend); either
      // way it must never defeat the newer acceptance.
      expect(state.grant?.granted_at).toBe(3000);
      if (state.revokedAt !== null) {
        expect(state.revokedAt).toBeLessThan(3000);
      }
    });

    it('breaks a latest-grant tie between rules versions deterministically (later record wins)', async () => {
      const store = createStore();
      await store.record(makeContractEvidence({ granted_at: 1000, rules_version: 'v1' }));
      await store.record(
        makeContractEvidence({ granted_at: 1000, rules_version: 'v2', rules_hash: 'hash-v2' }),
      );
      const state = await store.lookup(CONTRACT_IDENTITY, 'ms365', 'v1');
      // Equal granted_at across versions: the later recorded acceptance defines
      // the active rules version, in every backend.
      expect(state.grant?.rules_version).toBe('v1');
      expect(state.latestGrant?.rules_version).toBe('v2');
    });

    it('records an equal-timestamp re-acceptance of an older rules version as the latest grant', async () => {
      const store = createStore();
      await store.record(makeContractEvidence({ granted_at: 1000, rules_version: 'v1' }));
      await store.record(
        makeContractEvidence({ granted_at: 1000, rules_version: 'v2', rules_hash: 'hash-v2' }),
      );
      await store.record(makeContractEvidence({ granted_at: 1000, rules_version: 'v1' }));
      const state = await store.lookup(CONTRACT_IDENTITY, 'ms365', 'v1');
      // The third record call re-accepts v1 at the same timestamp: it must be
      // persisted and flip latestGrant back to v1 in every backend, otherwise
      // the gate would report a spurious rules_rollback on some backends only.
      expect(state.grant?.rules_version).toBe('v1');
      expect(state.latestGrant?.rules_version).toBe('v1');
    });

    it('records a revocation for the identity and profile without deleting the grant', async () => {
      const store = createStore();
      await store.record(makeContractEvidence({ granted_at: 1000 }));
      await store.revoke({ ...CONTRACT_IDENTITY, profileId: 'ms365', revoked_at: 2000 });
      const state = await store.lookup(CONTRACT_IDENTITY, 'ms365', 'v1');
      expect(state.grant?.granted_at).toBe(1000);
      expect(state.revokedAt).toBe(2000);
    });

    it('keeps the newest revocation timestamp', async () => {
      const store = createStore();
      await store.revoke({ ...CONTRACT_IDENTITY, profileId: 'ms365', revoked_at: 3000 });
      await store.revoke({ ...CONTRACT_IDENTITY, profileId: 'ms365', revoked_at: 2000 });
      await expect(store.lookup(CONTRACT_IDENTITY, 'ms365', 'v1')).resolves.toMatchObject({
        revokedAt: 3000,
      });
    });

    it('scopes a revocation to its own identity and profile', async () => {
      const store = createStore();
      await store.record(makeContractEvidence());
      await store.revoke({ ...CONTRACT_IDENTITY, sub: 'user-2', profileId: 'ms365', revoked_at: 2000 });
      await expect(store.lookup(CONTRACT_IDENTITY, 'ms365', 'v1')).resolves.toMatchObject({
        revokedAt: null,
      });
    });

    it('applies a revocation to every rules version of the identity', async () => {
      const store = createStore();
      await store.record(makeContractEvidence({ rules_version: 'v1', granted_at: 1000 }));
      await store.record(
        makeContractEvidence({ rules_version: 'v2', rules_hash: 'hash-v2', granted_at: 1500 }),
      );
      await store.revoke({ ...CONTRACT_IDENTITY, profileId: 'ms365', revoked_at: 2000 });
      await expect(store.lookup(CONTRACT_IDENTITY, 'ms365', 'v2')).resolves.toMatchObject({
        revokedAt: 2000,
      });
    });
  });
}
