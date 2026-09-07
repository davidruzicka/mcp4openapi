import crypto from 'node:crypto';
import { newDb } from 'pg-mem';
import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../core/logger.js';
import { PendingConsentStoreError } from '../core/errors.js';
import {
  InMemoryPendingConsentStore,
  PostgresPendingConsentStore,
  PENDING_CONSENT_TTL_MS,
  createPendingConsentStore,
  isPendingIdShape,
  pendingIdLogRef,
  type PendingConsentPayload,
  type PendingConsentStore,
} from './pending-consent-store.js';
import type { ConsentDbClient, PostgresConsentDbConfig } from './postgres-consent-evidence-store.js';

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

const MASTER_KEY = crypto.randomBytes(32);

const DB_CONFIG: PostgresConsentDbConfig = {
  host: 'unused.example',
  port: 5432,
  database: 'unused',
  user: 'unused',
  password: 'unused',
  ssl: false,
};

const makePayload = (over: Partial<PendingConsentPayload> = {}): PendingConsentPayload => ({
  profileId: 'ms365',
  identity: { subject: 'user-1', issuer: 'https://issuer.example.test/t/v2.0', tenantId: 't-1' },
  tokens: { access_token: 'upstream-access-secret', refresh_token: 'upstream-refresh-secret' },
  auth: {
    clientId: 'client-1',
    clientRedirectUri: 'http://localhost:3003/oauth/callback',
    codeChallenge: 'challenge',
    originalState: 'client-state',
    scopes: ['openid'],
  },
  rulesHash: 'rules-hash-1',
  createdAt: Date.now(),
  ...over,
});

/** pg-mem-backed client sharing one database across store instances. */
function memBackend(): { client: ConsentDbClient; another: () => ConsentDbClient } {
  const db = newDb();
  const make = (): ConsentDbClient => {
    const { Pool } = db.adapters.createPg();
    return new Pool() as unknown as ConsentDbClient;
  };
  return { client: make(), another: make };
}

type StoreCase = {
  name: string;
  make: (now?: () => number) => PendingConsentStore;
  makeSecond?: (first: PendingConsentStore) => PendingConsentStore;
};

const backendCases: StoreCase[] = [
  {
    name: 'InMemoryPendingConsentStore',
    make: (now) => new InMemoryPendingConsentStore(MASTER_KEY, now),
  },
  {
    name: 'PostgresPendingConsentStore (pg-mem)',
    make: (now) => {
      const backend = memBackend();
      const store = new PostgresPendingConsentStore(DB_CONFIG, MASTER_KEY, logger, {
        client: backend.client,
        now,
      });
      // Expose a sibling factory for the cross-instance test below.
      (store as unknown as { __another: () => ConsentDbClient }).__another = backend.another;
      return store;
    },
  },
];

describe.each(backendCases)('$name contract', ({ make }) => {
  it('round-trips a payload and consumes it exactly once', async () => {
    const store = make();
    const payload = makePayload();
    const pendingId = await store.create(payload);

    expect(isPendingIdShape(pendingId)).toBe(true);
    await expect(store.peek(pendingId, 'ms365')).resolves.toEqual(payload);

    const consumed = await store.consume(pendingId, 'ms365');
    expect(consumed).toEqual(payload);
    // Second consume must lose: entry is gone.
    await expect(store.consume(pendingId, 'ms365')).resolves.toBeNull();
    await expect(store.peek(pendingId, 'ms365')).resolves.toBeNull();
  });

  it('scopes entries to the profile they were created for', async () => {
    const store = make();
    const payload = makePayload();
    const pendingId = await store.create(payload);
    await expect(store.peek(pendingId, 'other-profile')).resolves.toBeNull();
    await expect(store.consume(pendingId, 'other-profile')).resolves.toBeNull();
    // The mismatched consume must not have burned the entry for the right profile.
    await expect(store.peek(pendingId, 'ms365')).resolves.toEqual(payload);
  });

  it('treats expired entries as absent', async () => {
    let clock = 1_000_000;
    const store = make(() => clock);
    const pendingId = await store.create(makePayload());
    clock += PENDING_CONSENT_TTL_MS + 1;
    await expect(store.peek(pendingId, 'ms365')).resolves.toBeNull();
    await expect(store.consume(pendingId, 'ms365')).resolves.toBeNull();
  });

  it('rejects malformed pending ids without touching storage', async () => {
    const store = make();
    await expect(store.consume('short', 'ms365')).resolves.toBeNull();
    await expect(store.peek('../../etc/passwd', 'ms365')).resolves.toBeNull();
  });
});

