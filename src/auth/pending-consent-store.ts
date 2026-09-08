/**
 * Pending-consent store for the consent-after-identity flow (AIPP-625).
 *
 * When the OAuth callback verifies an identity that has no valid grant, the
 * flow is interrupted: the callback stores everything needed to finish the
 * authorization later (upstream tokens, verified identity, client auth state)
 * and redirects the browser to the consent form. The form POST consumes the
 * pending entry exactly once and completes the authorization.
 *
 * Security posture:
 * - The pending id handed to the browser is a 256-bit CSPRNG value; the store
 *   persists only its SHA-256 hash, so a database read can never be replayed.
 * - The payload (which contains upstream IdP tokens) is AEAD-encrypted with
 *   AES-256-GCM under a purpose-bound subkey of MCP4_OAUTH_KEY; the AAD binds
 *   the ciphertext to the pending id and profile, so a row cannot be re-keyed
 *   to a different flow. A database operator never sees token material.
 * - Entries live for PENDING_CONSENT_TTL_MS and are deleted on consume
 *   (atomic, one-time). Expired rows are swept opportunistically on create,
 *   so no dedicated timer is needed and the table cannot grow unbounded.
 * - Missing, expired, and already-consumed entries are indistinguishable by
 *   design (hash-only lookup over deleted rows): `consume`/`exists` report
 *   "absent" and the caller renders the recoverable expired page.
 *
 * Failure policy mirrors the consent evidence store: any storage or crypto
 * failure throws `PendingConsentStoreError` so callers fail closed. A
 * decryption failure is never treated as "absent" (it signals tampering or a
 * key mismatch and must surface, not silently restart the flow).
 */
import crypto from 'node:crypto';
import { Pool } from 'pg';
import type { Logger } from '../core/logger.js';
import { PendingConsentStoreError } from '../core/errors.js';
import type { PostgresConsentDbConfig, ConsentDbClient } from './postgres-consent-evidence-store.js';

/** How long a pending consent may wait for the human to read and decide. */
export const PENDING_CONSENT_TTL_MS = 10 * 60 * 1000;

/** Verified identity captured at the OAuth callback. */
export interface PendingConsentIdentity {
  subject: string;
  issuer: string;
  tenantId?: string;
}

/** Client authorization state needed to finish the flow after acceptance. */
export interface PendingConsentAuthState {
  clientId: string;
  clientRedirectUri: string;
  codeChallenge: string;
  originalState?: string;
  scopes: string[];
}

/**
 * Everything the deferred completion needs. `tokens` is the upstream token
 * response (access + refresh token); it is stored only inside the AEAD
 * ciphertext, never in clear.
 */
export interface PendingConsentPayload {
  profileId: string;
  identity: PendingConsentIdentity;
  tokens: unknown;
  auth: PendingConsentAuthState;
  /**
   * Informational audit copy of the rules digest at park time. Enforcement
   * happens via the approval-token fingerprint, which carries the CURRENT
   * gate rules hash at both render and consume time; this field is for
   * debugging a rules bump mid-flow, never compared by the handlers.
   */
  rulesHash: string;
  /**
   * SHA-256 digest (base64url) of the `__Host-` binding cookie minted with
   * the 303 to the form. The form GET and POST must present the cookie whose
   * digest matches, so only the browser that completed the IdP login can see
   * the form or answer the consent question (a leaked pending URL alone is
   * not enough). Stored only inside the AEAD ciphertext.
   */
  bindingDigest: string;
  createdAt: number;
}

export interface PendingConsentStore {
  /**
   * Persist a payload and return the browser-facing pending id. The id is
   * generated here so no caller can supply a low-entropy value.
   */
  create(payload: PendingConsentPayload): Promise<string>;
  /**
   * Read a live (unexpired, unconsumed) entry without consuming it. The form
   * GET uses it to render (and re-render on refresh) and to derive the CSP
   * form-action origin from the stored client redirect URI.
   */
  peek(pendingId: string, profileId: string): Promise<PendingConsentPayload | null>;
  /**
   * Atomically remove and return the payload, or null when the entry is
   * missing, expired, or already consumed. At most one caller ever receives
   * the payload, across replicas.
   */
  consume(pendingId: string, profileId: string): Promise<PendingConsentPayload | null>;
}

