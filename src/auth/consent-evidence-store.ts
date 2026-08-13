/**
 * Pluggable store for consent evidence.
 *
 * Records that a provable human subject accepted the rules of a consent-gated
 * profile at a specific `rules_version`, and records revocations of those
 * grants. The store is dumb persistence: it returns what it holds for an
 * identity/profile pair, and `ConsentGate` decides whether that satisfies the
 * current policy (rules pinning, revocation, max age, version rollback). Adding
 * a backend therefore means implementing persistence only, never policy.
 *
 * Two implementations ship here: an in-memory store for dev/tests, and a
 * durable append-only JSONL `FileConsentEvidenceStore` for single-node/staging.
 * A transactional multi-replica backend (durable "who/when/rules_version" trail
 * with cross-writer dedup) is tracked in TODO.md and slots in behind this same
 * interface via the factory.
 */
import { constants as fsConstants } from 'node:fs';
import { appendFile, chmod, mkdir, open, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Logger } from '../core/logger.js';
import { ConsentEvidenceStoreError } from '../core/errors.js';

/** Directory mode for the evidence directory: owner-only. */
const EVIDENCE_DIR_MODE = 0o700;
/** File mode for the evidence file: owner read/write only. */
const EVIDENCE_FILE_MODE = 0o600;
/** Hard ceiling for the evidence file. Beyond it, writes fail closed. */
export const EVIDENCE_MAX_BYTES = 32 * 1024 * 1024;

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
  /** Digest of the rules material presented to the subject (see consent-rules-hash.ts). */
  rules_hash: string;
  /** Epoch milliseconds when consent was granted. */
  granted_at: number;
}

export interface ConsentRevocation {
  /** Subject whose consent is revoked. */
  sub: string;
  /** Canonical OIDC issuer of that subject. */
  issuer: string;
  /** Tenant context, or null when the issuer provided none. */
  tenantId: string | null;
  /** Profile the revocation applies to. */
  profileId: string;
  /** Epoch milliseconds when the revocation was recorded. */
  revoked_at: number;
  /** Free-text operator note. Never rendered to clients. */
  reason?: string;
}

/**
 * Everything the gate needs to evaluate consent for one identity and profile.
 *
 * `latestGrant` carries the newest grant for ANY rules version, which is how a
 * `rules_version` rollback is detected: re-pointing a profile from v2 back to
 * v1 must not reactivate the older v1 grant.
 */
export interface ConsentLookupResult {
  /**
   * Grant matching the requested rules version, or null. Carries the EARLIEST
   * `granted_at` for that key so the audit trail keeps the original acceptance.
   */
  grant: ConsentEvidence | null;
  /**
   * Timestamp of the most recent acceptance for the same key, which may be newer
   * than `grant.granted_at` when a subject accepted again (for example after an
   * operator revocation). Policy checks use this; audit reporting uses `grant`.
   */
  grantRenewedAt: number | null;
  /** Newest grant for this identity and profile regardless of rules version. */
  latestGrant: ConsentEvidence | null;
  /** Timestamp of the newest revocation for this identity and profile, or null. */
  revokedAt: number | null;
}

export interface ConsentEvidenceStore {
  /** Persist a consent evidence record. Idempotent for the same key. */
  record(evidence: ConsentEvidence): Promise<void>;
  /** Persist a revocation for an identity and profile. */
  revoke(revocation: ConsentRevocation): Promise<void>;
  /** Return the stored consent state for an identity, profile and rules version. */
  lookup(
    identity: ConsentIdentityContext,
    profileId: string,
    rulesVersion: string,
  ): Promise<ConsentLookupResult>;
}

export type ConsentIdentityContext = Pick<ConsentEvidence, 'sub' | 'issuer' | 'tenantId'>;

type StoredRecord =
  | ({ type: 'grant' } & ConsentEvidence)
  | ({ type: 'revocation' } & ConsentRevocation);

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

/** Identity + profile key, without the rules version (rollback and revocation scope). */
function consentIdentityKey(identity: ConsentIdentityContext, profileId: string): string {
  return JSON.stringify([identity.sub, identity.issuer, identity.tenantId, profileId]);
}

/**
 * Accumulates grants and revocations into the values a lookup returns.
 *
 * Shared by both store implementations so precedence cannot drift between
 * in-memory and durable storage: the earliest grant per key is the audit record,
 * the most recent acceptance for that key drives policy (so a subject can accept
 * again after a revocation), and the newest grant per identity defines the active
 * rules version.
 */
class ConsentIndex {
  private readonly grants = new Map<string, ConsentEvidence>();
  private readonly renewals = new Map<string, number>();
  private readonly latestGrants = new Map<string, ConsentEvidence>();
  private readonly revocations = new Map<string, number>();

