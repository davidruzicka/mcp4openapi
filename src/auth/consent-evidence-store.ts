/**
 * Pluggable store for consent evidence.
 *
 * Records that a provable human subject accepted the rules of a consent-gated
 * profile at a specific `rules_version`. The gate consults `has(...)` before
 * dispatching any tool call; the consent HTTP flow calls `record(...)` after a
 * verified human login.
 *
 * Two implementations ship here: an in-memory store for dev/tests, and a
 * durable append-only JSONL `FileConsentEvidenceStore` for single-node/staging.
 * A transactional multi-replica backend (durable "who/when/rules_version" trail
 * with cross-writer dedup) is tracked in TODO.md and slots in behind this same
 * interface via the factory.
 */
import { appendFileSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Logger } from '../core/logger.js';
import { ConsentEvidenceStoreError } from '../core/errors.js';

export interface ConsentEvidence {
  /** Authenticated subject identifier (OAuth `sub`) that granted consent. */
  sub: string;
  /** Canonical OIDC issuer that verified the subject. */
  issuer: string;
  /** Tenant context that granted consent, or null when the issuer provided none. */
  tenantId: string | null;
  /** Profile the consent applies to. */
  profileId: string;
  /** Rules version the subject accepted. */
  rules_version: string;
  /** Epoch milliseconds when consent was granted. */
  granted_at: number;
}

export interface ConsentEvidenceStore {
  /** Persist a consent evidence record. Idempotent for the same key. */
  record(evidence: ConsentEvidence): Promise<void>;
  /** Return true when consent exists for the complete identity context and rules version. */
  has(identity: ConsentIdentityContext, profileId: string, rulesVersion: string): Promise<boolean>;
}

export type ConsentIdentityContext = Pick<ConsentEvidence, 'sub' | 'issuer' | 'tenantId'>;

/**
 * Build a structured tuple key that binds consent to the complete identity
 * context, profile, and rules version. JSON encoding avoids collisions when
 * attacker-controlled fields contain delimiter characters.
 */
export function consentEvidenceKey(
  identity: ConsentIdentityContext,
  profileId: string,
  rulesVersion: string,
): string {
  return JSON.stringify([
    identity.sub,
    identity.issuer,
    identity.tenantId,
    profileId,
    rulesVersion,
  ]);
}

/**
 * In-memory consent evidence store.
 *
 * Suitable for local development and pilot only. No TTL: consent persists for
 * the process lifetime and is invalidated solely by a `rules_version` change.
 */
export class InMemoryConsentEvidenceStore implements ConsentEvidenceStore {
  private readonly records = new Map<string, ConsentEvidence>();

  async record(evidence: ConsentEvidence): Promise<void> {
    const key = consentEvidenceKey(
      evidence,
      evidence.profileId,
      evidence.rules_version,
    );
    // Keep the first grant to preserve the original granted_at for audit.
    if (!this.records.has(key)) {
      this.records.set(key, { ...evidence });
    }
  }

  async has(identity: ConsentIdentityContext, profileId: string, rulesVersion: string): Promise<boolean> {
    return this.records.has(consentEvidenceKey(identity, profileId, rulesVersion));
  }
}

/**
 * Durable single-node consent evidence store backed by an append-only JSONL file.
 *
 * Each granted consent is one JSON line (`ConsentEvidence`). Reads rebuild an
 * in-memory index and reload external writes when the file changes on disk, so
 * multiple replicas sharing one file (e.g. an RWX volume) observe each other's
 * grants. Records from the pre-issuer schema are ignored and cannot satisfy a
 * new lookup. It is durable across restarts, but grants are NOT transactionally
 * deduplicated across concurrent writers — that guarantee requires the
 * transactional multi-replica backend tracked in TODO.md. Use this for
 * single-node/staging; do not rely on it for multi-writer production.
 *
 * Failure policy: any read/write failure throws `ConsentEvidenceStoreError` so
 * the consent gate fails closed (blocks) rather than silently allowing access.
 */
export class FileConsentEvidenceStore implements ConsentEvidenceStore {
  private readonly index = new Map<string, ConsentEvidence>();
  private writeQueue: Promise<void> = Promise.resolve();
  private lastLoadedMtimeMs = -1;
  private loadedOnce = false;

  constructor(
    private readonly filePath: string,
    private readonly logger: Logger,
  ) {}

