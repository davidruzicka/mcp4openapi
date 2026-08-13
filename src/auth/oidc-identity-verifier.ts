import { decodeProtectedHeader, errors as joseErrors, jwtVerify } from 'jose';
import type { Logger } from '../core/logger.js';
import { AuthenticationError } from '../core/errors.js';
import { JwksCache } from './jwks-cache.js';
import { SSRFValidator } from '../security/ssrf-validator.js';
import { normalizeIssuer } from './issuer.js';

interface OidcDiscoveryMetadata {
  issuer?: string;
  jwks_uri?: string;
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
  private readonly fetchFn: typeof fetch;
  private readonly ssrfValidator: SSRFValidator;
  private discoveryPromise?: Promise<Required<OidcDiscoveryMetadata>>;

  constructor(options: OidcIdentityVerifierOptions) {
    this.issuer = normalizeIssuer(options.issuer);
    this.audience = options.audience;
    this.jwksCache = options.jwksCache;
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
      if (error instanceof AuthenticationError) throw error;
      if (error instanceof joseErrors.JOSEError) {
        throw new AuthenticationError('OIDC ID token validation failed');
      }
      throw new AuthenticationError('OIDC identity validation failed');
    }
  }

  private async discover(): Promise<Required<OidcDiscoveryMetadata>> {
    this.discoveryPromise ??= this.fetchDiscovery();
    return this.discoveryPromise;
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
    if (jwksUrl.protocol !== 'https:' || jwksUrl.origin !== new URL(this.issuer).origin) {
      throw new AuthenticationError('OIDC discovery JWKS endpoint is not trusted');
    }
    await this.ssrfValidator.validate(jwksUrl.toString(), {
      allowPrivateNetwork: process.env.MCP4_SSRF_ALLOW_PRIVATE_NETWORK === 'true',
    });
    return { issuer: metadataIssuer, jwks_uri: metadata.jwks_uri };
  }
}