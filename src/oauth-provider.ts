/**
 * OAuth 2.0 Provider Adapter
 * 
 * Implements MCP SDK OAuthServerProvider interface to integrate with external
 * OAuth 2.0 authorization servers (e.g., GitLab, GitHub, etc.)
 * 
 * Architecture:
 * - This server acts as an OAuth client, not an authorization server
 * - Redirects authorization requests to external OAuth provider
 * - Proxies token exchange to external token endpoint
 * - Validates tokens via introspection or JWT validation
 * 
 * Supports:
 * - Authorization Code Flow with PKCE (RFC 7636)
 * - Static client registration (pre-configured client_id/secret)
 * - Dynamic client registration (RFC 7591) - future enhancement
 */

import { randomUUID } from 'node:crypto';
import { Response } from 'express';
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
import type { OAuthConfig } from './types/profile.js';
import type { Logger } from './logger.js';

/**
 * In-memory store for OAuth client registrations
 * 
 * Note: This is a simple implementation for demonstration.
 * Production deployments should use persistent storage (database/Redis)
 */
export class InMemoryClientsStore implements OAuthRegisteredClientsStore {
  private clients = new Map<string, OAuthClientInformationFull>();

  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    return this.clients.get(clientId);
  }

  async registerClient(clientMetadata: OAuthClientInformationFull): Promise<OAuthClientInformationFull> {
    this.clients.set(clientMetadata.client_id, clientMetadata);
    return clientMetadata;
  }
}

/**
 * Data stored for each authorization code
 */
interface AuthorizationCodeData {
  client: OAuthClientInformationFull;
  params: AuthorizationParams;
  createdAt: number;
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
 * 
 * Acts as a proxy between MCP SDK OAuth flow and external OAuth provider
 */
export class ExternalOAuthProvider implements OAuthServerProvider {
  private config: OAuthConfig;
  private logger: Logger;
  private _clientsStore: InMemoryClientsStore;
  
  // In-memory storage for authorization codes and tokens
  // Note: In production, use persistent storage with expiration
  private authorizationCodes = new Map<string, AuthorizationCodeData>();
  private accessTokens = new Map<string, AccessTokenData>();

  constructor(config: OAuthConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
    this._clientsStore = new InMemoryClientsStore();
    
    // Resolve environment variables in OAuth config
    this.config = this.resolveEnvVars(config);
    
    this.logger.info('ExternalOAuthProvider initialized', {
      authEndpoint: this.config.authorization_endpoint,
      tokenEndpoint: this.config.token_endpoint,
      hasClientId: !!this.config.client_id,
      scopes: this.config.scopes,
    });
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return this._clientsStore;
  }

  get authorizationEndpoint(): string {
    return this.config.authorization_endpoint;
  }

  get redirectUri(): string | undefined {
    return this.config.redirect_uri;
  }

  get scopes(): string[] {
    return this.config.scopes;
  }

