/**
 * Transactional multi-replica consent evidence store backed by PostgreSQL.
 *
 * Append-only audit table: every policy-relevant grant and every revocation is
 * one row, nothing is ever updated or deleted. `lookup` folds rows with the
 * same rules the in-memory/file stores use (newest acceptance per key, newest
 * grant per identity, newest revocation), so `ConsentGate` policy sees
 * identical inputs regardless of backend. Cross-replica behavior comes from
 * the database itself: all replicas read the same rows, and the append-only
 * scheme means concurrent writers can at worst duplicate an audit row, never
 * lose one.
 *
 * Failure policy: any connection/query failure throws
 * `ConsentEvidenceStoreError` so the consent gate fails closed (blocks)
 * rather than silently allowing access.
 */
import { Pool } from 'pg';
import type { Logger } from '../core/logger.js';
import { ConsentEvidenceStoreError } from '../core/errors.js';
import { evaluateGrantFold } from './consent-evidence-store.js';
import type {
  ConsentEvidence,
  ConsentEvidenceStore,
  ConsentIdentityContext,
  ConsentLookupResult,
  ConsentRevocation,
} from './consent-evidence-store.js';

export interface PostgresConsentDbConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  /**
   * TLS to the database. Defaults to true (`MCP_CONSENTS_DB_SSL=false` to opt
   * out for local development): the internal pgaas endpoints expect encrypted
   * connections. `require` semantics — encrypted, without CA verification —
   * matching the convention of other pgaas consumers in the organization.
   */
  ssl: boolean;
}

/** Minimal query surface of `pg.Pool`, injectable for unit tests. */
export interface ConsentDbClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}

const DEFAULT_TABLE = 'consent_evidence';
/** Table names come from code/config, never from request data; still validated. */
const TABLE_NAME_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/;

/**
 * Binds a query to one identity and profile ($1..$4). The tenant comparison is
 * a portable spelling of IS NOT DISTINCT FROM: an absent tenant matches only
 * an absent tenant, never a concrete one.
 */
const IDENTITY_PREDICATE = `sub = $1 AND issuer = $2
        AND (tenant_id = $3 OR (tenant_id IS NULL AND $3 IS NULL))
        AND profile_id = $4`;

interface GrantRow {
  id: string | number;
  sub: string;
  issuer: string;
  tenant_id: string | null;
  profile_id: string;
  rules_version: string;
  rules_hash: string;
  granted_at: string | number;
}

/** Newest-revocation aggregate for one identity and profile. */
interface RevocationRow {
  revoked_at: string | number | null;
  last_id: string | number | null;
}

export class PostgresConsentEvidenceStore implements ConsentEvidenceStore {
  private readonly table: string;
  private readonly client: ConsentDbClient;
  private schemaReady: Promise<void> | null = null;

  constructor(
    config: PostgresConsentDbConfig,
    private readonly logger: Logger,
    options: { tableName?: string; client?: ConsentDbClient } = {},
  ) {
    const table = options.tableName ?? DEFAULT_TABLE;
    if (!TABLE_NAME_PATTERN.test(table)) {
      throw new ConsentEvidenceStoreError('Invalid consent evidence table name', { table });
    }
    this.table = table;
    this.client =
      options.client ??
      new Pool({
        host: config.host,
        port: config.port,
        database: config.database,
        user: config.user,
        password: config.password,
        ssl: config.ssl ? { rejectUnauthorized: false } : undefined,
        // Consent checks sit on the tool dispatch path: fail fast instead of
        // queueing requests behind an unreachable database.
        connectionTimeoutMillis: 5000,
      });
  }

  /** Release the underlying pool. Used by tests and graceful shutdown. */
  async close(): Promise<void> {
    await this.client.end();
  }

  async record(evidence: ConsentEvidence): Promise<void> {
    await this.ensureSchema();
    // Same fold rule as ConsentIndex.apply, evaluated by the shared
    // `evaluateGrantFold` against the newest stored row per key and per
    // identity, so every backend persists the same acceptances (for example an
    // equal-timestamp re-acceptance of an older rules version must flip the
    // latest grant here exactly as it does in the in-memory/file index).
    // Read-then-insert is not transactional: two racing writers can at worst
    // duplicate an audit row, which the append-only design already accepts.
    const identityParams = [evidence.sub, evidence.issuer, evidence.tenantId, evidence.profileId];
    const [keyRows, identityRows] = await Promise.all([
      this.run(
        'read newest consent grant for key',
        this.newestGrantQuery(true),
        [...identityParams, evidence.rules_version],
      ),
      this.run('read newest consent grant for identity', this.newestGrantQuery(false), identityParams),
    ]);
    const fold = evaluateGrantFold(
      evidence,
      toEvidence(keyRows.rows[0] as unknown as GrantRow | undefined),
      toEvidence(identityRows.rows[0] as unknown as GrantRow | undefined),
    );
    if (!fold.updatesGrant && !fold.updatesLatestGrant) return;
    await this.run(
      'record consent grant',
      `INSERT INTO ${this.table}
         (type, sub, issuer, tenant_id, profile_id, rules_version, rules_hash, granted_at)
       VALUES ('grant', $1, $2, $3, $4, $5, $6, CAST($7 AS BIGINT))`,
      [
        evidence.sub,
        evidence.issuer,
        evidence.tenantId,
        evidence.profileId,
        evidence.rules_version,
        evidence.rules_hash,
        evidence.granted_at,
      ],
    );
  }

  async revoke(revocation: ConsentRevocation): Promise<void> {
    await this.ensureSchema();
    await this.run(
      'record consent revocation',
      `INSERT INTO ${this.table}
         (type, sub, issuer, tenant_id, profile_id, revoked_at, reason)
       VALUES ('revocation', $1, $2, $3, $4, CAST($5 AS BIGINT), $6)`,
      [
        revocation.sub,
        revocation.issuer,
        revocation.tenantId,
        revocation.profileId,
        revocation.revoked_at,
        revocation.reason ?? null,
      ],
    );
  }