describe('payload protection', () => {
  it('never stores token material in clear (in-memory)', async () => {
    const store = new InMemoryPendingConsentStore(MASTER_KEY);
    await store.create(makePayload());
    const rows = (store as unknown as { rows: Map<string, { ciphertext: string }> }).rows;
    const stored = [...rows.values()].map((row) => row.ciphertext).join('');
    expect(stored).not.toContain('upstream-access-secret');
    expect(stored).not.toContain('upstream-refresh-secret');
    expect(stored).not.toContain('user-1');
  });

  it('fails closed on a tampered ciphertext instead of reporting absence', async () => {
    const store = new InMemoryPendingConsentStore(MASTER_KEY);
    const pendingId = await store.create(makePayload());
    const rows = (store as unknown as { rows: Map<string, { ciphertext: string }> }).rows;
    for (const row of rows.values()) {
      const envelope = JSON.parse(row.ciphertext) as { data: string };
      const flipped = Buffer.from(envelope.data, 'base64url');
      flipped[0] = flipped[0] ^ 0xff;
      envelope.data = flipped.toString('base64url');
      row.ciphertext = JSON.stringify(envelope);
    }
    await expect(store.consume(pendingId, 'ms365')).rejects.toBeInstanceOf(PendingConsentStoreError);
  });

  it('binds the ciphertext to the pending id via AAD (a swapped row fails authentication)', async () => {
    const store = new InMemoryPendingConsentStore(MASTER_KEY);
    const idA = await store.create(makePayload());
    const idB = await store.create(makePayload({ identity: { subject: 'user-2', issuer: 'https://issuer.example.test/t/v2.0' } }));
    const rows = (store as unknown as { rows: Map<string, { ciphertext: string; profileId: string; expiresAt: number }> }).rows;
    const hashes = [...rows.keys()];
    const [first, second] = hashes;
    const tmp = rows.get(first)!.ciphertext;
    rows.get(first)!.ciphertext = rows.get(second)!.ciphertext;
    rows.get(second)!.ciphertext = tmp;
    await expect(store.consume(idA, 'ms365')).rejects.toBeInstanceOf(PendingConsentStoreError);
    await expect(store.consume(idB, 'ms365')).rejects.toBeInstanceOf(PendingConsentStoreError);
  });
});

describe('PostgresPendingConsentStore', () => {
  it('stores only hashes and ciphertext (a DB dump is not replayable)', async () => {
    const backend = memBackend();
    const store = new PostgresPendingConsentStore(DB_CONFIG, MASTER_KEY, logger, { client: backend.client });
    const pendingId = await store.create(makePayload());
    const raw = await backend.client.query('SELECT id_hash, ciphertext FROM pending_consents');
    expect(raw.rows).toHaveLength(1);
    const dump = JSON.stringify(raw.rows);
    expect(dump).not.toContain(pendingId);
    expect(dump).not.toContain('upstream-access-secret');
  });

  it('consumes exactly once across two store instances over the same database', async () => {
    const backend = memBackend();
    const storeA = new PostgresPendingConsentStore(DB_CONFIG, MASTER_KEY, logger, { client: backend.client });
    const storeB = new PostgresPendingConsentStore(DB_CONFIG, MASTER_KEY, logger, { client: backend.another() });
    const pendingId = await storeA.create(makePayload());

    const first = await storeB.consume(pendingId, 'ms365');
    expect(first).not.toBeNull();
    await expect(storeA.consume(pendingId, 'ms365')).resolves.toBeNull();
  });

  it('sweeps expired rows when a new flow starts', async () => {
    const backend = memBackend();
    let clock = 1_000_000;
    const store = new PostgresPendingConsentStore(DB_CONFIG, MASTER_KEY, logger, {
      client: backend.client,
      now: () => clock,
    });
    await store.create(makePayload());
    clock += PENDING_CONSENT_TTL_MS + 1;
    await store.create(makePayload());
    const raw = await backend.client.query('SELECT id_hash FROM pending_consents');
    expect(raw.rows).toHaveLength(1);
  });

  it('wraps storage failures in PendingConsentStoreError so callers fail closed', async () => {
    const failing: ConsentDbClient = {
      query: async () => {
        throw new Error('connection refused');
      },
      end: async () => {},
    };
    const store = new PostgresPendingConsentStore(DB_CONFIG, MASTER_KEY, logger, { client: failing });
    await expect(store.create(makePayload())).rejects.toBeInstanceOf(PendingConsentStoreError);
  });

  it('rejects an invalid table name before touching the database', () => {
    expect(
      () =>
        new PostgresPendingConsentStore(DB_CONFIG, MASTER_KEY, logger, {
          client: memBackend().client,
          tableName: 'evil"; DROP TABLE x; --',
        }),
    ).toThrow(PendingConsentStoreError);
  });
});

describe('createPendingConsentStore', () => {
  it('prefers Postgres when the consents database is configured', () => {
    const store = createPendingConsentStore({ db: DB_CONFIG, masterKey: MASTER_KEY, logger });
    expect(store).toBeInstanceOf(PostgresPendingConsentStore);
  });

  it('falls back to in-memory without a database (ten-minute artifact, retry on restart)', () => {
    const store = createPendingConsentStore({ masterKey: MASTER_KEY, logger });
    expect(store).toBeInstanceOf(InMemoryPendingConsentStore);
  });
});

describe('pendingIdLogRef', () => {
  it('produces a short hash reference that never contains the id', () => {
    const id = crypto.randomBytes(32).toString('base64url');
    const ref = pendingIdLogRef(id);
    expect(ref).toHaveLength(12);
    expect(id).not.toContain(ref);
  });
});
