import type { Logger } from '../core/logger.js';
import { SSRFValidator } from '../security/ssrf-validator.js';
import { createLocalJWKSet, type JWK } from 'jose';
import { EnterpriseIssuerDiscoveryError } from '../core/errors.js';

const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_JWKS_RESPONSE_BYTES = 256 * 1024;

export interface JwksCacheOptions {
  maxCachedIssuers: number;
  maxCachedKeys: number;
  refreshTimeoutMs: number;
  refreshBackoffMs: number;
  cacheTtlMs?: number;
}

interface CachedJwks {
  jwksUri: string;
  fetchedAt: number;
  keyResolver: ReturnType<typeof createLocalJWKSet>;
  kids: Set<string>;
}

export class JwksCache {
  private readonly options: JwksCacheOptions;
  private readonly logger: Logger;
  private readonly ssrfValidator: SSRFValidator;
  private readonly issuers = new Map<string, CachedJwks>();
  private readonly refreshes = new Map<string, Promise<CachedJwks>>();
  private readonly lastRefreshAttempt = new Map<string, number>();

  constructor(options: JwksCacheOptions, logger: Logger) {
    this.options = options;
    this.logger = logger;
    this.ssrfValidator = new SSRFValidator(logger);
  }

  async getResolver(issuer: string, jwksUri: string, kid?: string): Promise<ReturnType<typeof createLocalJWKSet>> {
    const cached = this.issuers.get(issuer);
    if (cached && this.isCacheEntryFresh(cached) && (!kid || cached.kids.has(kid))) {
      return cached.keyResolver;
    }

    const refreshed = await this.refresh(issuer, jwksUri, !cached || !this.isCacheEntryFresh(cached));
    if (kid && !refreshed.kids.has(kid)) {
      throw new EnterpriseIssuerDiscoveryError('JWKS does not contain the requested key id', { issuer, kid });
    }
    return refreshed.keyResolver;
  }

  private isCacheEntryFresh(entry: CachedJwks): boolean {
    return Date.now() - entry.fetchedAt < (this.options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS);
  }

  private async refresh(issuer: string, jwksUri: string, force: boolean): Promise<CachedJwks> {
    const now = Date.now();
    const lastAttempt = this.lastRefreshAttempt.get(issuer) ?? 0;
    if (!force && now - lastAttempt < this.options.refreshBackoffMs) {
      const cached = this.issuers.get(issuer);
      if (cached && this.isCacheEntryFresh(cached)) {
        return cached;
      }
    }

    const inflight = this.refreshes.get(issuer);
    if (inflight) {
      return inflight;
    }

    const promise = this.fetchJwks(issuer, jwksUri);
    this.refreshes.set(issuer, promise);
    try {
      return await promise;
    } finally {
      this.refreshes.delete(issuer);
      this.lastRefreshAttempt.set(issuer, Date.now());
    }
  }

  private async fetchJwks(issuer: string, jwksUri: string): Promise<CachedJwks> {
    await this.ssrfValidator.validate(jwksUri, {
      allowPrivateNetwork: process.env.MCP4_SSRF_ALLOW_PRIVATE_NETWORK === 'true',
    });
    const response = await fetch(jwksUri, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(this.options.refreshTimeoutMs),
    });
    if (!response.ok) {
      throw new EnterpriseIssuerDiscoveryError('Failed to fetch enterprise JWKS', { issuer, status: response.status });
    }

    const body = await response.text();
    if (Buffer.byteLength(body, 'utf8') > MAX_JWKS_RESPONSE_BYTES) {
      throw new EnterpriseIssuerDiscoveryError('Enterprise JWKS response exceeded the size limit', { issuer });
    }

    const jwks = JSON.parse(body) as { keys?: JWK[] };
    if (!Array.isArray(jwks.keys) || jwks.keys.length === 0) {
      throw new EnterpriseIssuerDiscoveryError('Enterprise JWKS response did not include keys', { issuer });
    }

    const limitedKeys = jwks.keys.slice(0, this.options.maxCachedKeys);
    const cached: CachedJwks = {
      jwksUri,
      fetchedAt: Date.now(),
      keyResolver: createLocalJWKSet({ keys: limitedKeys }),
      kids: new Set(limitedKeys.map((key) => String(key.kid ?? '')).filter(Boolean)),
    };
    this.issuers.set(issuer, cached);
    while (this.issuers.size > this.options.maxCachedIssuers) {
      const oldest = this.issuers.keys().next().value;
      if (!oldest) {
        break;
      }
      this.issuers.delete(oldest);
    }
    this.logger.debug('Enterprise JWKS refreshed', { issuer, kidCount: cached.kids.size });
    return cached;
  }
}
