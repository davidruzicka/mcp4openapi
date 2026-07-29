import { decodeProtectedHeader, jwtVerify, errors as joseErrors } from 'jose';
import type { Logger } from '../core/logger.js';
import type { EnterpriseAuthorizationConfig } from '../types/profile.js';
import { EnterpriseReplayStore } from './enterprise-replay-store.js';
import { JwksCache } from './jwks-cache.js';
import { buildEnterprisePrincipal } from './enterprise-policy.js';
import { SSRFValidator } from '../security/ssrf-validator.js';
import {
  EnterpriseIssuerDiscoveryError,
  EnterprisePolicyViolationError,
  EnterpriseTokenReplayError,
  EnterpriseTokenValidationError,
} from '../core/errors.js';
import type { AuthorizedPrincipal } from './inbound-auth-principal.js';

export interface EnterpriseAuthProviderOptions {
  profileId: string;
  config: EnterpriseAuthorizationConfig;
  jwksCache: JwksCache;
  replayStore: EnterpriseReplayStore;
  logger: Logger;
  ssrfValidator: SSRFValidator;
}

export class EnterpriseAuthProvider {
  private readonly profileId: string;
  private readonly config: EnterpriseAuthorizationConfig;
  private readonly jwksCache: JwksCache;
  private readonly replayStore: EnterpriseReplayStore;
  private readonly logger: Logger;
  private readonly ssrfValidator: SSRFValidator;

  constructor(options: EnterpriseAuthProviderOptions) {
    this.profileId = options.profileId;
    this.config = options.config;
    this.jwksCache = options.jwksCache;
    this.replayStore = options.replayStore;
    this.logger = options.logger;
    this.ssrfValidator = options.ssrfValidator;
  }

  async validateAssertion(assertion: string, clientId?: string): Promise<AuthorizedPrincipal> {
    if (Buffer.byteLength(assertion, 'utf8') > (this.config.token_exchange.max_assertion_size_bytes ?? 16384)) {
      throw new EnterpriseTokenValidationError('Enterprise assertion exceeds the configured size limit');
    }
    const header = decodeProtectedHeader(assertion);
    if (!header.alg || !this.config.issuer.allowed_algs?.includes(header.alg as never)) {
      throw new EnterpriseTokenValidationError('Enterprise assertion uses an unsupported signing algorithm', { alg: header.alg });
    }
    if (header.alg === 'none') {
      throw new EnterpriseTokenValidationError('Unsigned enterprise assertions are not accepted');
    }
    if (this.config.issuer.allowed_kids?.length && (!header.kid || !this.config.issuer.allowed_kids.includes(header.kid))) {
      throw new EnterpriseTokenValidationError('Enterprise assertion key id is not allowed', { kid: header.kid });
    }
    if (this.config.access_policy?.allow_dynamic_client_registration === false) {
      if (!clientId) {
        throw new EnterprisePolicyViolationError('Client identifier is required for enterprise token exchange');
      }
      if (!this.config.token_exchange.allowed_client_ids?.includes(clientId)) {
        throw new EnterprisePolicyViolationError('Client is not allowed to use enterprise token exchange', { clientId });
      }
    } else if (this.config.token_exchange.allowed_client_ids?.length && clientId && !this.config.token_exchange.allowed_client_ids.includes(clientId)) {
      throw new EnterprisePolicyViolationError('Client is not allowed to use enterprise token exchange', { clientId });
    }

    const jwksUri = await this.resolveJwksUri();
    const resolver = await this.jwksCache.getResolver(this.config.issuer.issuer, jwksUri, header.kid);
    try {
      const { payload } = await jwtVerify(assertion, resolver, {
        issuer: this.config.issuer.issuer,
        audience: this.config.resource ?? this.config.audience,
        algorithms: this.config.issuer.allowed_algs,
        clockTolerance: this.config.issuer.clock_skew_seconds,
        maxTokenAge: `${this.config.token_exchange.max_assertion_ttl_seconds ?? 300}s`,
      });
      this.validatePayload(payload, header.typ);
      try {
        this.replayStore.register({
          jti: typeof payload.jti === 'string' ? payload.jti : undefined,
          assertion,
          ttlSeconds: this.config.token_exchange.replay_protection_ttl_seconds ?? 600,
          issuer: this.config.issuer.issuer,
        });
      } catch {
        throw new EnterpriseTokenReplayError();
      }
      return buildEnterprisePrincipal(this.profileId, this.config, payload as Record<string, unknown>, clientId);
    } catch (error) {
      if (error instanceof EnterpriseTokenReplayError || error instanceof EnterprisePolicyViolationError || error instanceof EnterpriseTokenValidationError) {
        throw error;
      }
      if (error instanceof EnterpriseIssuerDiscoveryError) {
        throw error;
      }
      if (error instanceof joseErrors.JWTExpired || error instanceof joseErrors.JWTClaimValidationFailed || error instanceof joseErrors.JWSSignatureVerificationFailed) {
        throw new EnterpriseTokenValidationError('Enterprise assertion validation failed', { reason: error.code });
      }
      throw new EnterpriseTokenValidationError('Enterprise assertion validation failed');
    }
  }

  private async resolveJwksUri(): Promise<string> {
    if (this.config.issuer.trust_mode !== 'discovery') {
      return this.config.issuer.jwks_uri ?? new URL('/.well-known/jwks.json', this.config.issuer.issuer).toString();
    }

    const discoveryUrl = new URL('/.well-known/openid-configuration', this.config.issuer.issuer).toString();
    await this.ssrfValidator.validate(discoveryUrl, {
      allowPrivateNetwork: process.env.MCP4_SSRF_ALLOW_PRIVATE_NETWORK === 'true',
    });
    const response = await fetch(discoveryUrl, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      throw new EnterpriseIssuerDiscoveryError('Failed to resolve issuer discovery metadata', {
        issuer: this.config.issuer.issuer,
        status: response.status,
      });
    }

    const metadata = await response.json() as { jwks_uri?: string; issuer?: string };
    if (metadata.issuer && metadata.issuer !== this.config.issuer.issuer) {
      throw new EnterpriseIssuerDiscoveryError('Issuer discovery metadata did not match configured issuer', {
        issuer: this.config.issuer.issuer,
        discoveredIssuer: metadata.issuer,
      });
    }
    if (!metadata.jwks_uri) {
      throw new EnterpriseIssuerDiscoveryError('Issuer discovery metadata did not include jwks_uri', {
        issuer: this.config.issuer.issuer,
      });
    }
    return metadata.jwks_uri;
  }

  private validatePayload(payload: Record<string, unknown>, typ?: string): void {
    if (this.config.token_exchange.required_typ?.length) {
      const matchesTyp = typ && this.config.token_exchange.required_typ.includes(typ);
      if (!matchesTyp) {
        throw new EnterpriseTokenValidationError('Enterprise assertion typ header is not allowed');
      }
    }
    for (const claim of this.config.token_exchange.required_claims ?? []) {
      if (payload[claim] === undefined || payload[claim] === null || payload[claim] === '') {
        throw new EnterpriseTokenValidationError(`Enterprise assertion is missing required claim '${claim}'`);
      }
    }
    if (!payload.sub || typeof payload.sub !== 'string') {
      throw new EnterpriseTokenValidationError('Enterprise assertion is missing sub claim');
    }
    this.logger.debug('Enterprise assertion validated', {
      profileId: this.profileId,
      issuer: payload.iss,
      clientId: payload.azp,
      subject: payload.sub,
    });
  }
}