  clear(): void {
    this.grants.clear();
    this.renewals.clear();
    this.latestGrants.clear();
    this.revocations.clear();
  }

  addGrant(evidence: ConsentEvidence): void {
    const key = consentEvidenceKey(evidence, evidence.profileId, evidence.rules_version);
    const known = this.grants.get(key);
    // Keep the first grant to preserve the original granted_at for audit.
    if (!known || evidence.granted_at < known.granted_at) {
      this.grants.set(key, { ...evidence });
    }
    const renewedAt = this.renewals.get(key);
    if (renewedAt === undefined || evidence.granted_at > renewedAt) {
      this.renewals.set(key, evidence.granted_at);
    }
    const identityKey = consentIdentityKey(evidence, evidence.profileId);
    const latest = this.latestGrants.get(identityKey);
    if (!latest || evidence.granted_at >= latest.granted_at) {
      this.latestGrants.set(identityKey, { ...evidence });
    }
  }

  addRevocation(revocation: ConsentRevocation): void {
    const identityKey = consentIdentityKey(revocation, revocation.profileId);
    const known = this.revocations.get(identityKey);
    if (known === undefined || revocation.revoked_at > known) {
      this.revocations.set(identityKey, revocation.revoked_at);
    }
  }

  /**
   * True when recording this grant would add nothing durable.
   *
   * `record` is first-writer-wins for the audit record: a repeat acceptance only
   * moves the renewal timestamp forward and is not persisted again. Rebuilding
   * the index from stored lines is different and keeps the earliest line, since
   * a file can hold lines in any order.
   */
  isRedundantGrant(evidence: ConsentEvidence): boolean {
    const key = consentEvidenceKey(evidence, evidence.profileId, evidence.rules_version);
    const renewedAt = this.renewals.get(key);
    if (renewedAt === undefined) return false;
    const identityKey = consentIdentityKey(evidence, evidence.profileId);
    const revokedAt = this.revocations.get(identityKey);
    // A grant that supersedes the newest revocation must still be written, so a
    // subject who accepts again after an operator revoke is not blocked forever.
    if (revokedAt !== undefined && evidence.granted_at > revokedAt && renewedAt <= revokedAt) {
      return false;
    }
    // Still track recency so policy sees the newest acceptance.
    if (evidence.granted_at > renewedAt) {
      this.renewals.set(key, evidence.granted_at);
    }
    return true;
  }

  lookup(
    identity: ConsentIdentityContext,
    profileId: string,
    rulesVersion: string,
  ): ConsentLookupResult {
    const identityKey = consentIdentityKey(identity, profileId);
    const key = consentEvidenceKey(identity, profileId, rulesVersion);
    return {
      grant: this.grants.get(key) ?? null,
      grantRenewedAt: this.renewals.get(key) ?? null,
      latestGrant: this.latestGrants.get(identityKey) ?? null,
      revokedAt: this.revocations.get(identityKey) ?? null,
    };
  }
}

/**
 * In-memory consent evidence store.
 *
 * Suitable for local development and tests only: state is lost on restart and
 * is not shared across replicas.
 */
export class InMemoryConsentEvidenceStore implements ConsentEvidenceStore {
  private readonly index = new ConsentIndex();

  async record(evidence: ConsentEvidence): Promise<void> {
    // Same first-writer-wins rule as the durable store, so the two never disagree
    // about which acceptance is the audit record.
    if (this.index.isRedundantGrant(evidence)) return;
    this.index.addGrant(evidence);
  }

  async revoke(revocation: ConsentRevocation): Promise<void> {
    this.index.addRevocation(revocation);
  }

  async lookup(
    identity: ConsentIdentityContext,
    profileId: string,
    rulesVersion: string,
  ): Promise<ConsentLookupResult> {
    return this.index.lookup(identity, profileId, rulesVersion);
  }
}

/**
 * Durable single-node consent evidence store backed by an append-only JSONL file.
 *
 * Each grant and each revocation is one JSON line carrying a `type`
 * discriminator. Records from an earlier schema (no `type`, no `rules_hash`)
 * are ignored and cannot satisfy a lookup, so a format change forces
 * re-consent rather than silently accepting an unpinned grant.
 *
 * Reads are incremental: the index tracks the last read (size, mtime) and, when
 * the file has only grown, parses just the new tail. The watermark is never
 * advanced from a stat that did not accompany a read, so an append by another
 * writer landing between our append and our stat is picked up on the next
 * lookup instead of being skipped forever. Cross-writer deduplication is still
 * best-effort: two writers can append the same grant concurrently, and the
 * index keeps the earliest. Use this for single-node/staging; multi-writer
 * production needs the transactional backend tracked in TODO.md.
 *
 * The directory is created 0700 and the file 0600; an existing file with wider
 * permissions is tightened before use.
 *
 * Failure policy: any read/write failure throws `ConsentEvidenceStoreError` so
 * the consent gate fails closed (blocks) rather than silently allowing access.
 */
