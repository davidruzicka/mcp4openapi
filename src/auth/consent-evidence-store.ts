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
/** Hard ceiling for the evidence file. Beyond it, grant writes fail closed. */
export const EVIDENCE_MAX_BYTES = 32 * 1024 * 1024;
/**
 * Per-line bound for a revocation append. Revocations are exempt from the
 * file cap (rejecting one would keep consent active), so this bound is the
 * only limit on how much a single revocation can grow the file.
 */
export const EVIDENCE_MAX_LINE_BYTES = 64 * 1024;
/**
 * How many bytes at the incremental-read boundary are remembered and verified
 * before a grown file is trusted as append-only (see `reloadIfChanged`).
 */
const TAIL_PROBE_BYTES = 256;

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
   * Grant matching the requested rules version, or null. Carries the LATEST
   * acceptance for that key: policy always evaluates the newest acceptance,
   * and the durable JSONL file keeps every earlier acceptance as the full
   * audit history.
   */
  grant: ConsentEvidence | null;
  /** Newest grant for this identity and profile regardless of rules version. */
  latestGrant: ConsentEvidence | null;
  /** Timestamp of the newest revocation for this identity and profile, or null. */
  revokedAt: number | null;
}

export interface ConsentEvidenceStore {
  /**
   * Persist a consent evidence record. Idempotent for an identical record;
   * any acceptance that changes policy-relevant state (renewal recency,
   * latest-version acceptance, superseding a revocation) is persisted again
   * as a new audit line.
   */
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

/** Which policy-relevant state a new acceptance changes (see `evaluateGrantFold`). */
export interface ConsentGrantFold {
  /** The acceptance becomes the newest one for its exact key. */
  updatesGrant: boolean;
  /** The acceptance becomes the newest one for the identity and profile. */
  updatesLatestGrant: boolean;
}

/**
 * Decide what a new acceptance changes, given the newest previously stored
 * acceptance for the same key and for the same identity. This is the single
 * fold rule shared by every backend (the in-memory/file `ConsentIndex` and the
 * Postgres record path), so they never disagree about which acceptance is
 * persisted or which one drives policy.
 */
export function evaluateGrantFold(
  evidence: ConsentEvidence,
  newestForKey: ConsentEvidence | null,
  newestForIdentity: ConsentEvidence | null,
): ConsentGrantFold {
  // Latest acceptance per key wins and never moves backwards: otherwise a
  // revocation between two timestamps would silently stop applying. On an
  // equal timestamp a differing rules hash wins, so a re-acceptance of
  // changed rules content under the same version is never lost.
  const updatesGrant =
    !newestForKey ||
    evidence.granted_at > newestForKey.granted_at ||
    (evidence.granted_at === newestForKey.granted_at &&
      evidence.rules_hash !== newestForKey.rules_hash);
  // Deterministic tie-break: on an equal granted_at the later applied record
  // wins, in both the live path and a rebuild (file order), and only when it
  // actually differs, so an exact replay stays a no-op.
  const updatesLatestGrant =
    !newestForIdentity ||
    evidence.granted_at > newestForIdentity.granted_at ||
    (evidence.granted_at === newestForIdentity.granted_at &&
      (evidence.rules_version !== newestForIdentity.rules_version ||
        evidence.rules_hash !== newestForIdentity.rules_hash));
  return { updatesGrant, updatesLatestGrant };
}

/**
 * Accumulates grants and revocations into the values a lookup returns.
 *
 * Shared by both store implementations AND by the file rebuild path, so live
 * writes and a rebuild from disk fold records identically: the latest
 * acceptance per key drives policy, the newest grant per identity defines the
 * active rules version, and the newest revocation per identity applies. The
 * durable JSONL file, not this index, is the full audit history.
 */
class ConsentIndex {
  private readonly grants = new Map<string, ConsentEvidence>();
  private readonly latestGrants = new Map<string, ConsentEvidence>();
  private readonly revocations = new Map<string, number>();

  clear(): void {
    this.grants.clear();
    this.latestGrants.clear();
    this.revocations.clear();
  }

