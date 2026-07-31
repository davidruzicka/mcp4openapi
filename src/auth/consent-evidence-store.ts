import { appendFile, mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

/**
 * Pluggable store for consent evidence.
 *
 * Records that a provable human subject accepted the rules of a consent-gated
 * profile at a specific `rules_version`. The gate consults `has(...)` before
 * dispatching any tool call; the consent HTTP flow calls `record(...)` after a
 * verified human login.
 *
 * The first implementation is in-memory (`InMemoryConsentEvidenceStore`), which
 * is adequate for a dev pilot but NOT for auditable production evidence: it is
 * lost on restart and is not shared across replicas. A persistent backend
 * (durable "who/when/rules_version" trail) is required before production and
 * slots in behind this same interface via the factory.
 */
export interface ConsentEvidence {
  /** Authenticated subject identifier (OAuth `sub`) that granted consent. */
  sub: string;
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
  /** Return true when consent exists for this subject + profile + rules_version. */
  has(sub: string, profileId: string, rulesVersion: string): Promise<boolean>;
}

/**
 * Build the composite key that binds consent to a subject, profile, and rules
 * version. Changing `rules_version` yields a new key, so prior consent no
 * longer matches and re-acceptance is forced.
 */
export function consentEvidenceKey(
  sub: string,
  profileId: string,
  rulesVersion: string,
): string {
  return `${sub}|${profileId}|${rulesVersion}`;
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
      evidence.sub,
      evidence.profileId,
      evidence.rules_version,
    );
    // Keep the first grant to preserve the original granted_at for audit.
    if (!this.records.has(key)) {
      this.records.set(key, { ...evidence });
    }
  }

  async has(sub: string, profileId: string, rulesVersion: string): Promise<boolean> {
    return this.records.has(consentEvidenceKey(sub, profileId, rulesVersion));
  }
}

/**
 * Durable append-only consent evidence store for single-node deployments.
 *
 * The file is reloaded when its mtime changes so independent gateway processes
 * on a shared filesystem can observe newly granted consent. Deployments that
 * require stronger cross-node transaction guarantees should replace this store
 * behind the same interface.
 */
export class FileConsentEvidenceStore implements ConsentEvidenceStore {
  private readonly records = new Map<string, ConsentEvidence>();
  private loadedMtimeMs = -1;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async record(evidence: ConsentEvidence): Promise<void> {
    this.writeQueue = this.writeQueue.then(async () => {
      await this.reloadIfChanged();
      const key = consentEvidenceKey(evidence.sub, evidence.profileId, evidence.rules_version);
      if (this.records.has(key)) return;
      await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
      await appendFile(this.filePath, `${JSON.stringify(evidence)}\n`, { encoding: 'utf8', mode: 0o600 });
      this.records.set(key, { ...evidence });
      this.loadedMtimeMs = (await stat(this.filePath)).mtimeMs;
    });
    return this.writeQueue;
  }

  async has(sub: string, profileId: string, rulesVersion: string): Promise<boolean> {
    await this.writeQueue;
    await this.reloadIfChanged();
    return this.records.has(consentEvidenceKey(sub, profileId, rulesVersion));
  }

  private async reloadIfChanged(): Promise<void> {
    let mtimeMs: number;
    try {
      mtimeMs = (await stat(this.filePath)).mtimeMs;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (mtimeMs === this.loadedMtimeMs) return;

    const content = await readFile(this.filePath, 'utf8');
    const reloaded = new Map<string, ConsentEvidence>();
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      const parsed = JSON.parse(line) as Partial<ConsentEvidence>;
      if (
        typeof parsed.sub !== 'string' ||
        typeof parsed.profileId !== 'string' ||
        typeof parsed.rules_version !== 'string' ||
        typeof parsed.granted_at !== 'number'
      ) {
        throw new Error('Consent evidence file contains an invalid record');
      }
      const evidence = parsed as ConsentEvidence;
      const key = consentEvidenceKey(evidence.sub, evidence.profileId, evidence.rules_version);
      if (!reloaded.has(key)) reloaded.set(key, evidence);
    }
    this.records.clear();
    for (const [key, evidence] of reloaded) this.records.set(key, evidence);
    this.loadedMtimeMs = mtimeMs;
  }
}