  /**
   * Resolve environment variable references in OAuth config
   * 
   * Supports: "${env:VARIABLE_NAME}" syntax
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
   * Begin authorization flow by redirecting to external OAuth provider
   * 
   * Flow:
   * 1. Store authorization params with a code
   * 2. Build authorization URL for external provider
   * 3. Redirect user's browser to external provider
   * 4. External provider will redirect back to our callback with code
   */
  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response
  ): Promise<void> {
    this.logger.info('Starting OAuth authorization', {
      clientId: client.client_id,
      scopes: params.scopes,
      redirectUri: params.redirectUri,
    });

    // Generate authorization code for our internal tracking
    const code = randomUUID();
    
    // Store authorization data
    this.authorizationCodes.set(code, {
      client,
      params,
      createdAt: Date.now(),
    });

    // Validate redirect URI
    if (!client.redirect_uris.includes(params.redirectUri)) {
      this.logger.error('Invalid redirect URI', undefined, {
        providedUri: params.redirectUri,
        registeredUris: client.redirect_uris,
      });
      throw new Error('Unregistered redirect_uri');
    }

    // Build authorization URL for external OAuth provider
    const authUrl = new URL(this.config.authorization_endpoint);
    
    // Use configured client_id or the MCP client's ID
    const clientId = this.config.client_id || client.client_id;
    
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('redirect_uri', params.redirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('code_challenge', params.codeChallenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    
    if (params.state) {
      authUrl.searchParams.set('state', params.state);
    }
    
    if (params.scopes && params.scopes.length > 0) {
      authUrl.searchParams.set('scope', params.scopes.join(' '));
    } else if (this.config.scopes.length > 0) {
      authUrl.searchParams.set('scope', this.config.scopes.join(' '));
    }

    this.logger.info('Redirecting to external OAuth provider', {
      authUrl: authUrl.toString().replace(/code_challenge=[^&]+/, 'code_challenge=***'),
    });

    // Redirect to external OAuth provider
    res.redirect(authUrl.toString());
  }

  /**
   * Get code challenge for authorization code
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
   * Exchange authorization code for access token
   * 
   * Flow:
   * 1. Validate authorization code
   * 2. Exchange code with external OAuth provider
   * 3. Store and return access token
   */
  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    codeVerifier?: string,
    redirectUri?: string,
    resource?: URL
  ): Promise<OAuthTokens> {
    this.logger.info('Exchanging authorization code', {
      clientId: client.client_id,
      hasCodeVerifier: !!codeVerifier,
    });

    const codeData = this.authorizationCodes.get(authorizationCode);
    
    if (!codeData) {
      throw new Error('Invalid authorization code');
    }
    
    if (codeData.client.client_id !== client.client_id) {
      throw new Error('Authorization code was not issued to this client');
    }

    // Check code expiration (5 minutes)
    const codeAge = Date.now() - codeData.createdAt;
    if (codeAge > 5 * 60 * 1000) {
      this.authorizationCodes.delete(authorizationCode);
      throw new Error('Authorization code expired');
    }

    // Delete authorization code (single use)
    this.authorizationCodes.delete(authorizationCode);

    // Exchange code with external OAuth provider
    const tokenResponse = await this.exchangeCodeWithProvider(
      authorizationCode,
      codeVerifier,
      redirectUri || codeData.params.redirectUri
    );

    // Store access token
    const tokenData: AccessTokenData = {
      token: tokenResponse.access_token,
      clientId: client.client_id,
      scopes: codeData.params.scopes || this.config.scopes,
      expiresAt: tokenResponse.expires_in 
        ? Date.now() + tokenResponse.expires_in * 1000 
        : undefined,
      resource,
    };
    
    this.accessTokens.set(tokenResponse.access_token, tokenData);

    this.logger.info('Token exchange successful', {
      clientId: client.client_id,
      expiresIn: tokenResponse.expires_in,
    });

    return tokenResponse;
  }

  /**
   * Exchange authorization code with external OAuth provider
   */
  private async exchangeCodeWithProvider(
    code: string,
    codeVerifier: string | undefined,
    redirectUri: string
  ): Promise<OAuthTokens> {
    const tokenUrl = this.config.token_endpoint;
    
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
    });

    if (codeVerifier) {
      body.set('code_verifier', codeVerifier);
    }

    // Add client credentials if configured
    if (this.config.client_id) {
      body.set('client_id', this.config.client_id);
    }
    
    if (this.config.client_secret) {
      body.set('client_secret', this.config.client_secret);
    }

    this.logger.debug('Exchanging code with external provider', { tokenUrl });

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

  /**
   * Exchange refresh token for new access token
   */
  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL
  ): Promise<OAuthTokens> {
    this.logger.info('Exchanging refresh token', { clientId: client.client_id });

    const tokenUrl = this.config.token_endpoint;
    
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

    // Update stored token data
    const tokenData: AccessTokenData = {
      token: tokenResponse.access_token,
      clientId: client.client_id,
      scopes: scopes || this.config.scopes,
      expiresAt: tokenResponse.expires_in 
        ? Date.now() + tokenResponse.expires_in * 1000 
        : undefined,
      resource,
    };
    
    this.accessTokens.set(tokenResponse.access_token, tokenData);

    return tokenResponse;
  }

  /**
   * Verify access token
   * 
   * Strategy:
   * 1. Check in-memory cache first
   * 2. If introspection endpoint configured, use it
   * 3. Otherwise, assume token is valid if in cache
   */
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const tokenData = this.accessTokens.get(token);
    
    if (!tokenData) {
      // Token not in our cache - try introspection if available
      if (this.config.introspection_endpoint) {
        return await this.introspectToken(token);
      }
      
      throw new Error('Invalid or expired token');
    }

    // Check expiration
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

  /**
   * Introspect token with external OAuth provider
   */
  private async introspectToken(token: string): Promise<AuthInfo> {
    const introspectionUrl = this.config.introspection_endpoint;
    
    if (!introspectionUrl) {
      throw new Error('Introspection endpoint not configured');
    }

    this.logger.debug('Introspecting token', { introspectionUrl });

    const body = new URLSearchParams({ token });

    // Add client credentials if configured
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

  /**
   * Revoke token
   */
  async revokeToken(
    client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest
  ): Promise<void> {
    this.logger.info('Revoking token', { clientId: client.client_id });

    // Remove from local cache
    this.accessTokens.delete(request.token);

    // Revoke with external provider if endpoint configured
    if (this.config.revocation_endpoint) {
      await this.revokeTokenWithProvider(request.token);
    }
  }

  /**
   * Revoke token with external OAuth provider
   */
  private async revokeTokenWithProvider(token: string): Promise<void> {
    const revocationUrl = this.config.revocation_endpoint;
    
    if (!revocationUrl) {
      return; // No revocation endpoint configured
    }

    this.logger.debug('Revoking token with external provider', { revocationUrl });

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
      // Don't throw - revocation is best-effort
    }
  }
}