  async record(evidence: ConsentEvidence): Promise<void> {
    const operation = this.writeQueue.then(() => this.persistRecord(evidence));
    this.writeQueue = operation.catch(() => undefined);
    return operation;
  }

  private persistRecord(evidence: ConsentEvidence): void {
    this.reloadIfChanged();
    const key = consentEvidenceKey(
      evidence,
      evidence.profileId,
      evidence.rules_version,
    );
    // Idempotent: preserve the first grant (original granted_at) for audit.
    if (this.index.has(key)) return;

    const line = `${JSON.stringify({
      sub: evidence.sub,
      issuer: evidence.issuer,
      tenantId: evidence.tenantId,
      profileId: evidence.profileId,
      rules_version: evidence.rules_version,
      granted_at: evidence.granted_at,
    })}\n`;

    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      // O_APPEND makes each small write atomic on POSIX, so concurrent single-node
      // writers do not interleave partial lines (cross-writer dedup is best-effort).
      appendFileSync(this.filePath, line, { encoding: 'utf8' });
    } catch (err) {
      throw new ConsentEvidenceStoreError(
        'Failed to persist consent evidence',
        { path: this.filePath, cause: err instanceof Error ? err.message : String(err) },
      );
    }

    this.index.set(key, { ...evidence });
    this.refreshMtime();
  }

  async has(identity: ConsentIdentityContext, profileId: string, rulesVersion: string): Promise<boolean> {
    await this.writeQueue;
    this.reloadIfChanged();
    return this.index.has(consentEvidenceKey(identity, profileId, rulesVersion));
  }

  /** Re-read the file into the index when it is newer than the last load. */
  private reloadIfChanged(): void {
    let mtimeMs: number;
    try {
      mtimeMs = statSync(this.filePath).mtimeMs;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        // No file yet: an empty index is the correct, durable state.
        this.index.clear();
        this.lastLoadedMtimeMs = -1;
        this.loadedOnce = true;
        return;
      }
      throw new ConsentEvidenceStoreError(
        'Failed to stat consent evidence file',
        { path: this.filePath, cause: err instanceof Error ? err.message : String(err) },
      );
    }

    if (this.loadedOnce && mtimeMs === this.lastLoadedMtimeMs) return;
    this.loadIndex(mtimeMs);
  }

  private loadIndex(mtimeMs: number): void {
    let content: string;
    try {
      content = readFileSync(this.filePath, 'utf8');
    } catch (err) {
      throw new ConsentEvidenceStoreError(
        'Failed to read consent evidence file',
        { path: this.filePath, cause: err instanceof Error ? err.message : String(err) },
      );
    }

    this.index.clear();
    let skipped = 0;
    for (const rawLine of content.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;
      const parsed = this.parseLine(line);
      if (!parsed) {
        skipped += 1;
        continue;
      }
      const key = consentEvidenceKey(parsed, parsed.profileId, parsed.rules_version);
      const existing = this.index.get(key);
      // Keep the earliest grant so the original granted_at survives replays.
      if (!existing || parsed.granted_at < existing.granted_at) {
        this.index.set(key, parsed);
      }
    }
    if (skipped > 0) {
      this.logger.warn('Skipped malformed consent evidence lines', {
        path: this.filePath,
        skipped,
      });
    }
    this.lastLoadedMtimeMs = mtimeMs;
    this.loadedOnce = true;
  }

  private parseLine(line: string): ConsentEvidence | null {
    try {
      const obj = JSON.parse(line) as Partial<ConsentEvidence>;
      if (
        typeof obj.sub === 'string' &&
        typeof obj.issuer === 'string' &&
        (typeof obj.tenantId === 'string' || obj.tenantId === null) &&
        typeof obj.profileId === 'string' &&
        typeof obj.rules_version === 'string' &&
        typeof obj.granted_at === 'number'
      ) {
        return {
          sub: obj.sub,
          issuer: obj.issuer,
          tenantId: obj.tenantId,
          profileId: obj.profileId,
          rules_version: obj.rules_version,
          granted_at: obj.granted_at,
        };
      }
    } catch {
      // fallthrough: malformed line
    }
    return null;
  }

  private refreshMtime(): void {
    try {
      this.lastLoadedMtimeMs = statSync(this.filePath).mtimeMs;
      this.loadedOnce = true;
    } catch {
      // If stat fails right after a successful append, force a reload next time.
      this.lastLoadedMtimeMs = -1;
    }
  }
}
