import { newDb } from 'pg-mem';
import { afterAll, describe, expect, it } from 'vitest';
import type { Logger } from '../core/logger.js';
import { ConsentEvidenceStoreError } from '../core/errors.js';
import { runConsentStoreContract } from '../testing/consent-store-contract.js';
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
    ).resolves.toEqual({ grant: null, grantRenewedAt: null, latestGrant: null, revokedAt: null });
    expect(ddlCalls).toBe(2);
  });

  it('maps bigint columns arriving as strings back to epoch numbers', async () => {
    const grantRow = {
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
        if (text.includes("type = 'revocation'")) return { rows: [{ revoked_at: '2000' }] };
        return { rows: [grantRow] };
      }),
    });
    const state = await store.lookup({ sub: 's', issuer: 'i', tenantId: null }, 'p', 'v1');
    expect(state.grant?.granted_at).toBe(1000);
    expect(state.grantRenewedAt).toBe(1000);
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