export class FileConsentEvidenceStore implements ConsentEvidenceStore {
  private readonly index = new ConsentIndex();
  private writeQueue: Promise<void> = Promise.resolve();
  private lastLoadedMtimeMs = -1;
  private lastLoadedSize = 0;
  private loadedOnce = false;
  private permissionsChecked = false;

  constructor(
    private readonly filePath: string,
    private readonly logger: Logger,
    private readonly maxBytes: number = EVIDENCE_MAX_BYTES,
  ) {}

  async record(evidence: ConsentEvidence): Promise<void> {
    return this.enqueue(() => this.persistGrant(evidence));
  }

  async revoke(revocation: ConsentRevocation): Promise<void> {
    return this.enqueue(() => this.persistRevocation(revocation));
  }

  async lookup(
    identity: ConsentIdentityContext,
    profileId: string,
    rulesVersion: string,
  ): Promise<ConsentLookupResult> {
    await this.writeQueue;
    await this.reloadIfChanged();
    return this.index.lookup(identity, profileId, rulesVersion);
  }

  /**
   * Serialize writes without letting one failure poison the queue: the caller
   * of a failed write gets the rejection, the queue continues.
   */
  private enqueue(operation: () => Promise<void>): Promise<void> {
    const run = this.writeQueue.then(operation);
    this.writeQueue = run.catch(() => undefined);
    return run;
  }

  private async persistGrant(evidence: ConsentEvidence): Promise<void> {
    await this.reloadIfChanged();
    // Idempotent: preserve the first grant (original granted_at) for audit, but
    // never suppress an acceptance that supersedes a revocation.
    if (this.index.isRedundantGrant(evidence)) {
      return;
    }
    await this.appendLine({ type: 'grant', ...evidence });
    this.index.addGrant(evidence);
  }

  private async persistRevocation(revocation: ConsentRevocation): Promise<void> {
    await this.reloadIfChanged();
    await this.appendLine({ type: 'revocation', ...revocation });
    this.index.addRevocation(revocation);
  }

  private async appendLine(record: StoredRecord): Promise<void> {
    const line = `${JSON.stringify(record)}\n`;
    try {
      await mkdir(dirname(this.filePath), { recursive: true, mode: EVIDENCE_DIR_MODE });
      await this.enforceFilePermissions();
      await this.assertSizeAllows(line.length);
      // O_APPEND makes each small write atomic on POSIX, so concurrent single-node
      // writers do not interleave partial lines (cross-writer dedup is best-effort).
      await appendFile(this.filePath, line, { encoding: 'utf8', mode: EVIDENCE_FILE_MODE });
      // Invalidate the mtime watermark without advancing the byte offset. Our own
      // bytes are already indexed, but a peer may have appended between our last
      // read and this write, and mtime granularity can hide a same-size change.
      // The next lookup therefore re-reads from the last consumed offset.
      this.lastLoadedMtimeMs = -1;
    } catch (err) {
      if (err instanceof ConsentEvidenceStoreError) throw err;
      throw new ConsentEvidenceStoreError(
        'Failed to persist consent evidence',
        { path: this.filePath, cause: err instanceof Error ? err.message : String(err) },
      );
    }
  }

  private async assertSizeAllows(additionalBytes: number): Promise<void> {
    const size = await this.currentSize();
    if (size + additionalBytes > this.maxBytes) {
      throw new ConsentEvidenceStoreError(
        'Consent evidence file exceeded its size limit; compact or rotate it before granting further consent',
        { path: this.filePath, size, maxBytes: this.maxBytes },
      );
    }
  }

  private async currentSize(): Promise<number> {
    try {
      return (await stat(this.filePath)).size;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw err;
    }
  }

