import { randomBytes } from 'node:crypto';
import type { AuthorizedPrincipal, InboundAuthTokenRecord } from './inbound-auth-principal.js';

export interface InboundAuthTokenStoreOptions {
  maxTokens: number;
}

export class InboundAuthTokenStore {
  private readonly maxTokens: number;
  private readonly records = new Map<string, InboundAuthTokenRecord>();

  constructor(options: InboundAuthTokenStoreOptions) {
    this.maxTokens = options.maxTokens;
  }

  issue(principal: AuthorizedPrincipal): InboundAuthTokenRecord {
    this.evictExpired(Date.now());
    const token = randomBytes(32).toString('base64url');
    const record: InboundAuthTokenRecord = {
      token,
      principal,
      issuedAt: Date.now(),
      expiresAt: principal.expiresAt,
    };
    this.records.set(token, record);
    this.evictOverflow();
    return record;
  }

  get(token: string): InboundAuthTokenRecord | undefined {
    const record = this.records.get(token);
    if (!record) {
      return undefined;
    }
    if (record.expiresAt !== undefined && record.expiresAt <= Date.now()) {
      this.records.delete(token);
      return undefined;
    }
    return record;
  }

  delete(token: string): void {
    this.records.delete(token);
  }

  size(): number {
    return this.records.size;
  }

  private evictExpired(now: number): void {
    for (const [token, record] of this.records.entries()) {
      if (record.expiresAt !== undefined && record.expiresAt <= now) {
        this.records.delete(token);
      }
    }
  }

  private evictOverflow(): void {
    while (this.records.size > this.maxTokens) {
      const oldestKey = this.records.keys().next().value;
      if (!oldestKey) {
        break;
      }
      this.records.delete(oldestKey);
    }
  }
}