  /**
   * Fold a grant into the index. Returns true when durable policy-relevant
   * state changed (renewal recency, latest-version acceptance, or the rules
   * hash at an equal timestamp), meaning the record must be persisted. An
   * exact replay or an out-of-order older acceptance returns false. A grant
   * that supersedes a revocation always carries a newer `granted_at` than the
   * previous renewal, so it changes renewal recency and is persisted.
   */
  apply(evidence: ConsentEvidence): boolean {
    const key = consentEvidenceKey(evidence, evidence.profileId, evidence.rules_version);
    const identityKey = consentIdentityKey(evidence, evidence.profileId);
    const fold = evaluateGrantFold(
      evidence,
      this.grants.get(key) ?? null,
      this.latestGrants.get(identityKey) ?? null,
    );
    if (fold.updatesGrant) {
      this.grants.set(key, { ...evidence });
    }
    if (fold.updatesLatestGrant) {
      this.latestGrants.set(identityKey, { ...evidence });
    }
    return fold.updatesGrant || fold.updatesLatestGrant;
  }

  addRevocation(revocation: ConsentRevocation): void {
    const identityKey = consentIdentityKey(revocation, revocation.profileId);
    const known = this.revocations.get(identityKey);
    if (known === undefined || revocation.revoked_at > known) {
      this.revocations.set(identityKey, revocation.revoked_at);
    }
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
      latestGrant: this.latestGrants.get(identityKey) ?? null,
      revokedAt: this.revocations.get(identityKey) ?? null,
    };
  }
}

/**
 * In-memory consent evidence store.
 *
 * Pilot/dev/test use only: state is lost on restart, is not shared across
 * replicas, and the index is unbounded (nothing is ever evicted). Production
 * wiring always uses the file-backed store via the factory.
 */
export class InMemoryConsentEvidenceStore implements ConsentEvidenceStore {
  private readonly index = new ConsentIndex();