  /**
   * `mkdir`/`appendFile` modes apply on creation only, so an evidence file that
   * predates this policy (or a permissive umask) keeps its old mode until it is
   * tightened explicitly.
   */
  private async enforceFilePermissions(): Promise<void> {
    if (this.permissionsChecked) return;
    try {
      await chmod(dirname(this.filePath), EVIDENCE_DIR_MODE);
      const stats = await stat(this.filePath);
      if ((stats.mode & 0o777) !== EVIDENCE_FILE_MODE) {
        await chmod(this.filePath, EVIDENCE_FILE_MODE);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    this.permissionsChecked = true;
  }

  /**
   * Re-read the file when it changed on disk. Growth is parsed incrementally
   * from the previous offset; a shrink, a replacement, or an mtime change
   * without growth forces a full reload.
   */
  private async reloadIfChanged(): Promise<void> {
    let size: number;
    let mtimeMs: number;
    try {
      const stats = await stat(this.filePath);
      size = stats.size;
      mtimeMs = stats.mtimeMs;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        // No file yet: an empty index is the correct, durable state.
        this.index.clear();
        this.lastLoadedMtimeMs = -1;
        this.lastLoadedSize = 0;
        this.loadedOnce = true;
        return;
      }
      throw new ConsentEvidenceStoreError(
        'Failed to stat consent evidence file',
        { path: this.filePath, cause: err instanceof Error ? err.message : String(err) },
      );
    }

    if (this.loadedOnce && size === this.lastLoadedSize && mtimeMs === this.lastLoadedMtimeMs) {
      return;
    }
    if (this.loadedOnce && size > this.lastLoadedSize) {
      await this.loadTail(size, mtimeMs);
      return;
    }
    await this.loadAll(size, mtimeMs);
  }

  private async loadAll(size: number, mtimeMs: number): Promise<void> {
    this.index.clear();
    this.lastLoadedSize = 0;
    await this.consumeFrom(0, size, mtimeMs);
  }

  private async loadTail(size: number, mtimeMs: number): Promise<void> {
    await this.consumeFrom(this.lastLoadedSize, size, mtimeMs);
  }

  /**
   * Read `[from, size)` and fold complete lines into the index.
   *
   * A trailing partial line means a concurrent writer is mid-append, so the
   * watermark stops at the last newline and the remainder is re-read next time.
   */
  private async consumeFrom(from: number, size: number, mtimeMs: number): Promise<void> {
    if (size === from) {
      this.lastLoadedSize = size;
      this.lastLoadedMtimeMs = mtimeMs;
      this.loadedOnce = true;
      return;
    }

    let content: string;
    try {
      const handle = await open(this.filePath, fsConstants.O_RDONLY);
      try {
        const buffer = Buffer.alloc(size - from);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, from);
        content = buffer.subarray(0, bytesRead).toString('utf8');
      } finally {
        await handle.close();
      }
    } catch (err) {
      throw new ConsentEvidenceStoreError(
        'Failed to read consent evidence file',
        { path: this.filePath, cause: err instanceof Error ? err.message : String(err) },
      );
    }

    const lastNewline = content.lastIndexOf('\n');
    const complete = lastNewline === -1 ? '' : content.slice(0, lastNewline + 1);
    let skipped = 0;
    for (const rawLine of complete.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;
      const parsed = this.parseLine(line);
      if (!parsed) {
        skipped += 1;
        continue;
      }
      if (parsed.type === 'grant') {
        this.index.addGrant(parsed);
      } else {
        this.index.addRevocation(parsed);
      }
    }
    if (skipped > 0) {
      this.logger.warn('Skipped malformed consent evidence lines', {
        path: this.filePath,
        skipped,
      });
    }

    this.lastLoadedSize = from + Buffer.byteLength(complete, 'utf8');
    // Only claim the observed mtime when the whole observed file was consumed;
    // otherwise the next lookup must stat and read again.
    this.lastLoadedMtimeMs = this.lastLoadedSize === size ? mtimeMs : -1;
    this.loadedOnce = true;
  }

  private parseLine(line: string): StoredRecord | null {
    try {
      const obj = JSON.parse(line) as Partial<StoredRecord>;
      if (obj.type === 'grant') {
        const grant = obj as Partial<ConsentEvidence> & { type: 'grant' };
        if (
          typeof grant.sub === 'string' &&
          typeof grant.issuer === 'string' &&
          (typeof grant.tenantId === 'string' || grant.tenantId === null) &&
          typeof grant.profileId === 'string' &&
          typeof grant.rules_version === 'string' &&
          typeof grant.rules_hash === 'string' &&
          typeof grant.granted_at === 'number'
        ) {
          return {
            type: 'grant',
            sub: grant.sub,
            issuer: grant.issuer,
            tenantId: grant.tenantId,
            profileId: grant.profileId,
            rules_version: grant.rules_version,
            rules_hash: grant.rules_hash,
            granted_at: grant.granted_at,
          };
        }
        return null;
      }
      if (obj.type === 'revocation') {
        const revocation = obj as Partial<ConsentRevocation> & { type: 'revocation' };
        if (
          typeof revocation.sub === 'string' &&
          typeof revocation.issuer === 'string' &&
          (typeof revocation.tenantId === 'string' || revocation.tenantId === null) &&
          typeof revocation.profileId === 'string' &&
          typeof revocation.revoked_at === 'number'
        ) {
          return {
            type: 'revocation',
            sub: revocation.sub,
            issuer: revocation.issuer,
            tenantId: revocation.tenantId,
            profileId: revocation.profileId,
            revoked_at: revocation.revoked_at,
            reason: typeof revocation.reason === 'string' ? revocation.reason : undefined,
          };
        }
        return null;
      }
    } catch {
      // fallthrough: malformed line
    }
    return null;
  }
}