const PENDING_ID_BYTES = 32;
/** base64url of 32 random bytes. */
const PENDING_ID_SHAPE = /^[A-Za-z0-9_-]{43}$/;

export function isPendingIdShape(value: unknown): value is string {
  return typeof value === 'string' && PENDING_ID_SHAPE.test(value);
}

/** Hash prefix suitable for logs; never log the raw pending id. */
export function pendingIdLogRef(pendingId: string): string {
  return crypto.createHash('sha256').update(pendingId).digest('hex').slice(0, 12);
}

function hashPendingId(pendingId: string): string {
  return crypto.createHash('sha256').update(pendingId).digest('base64url');
}

/** Cookie binding the pending flow to the browser that completed the IdP login. */
export const PENDING_BINDING_COOKIE = '__Host-mcp4_pending';

/** Mint a fresh binding cookie value (256-bit CSPRNG, same shape as ids). */
export function newPendingBindingValue(): string {
  return crypto.randomBytes(PENDING_ID_BYTES).toString('base64url');
}

/**
 * Digest stored in the AEAD payload; the cookie value itself never leaves the
 * Set-Cookie header, so a database or payload leak cannot forge the cookie.
 */
export function pendingBindingDigest(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('base64url');
}

/**
 * Timing-safe check of a presented binding cookie against the stored digest.
 * Absent or malformed cookies fail without touching crypto.
 */
export function matchesPendingBinding(presented: string | undefined, storedDigest: string): boolean {
  if (!presented || !PENDING_ID_SHAPE.test(presented)) return false;
  const left = Buffer.from(pendingBindingDigest(presented), 'utf8');
  const right = Buffer.from(storedDigest, 'utf8');
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

/**
 * Purpose-bound subkey so pending-consent ciphertexts can never be confused
 * with token envelopes or consent approvals built from the same MCP4_OAUTH_KEY
 * (same derivation style as the consent approval HMAC subkey).
 */
function deriveKey(masterKey: Buffer): Buffer {
  return crypto.createHmac('sha256', masterKey).update('mcp4openapi:pending-consent:v1').digest();
}

interface CipherEnvelope {
  iv: string;
  tag: string;
  data: string;
}

function encryptPayload(key: Buffer, pendingId: string, payload: PendingConsentPayload): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(JSON.stringify([pendingId, payload.profileId])));
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
  const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const envelope: CipherEnvelope = {
    iv: iv.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
    data: data.toString('base64url'),
  };
  return JSON.stringify(envelope);
}

function decryptPayload(
  key: Buffer,
  pendingId: string,
  profileId: string,
  ciphertext: string,
): PendingConsentPayload {
  let envelope: CipherEnvelope;
  try {
    envelope = JSON.parse(ciphertext) as CipherEnvelope;
  } catch {
    throw new PendingConsentStoreError('Pending consent ciphertext is malformed');
  }
  try {
    // authTagLength pins the full 16-byte GCM tag: without it Node accepts
    // shorter tags, which enables truncated-tag forgery (semgrep
    // gcm-no-tag-length; token-envelope.ts applies the same option).
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(envelope.iv, 'base64url'),
      { authTagLength: 16 },
    );
    decipher.setAAD(Buffer.from(JSON.stringify([pendingId, profileId])));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.data, 'base64url')),
      decipher.final(),
    ]);
    return JSON.parse(plaintext.toString('utf8')) as PendingConsentPayload;
  } catch {
    // Tampering or a key mismatch: must surface, never look like "absent".
    throw new PendingConsentStoreError('Pending consent payload failed authentication', {
      pendingIdRef: pendingIdLogRef(pendingId),
    });
  }
}

/** Shared crypto and id plumbing for both backends. */
abstract class BasePendingConsentStore implements PendingConsentStore {
  protected readonly key: Buffer;

  constructor(masterKey: Buffer, protected readonly now: () => number = Date.now) {
    this.key = deriveKey(masterKey);
  }