  async record(evidence: ConsentEvidence): Promise<void> {
    // Same fold rule as the durable store, so the two never disagree about
    // which acceptance drives policy; there is no durable line to persist.
    this.index.apply(evidence);
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
 * re-consent rather than silently accepting an unpinned grant. A line that is
 * not valid JSON at all, or a `type: 'revocation'` line failing validation,
 * fails the read closed instead: skipping a grant fails closed, but skipping
 * a revocation would fail open by leaving revoked consent active.
 *
 * Reads are incremental: the index tracks the last read (size, mtime, dev,
 * ino) and, when the same file object has only grown AND the bytes at the
 * previous boundary are unchanged, parses just the new tail; anything else
 * (replacement, shrink, in-place rewrite) forces a full reload. The watermark
 * is never advanced from a stat that did not accompany a read, so an append by
 * another writer landing between our append and our stat is picked up on the
 * next lookup instead of being skipped forever. Cross-writer deduplication is
 * still best-effort: two writers can append the same grant concurrently. Use
 * this for single-node/staging; multi-writer production needs the
 * transactional backend tracked in TODO.md.
 *
 * A directory the store creates itself is created 0700; a pre-existing
 * directory's mode is left to the operator. The evidence file is created 0600
 * and an existing file with wider permissions is tightened before use.
 *
 * Failure policy: any read/write failure throws `ConsentEvidenceStoreError` so
 * the consent gate fails closed (blocks) rather than silently allowing access.
 */
export class FileConsentEvidenceStore implements ConsentEvidenceStore {
  private readonly index = new ConsentIndex();
  private writeQueue: Promise<void> = Promise.resolve();
  private lastLoadedMtimeMs = -1;
  private lastLoadedSize = 0;
  private lastLoadedDev = -1;
  private lastLoadedIno = -1;
  /** Last consumed bytes ending at `lastLoadedSize`, for the append-only proof. */
  private lastLoadedTail: Buffer | null = null;
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
    // Reads share the write queue: `reloadIfChanged`/`loadAll` mutate the index
    // and the watermark, so a reload racing a write's reload could expose the
    // transient empty index mid-rebuild (a false denial) or advance the
    // watermark out of order. Single-flight serialization removes both.
    return this.enqueue(async () => {
      await this.reloadIfChanged();
      return this.index.lookup(identity, profileId, rulesVersion);
    });
  }

  /**
   * Serialize operations without letting one failure poison the queue: the
   * caller of a failed operation gets the rejection, the queue continues.
   */
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.writeQueue.then(operation);
    this.writeQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async persistGrant(evidence: ConsentEvidence): Promise<void> {
    await this.reloadIfChanged();
    // Fold first: only a grant that changes durable policy state (renewal
    // recency, latest-version acceptance, superseding a revocation) is
    // appended; an exact replay is a no-op.
    if (!this.index.apply(evidence)) {
      return;
    }
    try {
      await this.appendLine({ type: 'grant', ...evidence });
    } catch (err) {
      // The in-memory index is now ahead of the durable file. Drop it so the
      // next operation rebuilds from disk and a non-durable grant is never
      // served (fail closed).
      this.resetWatermark();
      throw err;
    }
  }

  private async persistRevocation(revocation: ConsentRevocation): Promise<void> {
    await this.reloadIfChanged();
    await this.appendLine({ type: 'revocation', ...revocation });
    this.index.addRevocation(revocation);
  }

  private async appendLine(record: StoredRecord): Promise<void> {
    const line = `${JSON.stringify(record)}\n`;
    try {
      const createdDir = await mkdir(dirname(this.filePath), {
        recursive: true,
        mode: EVIDENCE_DIR_MODE,
      });
      // Tighten only a directory this store created itself: the `mode` option
      // is masked by the umask, and a pre-existing directory's mode is owned
      // by the operator, not by this store.
      if (createdDir !== undefined) {
        await chmod(dirname(this.filePath), EVIDENCE_DIR_MODE);
      }
      await this.enforceFilePermissions();
      // Size accounting is in bytes, not UTF-16 code units.
      const lineBytes = Buffer.byteLength(line, 'utf8');
      if (record.type === 'revocation') {
        // A revocation is exempt from the file cap: refusing it would keep
        // consent active (fail open) exactly when an operator needs to revoke.
        // Only a sane per-line bound applies.
        if (lineBytes > EVIDENCE_MAX_LINE_BYTES) {
          throw new ConsentEvidenceStoreError(
            'Consent revocation record exceeds the per-line size bound',
            { path: this.filePath, lineBytes, maxLineBytes: EVIDENCE_MAX_LINE_BYTES },
          );
        }
      } else {
        await this.assertSizeAllows(lineBytes);
      }
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
   * `appendFile` mode applies on creation only, so an evidence file that
   * predates this policy (or a permissive umask) keeps its old mode until it
   * is tightened explicitly. Scoped to the evidence file: a pre-existing
   * directory's mode is deliberately left untouched (see `appendLine`).
   */
  private async enforceFilePermissions(): Promise<void> {
    if (this.permissionsChecked) return;
    try {
      const stats = await stat(this.filePath);
      if ((stats.mode & 0o777) !== EVIDENCE_FILE_MODE) {
        await chmod(this.filePath, EVIDENCE_FILE_MODE);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    this.permissionsChecked = true;
  }

  /** Forget everything read so far; the next operation rebuilds from disk. */
  private resetWatermark(): void {
    this.index.clear();
    this.lastLoadedMtimeMs = -1;
    this.lastLoadedSize = 0;
    this.lastLoadedDev = -1;
    this.lastLoadedIno = -1;
    this.lastLoadedTail = null;
    this.loadedOnce = false;
  }

  /**
   * Re-read the file when it changed on disk. Growth of the SAME file object
   * (matching dev/ino) is parsed incrementally from the previous offset, but
   * only after proving the bytes at the previous boundary are unchanged:
   * growth alone does not imply append-only, since an in-place rewrite (for
   * example an operator hand-edit) can produce a larger file with different
   * earlier bytes on the same inode. Anything else (shrink, replacement,
   * dev/ino change, failed boundary proof) forces a full reload.
   */
  private async reloadIfChanged(): Promise<void> {
    let size: number;
    let mtimeMs: number;
    let dev: number;
    let ino: number;
    try {
      const stats = await stat(this.filePath);
      size = stats.size;
      mtimeMs = stats.mtimeMs;
      dev = stats.dev;
      ino = stats.ino;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        // No file yet: an empty index is the correct, durable state.
        this.resetWatermark();
        this.loadedOnce = true;
        return;
      }
      throw new ConsentEvidenceStoreError(
        'Failed to stat consent evidence file',
        { path: this.filePath, cause: err instanceof Error ? err.message : String(err) },
      );
    }

    const sameFile = dev === this.lastLoadedDev && ino === this.lastLoadedIno;
    if (
      this.loadedOnce &&
      sameFile &&
      size === this.lastLoadedSize &&
      mtimeMs === this.lastLoadedMtimeMs
    ) {
      return;
    }
    if (
      this.loadedOnce &&
      sameFile &&
      size > this.lastLoadedSize &&
      (await this.consumedBoundaryUnchanged())
    ) {
      await this.loadTail(size, mtimeMs);
    } else {
      await this.loadAll(size, mtimeMs);
    }
    this.lastLoadedDev = dev;
    this.lastLoadedIno = ino;
  }

  /**
   * Append-only proof for the incremental read: re-read the last consumed
   * bytes at the watermark boundary and require them to match what was
   * consumed before. A mismatch (or any read problem) falls back to a full
   * reload, which surfaces real errors with full context.
   */
  private async consumedBoundaryUnchanged(): Promise<boolean> {
    if (this.lastLoadedSize === 0) return true;
    const expected = this.lastLoadedTail;
    if (!expected || expected.length === 0) return false;
    try {
      const handle = await open(this.filePath, fsConstants.O_RDONLY);
      try {
        const buffer = Buffer.alloc(expected.length);
        const { bytesRead } = await handle.read(
          buffer,
          0,
          buffer.length,
          this.lastLoadedSize - expected.length,
        );
        return bytesRead === expected.length && buffer.equals(expected);
      } finally {
        await handle.close();
      }
    } catch {
      return false;
    }
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
      if (from === 0) this.lastLoadedTail = Buffer.alloc(0);
      this.lastLoadedSize = size;
      this.lastLoadedMtimeMs = mtimeMs;
      this.loadedOnce = true;
      return;
    }

    let raw: Buffer;
    let content: string;
    try {
      const handle = await open(this.filePath, fsConstants.O_RDONLY);
      try {
        const buffer = Buffer.alloc(size - from);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, from);
        raw = buffer.subarray(0, bytesRead);
        content = raw.toString('utf8');
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
        this.index.apply(parsed);
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

    const consumedBytes = Buffer.byteLength(complete, 'utf8');
    this.updateConsumedTail(from === 0, raw.subarray(0, consumedBytes));
    this.lastLoadedSize = from + consumedBytes;
    // Only claim the observed mtime when the whole observed file was consumed;
    // otherwise the next lookup must stat and read again.
    this.lastLoadedMtimeMs = this.lastLoadedSize === size ? mtimeMs : -1;
    this.loadedOnce = true;
  }

  /** Remember the last consumed bytes ending at the watermark boundary. */
  private updateConsumedTail(fromStart: boolean, consumed: Buffer): void {
    const previous = fromStart ? Buffer.alloc(0) : this.lastLoadedTail ?? Buffer.alloc(0);
    const joined = Buffer.concat([previous, consumed]);
    this.lastLoadedTail = Buffer.from(
      joined.subarray(Math.max(0, joined.length - TAIL_PROBE_BYTES)),
    );
  }

  private parseLine(line: string): StoredRecord | null {
    let obj: Partial<StoredRecord>;
    try {
      obj = JSON.parse(line) as Partial<StoredRecord>;
    } catch {
      // An unparseable line cannot be proven not to be a revocation, and a
      // skipped revocation fails open (consent stays active), so fail closed
      // until an operator repairs the file. The line content is not included
      // in the error: it may carry identity data.
      throw new ConsentEvidenceStoreError(
        'Unparseable consent evidence line; repair the evidence file before continuing',
        { path: this.filePath },
      );
    }
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
      // Skipping a malformed grant fails closed (it merely cannot satisfy a
      // lookup), so unlike a revocation it does not block the whole read.
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
      // A revocation that fails validation must not be skipped: it would
      // silently stop applying and leave consent active (fail open).
      throw new ConsentEvidenceStoreError(
        'Malformed consent revocation line; repair the evidence file before continuing',
        { path: this.filePath },
      );
    }
    return null;
  }
}
