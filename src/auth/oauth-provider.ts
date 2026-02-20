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
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type {
  OAuthClientInformationFull,
  OAuthTokens,
  OAuthTokenRevocationRequest,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { OAuthConfig } from '../types/profile.js';
import type { Logger } from '../core/logger.js';
import { OAUTH_CLEANUP, OAUTH_PATHS, PROXY_CREDENTIALS } from '../core/constants.js';
import { escapeHtmlSafe } from '../validation/validation-utils.js';
import { SSRFValidator } from '../security/ssrf-validator.js';
import { parseOAuthMetadataEndpoints } from './oauth-metadata.js';

/**
 * In-memory store for OAuth client registrations
 */
export class InMemoryClientsStore implements OAuthRegisteredClientsStore {
  private clients = new Map<string, OAuthClientInformationFull>();
  private readonly MAX_CLIENTS = 1000;

  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    return this.clients.get(clientId);
  }

  async registerClient(clientMetadata: OAuthClientInformationFull): Promise<OAuthClientInformationFull> {
    if (this.clients.size >= this.MAX_CLIENTS) {
      // Eviction strategy: prioritize removing dynamic clients (mcp-client-*)
      let evicted = false;
      for (const [id] of this.clients) {
        if (id.startsWith('mcp-client-')) {
          this.clients.delete(id);
          evicted = true;
          break;
        }
      }

      // Fallback: remove oldest client (FIFO) if no dynamic client found
      if (!evicted) {
        const oldestId = this.clients.keys().next().value;
        if (oldestId) {
          this.clients.delete(oldestId);
        }
      }
    }

    this.clients.set(clientMetadata.client_id, clientMetadata);
    return clientMetadata;
  }
}

/**
 * State preserved across the redirect to external provider
 */
interface AuthorizationState {
  clientRedirectUri: string;
  codeChallenge: string;
  originalState?: string;
  clientId: string;
  scopes?: string[];
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
}

/**
 * OAuth Provider Adapter for external OAuth servers
 */
export class ExternalOAuthProvider implements OAuthServerProvider {
  private config: OAuthConfig;
  private logger: Logger;
  private _clientsStore: InMemoryClientsStore;
  private ssrfValidator: SSRFValidator;
  
  // In-memory storage
  private authorizationCodes = new Map<string, AuthorizationCodeData>();
  private accessTokens = new Map<string, AccessTokenData>();
  private stateStore = new Map<string, AuthorizationState>();

  private endpointsInitialized: boolean = false;
  private initializationPromise: Promise<void> | null = null;