  async lookup(
    identity: ConsentIdentityContext,
    profileId: string,
    rulesVersion: string,
  ): Promise<ConsentLookupResult> {
    await this.ensureSchema();
    const identityParams = [identity.sub, identity.issuer, identity.tenantId, profileId];

    const [grantRows, latestRows, revocationRows] = await Promise.all([
      this.run('look up consent grant', this.newestGrantQuery(true), [
        ...identityParams,
        rulesVersion,
      ]),
      this.run('look up latest consent grant', this.newestGrantQuery(false), identityParams),
      this.run(
        'look up consent revocation',
        `SELECT MAX(revoked_at) AS revoked_at, MAX(id) AS last_id FROM ${this.table}
         WHERE type = 'revocation' AND ${IDENTITY_PREDICATE}`,
        identityParams,
      ),
    ]);

    const grantRow = grantRows.rows[0] as unknown as GrantRow | undefined;
    return {
      grant: toEvidence(grantRow),
      latestGrant: toEvidence(latestRows.rows[0] as unknown as GrantRow | undefined),
      revokedAt: effectiveRevokedAt(
        grantRow,
        revocationRows.rows[0] as unknown as RevocationRow | undefined,
      ),
    };
  }

  /**
   * Newest acceptance first: `id DESC` implements the deterministic tie-break
   * the contract requires (on an equal granted_at the later recorded
   * acceptance wins). Shared by `record` and `lookup` so both fold over the
   * same newest row.
   */
  private newestGrantQuery(perKey: boolean): string {
    return `SELECT id, sub, issuer, tenant_id, profile_id, rules_version, rules_hash, granted_at
         FROM ${this.table}
         WHERE type = 'grant' AND ${IDENTITY_PREDICATE}${perKey ? ' AND rules_version = $5' : ''}
         ORDER BY granted_at DESC, id DESC
         LIMIT 1`;
  }

  private ensureSchema(): Promise<void> {
    // Idempotent DDL, executed once per store instance; concurrent replicas
    // racing on IF NOT EXISTS is safe. A failure is not cached so the next
    // operation retries instead of poisoning the store forever.
    if (!this.schemaReady) {
      this.schemaReady = this.run(
        'initialize consent evidence schema',
        `CREATE TABLE IF NOT EXISTS ${this.table} (
           id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
           type TEXT NOT NULL CHECK (type IN ('grant', 'revocation')),
           sub TEXT NOT NULL,
           issuer TEXT NOT NULL,
           tenant_id TEXT NULL,
           profile_id TEXT NOT NULL,
           rules_version TEXT NULL,
           rules_hash TEXT NULL,
           granted_at BIGINT NULL,
           revoked_at BIGINT NULL,
           reason TEXT NULL,
           recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
           CONSTRAINT ${this.table}_grant_shape CHECK (
             type <> 'grant'
             OR (rules_version IS NOT NULL AND rules_hash IS NOT NULL AND granted_at IS NOT NULL)
           ),
           CONSTRAINT ${this.table}_revocation_shape CHECK (
             type <> 'revocation' OR revoked_at IS NOT NULL
           )
         );
         CREATE INDEX IF NOT EXISTS ${this.table}_identity_idx
           ON ${this.table} (sub, issuer, profile_id, tenant_id)`,
      ).then(
        () => {
          this.logger.info('Postgres consent evidence schema ready', { table: this.table });
        },
        (err) => {
          this.schemaReady = null;
          throw err;
        },
      );
    }
    return this.schemaReady;
  }

  private async run(
    action: string,
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }> {
    try {
      return await this.client.query(text, values);
    } catch (err) {
      throw new ConsentEvidenceStoreError(`Failed to ${action} in Postgres`, {
        table: this.table,
        cause: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

function toEvidence(row: GrantRow | null | undefined): ConsentEvidence | null {
  if (!row) return null;
  return {
    sub: row.sub,
    issuer: row.issuer,
    tenantId: row.tenant_id,
    profileId: row.profile_id,
    rules_version: row.rules_version,
    rules_hash: row.rules_hash,
    // BIGINT arrives as a string from pg; consent timestamps are epoch millis
    // and stay far below Number.MAX_SAFE_INTEGER.
    granted_at: Number(row.granted_at),
  };
}

/** BIGINT arrives as a string from pg; null/undefined means no row matched. */
function toNumberOrNull(value: string | number | null | undefined): number | null {
  return value === null || value === undefined ? null : Number(value);
}

/**
 * Grant-vs-revocation supersession is ordered by insertion order (monotonic
 * `id`), not by the caller-supplied timestamps: with multiple replicas, clock
 * skew could otherwise let a later-stamped grant defeat a revocation recorded
 * after it (fail open), or a later-stamped revocation defeat a grant recorded
 * after it. The returned value is shaped so the gate's timestamp comparison
 * reproduces the insertion-order decision: a revocation recorded after the
 * newest acceptance always reads as at least as new as the acceptance, and one
 * superseded by a later-recorded acceptance is dropped entirely.
 */
function effectiveRevokedAt(
  grant: GrantRow | undefined,
  revocation: RevocationRow | undefined,
): number | null {
  const revokedAt = toNumberOrNull(revocation?.revoked_at);
  if (revokedAt === null) return null;
  if (!grant) return revokedAt;
  const lastRevocationId = toNumberOrNull(revocation?.last_id);
  if (lastRevocationId !== null && Number(grant.id) > lastRevocationId) return null;
  return Math.max(revokedAt, Number(grant.granted_at));
}
