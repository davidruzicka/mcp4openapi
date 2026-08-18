import { newDb } from 'pg-mem';
import { afterAll, describe, expect, it } from 'vitest';
import type { Logger } from '../core/logger.js';
import { ConsentEvidenceStoreError } from '../core/errors.js';
import {
  CONTRACT_IDENTITY,
  makeContractEvidence,
  runConsentStoreContract,
} from '../testing/consent-store-contract.js';
import {
  PostgresConsentEvidenceStore,
  type ConsentDbClient,
  type PostgresConsentDbConfig,
} from './postgres-consent-evidence-store.js';

const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

const DB_CONFIG: PostgresConsentDbConfig = {
  host: 'unused.example',
  port: 5432,
  database: 'unused',
  user: 'unused',
  password: 'unused',
  ssl: false,
};

function fakeClient(
  query: ConsentDbClient['query'] = async () => ({ rows: [] }),
): ConsentDbClient {
  return { query, end: async () => {} };
}

/** Fresh in-memory Postgres per store: full SQL semantics without a server. */
function memClient(): ConsentDbClient {
  const { Pool } = newDb().adapters.createPg();
  return new Pool() as unknown as ConsentDbClient;
}

describe('PostgresConsentEvidenceStore (unit)', () => {
  it('rejects an invalid table name before touching the database', () => {
    expect(
      () => new PostgresConsentEvidenceStore(DB_CONFIG, logger, {
        client: fakeClient(),
        tableName: 'evil"; DROP TABLE x; --',
      }),
    ).toThrow(ConsentEvidenceStoreError);
  });

  it('wraps query failures in ConsentEvidenceStoreError so the gate fails closed', async () => {
    const store = new PostgresConsentEvidenceStore(DB_CONFIG, logger, {
      client: fakeClient(async () => {
        throw new Error('connection refused');
      }),
    });
    await expect(
      store.lookup({ sub: 's', issuer: 'i', tenantId: null }, 'p', 'v1'),
    ).rejects.toThrow(ConsentEvidenceStoreError);
  });

  it('retries schema initialization after a failure instead of caching it', async () => {
    let ddlCalls = 0;
    const store = new PostgresConsentEvidenceStore(DB_CONFIG, logger, {
      client: fakeClient(async (text) => {
        if (text.startsWith('CREATE TABLE')) {
          ddlCalls += 1;
          if (ddlCalls === 1) throw new Error('transient outage');
          return { rows: [] };
        }
        if (text.includes("type = 'revocation'")) return { rows: [{ revoked_at: null }] };
        return { rows: [] };
      }),
    });
    await expect(
      store.lookup({ sub: 's', issuer: 'i', tenantId: null }, 'p', 'v1'),
    ).rejects.toThrow(ConsentEvidenceStoreError);
    await expect(
      store.lookup({ sub: 's', issuer: 'i', tenantId: null }, 'p', 'v1'),
    ).resolves.toEqual({ grant: null, latestGrant: null, revokedAt: null });
    expect(ddlCalls).toBe(2);
  });

  it('maps bigint columns arriving as strings back to epoch numbers', async () => {
    const grantRow = {
      id: '1',
      sub: 's',
      issuer: 'i',
      tenant_id: null,
      profile_id: 'p',
      rules_version: 'v1',
      rules_hash: 'h',
      granted_at: '1000',
    };
    const store = new PostgresConsentEvidenceStore(DB_CONFIG, logger, {
      client: fakeClient(async (text) => {
        if (text.startsWith('CREATE TABLE')) return { rows: [] };
        if (text.includes("type = 'revocation'")) {
          return { rows: [{ revoked_at: '2000', last_id: '2' }] };
        }
        return { rows: [grantRow] };
      }),
    });
    const state = await store.lookup({ sub: 's', issuer: 'i', tenantId: null }, 'p', 'v1');
    expect(state.grant?.granted_at).toBe(1000);
    expect(state.latestGrant?.granted_at).toBe(1000);
    expect(state.revokedAt).toBe(2000);
  });
});

// Full behavioral contract against an in-memory Postgres emulator (pg-mem):
// real SQL execution, hermetic, runs in every `npm test`.
runConsentStoreContract(
  'PostgresConsentEvidenceStore (pg-mem)',
  () => new PostgresConsentEvidenceStore(DB_CONFIG, logger, { client: memClient() }),
);