  constructor(config: OAuthConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
    this.ssrfValidator = new SSRFValidator(logger);
    this._clientsStore = new InMemoryClientsStore();
    
    // Resolve environment variables in OAuth config
    this.config = this.resolveEnvVars(config);
    
    // Pre-register mcp-proxy-client for VS Code compatibility
    // VS Code doesn't call /oauth/register endpoint before calling /oauth/authorize
    // This client has empty redirect_uris, allowing any redirect URI (validated at runtime)
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

    this.initializationPromise = (async () => {
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
        // Also allow common localhost patterns for development/testing
        allowedUris.push('http://localhost:3003/oauth/callback');
        allowedUris.push('http://127.0.0.1:3003/oauth/callback');
        
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

    return this.initializationPromise;
  }

  get clientsStore(): OAuthRegisteredClientsStore {
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
      
      const match = value.match(/^\$\{env:([^}]+)\}$/);
      if (match) {
        const envVar = match[1];
        const envValue = process.env[envVar];
        if (!envValue) {
          throw new Error(`Environment variable ${envVar} not found (referenced in OAuth config)`);
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
      
      // Default to localhost only if not configured
      const allowedHosts = this.config.allowed_redirect_hosts || ['localhost', '127.0.0.1'];
      
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
    params: AuthorizationParams,
    res: Response
  ): Promise<void> {
    await this.ensureEndpointsInitialized();
    
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

    // Validate redirect host against allowlist to prevent open redirect
    if (!this.isAllowedRedirectHost(params.redirectUri)) {
      this.logger.error('Redirect URI not allowed', undefined, {
        providedUri: params.redirectUri,
        allowedHosts: this.config.allowed_redirect_hosts || ['localhost', '127.0.0.1'],
      });
      throw new Error('Redirect URI not allowed');
    }

    const stateToken = randomUUID();
    
    this.stateStore.set(stateToken, {
      clientRedirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      originalState: params.state,
      clientId: client.client_id,
      scopes: params.scopes,
      createdAt: Date.now(),
    });

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

    if (params.scopes && params.scopes.length > 0) {
      authUrl.searchParams.set('scope', params.scopes.join(' '));
    } else if (this.config.scopes && this.config.scopes.length > 0) {
      authUrl.searchParams.set('scope', this.config.scopes.join(' '));
    }

    // NOTE: Do NOT forward PKCE parameters to external provider
    // The MCP server acts as an OAuth proxy with client_secret (confidential client)
    // PKCE is used only between Cursor <-> MCP, not between MCP <-> External Provider
    // If we forwarded code_challenge, we would need code_verifier which only Cursor has

    this.logger.info('Redirecting to external OAuth provider', {
      authUrl: authUrl.toString(),
      callbackUri,
      stateToken,
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
        this.logger.error('OAuth callback error', undefined, { error, state });
        
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

    try {
        // Exchange External Code for Tokens
        const tokens = await this.exchangeCodeWithProvider(
            code, 
            undefined,
            this.config.redirect_uri!
        );

        // Generate Internal Code
        const internalCode = randomUUID();

        // Store Internal Code -> Tokens mapping
        const client = await this._clientsStore.getClient(storedState.clientId);
        if (!client) throw new Error('Client not found');

        this.authorizationCodes.set(internalCode, {
            client,
            params: {
                redirectUri: storedState.clientRedirectUri,
                codeChallenge: storedState.codeChallenge,
                scopes: storedState.scopes || [],
                state: storedState.originalState
            },
            createdAt: Date.now(),
            tokens
        });

        // Re-validate redirect URI host + registration before redirect (defense-in-depth)
        if (!this.isAllowedRedirectHost(storedState.clientRedirectUri)) {
            this.logger.error('Redirect URI not allowed (callback)', undefined, {
                storedUri: storedState.clientRedirectUri,
                allowedHosts: this.config.allowed_redirect_hosts || ['localhost', '127.0.0.1'],
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
        clientUrl.searchParams.set('code', internalCode);
        if (storedState.originalState) {
            clientUrl.searchParams.set('state', storedState.originalState);
        }

        this.logger.info('Redirecting to client with internal code', {
            clientUrl: clientUrl.toString(),
            internalCode
        });

        // nosemgrep: javascript.express.open-redirect-deepsemgrep.open-redirect-deepsemgrep, javascript.express.web.tainted-redirect-express.tainted-redirect-express
        res.redirect(clientUrl.toString());

    } catch (err) {
        this.logger.error('Callback handling failed', err as Error);
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
      throw new Error('Invalid authorization code');
    }
    
    if (codeData.client.client_id !== client.client_id) {
      throw new Error('Authorization code was not issued to this client');
    }

    // Validate expiration (5 minutes)
    const codeAge = Date.now() - codeData.createdAt;
    const EXPIRATION_MS = 5 * 60 * 1000; // 5 minutes
    if (codeAge > EXPIRATION_MS) {
      this.authorizationCodes.delete(authorizationCode);
      throw new Error('Authorization code expired');
    }

    // Validate PKCE if code challenge was provided
    if (codeData.params.codeChallenge) {
      if (!codeVerifier) {
        throw new Error('code_verifier is required for PKCE');
      }
      
      // Verify code challenge (S256 method)
      const hash = createHash('sha256').update(codeVerifier).digest('base64url');

      // Use constant-time comparison to prevent timing attacks
      const hashBuffer = Buffer.from(hash);
      const challengeBuffer = Buffer.from(codeData.params.codeChallenge);

      if (hashBuffer.length !== challengeBuffer.length || !timingSafeEqual(hashBuffer, challengeBuffer)) {
        throw new Error('Invalid code_verifier');
      }
    }

    if (!codeData.tokens) {
        throw new Error('No tokens associated with this code');
    }

    // Delete authorization code (single use)
    this.authorizationCodes.delete(authorizationCode);

    // Store access token for validation
    const tokenData: AccessTokenData = {
      token: codeData.tokens.access_token,
      clientId: client.client_id,
      scopes: codeData.params.scopes || this.config.scopes || [],
      expiresAt: codeData.tokens.expires_in 
        ? Date.now() + codeData.tokens.expires_in * 1000 
        : undefined,
      resource,
    };
    
    this.accessTokens.set(codeData.tokens.access_token, tokenData);

    return codeData.tokens;
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
      throw new Error(`Token exchange failed: ${response.status} ${errorText}`);
    }

    const tokenResponse = await response.json() as OAuthTokens;
    
    return tokenResponse;
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL
  ): Promise<OAuthTokens> {
    await this.ensureEndpointsInitialized();
    
    this.logger.info('Exchanging refresh token', { clientId: client.client_id });

    const tokenUrl = this.config.token_endpoint!;

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
      throw new Error(`Refresh token exchange failed: ${response.status}`);
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
    };
    
    this.accessTokens.set(tokenResponse.access_token, tokenData);

    return tokenResponse;
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
      }
    }

    // 2. Cleanup expired authorization codes (5 minutes)
    const CODE_TIMEOUT = 5 * 60 * 1000;
    for (const [code, data] of this.authorizationCodes.entries()) {
      if (now - data.createdAt > CODE_TIMEOUT) {
        this.authorizationCodes.delete(code);
      }
    }

    // 3. Cleanup expired access tokens
    for (const [token, data] of this.accessTokens.entries()) {
      if (data.expiresAt && data.expiresAt < now) {
        this.accessTokens.delete(token);
      }
    }
  }
}
