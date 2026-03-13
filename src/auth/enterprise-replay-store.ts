import { createHash } from 'node:crypto';

export interface EnterpriseReplayStoreOptions {
  maxEntries: number;
}

interface ReplayEntry {
  key: string;
  expiresAt: number;
}

export class EnterpriseReplayStore {
  private readonly maxEntries: number;
  private readonly entries = new Map<string, ReplayEntry>();

  constructor(options: EnterpriseReplayStoreOptions) {
    this.maxEntries = options.maxEntries;
  }

  register(input: { jti?: string; assertion: string; ttlSeconds: number; issuer: string }): string {
    this.evictExpired(Date.now());
    const key = input.jti?.trim() || this.digestAssertion(input.assertion, input.issuer);
    const now = Date.now();
    const existing = this.entries.get(key);
    if (existing && existing.expiresAt > now) {
      throw new Error('replay-detected');
    }

    this.entries.set(key, {
      key,
      expiresAt: now + (input.ttlSeconds * 1000),
    });
    this.evictOverflow();
    return key;
  }

  size(): number {
    return this.entries.size;
  }

  private digestAssertion(assertion: string, issuer: string): string {
    return createHash('sha256').update(`${issuer}:${assertion}`).digest('base64url');
  }

  private evictExpired(now: number): void {
    for (const [key, entry] of this.entries.entries()) {
      if (entry.expiresAt <= now) {
        this.entries.delete(key);
      }
    }
  }

  private evictOverflow(): void {
    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (!oldestKey) {
        break;
      }
      this.entries.delete(oldestKey);
    }
  }
}