describe('PostgresConsentEvidenceStore audit trail and ordering (pg-mem)', () => {
  const setup = () => {
    const client = memClient();
    const store = new PostgresConsentEvidenceStore(DB_CONFIG, logger, { client });
    const grantRows = async () =>
      (await client.query("SELECT * FROM consent_evidence WHERE type = 'grant'")).rows;
    return { client, store, grantRows };
  };

  it('appends one audit row per policy-relevant acceptance and none for a replay', async () => {
    const { store, grantRows } = setup();
    await store.record(makeContractEvidence({ granted_at: 1000 }));
    // Exact replay: no new audit row (an always-insert implementation fails here).
    await store.record(makeContractEvidence({ granted_at: 1000 }));
    expect(await grantRows()).toHaveLength(1);
    // Renewal: a new audit row (a never-insert implementation fails here).
    await store.record(makeContractEvidence({ granted_at: 5000 }));
    expect(await grantRows()).toHaveLength(2);
  });

  it('persists an equal-timestamp re-acceptance of an older rules version as a new audit row', async () => {
    const { store, grantRows } = setup();
    await store.record(makeContractEvidence({ granted_at: 1000, rules_version: 'v1' }));
    await store.record(
      makeContractEvidence({ granted_at: 1000, rules_version: 'v2', rules_hash: 'hash-v2' }),
    );
    // Same timestamp, older version re-accepted: must be inserted so replicas
    // and restarts agree with the in-memory fold (this is the 4.1 repro).
    await store.record(makeContractEvidence({ granted_at: 1000, rules_version: 'v1' }));
    expect(await grantRows()).toHaveLength(3);
    const state = await store.lookup(CONTRACT_IDENTITY, 'ms365', 'v1');
    expect(state.latestGrant?.rules_version).toBe('v1');
  });

  it('blocks with a revocation recorded after a later-stamped grant (insertion order wins)', async () => {
    const { store } = setup();
    // Clock skew stamped the grant AFTER the revocation, but the revocation was
    // recorded later: it must still defeat the grant in the gate's comparison.
    await store.record(makeContractEvidence({ granted_at: 5000 }));
    await store.revoke({ ...CONTRACT_IDENTITY, profileId: 'ms365', revoked_at: 1000 });
    const state = await store.lookup(CONTRACT_IDENTITY, 'ms365', 'v1');
    expect(state.revokedAt).not.toBeNull();
    expect(state.revokedAt!).toBeGreaterThanOrEqual(state.grant!.granted_at);
  });

  it('drops a revocation superseded by a later-recorded grant despite a later stamp', async () => {
    const { store } = setup();
    await store.revoke({ ...CONTRACT_IDENTITY, profileId: 'ms365', revoked_at: 5000 });
    // The grant was recorded after the revocation; its skewed earlier timestamp
    // must not let the stale revocation defeat it.
    await store.record(makeContractEvidence({ granted_at: 1000 }));
    const state = await store.lookup(CONTRACT_IDENTITY, 'ms365', 'v1');
    expect(state.grant?.granted_at).toBe(1000);
    expect(state.revokedAt).toBeNull();
  });
});

// Live-database contract run. Executes only when the deployment variables are
// present (MCP_CONSENTS_DB_HOST/PORT/NAME/USER/PASSWORD); otherwise the suite
// is skipped so `npm test` stays hermetic.
const liveConfig: PostgresConsentDbConfig | null = (() => {
  const { MCP_CONSENTS_DB_HOST, MCP_CONSENTS_DB_PORT, MCP_CONSENTS_DB_NAME, MCP_CONSENTS_DB_USER, MCP_CONSENTS_DB_PASSWORD } = process.env;
  if (!MCP_CONSENTS_DB_HOST || !MCP_CONSENTS_DB_PORT || !MCP_CONSENTS_DB_NAME || !MCP_CONSENTS_DB_USER || !MCP_CONSENTS_DB_PASSWORD) {
    return null;
  }
  return {
    host: MCP_CONSENTS_DB_HOST,
    port: Number.parseInt(MCP_CONSENTS_DB_PORT, 10),
    database: MCP_CONSENTS_DB_NAME,
    user: MCP_CONSENTS_DB_USER,
    password: MCP_CONSENTS_DB_PASSWORD,
    ssl: process.env.MCP_CONSENTS_DB_SSL !== 'false',
  };
})();

describe.runIf(liveConfig !== null)('PostgresConsentEvidenceStore (live database)', () => {
  const stores: PostgresConsentEvidenceStore[] = [];
  const tables: string[] = [];
  let counter = 0;

  const createStore = () => {
    // Unique table per contract test: the contract expects a store that starts
    // empty, and the shared dev database must keep no test residue.
    const tableName = `consent_evidence_test_${process.pid}_${Date.now()}_${counter++}`;
    const store = new PostgresConsentEvidenceStore(liveConfig!, logger, { tableName });
    stores.push(store);
    tables.push(tableName);
    return store;
  };

  afterAll(async () => {
    const cleanup = new PostgresConsentEvidenceStore(liveConfig!, logger, {
      tableName: 'consent_evidence_test_cleanup',
    });
    const client = (cleanup as unknown as { client: ConsentDbClient }).client;
    for (const table of tables) {
      await client.query(`DROP TABLE IF EXISTS ${table}`);
    }
    await cleanup.close();
    await Promise.all(stores.map(store => store.close()));
  });

  runConsentStoreContract('PostgresConsentEvidenceStore', createStore);
});
