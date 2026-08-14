import { decodeProtectedHeader, errors as joseErrors, jwtVerify } from 'jose';
import type { Logger } from '../core/logger.js';
import { AuthenticationError } from '../core/errors.js';
import { JwksCache } from './jwks-cache.js';
import { SSRFValidator } from '../security/ssrf-validator.js';
import { normalizeIssuer } from './issuer.js';

// Successful discovery metadata is cached for this long so a rotated jwks_uri
// is picked up without a process restart.
const DISCOVERY_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

interface OidcDiscoveryMetadata {
  issuer?: string;
  jwks_uri?: string;
}

interface DiscoveryCacheEntry {
  metadata: Promise<Required<OidcDiscoveryMetadata>>;
  expiresAt: number;
}

export interface OidcIdentity {
  subject: string;
  issuer: string;
  tenantId?: string;
}

export interface OidcIdentityVerifierOptions {
  issuer: string;
  audience: string;
  jwksCache: JwksCache;
  logger: Logger;
  fetchFn?: typeof fetch;
  ssrfValidator?: SSRFValidator;
}

export class OidcIdentityVerifier {
  private readonly issuer: string;
  private readonly audience: string;
  private readonly jwksCache: JwksCache;
  private readonly logger: Logger;
  private readonly fetchFn: typeof fetch;
  private readonly ssrfValidator: SSRFValidator;
  private discoveryCache?: DiscoveryCacheEntry;

  constructor(options: OidcIdentityVerifierOptions) {
    this.issuer = normalizeIssuer(options.issuer);
    this.audience = options.audience;
    this.jwksCache = options.jwksCache;
    this.logger = options.logger;
    this.fetchFn = options.fetchFn ?? fetch;
    this.ssrfValidator = options.ssrfValidator ?? new SSRFValidator(options.logger);
  }

  async verify(idToken: string, expectedNonce: string): Promise<OidcIdentity> {
    try {
      const header = decodeProtectedHeader(idToken);
      if (!header.alg || header.alg === 'none') {
        throw new AuthenticationError('OIDC ID token uses an unsupported signing algorithm');
      }
      const metadata = await this.discover();
      const resolver = await this.jwksCache.getResolver(metadata.issuer, metadata.jwks_uri, header.kid);
      const { payload } = await jwtVerify(idToken, resolver, {
        issuer: metadata.issuer,
        audience: this.audience,
        algorithms: ['RS256', 'RS384', 'RS512', 'ES256', 'ES384', 'ES512'],
        clockTolerance: 30,
        // A token without exp would never expire and one without sub carries
        // no verifiable principal; iat is required by OIDC Core section 2.
        requiredClaims: ['exp', 'iat', 'sub'],
      });
      // OIDC Core 3.1.3.7 rules 4-5: multi-audience tokens require azp, and any
      // present azp must identify this client.
      if (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp === undefined) {
        throw new AuthenticationError('OIDC ID token is missing an authorized party claim');
      }
      if (payload.azp !== undefined && payload.azp !== this.audience) {
        throw new AuthenticationError('OIDC ID token authorized party validation failed');
      }
      if (payload.nonce !== expectedNonce) {
        throw new AuthenticationError('OIDC ID token nonce validation failed');
      }
      const subject = typeof payload.oid === 'string' ? payload.oid : payload.sub;
      if (typeof subject !== 'string' || !subject) {
        throw new AuthenticationError('OIDC ID token is missing a subject claim');
      }
      return {
        subject,
        issuer: metadata.issuer,
        tenantId: typeof payload.tid === 'string' ? payload.tid : undefined,
      };
    } catch (error) {
      // Server-side diagnostic: error NAME only - never token material or claims.
      this.logger.warn('OIDC verification failed', {
        reason: error instanceof Error ? error.name : 'UnknownError',
      });
      if (error instanceof AuthenticationError) throw error;
      if (error instanceof joseErrors.JOSEError) {
        throw new AuthenticationError('OIDC ID token validation failed');
      }
      throw new AuthenticationError('OIDC identity validation failed');
    }
  }

  private discover(): Promise<Required<OidcDiscoveryMetadata>> {
    const now = Date.now();
    if (this.discoveryCache && now < this.discoveryCache.expiresAt) {
      return this.discoveryCache.metadata;
    }
    const entry: DiscoveryCacheEntry = {
      metadata: this.fetchDiscovery(),
      expiresAt: now + DISCOVERY_CACHE_TTL_MS,
    };
    this.discoveryCache = entry;
    // A rejected discovery must not brick later logins: drop the memo so the
    // next verify() retries instead of replaying the cached rejection.
    entry.metadata.catch(() => {
      if (this.discoveryCache === entry) {
        this.discoveryCache = undefined;
      }
    });
    return entry.metadata;
  }

  private async fetchDiscovery(): Promise<Required<OidcDiscoveryMetadata>> {
    const discoveryUrl = `${this.issuer}/.well-known/openid-configuration`;
    await this.ssrfValidator.validate(discoveryUrl, {
      allowPrivateNetwork: process.env.MCP4_SSRF_ALLOW_PRIVATE_NETWORK === 'true',
    });
    const response = await this.fetchFn(discoveryUrl, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      throw new AuthenticationError('OIDC discovery failed');
    }
    const metadata = await response.json() as OidcDiscoveryMetadata;
    const metadataIssuer = typeof metadata.issuer === 'string'
      ? normalizeIssuer(metadata.issuer)
      : undefined;
    if (metadataIssuer !== this.issuer || !metadata.jwks_uri) {
      throw new AuthenticationError('OIDC discovery metadata is invalid');
    }
    const jwksUrl = new URL(metadata.jwks_uri);
    // Same-origin pin (Entra-shaped assumption): on Microsoft Entra ID the
    // issuer and jwks_uri share an origin. IdPs that serve JWKS from a
    // different host (for example Google, which splits accounts.google.com
    // and www.googleapis.com) are intentionally rejected here - supporting
    // them would require a per-IdP host allowlist, not a relaxed check.
    if (jwksUrl.protocol !== 'https:' || jwksUrl.origin !== new URL(this.issuer).origin) {
      throw new AuthenticationError('OIDC discovery JWKS endpoint is not trusted');
    }
    await this.ssrfValidator.validate(jwksUrl.toString(), {
      allowPrivateNetwork: process.env.MCP4_SSRF_ALLOW_PRIVATE_NETWORK === 'true',
    });
    return { issuer: metadataIssuer, jwks_uri: metadata.jwks_uri };
  }
}