  async create(payload: PendingConsentPayload): Promise<string> {
    const pendingId = crypto.randomBytes(PENDING_ID_BYTES).toString('base64url');
    const ciphertext = encryptPayload(this.key, pendingId, payload);
    await this.insert(
      hashPendingId(pendingId),
      payload.profileId,
      ciphertext,
      this.now() + PENDING_CONSENT_TTL_MS,
    );
    return pendingId;
  }

  async peek(pendingId: string, profileId: string): Promise<PendingConsentPayload | null> {
    if (!isPendingIdShape(pendingId)) return null;
    const ciphertext = await this.read(hashPendingId(pendingId), profileId, this.now());
    if (ciphertext === null) return null;
    return decryptPayload(this.key, pendingId, profileId, ciphertext);
  }

  async consume(pendingId: string, profileId: string): Promise<PendingConsentPayload | null> {
    if (!isPendingIdShape(pendingId)) return null;
    const ciphertext = await this.take(hashPendingId(pendingId), profileId, this.now());
    if (ciphertext === null) return null;
    return decryptPayload(this.key, pendingId, profileId, ciphertext);
  }

  protected abstract insert(
    idHash: string,
    profileId: string,
    ciphertext: string,
    expiresAt: number,
  ): Promise<void>;
  protected abstract read(idHash: string, profileId: string, now: number): Promise<string | null>;
  protected abstract take(idHash: string, profileId: string, now: number): Promise<string | null>;
}

/** Dev/single-node backend; entries do not survive a restart (the user retries). */
export class InMemoryPendingConsentStore extends BasePendingConsentStore {
  private readonly rows = new Map<string, { profileId: string; ciphertext: string; expiresAt: number }>();

  protected async insert(
    idHash: string,
    profileId: string,
    ciphertext: string,
    expiresAt: number,
  ): Promise<void> {
    // Opportunistic sweep: every create cleans expired rows, so the map is
    // bounded by the number of flows started within one TTL window.
    const now = this.now();
    for (const [hash, row] of this.rows) {
      if (row.expiresAt <= now) this.rows.delete(hash);
    }
    this.rows.set(idHash, { profileId, ciphertext, expiresAt });
  }

  protected async read(idHash: string, profileId: string, now: number): Promise<string | null> {
    const row = this.rows.get(idHash);
    if (!row || row.profileId !== profileId || row.expiresAt <= now) return null;
    return row.ciphertext;
  }

  protected async take(idHash: string, profileId: string, now: number): Promise<string | null> {
    const row = this.rows.get(idHash);
    if (!row || row.profileId !== profileId) return null;
    this.rows.delete(idHash);
    if (row.expiresAt <= now) return null;
    return row.ciphertext;
  }
}

const DEFAULT_TABLE = 'pending_consents';
const TABLE_NAME_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/;

/**
 * Multi-replica backend in the consents database. The form POST can land on a
 * different pod (or cluster) than the callback that created the entry; the
 * atomic DELETE ... RETURNING guarantees one-time consumption across all of
 * them.
 *
 * TODO(AIPP-651): share one Pool with PostgresConsentEvidenceStore once the
 * shared ConsentDbPool helper lands; until then this mirrors its connection
 * pattern.
 */
export class PostgresPendingConsentStore extends BasePendingConsentStore {
  private readonly table: string;
  private readonly client: ConsentDbClient;
  private schemaReady: Promise<void> | null = null;

