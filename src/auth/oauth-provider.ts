/**
 * OAuth 2.0 Provider Adapter
 * 
 * Implements MCP SDK OAuthServerProvider interface to integrate with external
 * OAuth 2.0 authorization servers (e.g., GitLab, GitHub, etc.)
 * 
 * Architecture:
 * - This server acts as an OAuth client to the external provider (Proxy/Gateway)
 * - Implements "Callback Mode":
 *   1. Client -> MCP (Authorize) -> MCP redirects to Provider (with MCP callback URL)
 *   2. Provider -> MCP (Callback) -> MCP exchanges code for tokens
 *   3. MCP redirects to Client (with Internal Code)
 *   4. Client -> MCP (Token) -> MCP returns stored tokens
 */

import { randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { Request, Response } from 'express';
import type {
  OAuthServerProvider,
  AuthorizationParams,
} from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type {
  OAuthClientInformationFull,
  OAuthTokens,
  OAuthTokenRevocationRequest,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { OAuthConfig } from '../types/profile.js';
import type { Logger } from '../core/logger.js';
import type { OidcIdentity, OidcIdentityVerifier } from './oidc-identity-verifier.js';
import { normalizeIssuer } from './issuer.js';
import { REFRESH_IDENTITY_TTL_MS } from './token-envelope.js';
import { AuthenticationError, OAuthInvalidGrantError, OAuthUpstreamError, ValidationError } from '../core/errors.js';
import { matchEnvRefName, resolveEnvRef } from '../core/env-ref.js';
import {
  DEFAULT_ALLOWED_REDIRECT_HOSTS,
  DEFAULT_OAUTH_LOOPBACK_CALLBACK_URIS,
  OAUTH_CLEANUP,
  OAUTH_PATHS,
  PROXY_CREDENTIALS,
} from '../core/constants.js';
import { escapeHtmlSafe } from '../validation/validation-utils.js';
import { SSRFValidator } from '../security/ssrf-validator.js';
import { parseOAuthMetadataEndpoints } from './oauth-metadata.js';
import { InMemoryClientsStore } from './client-store/in-memory-clients-store.js';
import { isApprovedUnregisteredClientRedirectUri } from './unregistered-client-redirect-policy.js';
export { InMemoryClientsStore };
export type { InMemoryClientsStoreOptions } from './client-store/types.js';

// --- OAuth operational-check helpers (module-private + exported) ---

// Upper bound on remembered refresh-token identity bindings.
// Binding TTL: REFRESH_IDENTITY_TTL_MS, shared with the refresh envelope
// age check (see token-envelope.ts).
const REFRESH_IDENTITY_MAX = 10000;
// Capacity-eviction warnings are aggregated to at most one per interval.
const REFRESH_EVICTION_WARN_INTERVAL_MS = 60 * 1000;

/**
 * Safely resolves a single `${env:VAR}` reference. Returns the env var value
 * when the var is set, undefined when unset, or the literal value when no
 * env reference pattern is present. Does NOT throw - callers rely on this
 * for pre-flight checks before ExternalOAuthProvider construction.
 */
function tryResolveEnvRef(value: string | undefined): string | undefined {
  if (!value) return value;
  return resolveEnvRef(value); // undefined when a referenced var is not set
}

/** Result returned by isOAuthConfigOperational(). */
export interface OAuthOperationalCheck {
  operational: boolean;
  /** Names of required fields that are absent or have unresolved env refs. */
  missing: string[];
}

/**
 * Pre-flight check: returns whether an OAuthConfig has the minimum required
 * fields available at runtime (env vars resolved). Safe to call before
 * ExternalOAuthProvider construction - does not throw.
 *
 * Required after env-var resolution:
 * - `issuer` OR (`authorization_endpoint` AND `token_endpoint`)
 * - `redirect_uri` - unless `allow_unregistered_clients: true`
 */
export function isOAuthConfigOperational(config: OAuthConfig): OAuthOperationalCheck {
  const missing: string[] = [];

  const issuer = tryResolveEnvRef(config.issuer);
  const authEndpoint = tryResolveEnvRef(config.authorization_endpoint);
  const tokenEndpoint = tryResolveEnvRef(config.token_endpoint);

  if (!issuer && !(authEndpoint && tokenEndpoint)) {
    missing.push('issuer or (authorization_endpoint + token_endpoint)');
  }

  // redirect_uri required only for pre-registered clients;
  // allow_unregistered_clients flows provide redirect_uri at runtime.
  if (!config.allow_unregistered_clients) {
    const redirectUri = tryResolveEnvRef(config.redirect_uri);
    if (!redirectUri) missing.push('redirect_uri');
    // client_id: only flag when declared as an env ref but var is unset.
    // Absent (undefined) is not flagged — ExternalOAuthProvider does not throw for it,
    // and allow_unregistered_clients flows may set it via DCR at runtime.
    if (config.client_id !== undefined && !tryResolveEnvRef(config.client_id)) {
      missing.push('client_id');
    }
  }

  return { operational: missing.length === 0, missing };
}

/**
 * RFC 7636 4.1: a PKCE code_verifier is 43-128 chars from the unreserved set
 * [A-Z / a-z / 0-9 / "-" / "." / "_" / "~"]. Enforced before the S256 compare
 * so malformed verifiers are rejected as invalid_request, not invalid_grant.
 */
const PKCE_CODE_VERIFIER_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/;

/**
 * How long a consumed authorization code is remembered so a replay can revoke
 * the tokens issued during its first redemption (RFC 6749 §4.1.2). Matches the
 * 5 min authorization-code TTL: a code cannot be replayed after it would have
 * expired anyway.
 */
const CONSUMED_CODE_TOMBSTONE_TTL_MS = 5 * 60 * 1000;

/** Loopback hosts that may use plain http redirect_uris (RFC 8252). */
const LOOPBACK_REDIRECT_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

/**
 * State preserved across the redirect to external provider
 */
interface AuthorizationState {
  clientRedirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  originalState?: string;
  clientId: string;
  scopes?: string[];
  nonce?: string;
  createdAt: number;
}

/**
 * Data stored for each internal authorization code
 */
interface AuthorizationCodeData {
  client: OAuthClientInformationFull;
  params: AuthorizationParams;
  createdAt: number;
  tokens?: OAuthTokens; // Stored external tokens
  identity?: OidcIdentity;
}

/**
 * Data stored for each access token
 */
interface AccessTokenData {
  token: string;
  clientId: string;
  scopes: string[];
  expiresAt?: number;
  resource?: URL;
  identity?: OidcIdentity;
}

/**
 * OAuth Provider Adapter for external OAuth servers
 */
export class ExternalOAuthProvider implements OAuthServerProvider {
  private config: OAuthConfig;
  private logger: Logger;
  private _clientsStore: InMemoryClientsStore;
  private ssrfValidator: SSRFValidator;
  private identityVerifier?: OidcIdentityVerifier;
  private onIdentityVerified?: (identity: OidcIdentity) => Promise<void>;
  
  // In-memory storage
  private authorizationCodes = new Map<string, AuthorizationCodeData>();
  private accessTokens = new Map<string, AccessTokenData>();
  private refreshTokenIdentities = new Map<string, { identity: OidcIdentity; clientId: string; expiresAt: number }>();
  private stateStore = new Map<string, AuthorizationState>();
  private materializedUnregisteredClientIds = new Set<string>();
  // RFC 6749 §4.1.2: short-lived record of tokens issued from a now-consumed
  // authorization code, so a replay of that code can revoke them.
  private consumedCodeTombstones = new Map<string, { accessToken: string; refreshToken?: string; clientId: string; expiresAt: number }>();

  private endpointsInitialized: boolean = false;
  private initializationPromise: Promise<void> | null = null;

  // Aggregation state for the capacity-eviction warn (see storeRefreshTokenIdentity).
  private refreshEvictionsSinceLastWarn = 0;
  private lastRefreshEvictionWarnAt = 0;

  constructor(config: OAuthConfig, logger: Logger, identityVerifier?: OidcIdentityVerifier) {
    this.config = config;
    this.logger = logger;
    this.ssrfValidator = new SSRFValidator(logger);
    this.identityVerifier = identityVerifier;
    this._clientsStore = new InMemoryClientsStore();
    
    // Resolve environment variables in OAuth config
    const resolvedConfig = this.resolveEnvVars(config);
    this.config = {
      ...resolvedConfig,
      issuer: resolvedConfig.issuer ? normalizeIssuer(resolvedConfig.issuer) : undefined,
    };
    
    // Pre-register mcp-proxy-client for VS Code compatibility.
    // VS Code does not call /oauth/register before /oauth/authorize and uses one
    // shared compatibility client_id across installs, so redirect validation must
    // remain request-scoped instead of relying on a per-install registration record.
    // Keep redirect_uris empty here to allow runtime validation without pinning one
    // VS Code instance's redirect_uri onto another instance that reuses the same id.
    const proxyClient: OAuthClientInformationFull = {
      client_id: PROXY_CREDENTIALS.CLIENT_ID,
      client_secret: PROXY_CREDENTIALS.CLIENT_SECRET,
      redirect_uris: [], // Empty = allow any redirect URI
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: this.config.scopes ? this.config.scopes.join(' ') : '',
    };
    this._clientsStore.registerClient(proxyClient);
    this.logger.info('Pre-registered mcp-proxy-client for VS Code compatibility');
  }

  configureIdentityVerification(
    verifier: OidcIdentityVerifier,
    onIdentityVerified?: (identity: OidcIdentity) => Promise<void>,
  ): void {
    this.identityVerifier = verifier;
    this.onIdentityVerified = onIdentityVerified;
  }

  get issuer(): string | undefined {
    return this.config.issuer;
  }

  get configuredClientId(): string | undefined {
    return this.config.client_id;
  }

  /**
   * Lazy initialization of OAuth endpoints (async)
   * Public method to allow HttpTransport to ensure initialization before client validation
   */
  public async ensureEndpointsInitialized(): Promise<void> {
    if (this.endpointsInitialized) {
      return;
    }

    // Prevent concurrent initializations
    if (this.initializationPromise) {
      return this.initializationPromise;
    }

    const initialization = (async () => {
      // Register default client BEFORE deriving endpoints
      // This ensures the client is available immediately, even if endpoint derivation fails
      // The client_id from config should be registered as soon as possible to avoid
      // race conditions where /oauth/authorize is called before initialization completes
      if (this.config.client_id) {
        // Allow localhost and configured redirect_uri for default client
        const allowedUris: string[] = [];
        if (this.config.redirect_uri) {
          allowedUris.push(this.config.redirect_uri);
        }
        // Also allow common loopback callbacks for development/testing
        allowedUris.push(...DEFAULT_OAUTH_LOOPBACK_CALLBACK_URIS);
        
        const defaultClient: OAuthClientInformationFull = {
          client_id: this.config.client_id,
          client_secret: this.config.client_secret,
          redirect_uris: allowedUris,
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          scope: this.config.scopes ? this.config.scopes.join(' ') : '',
        };
        this._clientsStore.registerClient(defaultClient);
        this.logger.info('Registered default OAuth client', { 
          clientId: this.config.client_id,
          redirectUris: allowedUris 
        });
      }
      
      // Derive endpoints from issuer if needed
      this.config = await this.deriveEndpointsFromIssuer(this.config);
      
      // Validate that we have required endpoints
      if (!this.config.authorization_endpoint || !this.config.token_endpoint) {
        throw new Error('OAuth config must provide either issuer OR both authorization_endpoint and token_endpoint');
      }
      
      this.logger.info('ExternalOAuthProvider initialized', {
        authEndpoint: this.config.authorization_endpoint,
        tokenEndpoint: this.config.token_endpoint,
        hasClientId: !!this.config.client_id,
        scopes: this.config.scopes || [],
      });

      this.endpointsInitialized = true;
    })();

    // Reset the memoized promise on failure so a later request retries
    // initialization instead of permanently 500-ing every OAuth endpoint after
    // a single config-time error.
    initialization.catch(() => {
      this.initializationPromise = null;
    });

    this.initializationPromise = initialization;
    return this.initializationPromise;
  }

  get clientsStore(): InMemoryClientsStore {
    return this._clientsStore;
  }

  get authorizationEndpoint(): string | undefined {
    // May be undefined before ensureEndpointsInitialized() is called
    // when OAuth config provides issuer instead of explicit endpoints
    return this.config.authorization_endpoint;
  }

  get redirectUri(): string | undefined {
    return this.config.redirect_uri;
  }

  get scopes(): string[] {
    return this.config.scopes || [];
  }

  async getOrProvisionUnregisteredClient(
    clientId: string,
    redirectUri: string,
  ): Promise<OAuthClientInformationFull | undefined> {
    if (!this.config.allow_unregistered_clients) {
      return undefined;
    }

    if (!this.isApprovedUnregisteredClientRedirectUri(redirectUri)) {
      return undefined;
    }

    const existingClient = await this._clientsStore.getClient(clientId);
    if (existingClient) {
      if (!this.materializedUnregisteredClientIds.has(clientId)) {
        return existingClient;
      }

      if (
        existingClient.redirect_uris?.length === 0
        || existingClient.redirect_uris?.includes(redirectUri)
      ) {
        return existingClient;
      }

      const redirectUris = this.buildValidatedUnregisteredRedirectUriList(
        existingClient.redirect_uris,
        redirectUri,
      );
      if (!redirectUris) {
        return undefined;
      }

      // Some desktop clients (notably VS Code compatibility flows) reuse a shared
      // client_id across installations. Preserve the existing materialized record,
      // but append newly approved redirect_uris so one instance does not block
      // another instance that reuses the same client_id with a different callback.
      const updatedClient: OAuthClientInformationFull = {
        ...existingClient,
        redirect_uris: redirectUris,
      };
      await this._clientsStore.registerClient(updatedClient);
      this.logger.info('Appended approved redirect URI to existing OAuth client', {
        clientId,
        redirectUri,
        redirectUriCount: updatedClient.redirect_uris.length,
      });
      return updatedClient;
    }

    const redirectUris = this.buildValidatedUnregisteredRedirectUriList([], redirectUri);
    if (!redirectUris) {
      return undefined;
    }

    const client: OAuthClientInformationFull = {
      client_id: clientId,
      redirect_uris: redirectUris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: this.config.scopes ? this.config.scopes.join(' ') : '',
    };

    await this._clientsStore.registerClient(client);
    this.materializedUnregisteredClientIds.add(clientId);
    this.logger.info('Materialized approved unregistered OAuth client', {
      clientId,
      redirectUri,
    });
    return client;
  }

  hasMaterializedUnregisteredClient(clientId: string): boolean {
    return this.materializedUnregisteredClientIds.has(clientId);
  }

  private buildValidatedUnregisteredRedirectUriList(
    existingRedirectUris: readonly string[],
    nextRedirectUri: string,
  ): string[] | undefined {
    const redirectUris = Array.from(new Set([...existingRedirectUris, nextRedirectUri]));
    const limits = this._clientsStore.getLimits();

    if (redirectUris.length > limits.maxRedirectUris) {
      this.logger.warn('Refused to materialize unregistered OAuth client redirect URI: max redirect URI count exceeded', {
        redirectUriCount: redirectUris.length,
        maxRedirectUris: limits.maxRedirectUris,
      });
      return undefined;
    }

    if (nextRedirectUri.length > limits.maxRedirectUriLength) {
      this.logger.warn('Refused to materialize unregistered OAuth client redirect URI: redirect URI too long', {
        redirectUriLength: nextRedirectUri.length,
        maxRedirectUriLength: limits.maxRedirectUriLength,
      });
      return undefined;
    }

    return redirectUris;
  }

  /**
   * Fetch OAuth Authorization Server Metadata (RFC 8414)
   */
  private async fetchOAuthMetadata(issuerUrl: string): Promise<{ authorization_endpoint: string; token_endpoint: string } | null> {
    try {
      // Use URL constructor to properly handle trailing slashes
      const metadataUrl = new URL(OAUTH_PATHS.WELL_KNOWN_AUTHORIZATION_SERVER, issuerUrl).toString();

      await this.ssrfValidator.validate(metadataUrl, {
        allowPrivateNetwork: process.env.MCP4_SSRF_ALLOW_PRIVATE_NETWORK === 'true'
      });

      const response = await fetch(metadataUrl, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(5000), // 5 second timeout
      });
      
      if (!response.ok) {
        return null;
      }
      
      return parseOAuthMetadataEndpoints(await response.json());
    } catch (error) {
      this.logger.debug('OAuth metadata fetch failed', { issuerUrl, error });
      return null;
    }
  }

  /**
   * Resolve environment variable references in OAuth config
   */
  private resolveEnvVars(config: OAuthConfig): OAuthConfig {
    const resolve = (value: string | undefined): string | undefined => {
      if (!value) return value;
      const envVarName = matchEnvRefName(value);
      if (envVarName !== undefined) {
        const envValue = resolveEnvRef(value);
        if (!envValue) {
          throw new Error(`Environment variable ${envVarName} not found (referenced in OAuth config)`);
        }
        return envValue;
      }
      return value;
    };

    return {
      ...config,
      issuer: resolve(config.issuer),
      authorization_endpoint: resolve(config.authorization_endpoint) || config.authorization_endpoint,
      token_endpoint: resolve(config.token_endpoint) || config.token_endpoint,
      client_id: resolve(config.client_id),
      client_secret: resolve(config.client_secret),
      redirect_uri: resolve(config.redirect_uri),
      registration_endpoint: resolve(config.registration_endpoint),
      introspection_endpoint: resolve(config.introspection_endpoint),
      revocation_endpoint: resolve(config.revocation_endpoint),
    };
  }

  /**
   * Derive OAuth endpoints from issuer if needed
   */
  private async deriveEndpointsFromIssuer(config: OAuthConfig): Promise<OAuthConfig> {
    // If both endpoints are explicitly provided, no need to derive
    if (config.authorization_endpoint && config.token_endpoint) {
      return config;
    }

    // If issuer is not provided, we can't derive
    if (!config.issuer) {
      if (!config.authorization_endpoint || !config.token_endpoint) {
        throw new Error('OAuth config must provide either issuer OR both authorization_endpoint and token_endpoint');
      }
      return config;
    }

    const issuer = config.issuer;
    this.logger.info('Deriving OAuth endpoints from issuer', { issuer });

    // Try to fetch OAuth metadata
    const metadata = await this.fetchOAuthMetadata(issuer);
    
    if (metadata) {
      this.logger.info('Successfully discovered OAuth endpoints', {
        authorization_endpoint: metadata.authorization_endpoint,
        token_endpoint: metadata.token_endpoint,
      });
      return {
        ...config,
        authorization_endpoint: config.authorization_endpoint || metadata.authorization_endpoint,
        token_endpoint: config.token_endpoint || metadata.token_endpoint,
      };
    }

    // Fallback to standard OAuth paths
    this.logger.info('OAuth metadata fetch failed, using standard OAuth paths', { issuer });
    return {
      ...config,
      authorization_endpoint: config.authorization_endpoint || `${issuer}/oauth/authorize`,
      token_endpoint: config.token_endpoint || `${issuer}/oauth/token`,
    };
  }

  /**
   * Check if redirect URI host AND scheme are allowed
   * Prevents open redirect vulnerabilities (CWE-601) and XSS (javascript: scheme)
   */
  private isAllowedRedirectHost(redirectUri: string): boolean {
    try {
      const url = new URL(redirectUri);

      // Security: Validate protocol to prevent javascript: or data: schemes
      // We block dangerous schemes that could lead to XSS or local file access
      const protocol = url.protocol.toLowerCase();
      const dangerousSchemes = ['javascript:', 'data:', 'vbscript:', 'file:', 'blob:', 'about:'];
      if (dangerousSchemes.includes(protocol)) {
        return false;
      }

      const hostname = url.hostname;
      if (hostname.includes('*') || url.pathname.includes('*')) {
        return false;
      }
      
      // Default to loopback hosts only if not configured
      const allowedHosts = this.config.allowed_redirect_hosts || [...DEFAULT_ALLOWED_REDIRECT_HOSTS];
      
      for (const allowed of allowedHosts) {
        if (this.matchRedirectHost(hostname, allowed)) {
          return true;
        }
      }
      
      return false;
    } catch {
      // Invalid URL
      return false;
    }
  }

  private isApprovedUnregisteredClientRedirectUri(redirectUri: string): boolean {
    return isApprovedUnregisteredClientRedirectUri(
      redirectUri,
      this.config.allowed_unregistered_redirect_uris,
      this.logger,
    );
  }

  /**
   * Redirect_uri policy for the shared/empty-redirect_uris client (e.g. the
   * VS Code proxy compatibility client). RFC 6749 §3.1.2.3 / OAuth 2.1 §4.1.3:
   * without a per-install registration record, tighten the host-only match to
   * scheme in {http for loopback, https} on an allowlisted host, and reject
   * custom/arbitrary schemes. RFC 8252 loopback port variance is preserved
   * (any port on a loopback host is accepted).
   */
  private isAllowedSharedClientRedirectUri(redirectUri: string): boolean {
    let url: URL;
    try {
      url = new URL(redirectUri);
    } catch {
      return false;
    }

    const scheme = url.protocol.toLowerCase();
    if (scheme !== 'http:' && scheme !== 'https:') {
      return false;
    }

    if (!this.isAllowedRedirectHost(redirectUri)) {
      return false;
    }

    const hostname = this.stripIpv6Brackets(url.hostname).toLowerCase();
    if (scheme === 'http:' && !LOOPBACK_REDIRECT_HOSTS.has(hostname)) {
      // Plain http is only acceptable for RFC 8252 loopback clients.
      return false;
    }

    return true;
  }

  private isAllowedClientRedirectUri(
    client: OAuthClientInformationFull,
    redirectUri: string,
  ): boolean {
    const hasRegisteredUris = !!(client.redirect_uris && client.redirect_uris.length > 0);
    if (hasRegisteredUris) {
      // Registered clients: exact registration match is enforced by the caller;
      // here only the host/scheme allowlist is confirmed.
      if (this.isAllowedRedirectHost(redirectUri)) {
        return true;
      }
    } else if (this.isAllowedSharedClientRedirectUri(redirectUri)) {
      // Shared client with no registration record: tightened scheme/host policy.
      return true;
    }

    if (!this.config.allow_unregistered_clients) {
      return false;
    }

    if (!client.redirect_uris?.includes(redirectUri)) {
      return false;
    }

    return this.isApprovedUnregisteredClientRedirectUri(redirectUri);
  }

  /**
   * Whether a redirect_uri is registered (exact match for registered clients)
   * and passes the redirect policy. Public so the HTTP layer can decide between
   * a direct 400 (invalid/unregistered redirect_uri) and a 302 error redirect
   * (RFC 6749 §4.1.2.1) before other authorization-request errors are surfaced.
   */
  public isRedirectUriAllowedForClient(
    client: OAuthClientInformationFull,
    redirectUri: string,
  ): boolean {
    if (
      client.redirect_uris
      && client.redirect_uris.length > 0
      && !client.redirect_uris.includes(redirectUri)
    ) {
      return false;
    }
    return this.isAllowedClientRedirectUri(client, redirectUri);
  }

  /**
   * Match hostname against allowlist entry
   *
   * Supports:
   * - Exact hostnames
   * - Wildcard subdomains (*.example.com)
   * - IPv4 exact matches
   * - IPv4 CIDR ranges (e.g., 10.0.0.0/8)
   * - IPv6 exact matches
   * - IPv6 CIDR ranges (e.g., 2001:db8::/32)
   */
  private matchRedirectHost(hostname: string, pattern: string): boolean {
    const normalizedHost = this.stripIpv6Brackets(hostname);
    const normalizedPattern = this.stripIpv6Brackets(pattern);

    if (normalizedHost === normalizedPattern) {
      return true;
    }

    if (normalizedPattern.startsWith('*.')) {
      const domain = normalizedPattern.slice(2);
      return normalizedHost === domain || normalizedHost.endsWith('.' + domain);
    }

    if (normalizedPattern.includes('/')) {
      return this.matchCIDR(normalizedHost, normalizedPattern);
    }

    return false;
  }

  /**
   * Check if IP address is within CIDR range
   *
   * Example: '192.168.1.50' matches '192.168.1.0/24'
   *          '2001:db8::1' matches '2001:db8::/32'
   */
  private matchCIDR(ip: string, cidr: string): boolean {
    const [rawRange, bits] = cidr.split('/');
    const range = this.stripIpv6Brackets(rawRange);
    const maskBits = parseInt(bits, 10);

    if (isNaN(maskBits)) {
      return false;
    }

    const ipVersion = isIP(ip);
    const rangeVersion = isIP(range);
    if (ipVersion === 0 || rangeVersion === 0 || ipVersion !== rangeVersion) {
      return false;
    }

    if (ipVersion === 4) {
      if (maskBits < 0 || maskBits > 32) {
        this.logger.warn('Invalid IPv4 CIDR mask bits for redirect host allowlist', { cidr });
        return false;
      }
      const ipInt = this.ipv4ToInt(ip);
      const rangeInt = this.ipv4ToInt(range);

      if (ipInt === null || rangeInt === null) {
        return false;
      }

      const mask = (0xFFFFFFFF << (32 - maskBits)) >>> 0;
      return (ipInt & mask) === (rangeInt & mask);
    }

    if (maskBits < 0 || maskBits > 128) {
      this.logger.warn('Invalid IPv6 CIDR mask bits for redirect host allowlist', { cidr });
      return false;
    }

    const ipInt = this.ipv6ToBigInt(ip);
    const rangeInt = this.ipv6ToBigInt(range);

    if (ipInt === null || rangeInt === null) {
      return false;
    }

    const mask = this.ipv6Mask(maskBits);
    return (ipInt & mask) === (rangeInt & mask);
  }

  /**
   * Convert IPv4 address to 32-bit integer
   */
  private ipv4ToInt(ip: string): number | null {
    const parts = ip.split('.');

    if (parts.length !== 4) {
      return null;
    }

    let result = 0;
    for (let i = 0; i < 4; i++) {
      const octet = parseInt(parts[i], 10);
      if (isNaN(octet) || octet < 0 || octet > 255) {
        return null;
      }
      result = (result << 8) | octet;
    }

    return result >>> 0;
  }

  /**
   * Convert IPv6 address to 128-bit BigInt
   */
  private ipv6ToBigInt(ip: string): bigint | null {
    const cleaned = this.stripIpv6Brackets(ip);

    // Handle IPv4-mapped IPv6 (e.g., ::ffff:192.168.0.1)
    let ipv4Tail: number | null = null;
    let base = cleaned;
    if (cleaned.includes('.')) {
      const lastColon = cleaned.lastIndexOf(':');
      if (lastColon === -1) return null;
      const ipv4Part = cleaned.slice(lastColon + 1);
      ipv4Tail = this.ipv4ToInt(ipv4Part);
      if (ipv4Tail === null) return null;
      base = cleaned.slice(0, lastColon);
    }

    const parts = base.split('::');
    if (parts.length > 2) {
      return null;
    }

    const head = parts[0] ? parts[0].split(':') : [];
    const tail = parts.length === 2 && parts[1] ? parts[1].split(':') : [];

    if (head.some(p => p === '') || tail.some(p => p === '')) {
      return null;
    }

    const totalSegmentsNeeded = 8 - (ipv4Tail !== null ? 2 : 0);
    let segments: number[] = [];

    const parseHextets = (items: string[]): number[] | null => {
      const result: number[] = [];
      for (const part of items) {
        const num = parseInt(part || '0', 16);
        if (isNaN(num) || num < 0 || num > 0xFFFF) {
          return null;
        }
        result.push(num);
      }
      return result;
    };

    const headVals = parseHextets(head);
    const tailVals = parseHextets(tail);
    if (!headVals || !tailVals) {
      return null;
    }

    const missing = totalSegmentsNeeded - (headVals.length + tailVals.length);
    if (missing < 0) {
      return null;
    }

    segments = [...headVals, ...Array(missing).fill(0), ...tailVals];

    if (segments.length !== totalSegmentsNeeded) {
      return null;
    }

    if (ipv4Tail !== null) {
      const high = (ipv4Tail >>> 16) & 0xFFFF;
      const low = ipv4Tail & 0xFFFF;
      segments.push(high, low);
    }

    if (segments.length !== 8) {
      return null;
    }

    let value = 0n;
    for (const part of segments) {
      value = (value << 16n) + BigInt(part);
    }

    return value;
  }

  private ipv6Mask(maskBits: number): bigint {
    if (maskBits === 0) {
      return 0n;
    }
    const ones = (1n << BigInt(maskBits)) - 1n;
    return BigInt.asUintN(128, ones << BigInt(128 - maskBits));
  }

  private stripIpv6Brackets(value: string): string {
    return value.replace(/^\[/, '').replace(/\]$/, '');
  }

  /**
   * Begin authorization flow
   * Stores state and redirects to External Provider with MCP Callback URI
   */
  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams & { codeChallengeMethod?: string },
    res: Response
  ): Promise<void> {
    await this.ensureEndpointsInitialized();

    // RFC 7636 / OAuth 2.1: PKCE is mandatory. The HTTP layer already rejects
    // requests without an S256 challenge; this is a defense-in-depth guard so a
    // code can never be issued without a bound S256 challenge.
    if (!params.codeChallenge) {
      throw new ValidationError('code_challenge is required (PKCE)');
    }
    const codeChallengeMethod = params.codeChallengeMethod ?? 'S256';
    if (codeChallengeMethod !== 'S256') {
      throw new ValidationError('code_challenge_method must be S256');
    }

    this.logger.info('Starting OAuth authorization', {
      clientId: client.client_id,
      scopes: params.scopes,
      redirectUri: params.redirectUri,
      registeredUris: client.redirect_uris,
    });

    // Validate redirect URI
    if (client.redirect_uris && client.redirect_uris.length > 0 && !client.redirect_uris.includes(params.redirectUri)) {
      this.logger.error('Invalid redirect URI', undefined, {
        providedUri: params.redirectUri,
        registeredUris: client.redirect_uris,
      });
      throw new Error('Unregistered redirect_uri');
    }

    // Validate redirect against configured policies to prevent open redirect
    if (!this.isAllowedClientRedirectUri(client, params.redirectUri)) {
      this.logger.error('Redirect URI not allowed', undefined, {
        providedUri: params.redirectUri,
        allowedHosts: this.config.allowed_redirect_hosts || [...DEFAULT_ALLOWED_REDIRECT_HOSTS],
        allowedUnregisteredRedirectUris: this.config.allowed_unregistered_redirect_uris,
      });
      throw new Error('Redirect URI not allowed');
    }

    // Intentional precedence: non-empty configured scopes fully replace
    // caller-requested scopes so profile-level guarantees (for example the
    // openid scope required for identity verification) always hold.
    const effectiveScopes = this.config.scopes?.length
      ? this.config.scopes
      : params.scopes;
    if (
      this.config.scopes?.length
      && params.scopes?.length
      && params.scopes.join(' ') !== this.config.scopes.join(' ')
    ) {
      this.logger.debug('Caller-requested OAuth scopes discarded in favor of configured scopes', {
        requestedScopes: params.scopes,
        configuredScopes: this.config.scopes,
      });
    }
    const stateToken = randomUUID();
    
    const nonce = this.identityVerifier ? randomUUID() : undefined;
    this.stateStore.set(stateToken, {
      clientRedirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      codeChallengeMethod,
      originalState: params.state,
      clientId: client.client_id,
      scopes: effectiveScopes,
      nonce,
      createdAt: Date.now(),
    });
    this._clientsStore.markAuthStateOpened(client.client_id);

    const authUrl = new URL(this.config.authorization_endpoint!);
    const clientId = this.config.client_id || client.client_id;
    
    if (!this.config.redirect_uri) {
      throw new Error('MCP4_OAUTH_REDIRECT_URI must be configured');
    }
    const callbackUri = this.config.redirect_uri;

    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('redirect_uri', callbackUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('state', stateToken);
    if (nonce) authUrl.searchParams.set('nonce', nonce);

    if (effectiveScopes && effectiveScopes.length > 0) {
      authUrl.searchParams.set('scope', effectiveScopes.join(' '));
    }

    // NOTE: Do NOT forward PKCE parameters to external provider
    // The MCP server acts as an OAuth proxy with client_secret (confidential client)
    // PKCE is used only between Cursor <-> MCP, not between MCP <-> External Provider
    // If we forwarded code_challenge, we would need code_verifier which only Cursor has

    // Log only origin + pathname: the full URL carries the state token and the
    // OIDC nonce as query parameters, and neither may ever reach the logs.
    this.logger.info('Redirecting to external OAuth provider', {
      authUrl: authUrl.origin + authUrl.pathname,
      callbackUri,
      hasClientSecret: !!this.config.client_secret,
    });

    res.redirect(authUrl.toString());
  }

  /**
   * Handle callback from External Provider
   * Exchanges code for tokens and redirects to Client with Internal Code
   */
  async handleCallback(req: Request, res: Response): Promise<void> {
    await this.ensureEndpointsInitialized();
    
    const { code, state, error } = req.query;

    if (error) {
        // Do not log `state`: it is a live authorization-flow secret.
        this.logger.error('OAuth callback error', undefined, { error });
        
        // Sanitize error messages to prevent XSS
        const safeError = escapeHtmlSafe(error as string);
        res.status(400);
        res.json({ 
          error: safeError,
          error_description: `Authorization failed: ${safeError}`
        });
        return;
    }

    if (!code || typeof code !== 'string') {
        res.status(400).send('Missing authorization code');
        return;
    }

    if (!state || typeof state !== 'string') {
        res.status(400).send('Missing state parameter');
        return;
    }

    const storedState = this.stateStore.get(state);
    if (!storedState) {
        res.status(400).send('Invalid or expired state');
        return;
    }

    // Clean up state
    this.stateStore.delete(state);
    this._clientsStore.markAuthStateClosed(storedState.clientId);

    try {
        // Exchange External Code for Tokens
        const tokens = await this.exchangeCodeWithProvider(
            code, 
            undefined,
            this.config.redirect_uri!
        );

        const identity = this.identityVerifier
          ? await this.verifyCallbackIdentity(tokens, storedState.nonce)
          : undefined;
        const client = await this._clientsStore.getClient(storedState.clientId);
        if (!client) throw new Error('Client not found');

        // Re-validate redirect URI policy + registration before redirect (defense-in-depth)
        if (!this.isAllowedClientRedirectUri(client, storedState.clientRedirectUri)) {
            this.logger.error('Redirect URI not allowed (callback)', undefined, {
                storedUri: storedState.clientRedirectUri,
                allowedHosts: this.config.allowed_redirect_hosts || [...DEFAULT_ALLOWED_REDIRECT_HOSTS],
                allowedUnregisteredRedirectUris: this.config.allowed_unregistered_redirect_uris,
            });
            res.status(400).send('Redirect URI not allowed');
            return;
        }
        if (client.redirect_uris && client.redirect_uris.length > 0 && !client.redirect_uris.includes(storedState.clientRedirectUri)) {
            this.logger.error('Stored redirect URI no longer registered', undefined, {
                storedUri: storedState.clientRedirectUri,
                registeredUris: client.redirect_uris,
            });
            res.status(400).send('Unregistered redirect_uri');
            return;
        }

        // Redirect to Client
        let clientUrl: URL;
        try {
            // Allow custom schemes (e.g., vscode://, cursor://) as long as the host was validated above
            clientUrl = new URL(storedState.clientRedirectUri);
        } catch {
            res.status(400).send('Invalid redirect URI');
            return;
        }

        if (identity && this.onIdentityVerified) {
          await this.onIdentityVerified(identity);
        }

        const internalCode = randomUUID();
        this.authorizationCodes.set(internalCode, {
          client,
          params: {
            redirectUri: storedState.clientRedirectUri,
            codeChallenge: storedState.codeChallenge,
            scopes: storedState.scopes || [],
            state: storedState.originalState
          },
          createdAt: Date.now(),
          tokens,
          identity,
        });
        this._clientsStore.markAuthCodeOpened(client.client_id);

        clientUrl.searchParams.set('code', internalCode);
        if (storedState.originalState) {
            clientUrl.searchParams.set('state', storedState.originalState);
        }

        // Log only origin + pathname: the full URL carries the internal code and
        // echoed state as query parameters, and neither may reach the logs.
        this.logger.info('Redirecting to client with internal code', {
            clientUrl: clientUrl.origin + clientUrl.pathname,
        });

        // nosemgrep: javascript.express.open-redirect-deepsemgrep.open-redirect-deepsemgrep, javascript.express.web.tainted-redirect-express.tainted-redirect-express
        res.redirect(clientUrl.toString());

    } catch (err) {
        this.logger.error('Callback handling failed', err as Error);
        // Identity/verification failures are client-flow errors, not server
        // faults: surface them as 401 instead of a misleading 500.
        if (err instanceof AuthenticationError) {
            res.status(401).send('Authentication failed');
            return;
        }
        res.status(500).send('Internal Server Error during token exchange');
    }
  }

  /**
   * Get code challenge for authorization code (Internal)
   */
  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string
  ): Promise<string> {
    const codeData = this.authorizationCodes.get(authorizationCode);
    
    if (!codeData) {
      throw new Error('Invalid authorization code');
    }
    
    if (codeData.client.client_id !== client.client_id) {
      throw new Error('Authorization code was not issued to this client');
    }

    return codeData.params.codeChallenge;
  }

  /**
   * Exchange authorization code for access token (Internal)
   */
  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    codeVerifier?: string,
    redirectUri?: string,
    resource?: URL
  ): Promise<OAuthTokens> {
    await this.ensureEndpointsInitialized();
    
    this.logger.info('Exchanging internal authorization code', {
      clientId: client.client_id,
    });

    const codeData = this.authorizationCodes.get(authorizationCode);

    if (!codeData) {
      // RFC 6749 §4.1.2: replay of an already-consumed code must revoke the
      // tokens issued during its first redemption.
      this.revokeTokensForConsumedCode(authorizationCode);
      throw new OAuthInvalidGrantError('Invalid authorization code');
    }

    if (codeData.client.client_id !== client.client_id) {
      throw new OAuthInvalidGrantError('Authorization code was not issued to this client');
    }

    // Validate expiration (5 minutes)
    const codeAge = Date.now() - codeData.createdAt;
    const EXPIRATION_MS = 5 * 60 * 1000; // 5 minutes
    if (codeAge > EXPIRATION_MS) {
      this.authorizationCodes.delete(authorizationCode);
      this._clientsStore.markAuthCodeClosed(codeData.client.client_id);
      throw new OAuthInvalidGrantError('Authorization code expired');
    }

    // PKCE is mandatory (RFC 7636 / OAuth 2.1): every issued code carries an
    // S256 challenge, so verification is always required. Any failure consumes
    // the single-use code before throwing so a wrong verifier cannot be retried.
    const consumeCode = (): void => {
      this.authorizationCodes.delete(authorizationCode);
      this._clientsStore.markAuthCodeClosed(codeData.client.client_id);
    };

    // RFC 6749 §4.1.3: the token request redirect_uri must be identical to the
    // one used at authorize. A redirect_uri is always bound at authorize in this
    // flow, so it must be present and equal at token.
    const boundRedirectUri = codeData.params.redirectUri;
    if (boundRedirectUri && redirectUri !== boundRedirectUri) {
      consumeCode();
      throw new OAuthInvalidGrantError('redirect_uri does not match the authorization request');
    }

    // Defensive: a code without a bound challenge must never exist now.
    if (!codeData.params.codeChallenge) {
      consumeCode();
      throw new OAuthInvalidGrantError('Authorization code has no bound PKCE challenge');
    }
    if (!codeVerifier) {
      consumeCode();
      throw new OAuthInvalidGrantError('code_verifier is required for PKCE');
    }
    if (!PKCE_CODE_VERIFIER_PATTERN.test(codeVerifier)) {
      consumeCode();
      throw new ValidationError('code_verifier does not meet RFC 7636 length/charset requirements');
    }

    // Verify code challenge (S256 method) with constant-time comparison.
    const hash = createHash('sha256').update(codeVerifier).digest('base64url');
    const hashBuffer = Buffer.from(hash);
    const challengeBuffer = Buffer.from(codeData.params.codeChallenge);

    if (hashBuffer.length !== challengeBuffer.length || !timingSafeEqual(hashBuffer, challengeBuffer)) {
      consumeCode();
      throw new OAuthInvalidGrantError('Invalid code_verifier');
    }

    if (!codeData.tokens) {
        throw new Error('No tokens associated with this code');
    }

    // Delete authorization code (single use) and remember the issued tokens so a
    // later replay of this code can revoke them.
    this.authorizationCodes.delete(authorizationCode);
    this._clientsStore.markAuthCodeClosed(codeData.client.client_id);
    this.recordConsumedCodeTombstone(authorizationCode, codeData.tokens, client.client_id);

    // Store access token for validation
    const tokenData: AccessTokenData = {
      token: codeData.tokens.access_token,
      clientId: client.client_id,
      scopes: codeData.params.scopes || this.config.scopes || [],
      expiresAt: codeData.tokens.expires_in 
        ? Date.now() + codeData.tokens.expires_in * 1000 
        : undefined,
      resource,
      identity: codeData.identity,
    };
    
    this.accessTokens.set(codeData.tokens.access_token, tokenData);
    if (codeData.tokens.refresh_token && codeData.identity) {
      this.storeRefreshTokenIdentity(codeData.tokens.refresh_token, codeData.identity, client.client_id);
    }

    return codeData.tokens;
  }

  /**
   * Remember the tokens issued from a consumed authorization code so a replay
   * of that code can revoke them (RFC 6749 §4.1.2).
   */
  private recordConsumedCodeTombstone(code: string, tokens: OAuthTokens, clientId: string): void {
    this.consumedCodeTombstones.set(code, {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      clientId,
      expiresAt: Date.now() + CONSUMED_CODE_TOMBSTONE_TTL_MS,
    });
  }

  /**
   * Revoke the tokens issued from a code's first redemption when that code is
   * replayed. No-op when the code was never redeemed (genuinely unknown code).
   */
  private revokeTokensForConsumedCode(code: string): void {
    const tombstone = this.consumedCodeTombstones.get(code);
    if (!tombstone) {
      return;
    }
    this.accessTokens.delete(tombstone.accessToken);
    if (tombstone.refreshToken) {
      this.refreshTokenIdentities.delete(tombstone.refreshToken);
    }
    this.logger.warn('Authorization code replay detected - revoked tokens issued from first redemption', {
      clientId: tombstone.clientId,
    });
  }

  getIdentityForAccessToken(token: string): OidcIdentity | undefined {
    return this.accessTokens.get(token)?.identity;
  }

  private async verifyCallbackIdentity(tokens: OAuthTokens, nonce?: string): Promise<OidcIdentity> {
    if (!this.identityVerifier) {
      throw new AuthenticationError('OIDC identity verifier is not configured');
    }
    if (!nonce) {
      throw new AuthenticationError('Authorization state carries no OIDC nonce (state predates identity verification)');
    }
    const idToken = (tokens as OAuthTokens & { id_token?: string }).id_token;
    if (!idToken) {
      throw new AuthenticationError('OIDC identity token missing from authorization response');
    }
    return this.identityVerifier.verify(idToken, nonce);
  }

  /**
   * Exchange authorization code with external OAuth provider
   */
  private async exchangeCodeWithProvider(
    code: string,
    codeVerifier: string | undefined,
    redirectUri: string
  ): Promise<OAuthTokens> {
    const tokenUrl = this.config.token_endpoint!;
    
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
    });

    if (codeVerifier) {
      body.set('code_verifier', codeVerifier);
    }

    if (this.config.client_id) {
      body.set('client_id', this.config.client_id);
    }
    
    if (this.config.client_secret) {
      body.set('client_secret', this.config.client_secret);
    }

    this.logger.debug('Exchanging code with external provider', { tokenUrl });

    await this.ssrfValidator.validate(tokenUrl, {
      allowPrivateNetwork: process.env.MCP4_SSRF_ALLOW_PRIVATE_NETWORK === 'true'
    });

    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
      },
      body: body.toString(),
    });

    if (!response.ok) {
      const errorText = await response.text();
      this.logger.error('Token exchange failed', undefined, {
        httpStatus: response.status,
        errorMessage: errorText,
      });
      throw new OAuthUpstreamError(`Token exchange failed: ${response.status}`);
    }

    const tokenResponse = await response.json() as OAuthTokens;
    
    return tokenResponse;
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
    rehydratedIdentity?: OidcIdentity,
  ): Promise<OAuthTokens> {
    await this.ensureEndpointsInitialized();
    
    this.logger.info('Exchanging refresh token', { clientId: client.client_id });

    const tokenUrl = this.config.token_endpoint!;
    const identityEntry = this.refreshTokenIdentities.get(refreshToken);
    let cachedIdentity: OidcIdentity | undefined;
    if (identityEntry) {
      if (identityEntry.clientId !== client.client_id) {
        // Identity bindings are client-scoped (mirrors assertRefreshEnvelopeClientBinding):
        // client B presenting A's refresh token must not inherit A's verified identity.
        this.refreshTokenIdentities.delete(refreshToken);
        this.logger.warn('Refresh token identity was bound to a different client - identity dropped', {
          clientId: client.client_id,
        });
      } else if (identityEntry.expiresAt > Date.now()) {
        cachedIdentity = identityEntry.identity;
      } else {
        this.refreshTokenIdentities.delete(refreshToken);
      }
    }
    const identity = rehydratedIdentity
      ? { ...rehydratedIdentity, issuer: normalizeIssuer(rehydratedIdentity.issuer) }
      : cachedIdentity;
    if (identity && this.config.issuer && identity.issuer !== this.config.issuer) {
      throw new AuthenticationError('Refresh token identity issuer does not match OAuth provider issuer');
    }

    await this.ssrfValidator.validate(tokenUrl, {
      allowPrivateNetwork: process.env.MCP4_SSRF_ALLOW_PRIVATE_NETWORK === 'true'
    });

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });

    if (scopes && scopes.length > 0) {
      body.set('scope', scopes.join(' '));
    }

    if (this.config.client_id) {
      body.set('client_id', this.config.client_id);
    }
    
    if (this.config.client_secret) {
      body.set('client_secret', this.config.client_secret);
    }

    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
      },
      body: body.toString(),
    });

    if (!response.ok) {
      const errorText = await response.text();
      this.logger.error('Refresh token exchange failed', undefined, {
        httpStatus: response.status,
        errorMessage: errorText,
      });
      throw new OAuthUpstreamError(`Refresh token exchange failed: ${response.status}`);
    }

    const tokenResponse = await response.json() as OAuthTokens;

    const tokenData: AccessTokenData = {
      token: tokenResponse.access_token,
      clientId: client.client_id,
      scopes: scopes || this.config.scopes || [],
      expiresAt: tokenResponse.expires_in 
        ? Date.now() + tokenResponse.expires_in * 1000 
        : undefined,
      resource,
      identity,
    };
    
    this.accessTokens.set(tokenResponse.access_token, tokenData);
    if (identity && tokenResponse.refresh_token) {
      this.refreshTokenIdentities.delete(refreshToken);
      this.storeRefreshTokenIdentity(tokenResponse.refresh_token, identity, client.client_id);
    }

    return tokenResponse;
  }

  private storeRefreshTokenIdentity(refreshToken: string, identity: OidcIdentity, clientId: string): void {
    const now = Date.now();
    for (const [token, entry] of this.refreshTokenIdentities) {
      if (entry.expiresAt <= now) this.refreshTokenIdentities.delete(token);
    }
    // Every entry gets the same constant TTL, so Map insertion order equals
    // expiry order: the first key is always the nearest-expiry binding.
    // Overflow is logged so the cap is observable.
    let evicted = 0;
    while (this.refreshTokenIdentities.size >= REFRESH_IDENTITY_MAX) {
      const nearestToken = this.refreshTokenIdentities.keys().next().value;
      if (nearestToken === undefined) break;
      this.refreshTokenIdentities.delete(nearestToken);
      evicted += 1;
    }
    if (evicted > 0) {
      // Aggregate + rate-limit: at capacity every insert evicts, so warning
      // per insert would flood the logs.
      this.refreshEvictionsSinceLastWarn += evicted;
      if (now - this.lastRefreshEvictionWarnAt >= REFRESH_EVICTION_WARN_INTERVAL_MS) {
        this.logger.warn('Refresh identity map at capacity - evicted nearest-expiry bindings', {
          capacity: REFRESH_IDENTITY_MAX,
          evictedSinceLastWarn: this.refreshEvictionsSinceLastWarn,
        });
        this.lastRefreshEvictionWarnAt = now;
        this.refreshEvictionsSinceLastWarn = 0;
      }
    }
    // Delete-then-set keeps insertion order equal to expiry order even when a
    // non-rotating IdP returns the same refresh token again.
    this.refreshTokenIdentities.delete(refreshToken);
    this.refreshTokenIdentities.set(refreshToken, {
      identity,
      clientId,
      expiresAt: now + REFRESH_IDENTITY_TTL_MS,
    });
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const tokenData = this.accessTokens.get(token);
    
    if (!tokenData) {
      if (this.config.introspection_endpoint) {
        return await this.introspectToken(token);
      }
      throw new Error('Invalid or expired token');
    }

    if (tokenData.expiresAt && tokenData.expiresAt < Date.now()) {
      this.accessTokens.delete(token);
      throw new Error('Token expired');
    }

    return {
      token,
      clientId: tokenData.clientId,
      scopes: tokenData.scopes,
      expiresAt: tokenData.expiresAt ? Math.floor(tokenData.expiresAt / 1000) : undefined,
      resource: tokenData.resource,
    };
  }

  private async introspectToken(token: string): Promise<AuthInfo> {
    const introspectionUrl = this.config.introspection_endpoint;
    
    if (!introspectionUrl) {
      throw new Error('Introspection endpoint not configured');
    }

    await this.ssrfValidator.validate(introspectionUrl, {
      allowPrivateNetwork: process.env.MCP4_SSRF_ALLOW_PRIVATE_NETWORK === 'true'
    });

    const body = new URLSearchParams({ token });

    if (this.config.client_id) {
      body.set('client_id', this.config.client_id);
    }
    
    if (this.config.client_secret) {
      body.set('client_secret', this.config.client_secret);
    }

    const response = await fetch(introspectionUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
      },
      body: body.toString(),
    });

    if (!response.ok) {
      throw new Error(`Token introspection failed: ${response.status}`);
    }

    const introspectionResponse = await response.json() as {
      active: boolean;
      client_id?: string;
      scope?: string;
      exp?: number;
      aud?: string;
    };

    if (!introspectionResponse.active) {
      throw new Error('Token is not active');
    }

    return {
      token,
      clientId: introspectionResponse.client_id || 'unknown',
      scopes: introspectionResponse.scope ? introspectionResponse.scope.split(' ') : [],
      expiresAt: introspectionResponse.exp,
      resource: introspectionResponse.aud ? new URL(introspectionResponse.aud) : undefined,
    };
  }

  async revokeToken(
    client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest
  ): Promise<void> {
    this.logger.info('Revoking token', { clientId: client.client_id });
    this.accessTokens.delete(request.token);
    if (this.config.revocation_endpoint) {
      await this.revokeTokenWithProvider(request.token);
    }
  }

  private async revokeTokenWithProvider(token: string): Promise<void> {
    const revocationUrl = this.config.revocation_endpoint;
    if (!revocationUrl) return;

    await this.ssrfValidator.validate(revocationUrl, {
      allowPrivateNetwork: process.env.MCP4_SSRF_ALLOW_PRIVATE_NETWORK === 'true'
    });

    const body = new URLSearchParams({ token });

    if (this.config.client_id) {
      body.set('client_id', this.config.client_id);
    }
    
    if (this.config.client_secret) {
      body.set('client_secret', this.config.client_secret);
    }

    const response = await fetch(revocationUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });

    if (!response.ok) {
      this.logger.warn('Token revocation failed', { status: response.status });
    }
  }

  /**
   * Cleanup expired states, codes, and tokens
   * Called periodically by HttpTransport
   */
  public cleanup(): void {
    const now = Date.now();

    // 1. Cleanup expired states (10 minutes)
    const STATE_TIMEOUT = OAUTH_CLEANUP.STATE_TIMEOUT_MS;
    for (const [state, data] of this.stateStore.entries()) {
      if (now - data.createdAt > STATE_TIMEOUT) {
        this.stateStore.delete(state);
        this._clientsStore.markAuthStateClosed(data.clientId);
      }
    }

    // 2. Cleanup expired authorization codes (5 minutes)
    const CODE_TIMEOUT = 5 * 60 * 1000;
    for (const [code, data] of this.authorizationCodes.entries()) {
      if (now - data.createdAt > CODE_TIMEOUT) {
        this.authorizationCodes.delete(code);
        this._clientsStore.markAuthCodeClosed(data.client.client_id);
      }
    }

    // 3. Cleanup expired access tokens
    for (const [token, data] of this.accessTokens.entries()) {
      if (data.expiresAt && data.expiresAt < now) {
        this.accessTokens.delete(token);
      }
    }

    // 4. Cleanup expired refresh-token identity bindings
    for (const [token, entry] of this.refreshTokenIdentities.entries()) {
      if (entry.expiresAt <= now) {
        this.refreshTokenIdentities.delete(token);
      }
    }

    // 5. Cleanup expired consumed-code replay tombstones
    for (const [code, tombstone] of this.consumedCodeTombstones.entries()) {
      if (tombstone.expiresAt <= now) {
        this.consumedCodeTombstones.delete(code);
      }
    }
  }
}