  constructor(
    config: PostgresConsentDbConfig,
    masterKey: Buffer,
    private readonly logger: Logger,
    options: { tableName?: string; client?: ConsentDbClient; now?: () => number } = {},
  ) {
    super(masterKey, options.now);
    const table = options.tableName ?? DEFAULT_TABLE;
    if (!TABLE_NAME_PATTERN.test(table)) {
      throw new PendingConsentStoreError('Invalid pending consent table name', { table });
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
        // TLS in "require" semantics (encrypted, no CA verification): matches
        // the consent evidence store and how internal pgaas consumers connect;
        // documented in SECURITY.md. Not a debug bypass.
        // nosemgrep: problem-based-packs.insecure-transport.js-node.bypass-tls-verification.bypass-tls-verification
        ssl: config.ssl ? { rejectUnauthorized: false } : undefined,
        connectionTimeoutMillis: 5000,
      });
  }

  /** Release the underlying pool. Used by tests and graceful shutdown. */
  async close(): Promise<void> {
    await this.client.end();
  }

  protected async insert(
    idHash: string,
    profileId: string,
    ciphertext: string,
    expiresAt: number,
  ): Promise<void> {
    await this.ensureSchema();
    // Opportunistic sweep piggybacks on flow starts; no dedicated timer.
    await this.run('sweep expired pending consents', `DELETE FROM ${this.table} WHERE expires_at <= $1`, [
      this.now(),
    ]);
    await this.run(
      'store pending consent',
      `INSERT INTO ${this.table} (id_hash, profile_id, ciphertext, expires_at)
       VALUES ($1, $2, $3, CAST($4 AS BIGINT))`,
      [idHash, profileId, ciphertext, expiresAt],
    );
  }

  protected async read(idHash: string, profileId: string, now: number): Promise<string | null> {
    await this.ensureSchema();
    const result = await this.run(
      'read pending consent',
      `SELECT ciphertext FROM ${this.table} WHERE id_hash = $1 AND profile_id = $2 AND expires_at > $3`,
      [idHash, profileId, now],
    );
    const row = result.rows[0] as { ciphertext?: unknown } | undefined;
    return typeof row?.ciphertext === 'string' ? row.ciphertext : null;
  }

  protected async take(idHash: string, profileId: string, now: number): Promise<string | null> {
    await this.ensureSchema();
    // Atomic one-time consumption: exactly one racing caller gets the row.
    const result = await this.run(
      'consume pending consent',
      `DELETE FROM ${this.table}
       WHERE id_hash = $1 AND profile_id = $2 AND expires_at > $3
       RETURNING ciphertext`,
      [idHash, profileId, now],
    );
    const row = result.rows[0] as { ciphertext?: unknown } | undefined;
    return typeof row?.ciphertext === 'string' ? row.ciphertext : null;
  }

  private ensureSchema(): Promise<void> {
    if (!this.schemaReady) {
      this.schemaReady = this.initSchema().then(
        () => {
          this.logger.info('Postgres pending consent schema ready', { table: this.table });
        },
        (err) => {
          this.schemaReady = null;
          throw err;
        },
      );
    }
    return this.schemaReady;
  }

  private async initSchema(): Promise<void> {
    try {
      await this.run(
        'initialize pending consent schema',
        `CREATE TABLE IF NOT EXISTS ${this.table} (
           id_hash TEXT PRIMARY KEY,
           profile_id TEXT NOT NULL,
           ciphertext TEXT NOT NULL,
           expires_at BIGINT NOT NULL,
           created_at TIMESTAMPTZ NOT NULL DEFAULT now()
         )`,
      );
    } catch (ddlError) {
      // Replicas race on the DDL; when another writer created the table first
      // the probe below succeeds and this instance is ready anyway.
      try {
        await this.client.query(`SELECT id_hash FROM ${this.table} LIMIT 0`);
      } catch {
        throw ddlError;
      }
    }
  }

  private async run(action: string, text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> {
    try {
      return await this.client.query(text, values);
    } catch (error) {
      throw new PendingConsentStoreError(`Failed to ${action}`, {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export interface PendingConsentStoreConfig {
  /** Postgres connection settings (`MCP_CONSENTS_DB_*`), when configured. */
  db?: PostgresConsentDbConfig;
  /** MCP4_OAUTH_KEY material; consent-gated profiles always have it. */
  masterKey: Buffer;
  logger: Logger;
}

/**
 * Backend precedence mirrors the consent evidence store: Postgres when the
 * consents database is configured, in-memory otherwise (local single-node
 * runs; the JSONL evidence tier maps to in-memory here because a pending
 * entry is a ten-minute artifact, not an audit record - losing it on restart
 * only makes the user retry the flow).
 */
export function createPendingConsentStore(config: PendingConsentStoreConfig): PendingConsentStore {
  if (config.db) {
    config.logger.info('Using Postgres pending consent store', {
      host: config.db.host,
      port: config.db.port,
      database: config.db.database,
    });
    return new PostgresPendingConsentStore(config.db, config.masterKey, config.logger);
  }
  return new InMemoryPendingConsentStore(config.masterKey);
}
