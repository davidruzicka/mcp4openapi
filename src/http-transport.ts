/**
 * HTTP Streamable Transport for MCP
 * 
 * Implements MCP Specification 2025-03-26
 * https://modelcontextprotocol.io/specification/2025-03-26/basic/transports
 * 
 * Why: Enables remote MCP server access with SSE streaming, session management,
 * and resumability for reliable communication over HTTP.
 */

import express, { Request, Response, NextFunction, RequestHandler } from 'express';
import type { Server } from 'http';
import https from 'https';
import fs from 'fs';
import crypto from 'crypto';
import { isIP } from 'node:net';
import rateLimit from 'express-rate-limit';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import type { Logger } from './logger.js';
import type {
  SessionData,
  SSEStreamState,
  QueuedMessage,
  HttpTransportConfig,
  McpRequest
} from './types/http-transport.js';
import { isInitializeRequest } from './jsonrpc-validator.js';
import { MetricsCollector } from './metrics.js';
import { ExternalOAuthProvider } from './oauth-provider.js';
import type { AuthInterceptor } from './types/profile.js';
import { HTTP_STATUS, MIME_TYPES, OAUTH_PATHS, TIMEOUTS, OAUTH_RATE_LIMIT } from './constants.js';
import { escapeHtmlSafe } from './validation-utils.js';
import type { OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import {
  AuthenticationError,
  AuthorizationError,
  RateLimitError,
  ValidationError,
  generateCorrelationId,
} from './errors.js';
import { parseFilteringHeader, normalizeFilteringHeaderValue } from './filtering.js';
import { validateRegexPattern } from './tool-filter.js';

// Default maximum token length (1000 characters)
const DEFAULT_MAX_TOKEN_LENGTH = 1000;

export class HttpTransport {
  private app: express.Application;
  private server: Server | https.Server | null = null;
  private sessions: Map<string, SessionData> = new Map();
  private config: HttpTransportConfig;
  private logger: Logger;
  private metrics: MetricsCollector | null = null;
  private cleanupInterval: NodeJS.Timeout | null = null;
  private messageHandler: ((message: unknown, sessionId?: string) => Promise<unknown>) | null = null;
  private oauthProvider: ExternalOAuthProvider | null = null;
  // Map access_token -> { refreshToken, expiresAt, clientId, scopes }
  // Used to bridge /oauth/token endpoint (where we see OAuthTokens) and session initialization (where we only see access token)
  private oauthTokensByAccessToken: Map<string, { refreshToken?: string; expiresAt?: number; clientId: string; scopes: string[] }> = new Map();

  constructor(config: HttpTransportConfig, logger: Logger) {
    // Freeze config to prevent runtime mutation of security-critical settings (allowedOrigins, rate limits, etc.)
    this.config = Object.freeze({ ...config });
    this.logger = logger;
    
    // Initialize metrics if enabled
    if (config.metricsEnabled) {
      this.metrics = new MetricsCollector({
        enabled: true,
        prefix: 'mcp_',
      });
    }
    
    // Initialize OAuth provider if configured
    if (config.oauthConfig) {
      this.logger.info('Initializing OAuth provider with config', { hasClientId: !!config.oauthConfig.client_id });
      this.oauthProvider = new ExternalOAuthProvider(config.oauthConfig, logger);
      // Note: authorizationEndpoint may be undefined at this point if config uses issuer-based discovery
      // It will be resolved lazily on first OAuth operation (authorize/token)
      this.logger.info('OAuth provider initialized', { 
        endpoint: this.oauthProvider.authorizationEndpoint || '(to be derived from issuer)',
        hasIssuer: !!config.oauthConfig.issuer,
      });
    } else {
      this.logger.info('No OAuth config provided - OAuth provider not initialized');
    }
    
    this.app = express();
    this.setupMiddleware();
    this.setupRoutes();
  }

  /**
   * Setup Express middleware
   * 
   * Why: Security (Origin validation, rate limiting), JSON parsing, session extraction, metrics
   */
  private setupMiddleware(): void {
    // Request logging (before any middleware)
    this.app.use((req: Request, res: Response, next: NextFunction) => {
      this.logger.debug('Request received', {
        method: req.method,
        url: req.url,
        path: req.path,
        userAgent: req.get('user-agent'),
        ip: req.ip,
      });
      next();
    });

    // DNS rebinding protection when binding to localhost
    // Deny requests with mismatched Host headers to prevent DNS rebinding attacks
    // Applies when server host is localhost/127.0.0.1, regardless of auth configuration
    this.app.use((req: Request, res: Response, next: NextFunction) => {
      const hostCfg = this.config.host?.toLowerCase();
      if (hostCfg === 'localhost' || hostCfg === '127.0.0.1') {
        const hostHeader = (req.headers['host'] || '').toString().toLowerCase();
        const expectedHosts = new Set(['localhost', '127.0.0.1']);
        const headerHostOnly = hostHeader.split(':')[0];
        if (!expectedHosts.has(headerHostOnly)) {
          this.logger.warn('DNS rebinding protection: invalid Host header', {
            hostHeader,
            expected: Array.from(expectedHosts),
          });
          res.status(403).json({ error: 'Forbidden' });
          return;
        }
      }
      next();
    });

    // JSON body parser
    this.app.use(express.json());

    // Metrics: Track request start time
    this.app.use((req: Request, res: Response, next: NextFunction) => {
      (req as any).startTime = Date.now();

      // Log response
      const originalSend = res.send;
      const originalJson = res.json;
      const logger = this.logger;

      res.send = function(body: any) {
        logger.debug('Outgoing response', {
          method: req.method,
          url: req.url,
          status: res.statusCode,
          contentType: res.get('content-type'),
          bodyLength: body ? body.length : 0,
          bodyPreview: typeof body === 'string' ? body.substring(0, 200) : '[object]'
        });
        return originalSend.call(this, body);
      };

      res.json = function(body: any) {
        logger.debug('Outgoing JSON response', {
          method: req.method,
          url: req.url,
          status: res.statusCode,
          body
        });
        return originalJson.call(this, body);
      };

      next();
    });

    // Debug: Log all requests
    this.app.use((req: Request, res: Response, next: NextFunction) => {
      this.logger.debug('Incoming request', {
        method: req.method,
        url: req.url,
        path: req.path,
        headers: {
          'user-agent': req.headers['user-agent'],
          'accept': req.headers.accept,
          'content-type': req.headers['content-type'],
          'authorization': req.headers.authorization ? '[REDACTED]' : undefined
        },
        ip: req.ip
      });
      next();
    });

    // Security: Origin validation (DNS rebinding protection)
    this.app.use((req: Request, res: Response, next: NextFunction) => {
      const origin = req.headers.origin;
      
      // Warn if binding to 0.0.0.0
      if (this.config.host === '0.0.0.0' && !this.hasWarnedAboutBinding) {
        this.logger.warn('HTTP transport bound to 0.0.0.0 - accessible from network. Ensure firewall protection.');
        this.hasWarnedAboutBinding = true;
      }

      // Skip Origin check for localhost
      if (req.hostname === 'localhost' || req.hostname === '127.0.0.1') {
        return next();
      }

      // Validate Origin header for non-localhost
      if (origin && !this.isAllowedOrigin(origin)) {
        this.logger.warn('Rejected request from disallowed origin', { origin, ip: req.ip });
        return res.status(HTTP_STATUS.FORBIDDEN).json({
          error: 'Forbidden',
          message: 'Origin not allowed'
        });
      }

      next();
    });

    // Extract session ID from header
    this.app.use((req: McpRequest, res: Response, next: NextFunction) => {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      if (sessionId) {
        req.sessionId = sessionId;
      }
      next();
    });
  }

  private hasWarnedAboutBinding = false;

  /**
   * Check if origin is allowed
   * 
   * Why: Prevent DNS rebinding attacks
   * 
   * Supports:
   * - Exact hostname: 'example.com', 'api.example.com'
   * - Wildcard subdomain: '*.example.com'
   * - IPv4 CIDR: '192.168.1.0/24', '10.0.0.0/8'
   * - IPv4 exact: '192.168.1.100'
   */
  private isAllowedOrigin(origin: string): boolean {
    try {
      const url = new URL(origin);
      const hostname = url.hostname;

      // Always allow localhost
      if (hostname === 'localhost' || hostname === '127.0.0.1') {
        return true;
      }

      // Allow configured host
      if (hostname === this.config.host) {
        return true;
      }

      // Allow OAuth redirect URI host if configured
      if (this.oauthProvider?.redirectUri) {
        try {
          const redirectUrl = new URL(this.oauthProvider.redirectUri);
          if (hostname === redirectUrl.hostname) {
            return true;
          }
        } catch {
          // Invalid URL, ignore
        }
      }

      // Check custom allowed origins
      if (this.config.allowedOrigins && this.config.allowedOrigins.length > 0) {
        for (const allowed of this.config.allowedOrigins) {
          if (this.matchOrigin(hostname, allowed)) {
            return true;
          }
        }
      }

      return false;
    } catch {
      return false;
    }
  }

  /**
   * Match hostname against allowed origin pattern
   * 
   * Supports:
   * - Exact match: 'example.com' === 'example.com'
   * - Wildcard: '*.example.com' matches 'api.example.com', 'web.example.com'
   * - CIDR: '192.168.1.0/24' matches '192.168.1.1' through '192.168.1.254'
   */
  private matchOrigin(hostname: string, pattern: string): boolean {
    const normalizedHost = this.stripIpv6Brackets(hostname);
    const normalizedPattern = this.stripIpv6Brackets(pattern);

    // Exact match
    if (normalizedHost === normalizedPattern) {
      return true;
    }

    // Wildcard subdomain match (*.example.com)
    if (normalizedPattern.startsWith('*.')) {
      const domain = normalizedPattern.substring(2); // Remove '*.'
      return normalizedHost.endsWith('.' + domain) || normalizedHost === domain;
    }

    // CIDR match (IPv4/IPv6)
    if (normalizedPattern.includes('/')) {
      return this.matchCIDR(normalizedHost, normalizedPattern);
    }

    return false;
  }

  /**
   * Check if IP address is within CIDR range (IPv4 or IPv6)
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
        this.logger.warn('Invalid CIDR mask bits', { cidr });
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
      this.logger.warn('Invalid IPv6 CIDR mask bits', { cidr });
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
   * 
   * Example: '192.168.1.1' -> 3232235777
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

    return result >>> 0; // Unsigned
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
   * Create configured rate limiter or a passthrough handler when disabled
   *
   * Why: Both MCP and metrics endpoints share the same rate limiting setup logic.
   * Centralizing it keeps behaviour consistent and avoids drifting configuration.
   */
  private createRateLimiter(options: {
    enabled: boolean;
    windowMs: number;
    maxRequests: number;
    logMessage: string;
    responseMessage?: string;
  }): RequestHandler {
    if (!options.enabled) {
      return (_req: Request, _res: Response, next: NextFunction) => next();
    }

    const message = options.responseMessage ??
      `Rate limit exceeded. Max ${options.maxRequests} requests per ${options.windowMs / 1000} seconds.`;

    return rateLimit({
      windowMs: options.windowMs,
      max: options.maxRequests,
      standardHeaders: true, // Return rate limit info in `RateLimit-*` headers
      legacyHeaders: false, // Disable deprecated `X-RateLimit-*` headers
      handler: (req: Request, res: Response) => {
        this.logger.warn(options.logMessage, {
          ip: req.ip,
          path: req.path,
          method: req.method,
        });

        res.status(HTTP_STATUS.TOO_MANY_REQUESTS).json({
          error: 'Too Many Requests',
          message,
        });
      },
    });
  }

  private formatRateLimitMessage(scope: string, maxRequests: number, windowMs: number): string {
    return `Rate limit exceeded for ${scope}. Max ${maxRequests} requests per ${windowMs / 1000} seconds.`;
  }

  /**
   * Setup MCP endpoint routes
   *
   * Why: Single endpoint for POST (client→server) and GET (SSE stream)
   */
  private setupRoutes(): void {
    this.logger.info('Setting up HTTP routes');

    // Security: Rate limiting setup (needed for OAuth routes)
    const rateLimitEnabled = this.config.rateLimitEnabled !== false; // default: true
    
    // Rate limiter for OAuth endpoints (stricter limits for security)
    // OAuth endpoints are sensitive and should have lower limits than general API
    // Configuration priority: profile > env vars > defaults
    const oauthWindowMs = this.config.rateLimitOAuthWindowMs || OAUTH_RATE_LIMIT.WINDOW_MS;
    const oauthMaxRequests = this.config.rateLimitOAuthMax || OAUTH_RATE_LIMIT.MAX_REQUESTS;
    const oauthRateLimiter = this.createRateLimiter({
      enabled: rateLimitEnabled,
      windowMs: oauthWindowMs,
      maxRequests: oauthMaxRequests,
      logMessage: 'Rate limit exceeded for OAuth',
      responseMessage: `Too many OAuth requests. Limit: ${oauthMaxRequests} requests per ${Math.round(oauthWindowMs / 60000)} minutes. Please try again later.`,
    });

    // OAuth 2.0 routes (if configured)
    if (this.oauthProvider) {
      // Build redirect URI
      const redirectUri = this.oauthProvider.redirectUri ||
        `http://${this.config.host}:${this.config.port}/oauth/callback`;

      // Derive serverUrl from redirectUri
      const baseUrl = new URL(redirectUri).origin;
      const serverUrl = new URL(`${baseUrl}/mcp`);
      // issuerUrl should be the base URL of the authorization server (e.g. https://gitlab.com),
      // NOT the authorization endpoint (e.g. https://gitlab.com/oauth/authorize)
      // We try to derive it from authorizationEndpoint if not explicitly configured
      // Note: authorizationEndpoint might not be ready yet (async initialization),
      // so we use serverUrl.origin as fallback
      let issuerUrl: URL;
      try {
         const authEndpoint = this.oauthProvider.authorizationEndpoint;
         if (authEndpoint) {
           // Try to extract base URL from auth endpoint
           const authUrl = new URL(authEndpoint);
           issuerUrl = new URL(authUrl.origin);
         } else {
           // Fallback: use server origin (will be updated after async init)
           issuerUrl = new URL(serverUrl.origin);
         }
      } catch (e) {
         // Fallback: use server origin
         issuerUrl = new URL(serverUrl.origin);
      }

      this.logger.info('Setting up OAuth routes', {
        serverUrl: serverUrl.toString(),
        issuerUrl: issuerUrl.toString(),
        redirectUri,
      });

      // Install MCP OAuth router
      // This adds standard OAuth endpoints:
      // - /.well-known/oauth-authorization-server
      // - /.well-known/oauth-protected-resource
      // - /oauth/authorize
      // - /oauth/token
      // - /oauth/register (dynamic client registration)
      // - /oauth/revoke (token revocation)
      // Only register resource server endpoints, not authorization server endpoints
      // since our MCP server is not an OAuth authorization server
      this.app.get(OAUTH_PATHS.WELL_KNOWN_PROTECTED_RESOURCE, oauthRateLimiter, (req: Request, res: Response) => {
        // Build metadata object with only defined fields (RFC 8707)
        const metadata: any = {
          resource: serverUrl.href,
          authorization_servers: [serverUrl.origin], // We are the authorization server (proxy)
          bearer_methods_supported: ['header'],
        };
        
        // Optional: scopes_supported (only if scopes are defined)
        if (this.oauthProvider?.scopes && this.oauthProvider.scopes.length > 0) {
          metadata.scopes_supported = this.oauthProvider.scopes;
        }
        
        // Optional: resource_name (from config, already has fallback in mcp-server.ts)
        if (this.config.resourceName) {
          metadata.resource_name = this.config.resourceName;
        }
        
        // Optional: resource_documentation (from config, may be undefined)
        if (this.config.resourceDocumentation) {
          metadata.resource_documentation = this.config.resourceDocumentation;
        }
        
        res.json(metadata);
      });

      // Authorization endpoint
      // Initiates the OAuth flow by redirecting the user to the external provider
      this.app.get(OAUTH_PATHS.AUTHORIZE, oauthRateLimiter, async (req: Request, res: Response) => {
        try {
          const { response_type, client_id, redirect_uri, scope, state, code_challenge, code_challenge_method } = req.query;

          if (!client_id || typeof client_id !== 'string') {
            res.status(HTTP_STATUS.BAD_REQUEST).send('Missing client_id');
            return;
          }

          if (!redirect_uri || typeof redirect_uri !== 'string') {
            res.status(HTTP_STATUS.BAD_REQUEST).send('Missing redirect_uri');
            return;
          }

          if (this.oauthProvider) {
             // Ensure provider is initialized before client validation
             // This registers configured client_id if present
             await this.oauthProvider.ensureEndpointsInitialized();
             
             // Find the client to validate configuration
             const client = await this.oauthProvider.clientsStore.getClient(client_id);
             if (!client) {
                 res.status(HTTP_STATUS.BAD_REQUEST).send('Invalid client_id');
                 return;
             }

             // Prepare parameters for provider authorization
             const scopeStr = (scope as string || '').trim();
             const params = {
                 responseType: response_type as string || 'code',
                 clientId: client_id,
                 redirectUri: redirect_uri,
                 scope: scopeStr ? scopeStr.split(' ') : [],
                 state: state as string,
                 codeChallenge: code_challenge as string,
                 codeChallengeMethod: code_challenge_method as string,
                 scopes: scopeStr ? scopeStr.split(' ') : [],
             };

             // Call provider authorize method which handles the redirect logic
             await this.oauthProvider.authorize(client, params, res);
          } else {
             res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).send('OAuth provider not initialized');
          }
        } catch (error) {
          this.logger.error('OAuth authorize error', error instanceof Error ? error : new Error(String(error)));
          res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).send('OAuth authorization failed');
        }
      });

      // Token endpoint
      // Exchanges authorization code or refresh token for access token
      this.app.post(OAUTH_PATHS.TOKEN, oauthRateLimiter, express.urlencoded({ extended: false }), async (req: Request, res: Response) => {
        try {
          const { grant_type, code, redirect_uri, client_id, code_verifier, refresh_token } = req.body;

          this.logger.debug('OAuth token request', {
            grant_type,
            client_id,
            has_code: !!code,
            has_code_verifier: !!code_verifier,
            redirect_uri,
          });

          if (grant_type === 'authorization_code') {
            // Authorization Code Flow
            if (!code) {
               res.status(HTTP_STATUS.BAD_REQUEST).json({ error: 'invalid_request', error_description: 'Missing code' });
               return;
            }

            if (this.oauthProvider) {
               // Ensure provider is initialized before client validation
               await this.oauthProvider.ensureEndpointsInitialized();
               
               const client = await this.oauthProvider.clientsStore.getClient(client_id);
               if (!client) {
                   res.status(HTTP_STATUS.BAD_REQUEST).json({ error: 'invalid_client' });
                   return;
               }

               const tokens = await this.oauthProvider.exchangeAuthorizationCode(
                   client,
                   code,
                   code_verifier,
                   redirect_uri
               );

               // Store OAuth tokens for later session initialization
               this.storeOAuthTokens(tokens, client.client_id, client.scope?.split(' ') || []);

               res.json(tokens);
            } else {
               res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ error: 'server_error', error_description: 'OAuth provider not initialized' });
            }
          } else if (grant_type === 'refresh_token') {
            // Refresh Token Flow
            if (!refresh_token) {
               res.status(HTTP_STATUS.BAD_REQUEST).json({ error: 'invalid_request', error_description: 'Missing refresh_token' });
               return;
            }

            if (this.oauthProvider) {
               // Ensure provider is initialized before client validation
               await this.oauthProvider.ensureEndpointsInitialized();
               
               const client = await this.oauthProvider.clientsStore.getClient(client_id);
               if (!client) {
                   res.status(HTTP_STATUS.BAD_REQUEST).json({ error: 'invalid_client' });
                   return;
               }

               const tokens = await this.oauthProvider.exchangeRefreshToken(
                   client,
                   refresh_token
               );

               // Store OAuth tokens for later session initialization
               // Note: When refreshing, the old access token should be invalidated
               // but we don't track it here - the new token replaces it in the map
               this.storeOAuthTokens(tokens, client.client_id, client.scope?.split(' ') || []);

               res.json(tokens);
            } else {
               res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ error: 'server_error', error_description: 'OAuth provider not initialized' });
            }
          } else {
             this.logger.warn('Unsupported grant type', { grant_type, expected: 'authorization_code or refresh_token' });
             res.status(HTTP_STATUS.BAD_REQUEST).json({ error: 'unsupported_grant_type' });
             return;
          }
        } catch (error) {
          this.logger.error('OAuth token exchange error', error instanceof Error ? error : new Error(String(error)));
          res.status(HTTP_STATUS.BAD_REQUEST).json({ error: 'invalid_grant', error_description: String(error) });
        }
      });

      // OAuth callback endpoint to receive tokens from authorization server
      this.app.get(OAUTH_PATHS.CALLBACK, oauthRateLimiter, async (req: Request, res: Response) => {
        try {
          const { code, state, error, error_description } = req.query;

          this.logger.info('OAuth callback received', { 
            hasCode: !!code, 
            hasState: !!state,
            error: error,
            errorDescription: error_description
          });

          if (error) {
             // Sanitize error messages to prevent XSS
             const safeError = escapeHtmlSafe(error as string);
             const safeErrorDesc = escapeHtmlSafe(error_description as string);
             
             res.status(HTTP_STATUS.BAD_REQUEST).json({ 
               error: safeError,
               error_description: safeErrorDesc || safeError
             });
             return;
          }

          if (!code || typeof code !== 'string') {
            res.status(HTTP_STATUS.BAD_REQUEST).send('Missing authorization code');
            return;
          }

          // Delegate to OAuth provider to handle token exchange and redirect back to client (Cursor)
          if (this.oauthProvider) {
             await this.oauthProvider.handleCallback(req, res);
          } else {
             res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).send('OAuth provider not initialized');
          }
        } catch (error) {
          this.logger.error('OAuth callback error', error instanceof Error ? error : new Error(String(error)));
          if (!res.headersSent) {
            res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).send('OAuth callback failed');
          }
        }
      });

      // Provide authorization server metadata
      // We advertise the MCP server itself as the authorization server (Proxy Mode)
      // This allows us to handle the redirect dance between Cursor -> MCP -> GitLab -> MCP -> Cursor
      this.app.get(OAUTH_PATHS.WELL_KNOWN_AUTHORIZATION_SERVER, async (req: Request, res: Response) => {
        try {
          res.json({
            issuer: serverUrl.origin, // We are the issuer for the client
            authorization_endpoint: new URL(OAUTH_PATHS.AUTHORIZE, serverUrl.origin).href,
            token_endpoint: new URL(OAUTH_PATHS.TOKEN, serverUrl.origin).href,
            registration_endpoint: new URL(OAUTH_PATHS.REGISTER, serverUrl.origin).href,
            response_types_supported: ['code'],
            code_challenge_methods_supported: ['S256'],
            grant_types_supported: ['authorization_code', 'refresh_token'],
            scopes_supported: this.oauthProvider?.scopes || ['api'],
          });
        } catch (error) {
          this.logger.error('OAuth authorization server metadata error', error instanceof Error ? error : new Error(String(error)));
          res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).send('OAuth metadata failed');
        }
      });

      // Dynamic Client Registration endpoint
      // Cursor requires this to register itself with a redirect URI
      this.app.post(OAUTH_PATHS.REGISTER, express.json(), async (req: Request, res: Response) => {
         try {
            const { redirect_uris } = req.body;
            this.logger.info('Dynamic client registration request', { redirect_uris });
            
            // We don't actually strictly enforce registration in this proxy mode,
            // but we return a valid client configuration to satisfy the client.
            // We use a static client ID for the internal mapping.
            const clientId = 'mcp-proxy-client';
            const clientSecret = 'mcp-proxy-secret';
            
            // Register this client in our internal store so authorize requests pass validation
            if (this.oauthProvider) {
                const client = {
                    client_id: clientId,
                    client_secret: clientSecret,
                    redirect_uris: redirect_uris || [],
                    grant_types: ['authorization_code', 'refresh_token'],
                    response_types: ['code'],
                    scope: (this.oauthProvider.scopes || []).join(' '),
                };
                // We need to cast to any because registerClient might not be exposed on the interface
                // but we know ExternalOAuthProvider uses InMemoryClientsStore
                await (this.oauthProvider.clientsStore as any).registerClient(client);
            }

            res.status(HTTP_STATUS.CREATED).json({
                client_id: clientId,
                client_secret: clientSecret,
                redirect_uris: redirect_uris,
                grant_types: ['authorization_code', 'refresh_token'],
                response_types: ['code'],
                scope: (this.oauthProvider?.scopes || []).join(' '),
                token_endpoint_auth_method: 'client_secret_post'
            });
         } catch (error) {
            this.logger.error('Client registration failed', error instanceof Error ? error : new Error(String(error)));
            res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ error: 'server_error', error_description: 'Registration failed' });
         }
      });

      this.logger.info('OAuth routes registered');
    }

      // Security: Rate limiting setup (for MCP endpoints)
      const windowMs = this.config.rateLimitWindowMs || TIMEOUTS.RATE_LIMIT_WINDOW_MS;
    const maxRequests = this.config.rateLimitMaxRequests || 100; // 100 req/min
    const metricsMaxRequests = this.config.rateLimitMetricsMax || 10; // 10 req/min for metrics

    if (rateLimitEnabled) {
      this.logger.info('Rate limiting enabled', {
        windowMs,
        maxRequests,
        metricsMaxRequests,
      });
    }

    // Rate limiter for MCP/SSE endpoints (100 req/min by default)
    const mcpRateLimiter = this.createRateLimiter({
      enabled: rateLimitEnabled,
      windowMs,
      maxRequests,
      logMessage: 'Rate limit exceeded',
    });

    // Rate limiter for metrics endpoint (10 req/min by default)
    const metricsRateLimiter = this.createRateLimiter({
      enabled: rateLimitEnabled,
      windowMs,
      maxRequests: metricsMaxRequests,
      logMessage: 'Rate limit exceeded for metrics',
      responseMessage: this.formatRateLimitMessage('metrics', metricsMaxRequests, windowMs),
    });

    // Main MCP endpoint - POST for sending messages
    this.app.post('/mcp', mcpRateLimiter, this.handlePost.bind(this));
    // CORS preflight handler
    this.app.options('/mcp', (req: Request, res: Response) => {
      const origin = req.headers.origin;
      // Only send CORS headers for explicitly allowed origins; otherwise reject
      if (origin && this.isAllowedOrigin(origin)) {
        // nosemgrep: javascript.express.security.cors-misconfiguration.cors-misconfiguration
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept, Mcp-Session-Id');
        // We do not allow credentials; prevents cookie-based attacks by default
        res.setHeader('Access-Control-Allow-Credentials', 'false');
        res.setHeader('Access-Control-Max-Age', '86400'); // 24 hours cache
        return res.status(HTTP_STATUS.OK).send();
      }
      // Disallowed origin: do not echo origin or emit permissive headers
      res.status(HTTP_STATUS.FORBIDDEN).json({ error: 'Forbidden', message: 'Origin not allowed' });
    });

    this.logger.info('Registered POST /mcp route');

    // Main MCP endpoint - GET for SSE streaming
    this.app.get('/mcp', mcpRateLimiter, this.handleGet.bind(this));

    // Session termination
    this.app.delete('/mcp', mcpRateLimiter, this.handleDelete.bind(this));

    // Legacy alias endpoints - deprecated
    // Why: Backward compatibility for clients using /sse during migration
    this.app.post('/sse', mcpRateLimiter, (req: Request, res: Response, next: NextFunction) => {
      this.logger.warn('Deprecated endpoint used: POST /sse. Please migrate to POST /mcp');
      this.logger.info('Handling POST /sse request');
      return (this.handlePost as any)(req, res, next);
    });
    this.app.get('/sse', mcpRateLimiter, (req: Request, res: Response, next: NextFunction) => {
      this.logger.warn('Deprecated endpoint used: GET /sse. Please migrate to GET /mcp');
      this.logger.info(`Handling GET /sse request from: ${req.ip}`);
      return (this.handleGet as any)(req as any, res, next);
    });
    this.logger.info('Registered SSE routes: POST/GET/DELETE /sse');
    this.app.delete('/sse', mcpRateLimiter, (req: Request, res: Response, next: NextFunction) => {
      this.logger.warn('Deprecated endpoint used: DELETE /sse. Please migrate to DELETE /mcp');
      return (this.handleDelete as any)(req as any, res, next);
    });

    // Metrics endpoint (if enabled)
    if (this.config.metricsEnabled) {
      this.app.get(this.config.metricsPath, metricsRateLimiter, this.handleMetrics.bind(this));
    }

    // Health check (with rate limiting)
    this.app.get('/health', mcpRateLimiter, (req: Request, res: Response) => {
      const startTime = Date.now();
      res.json({ status: 'ok', sessions: this.sessions.size });

      if (this.metrics) {
        const duration = (Date.now() - startTime) / 1000;
        this.metrics.recordHttpRequest(req.method, req.path, res.statusCode, duration);
      }
    });

    // Debug: SSE route registered
    this.logger.info('SSE routes registered successfully');

    // Default 404 handler - MUST be last route registered
    // This will catch all unmatched requests
    this.app.use((req: Request, res: Response) => {
      this.logger.warn('Unhandled request (404)', {
        method: req.method,
        url: req.url,
        path: req.path,
        headers: req.headers,
        ip: req.ip
      });
      res.status(HTTP_STATUS.NOT_FOUND).json({
        error: 'Not Found',
        message: `Endpoint ${req.method} ${req.path} not found`
      });
    });
  }
  
  /**
   * Handle metrics endpoint
   * 
   * Why: Prometheus scraping endpoint
   */
  private async handleMetrics(req: Request, res: Response): Promise<void> {
    const startTime = Date.now();
    
    try {
      if (!this.metrics) {
        res.status(HTTP_STATUS.NOT_FOUND).json({ error: 'Not Found', message: 'Metrics disabled' });
        return;
      }
      
      const metrics = await this.metrics.getMetrics();
      res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
      res.send(metrics);
      
      // Don't record metrics call in metrics (avoid recursion)
    } catch (error) {
      this.logger.error('Metrics endpoint error', error as Error);
      res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ error: 'Internal Server Error', message: (error as Error).message });
    }
  }

  /**
   * Validate authentication token by making a probe request to the API
   * 
   * Supports all auth types: bearer, query, custom-header
   * Returns true if token is valid, false otherwise
   */
  /**
   * Builds a URL by intelligently combining base URL and endpoint
   * Handles absolute URLs, absolute paths, and relative paths correctly
   */
  private buildUrl(endpoint: string, baseUrl: string): URL {
    // If endpoint is already an absolute URL, use it as-is
    if (endpoint.startsWith('http://') || endpoint.startsWith('https://')) {
      return new URL(endpoint);
    }

    // If endpoint is an absolute path (starts with /), combine with origin of baseUrl
    if (endpoint.startsWith('/')) {
      const baseUrlObj = new URL(baseUrl);
      return new URL(endpoint, baseUrlObj.origin);
    }

    // Otherwise, treat as relative path and append to baseUrl
    // Ensure baseUrl ends with '/' for proper URL construction
    const normalizedBaseUrl = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/';
    return new URL(endpoint, normalizedBaseUrl);
  }

  private async validateAuthToken(
    authConfig: AuthInterceptor,
    token: string,
    baseUrl: string
  ): Promise<boolean> {
    if (!authConfig.validation_endpoint) {
      return true; // Skip validation if not configured
    }

    const url = this.buildUrl(authConfig.validation_endpoint, baseUrl);
    const headers: Record<string, string> = {};
    const method = authConfig.validation_method || 'GET';
    const timeout = authConfig.validation_timeout_ms || 5000;
    const urlString = url.toString();

    // Apply auth based on type
    switch (authConfig.type) {
      case 'oauth':
      case 'bearer':
        headers['Authorization'] = `Bearer ${token}`;
        break;
      
      case 'custom-header':
        if (authConfig.header_name) {
          headers[authConfig.header_name] = token;
        }
        break;
      
      case 'query':
        if (authConfig.query_param) {
          url.searchParams.set(authConfig.query_param, token);
        }
        break;
    }

    try {
      this.logger.debug('Validating auth token', {
        endpoint: urlString,
        method,
        authType: authConfig.type,
      });

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      const response = await fetch(url.toString(), {
        method,
        headers,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      const isValid = response.status >= 200 && response.status < 300;
      
      this.logger.debug('Auth token validation result', {
        status: response.status,
        isValid,
      });

      return isValid;
    } catch (error) {
      this.logger.warn(`Auth token validation failed: ${(error as Error).message}`, {
        endpoint: authConfig.validation_endpoint,
      });
      return false;
    }
  }

  /**
   * Validate token format and length
   * 
   * Why centralized: Single source of truth for token validation rules
   * 
   * Relaxed validation: Allow common API token characters including colons,
   * to support various token formats (GitLab glpat-, YouTrack perm:, etc.)
   */
  private validateToken(token: string, source: string): void {
    const maxLength = this.config.maxTokenLength ?? DEFAULT_MAX_TOKEN_LENGTH;
    if (token.length > maxLength) {
      throw new ValidationError(`${source} too long (max ${maxLength} characters)`);
    }
    if (token.length === 0) {
      throw new ValidationError(`${source} is empty`);
    }
    // RFC 6750 Bearer token characters + common API token chars (including colons for YouTrack)
    // Allow: alphanumeric, dash, underscore, dot, tilde, plus, slash, equals, colon
    // Note: dash at end of character class to avoid being interpreted as range
    if (!/^[A-Za-z0-9._~+/:=-]+$/.test(token)) {
      throw new ValidationError(`Invalid ${source} format`);
    }
  }

  /**
   * Extract and validate auth token from request headers
   * 
   * Supports:
   * - Authorization: Bearer <token>
   * - X-API-Token: <token>
   * - OAuth session (via mcp-session-id header)
   * 
   * Why strict validation: Prevents header injection attacks
   * 
   * Returns: { type: 'bearer' | 'oauth' | 'api-token', token: string, sessionId?: string }
   */
  private extractAuthToken(req: McpRequest): { type: 'bearer' | 'oauth' | 'api-token' | 'none', token?: string, sessionId?: string } {
    // 1. Check for OAuth session first (highest priority for authenticated sessions)
    const sessionId = req.sessionId || req.headers['mcp-session-id'] as string | undefined;
    if (sessionId && this.sessions.has(sessionId)) {
      const session = this.sessions.get(sessionId);
      if (session && session.authToken) {
        return { type: 'oauth', token: session.authToken, sessionId };
      }
    }
    
    // 2. Check Authorization: Bearer header
    const authHeader = req.headers.authorization;
    if (authHeader) {
      // Defense against ReDoS: Check length before regex
      const maxHeaderLength = (this.config.maxTokenLength ?? DEFAULT_MAX_TOKEN_LENGTH) + 10; // Bearer + spaces + margin
      if (authHeader.length > maxHeaderLength) {
        throw new ValidationError(`Authorization header too long (max ${maxHeaderLength} characters)`);
      }
      
      // Relaxed Bearer token format validation - allow flexible whitespace
      // Trim whitespace to handle client variations (IntelliJ, VSCode, etc.)
      const trimmed = authHeader.trim();
      const match = trimmed.match(/^Bearer\s+(.+)$/);
      if (!match) {
        throw new ValidationError('Invalid Authorization header format. Expected: Bearer <token>');
      }
      const token = match[1].trim();
      this.validateToken(token, 'Authorization token');
      return { type: 'bearer', token };
    }
    
    // 3. Check X-API-Token header (for custom implementations)
    const apiTokenHeader = req.headers['x-api-token'];
    if (apiTokenHeader) {
      if (typeof apiTokenHeader !== 'string') {
        throw new ValidationError('X-API-Token must be a string');
      }
      this.validateToken(apiTokenHeader, 'X-API-Token');
      return { type: 'api-token', token: apiTokenHeader };
    }
    
    return { type: 'none' };
  }

  /**
   * Handle POST requests - Client sending messages to server
   * 
   * MCP Spec: POST can contain requests, notifications, or responses
   */
  private async handlePost(req: McpRequest, res: Response): Promise<void> {
    const startTime = Date.now();
    try {
      this.logger.debug('handlePost called', { method: req.method, path: req.path, sessionId: req.sessionId, accept: req.headers.accept });
      const sessionId = req.sessionId;
      const body = req.body;
      const filteringHeader = normalizeFilteringHeaderValue(this.getFilteringHeaderValue(req));
      const parsedFiltering = filteringHeader ? parseFilteringHeader(filteringHeader) : undefined;

      const toolFilteringHeader = normalizeFilteringHeaderValue(this.getToolFilteringHeaderValue(req));
      const parsedToolFilter = toolFilteringHeader ? this.parseToolFilteringHeader(toolFilteringHeader) : undefined;

      // Validate Accept header per MCP Streamable HTTP specification
      const accept = req.headers.accept || '';

      // POST requests can return either JSON or SSE, so must accept both if specified
      // GET requests return SSE, so must accept text/event-stream
      const acceptsJson = accept.includes(MIME_TYPES.JSON) || accept === '*/*' || accept === '';
      const acceptsEventStream = accept.includes(MIME_TYPES.EVENT_STREAM) || accept === '*/*' || accept === '';

      if (req.method === 'GET' && accept && !acceptsEventStream) {
        this.logger.debug('Accept header validation failed for GET, returning 406');
        res.status(HTTP_STATUS.NOT_ACCEPTABLE).json({
          error: 'Not Acceptable',
          message: `GET requests must accept ${MIME_TYPES.EVENT_STREAM}`
        });
        return;
      }

      // For POST, be more flexible - allow if client accepts either JSON or SSE
      if (req.method === 'POST' && accept && !acceptsJson && !acceptsEventStream) {
        this.logger.debug('Accept header validation failed for POST, returning 406');
        res.status(HTTP_STATUS.NOT_ACCEPTABLE).json({
          error: 'Not Acceptable',
          message: `POST requests must accept ${MIME_TYPES.JSON} or ${MIME_TYPES.EVENT_STREAM}`
        });
        return;
      }

      // Check if this is initialization (no session ID yet)
      const isInitialization = isInitializeRequest(body);
      this.logger.debug('Session validation', { isInitialization, sessionId, bodyMethod: (body as any)?.method });

      // Validate session (except for initialization)
      if (!isInitialization && sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session) {
          res.status(HTTP_STATUS.NOT_FOUND).json({ error: 'Not Found', message: 'Session not found or expired' });
          return;
        }
        if (filteringHeader !== undefined) {
          if (!session.filteringHeader || session.filteringHeader !== filteringHeader) {
            throw new ValidationError('X-Mcp4-Filtering header mismatch for existing session.');
          }
        }

        // Immutability check for X-Mcp4-Tools header
        if (toolFilteringHeader !== undefined) {
          if (!session.toolFilter || session.toolFilter.originalHeader !== toolFilteringHeader) {
             // If session has no filter but request has one -> mismatch
             // If session has filter but request has different one -> mismatch
             // If session has filter and request has same one -> OK
             if (!session.toolFilter && toolFilteringHeader) {
                throw new ValidationError('X-Mcp4-Tools header mismatch for existing session. Session has no filter, request has one.');
             }
             if (session.toolFilter && session.toolFilter.originalHeader !== toolFilteringHeader) {
                throw new ValidationError('X-Mcp4-Tools header mismatch for existing session.');
             }
          }
        } else if (session.toolFilter) {
           // Request has no header but session has filter -> allowed (header not required on subsequent requests)
        }

        this.updateSessionActivity(sessionId);
      } else if (!isInitialization && !sessionId) {
        this.logger.debug('Session validation failed: non-init request without sessionId');
        res.status(HTTP_STATUS.BAD_REQUEST).json({ error: 'Bad Request', message: 'Mcp-Session-Id header required (except for initialization)' });
        return;
      }

      // Determine message type
      const messageType = this.getMessageType(body);
      this.logger.debug('Message type determined', { messageType, hasMessageHandler: !!this.messageHandler });

      // If only notifications/responses, return 202 Accepted
      if (messageType === 'notification-only' || messageType === 'response-only') {
        if (this.messageHandler) {
          await this.messageHandler(body);
        }
        res.status(HTTP_STATUS.ACCEPTED).send();
        return;
      }

      // If contains requests, process and return response
      if (messageType === 'request') {
        if (!this.messageHandler) {
          res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ error: 'Internal Server Error', message: 'Message handler not configured' });
          return;
        }

        // Create session on initialization
        let newSessionId: string | undefined;
        if (isInitialization) {
          // Extract and validate auth token from headers
          const authInfo = this.extractAuthToken(req);
          this.logger.debug('Auth token extracted', { authType: authInfo?.type, hasToken: !!authInfo?.token });

          // If OAuth is configured, require authentication for initialization
          // This ensures clients like Cursor properly handle OAuth flow
          if (this.oauthProvider && !authInfo.token) {
            this.logger.debug('OAuth configured but no token provided, triggering OAuth flow');
            const resourceMetadataUrl = new URL(OAUTH_PATHS.WELL_KNOWN_PROTECTED_RESOURCE, this.getServerUrl()).href;
            res.setHeader('WWW-Authenticate', `Bearer resource_metadata="${resourceMetadataUrl}", scope="${this.oauthProvider.scopes.join(' ')}"`);
            res.status(HTTP_STATUS.UNAUTHORIZED).json({
              error: 'Unauthorized',
              message: 'Authentication required for OAuth'
            });
            return;
          }

          // Allow initialization without token for non-OAuth scenarios
          
          // Validate token if auth is configured and token is provided
          if (authInfo && authInfo.token && this.config.authConfigs && this.config.baseUrl) {
            // Find matching auth config based on priority (authConfigs is sorted)
            // For 'bearer' token type, 'oauth' config is also a match
            const authConfig = this.config.authConfigs.find(c => 
                c.type === authInfo.type || 
                (authInfo.type === 'bearer' && c.type === 'oauth')
            );
            
            if (authConfig && authConfig.validation_endpoint) {
              this.logger.info('Validating auth token during initialization', {
                authType: authConfig.type, // Use config type for logging
                endpoint: authConfig.validation_endpoint,
              });
              
              const isValid = await this.validateAuthToken(authConfig, authInfo.token, this.config.baseUrl);
              
              if (!isValid) {
                this.logger.warn('Auth token validation failed during initialization', {
                  authType: authInfo.type,
                });
                res.status(HTTP_STATUS.UNAUTHORIZED).json({
                  error: 'Unauthorized',
                  message: 'Invalid or expired authentication token'
                });
                return;
              }
              
              this.logger.info('Auth token validation successful');
            }
          }
          
          // Look up OAuth tokens if this is an OAuth token
          let refreshToken: string | undefined;
          let accessTokenExpiresAt: number | undefined;
          let scopes: string[] | undefined;
          let oauthClientId: string | undefined;
          
          if (authInfo.token && (authInfo.type === 'oauth' || authInfo.type === 'bearer')) {
            const tokenData = this.oauthTokensByAccessToken.get(authInfo.token);
            if (tokenData) {
              refreshToken = tokenData.refreshToken;
              accessTokenExpiresAt = tokenData.expiresAt;
              scopes = tokenData.scopes;
              oauthClientId = tokenData.clientId;
              this.logger.debug('Found OAuth token data for session', {
                hasRefreshToken: !!refreshToken,
                hasExpiration: !!accessTokenExpiresAt,
                scopesCount: scopes.length,
              });
            } else {
              this.logger.debug('No OAuth token data found in map (may be non-OAuth bearer token)', {
                hasToken: true,
              });
            }
          }
          
          newSessionId = this.createSession(
            authInfo.token,
            refreshToken,
            accessTokenExpiresAt,
            scopes,
            oauthClientId,
            parsedFiltering?.filtering,
            parsedFiltering?.normalizedHeader,
            parsedToolFilter
          );
        }

        this.logger.debug('Calling messageHandler', { body, sessionId: isInitialization ? newSessionId : sessionId });
        const response = await this.messageHandler(body, isInitialization ? newSessionId : sessionId);
        this.logger.debug('MessageHandler response', { response });

        // Debug: Check OAuth conditions
        this.logger.debug('Checking OAuth conditions', {
          responseError: (response as any).error,
          hasOAuthProvider: !!this.oauthProvider,
          oauthProviderType: typeof this.oauthProvider
        });


        // Check if response contains OAuth error and add WWW-Authenticate header
        const responseObj = response as any;
        if (responseObj.error && responseObj.error.data && responseObj.error.data.oauth_required) {
          const resourceMetadataUrl = new URL(OAUTH_PATHS.WELL_KNOWN_PROTECTED_RESOURCE, this.getServerUrl()).href;
          res.setHeader('WWW-Authenticate', `Bearer resource_metadata="${resourceMetadataUrl}", scope="api"`);
          res.status(HTTP_STATUS.UNAUTHORIZED); // Set 401 status for OAuth errors
        }

        // Decide response format based on Accept header
        const accept = req.headers.accept || '';
        const wantsOnlySSE = accept.trim() === MIME_TYPES.EVENT_STREAM;

        if (wantsOnlySSE) {
          // Return SSE response only when client explicitly wants text/event-stream only
          this.logger.debug('Sending SSE response', { response, newSessionId });
          this.startSSEResponse(res, response, newSessionId, sessionId);
        } else {
          // Return JSON response (default for requests)
          if (newSessionId) {
            res.setHeader('Mcp-Session-Id', newSessionId);
          }
          this.logger.debug('Sending JSON response', { response, newSessionId });
          res.json(response);
        }
        return;
      }

      res.status(HTTP_STATUS.BAD_REQUEST).json({ error: 'Bad Request', message: 'Invalid message type' });
    } catch (error) {
      const correlationId = generateCorrelationId();
      this.logger.error('POST request error', error as Error, { correlationId });

      let status = 500;
      let errorLabel = 'Internal Server Error';
      let message = `Internal error (correlation ID: ${correlationId})`;

      if (error instanceof ValidationError) {
        status = HTTP_STATUS.BAD_REQUEST;
        errorLabel = 'Bad Request';
        message = `Validation error: ${error.message} (correlation ID: ${correlationId})`;
      } else if (error instanceof AuthenticationError) {
        status = HTTP_STATUS.UNAUTHORIZED;
        errorLabel = 'Unauthorized';
        message = `Authentication failed: ${error.message} (correlation ID: ${correlationId})`;
      } else if (error instanceof AuthorizationError) {
        status = HTTP_STATUS.FORBIDDEN;
        errorLabel = 'Forbidden';
        message = `Authorization failed: ${error.message} (correlation ID: ${correlationId})`;
      } else if (error instanceof RateLimitError) {
        status = HTTP_STATUS.TOO_MANY_REQUESTS;
        errorLabel = 'Too Many Requests';
        message = `Rate limit exceeded: ${error.message} (correlation ID: ${correlationId})`;
      }

      res.status(status).json({ error: errorLabel, message, correlationId });
      
      // Record error metrics
      if (this.metrics) {
        const duration = (Date.now() - startTime) / 1000;
        this.metrics.recordHttpRequest(req.method, req.path, status, duration);
      }
    } finally {
      // Record success metrics (if not already recorded in catch)
      if (this.metrics && res.statusCode !== 500) {
        const duration = (Date.now() - startTime) / 1000;
        this.metrics.recordHttpRequest(req.method, req.path, res.statusCode, duration);
      }
    }
  }

  /**
   * Handle GET requests - Client opening SSE stream for server messages
   * 
   * MCP Spec: GET opens SSE stream for server-initiated requests/notifications
   */
  private async handleGet(req: McpRequest, res: Response): Promise<void> {
    const startTime = Date.now();
    try {
      const sessionId = req.sessionId;
      const lastEventId = req.headers['last-event-id'] as string | undefined;

      // Validate Accept header
      const accept = req.headers.accept || '';
      if (!accept.includes(MIME_TYPES.EVENT_STREAM)) {
        res.status(HTTP_STATUS.METHOD_NOT_ALLOWED).json({ error: 'Method Not Allowed', message: `Must accept ${MIME_TYPES.EVENT_STREAM}` });
        return;
      }

      // Validate session
      if (!sessionId) {
        res.status(HTTP_STATUS.BAD_REQUEST).json({ error: 'Bad Request', message: 'Mcp-Session-Id header required' });
        return;
      }

      const session = this.sessions.get(sessionId);
      if (!session) {
        res.status(HTTP_STATUS.NOT_FOUND).json({ error: 'Not Found', message: 'Session not found or expired' });
        return;
      }

      this.updateSessionActivity(sessionId);

      // Start SSE stream
      this.startSSEStream(res, sessionId, lastEventId);
      
      // Record metrics for successful SSE start
      if (this.metrics) {
        const duration = (Date.now() - startTime) / 1000;
        this.metrics.recordHttpRequest(req.method, req.path, 200, duration);
      }
    } catch (error) {
      this.logger.error('GET request error', error as Error);
      const status = 500;
      if (!res.headersSent) {
        res.status(status).json({ error: 'Internal Server Error', message: (error as Error).message });
      }
      
      // Record error metrics
      if (this.metrics) {
        const duration = (Date.now() - startTime) / 1000;
        this.metrics.recordHttpRequest(req.method, req.path, status, duration);
      }
    }
  }

  /**
   * Handle DELETE requests - Client terminating session
   * 
   * MCP Spec: DELETE explicitly terminates session
   */
  private handleDelete(req: McpRequest, res: Response): void {
    const startTime = Date.now();
    const sessionId = req.sessionId;

    if (!sessionId) {
      const status = 400;
      res.status(status).json({ error: 'Bad Request', message: 'Mcp-Session-Id header required' });
      if (this.metrics) {
        const duration = (Date.now() - startTime) / 1000;
        this.metrics.recordHttpRequest(req.method, req.path, status, duration);
      }
      return;
    }

    const session = this.sessions.get(sessionId);
    if (!session) {
      const status = 404;
      res.status(status).json({ error: 'Not Found', message: 'Session not found' });
      if (this.metrics) {
        const duration = (Date.now() - startTime) / 1000;
        this.metrics.recordHttpRequest(req.method, req.path, status, duration);
      }
      return;
    }

    this.destroySession(sessionId);
    const status = 204;
    res.status(status).send();
    
    if (this.metrics) {
      const duration = (Date.now() - startTime) / 1000;
      this.metrics.recordHttpRequest(req.method, req.path, status, duration);
    }
  }

  /**
   * Start SSE response for a POST request
   * 
   * Why: Returns response via SSE stream, allows server-initiated messages
   */
  private startSSEResponse(
    res: Response,
    response: unknown,
    newSessionId: string | undefined,
    sessionId: string | undefined
  ): void {
    res.setHeader('Content-Type', MIME_TYPES.EVENT_STREAM);
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    if (newSessionId) {
      res.setHeader('Mcp-Session-Id', newSessionId);
    }

    // Send response
    const eventId = Date.now();
    res.write(`id: ${eventId}\n`);
    res.write(`data: ${JSON.stringify(response)}\n\n`);

    // Close stream
    res.end();
  }

  /**
   * Start SSE stream for GET request
   * 
   * Why: Allows server to send requests/notifications to client
   */
  private startSSEStream(res: Response, sessionId: string, lastEventId?: string): void {
    res.setHeader('Content-Type', MIME_TYPES.EVENT_STREAM);
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const streamId = crypto.randomBytes(16).toString('hex');
    const session = this.sessions.get(sessionId)!;

    const streamState: SSEStreamState = {
      streamId,
      lastEventId: lastEventId ? parseInt(lastEventId, 10) : 0,
      messageQueue: [],
      active: true,
      response: res,
    };

    session.sseStreams.set(streamId, streamState);

    // Replay missed messages if resuming
    if (lastEventId) {
      this.replayMessages(res, streamState);
    }

    // Setup heartbeat if enabled
    let heartbeatInterval: NodeJS.Timeout | null = null;
    if (this.config.heartbeatEnabled) {
      heartbeatInterval = setInterval(() => {
        if (streamState.active) {
          res.write(':ping\n\n');
        }
      }, this.config.heartbeatIntervalMs);
    }

    // Handle client disconnect
    res.on('close', () => {
      streamState.active = false;
      if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
      }
      this.logger.info('SSE stream closed', { sessionId, streamId });
    });

    this.logger.info('SSE stream opened', { sessionId, streamId, resuming: !!lastEventId });
  }

  /**
   * Replay messages after Last-Event-ID
   * 
   * Why: Resumability - client can reconnect and receive missed messages
   */
  private replayMessages(res: Response, streamState: SSEStreamState): void {
    const missedMessages = streamState.messageQueue.filter(
      msg => msg.eventId > streamState.lastEventId
    );

    for (const msg of missedMessages) {
      res.write(`id: ${msg.eventId}\n`);
      res.write(`data: ${JSON.stringify(msg.data)}\n\n`);
    }

    this.logger.info('Replayed messages', { count: missedMessages.length, streamId: streamState.streamId });
  }

  /**
   * Send message to client via SSE
   * 
   * Why: Server-initiated requests/notifications
   */
  public sendToClient(sessionId: string, message: unknown): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      this.logger.warn('Cannot send to client: session not found', { sessionId });
      return;
    }

    const eventId = Date.now();
    const queuedMessage: QueuedMessage = {
      eventId,
      data: message,
      timestamp: Date.now(),
    };

    // Send to all active streams for this session
    for (const [streamId, streamState] of session.sseStreams) {
      if (streamState.active) {
        // Queue for resumability
        streamState.messageQueue.push(queuedMessage);
        
        // Keep only last 100 messages
        if (streamState.messageQueue.length > 100) {
          streamState.messageQueue.shift();
        }
      }
    }
  }


  /**
   * Determine message type (request, notification, response)
   */
  private getMessageType(body: unknown): 'request' | 'notification-only' | 'response-only' | 'mixed' | 'unknown' {
    if (Array.isArray(body)) {
      // Batch
      const hasRequest = body.some((msg: unknown) => typeof msg === 'object' && msg !== null && 'method' in msg && 'id' in msg);
      const hasNotification = body.some((msg: unknown) => typeof msg === 'object' && msg !== null && 'method' in msg && !('id' in msg));
      const hasResponse = body.some((msg: unknown) => typeof msg === 'object' && msg !== null && ('result' in msg || 'error' in msg));

      if (hasRequest) return 'request';
      if (hasNotification && !hasResponse) return 'notification-only';
      if (hasResponse && !hasNotification) return 'response-only';
      return 'mixed';
    } else if (typeof body === 'object' && body !== null) {
      const msg = body as Record<string, unknown>;
      if ('method' in msg) {
        return 'id' in msg ? 'request' : 'notification-only';
      }
      if ('result' in msg || 'error' in msg) {
        return 'response-only';
      }
    }
    return 'unknown';
  }

  private getFilteringHeaderValue(req: Request): string | undefined {
    const headerValue = req.headers['x-mcp4-filtering'];
    if (Array.isArray(headerValue)) {
      if (headerValue.length === 0) {
        return undefined;
      }
      if (headerValue.length > 1) {
        throw new ValidationError('Invalid X-Mcp4-Filtering header. Expected comma-separated key=value pairs.');
      }
      return headerValue[0];
    }
    return headerValue;
  }

  private getToolFilteringHeaderValue(req: Request): string | undefined {
    const headerValue = req.headers['x-mcp4-tools'];
    if (Array.isArray(headerValue)) {
      if (headerValue.length === 0) {
        return undefined;
      }
      if (headerValue.length > 1) {
        throw new ValidationError('Invalid X-Mcp4-Tools header. Expected single comma-separated list.');
      }
      return headerValue[0];
    }
    return headerValue;
  }

  private parseToolFilteringHeader(headerValue: string): { allowedToolNames: Set<string>; patterns: { allow: RegExp[]; deny: RegExp[] }; originalHeader: string } {
    const maxTools = parseInt(process.env.MCP4_TOOL_FILTER_SESSION_MAX_TOOLS || '100', 10);
    const parts = headerValue.split(',').map(s => s.trim()).filter(s => s.length > 0);

    if (parts.length > maxTools) {
      throw new ValidationError(`X-Mcp4-Tools contains too many entries (${parts.length} > ${maxTools}). Reduce to ${maxTools} or configure MCP4_TOOL_FILTER_SESSION_MAX_TOOLS.`);
    }

    const allowedToolNames = new Set<string>();
    const patterns = { allow: [] as RegExp[], deny: [] as RegExp[] };

    for (const part of parts) {
      if (part.length > 255) {
        throw new ValidationError(`X-Mcp4-Tools entry exceeds 255 chars: '${part.substring(0, 20)}...'`);
      }

      if (part.startsWith('regex:')) {
        const patternStr = part.substring(6);
        const validation = validateRegexPattern(patternStr);
        if (!validation.valid) {
          throw new ValidationError(`Invalid regex in X-Mcp4-Tools: '${patternStr}'. ${validation.error}`);
        }

        let finalPattern = patternStr;
        if (!finalPattern.startsWith('^')) finalPattern = '^' + finalPattern;
        if (!finalPattern.endsWith('$')) finalPattern = finalPattern + '$';

        try {
          patterns.allow.push(new RegExp(finalPattern));
        } catch (e) {
          throw new ValidationError(`Failed to compile regex '${finalPattern}': ${(e as Error).message}`);
        }
      } else {
        allowedToolNames.add(part);
      }
    }

    // Check if filter has no effect (empty) - though here empty means "nothing allowed" if strict,
    // or "everything allowed" if not present. The caller handles "not present".
    // If present but empty, it means allow nothing.

    return { allowedToolNames, patterns, originalHeader: headerValue };
  }

  /**
   * Create new session
   *
   * Why: Stateful sessions for MCP protocol
   */
  private createSession(
    authToken?: string,
    refreshToken?: string,
    accessTokenExpiresAt?: number,
    scopes?: string[],
    oauthClientId?: string,
    filtering?: Record<string, string[]>,
    filteringHeader?: string,
    toolFilter?: SessionData['toolFilter']
  ): string {
    // Validate token if provided (defense in depth)
    if (authToken) {
      this.validateToken(authToken, 'Session auth token');
    }
    
    const sessionId = crypto.randomUUID();
    const session: SessionData = {
      id: sessionId,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      sseStreams: new Map(),
      authToken,
      refreshToken,
      accessTokenExpiresAt,
      scopes,
      oauthClientId,
      filtering,
      filteringHeader,
      toolFilter,
    };
    this.sessions.set(sessionId, session);
    this.logger.info('Session created', { 
      sessionId, 
      hasAuthToken: !!authToken,
      hasRefreshToken: !!refreshToken,
      hasExpiration: !!accessTokenExpiresAt,
    });

    // Record metrics
    if (this.metrics) {
      this.metrics.recordSessionCreated();
      // Record session tool count if filter is present (or full count if we had it, but we don't have tool list here easily)
      // Actually, mcpToolsSession is a Gauge. We can only set it if we know the count.
      // With filtering, the count is dynamic.
      // But we only know the 'allowedToolNames' size if filter exists.
      // If no filter, it's all tools (unknown count here).
      // We'll only record if we have a filter with explicit allow list.
      if (toolFilter?.allowedToolNames) {
         this.metrics.recordSessionToolCount(sessionId, toolFilter.allowedToolNames.size);
      }
    }

    return sessionId;
  }

  /**
   * Update session activity timestamp
   */
  private updateSessionActivity(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastActivityAt = Date.now();
    }
  }

  /**
   * Destroy session and cleanup resources
   * 
   * Why: Free memory, close streams
   */
  private destroySession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      // Close all active SSE streams
      for (const [, streamState] of session.sseStreams) {
        streamState.active = false;
        // Close the HTTP response to terminate the SSE connection
        try {
          if (!streamState.response.headersSent || !streamState.response.writableEnded) {
            streamState.response.end();
          }
        } catch (error) {
          // Ignore errors if response is already closed
          this.logger.debug('Failed to close SSE response', { error: (error as Error).message });
        }
      }
      session.sseStreams.clear();
      
      // Clean up OAuth token from map if present
      if (session.authToken) {
        this.oauthTokensByAccessToken.delete(session.authToken);
      }
      
      this.sessions.delete(sessionId);
      this.logger.info('Session destroyed', { sessionId });
      
      // Notify session destruction listeners (for cleanup in MCPServer)
      this.notifySessionDestroyed(sessionId);
      
      // Record metrics
      if (this.metrics) {
        this.metrics.recordSessionDestroyed();
        this.metrics.removeSessionToolCount(sessionId);
      }
    }
  }

  /**
   * Session destruction listeners for cleanup in other components
   */
  private sessionDestroyedListeners: Array<(sessionId: string) => void> = [];

  /**
   * Register listener for session destruction events
   * 
   * Why: Allows MCPServer to cleanup per-session HTTP clients
   */
  public onSessionDestroyed(listener: (sessionId: string) => void): void {
    this.sessionDestroyedListeners.push(listener);
  }

  /**
   * Notify all listeners about session destruction
   */
  private notifySessionDestroyed(sessionId: string): void {
    for (const listener of this.sessionDestroyedListeners) {
      try {
        listener(sessionId);
      } catch (error) {
        this.logger.error('Session destroyed listener error', error as Error);
      }
    }
  }

  /**
   * Store OAuth tokens in internal map for later session initialization
   * 
   * Why: Bridge between /oauth/token endpoint (where we see OAuthTokens) 
   * and session initialization (where we only see access token in Authorization header)
   */
  private storeOAuthTokens(tokens: OAuthTokens, clientId: string, scopes: string[]): void {
    if (!tokens.access_token) {
      this.logger.warn('OAuth tokens missing access_token, skipping storage');
      return;
    }

    const expiresAt = tokens.expires_in 
      ? Date.now() + tokens.expires_in * 1000 
      : undefined;

    this.oauthTokensByAccessToken.set(tokens.access_token, {
      refreshToken: tokens.refresh_token,
      expiresAt,
      clientId,
      scopes,
    });

    this.logger.debug('Stored OAuth tokens', {
      hasRefreshToken: !!tokens.refresh_token,
      expiresAt,
      clientId,
      scopesCount: scopes.length,
    });
  }

  /**
   * Cleanup expired sessions
   * 
   * Why: Prevent memory leaks, enforce session timeout
   * 
   * OAuth sessions with refresh tokens have extended or unlimited timeout
   * to avoid forcing users to re-authenticate after periods of inactivity
   */
  private cleanupExpiredSessions(): void {
    const now = Date.now();
    const expiredSessions: string[] = [];
    
    // Default OAuth session timeout: 24 hours (or configurable)
    const oauthSessionTimeoutMs = this.config.oauthSessionTimeoutMs 
      ?? (24 * 60 * 60 * 1000); // 24 hours default

    for (const [sessionId, session] of this.sessions) {
      const age = now - session.lastActivityAt;
      
      // OAuth sessions with refresh tokens: use extended timeout or never expire
      if (session.refreshToken) {
        // If oauthSessionTimeoutMs is 0 or negative, never expire OAuth sessions
        if (oauthSessionTimeoutMs > 0 && age > oauthSessionTimeoutMs) {
          expiredSessions.push(sessionId);
        }
        // Otherwise, keep the session alive (unlimited timeout)
      } else {
        // Non-OAuth sessions: use standard timeout
        if (age > this.config.sessionTimeoutMs) {
          expiredSessions.push(sessionId);
        }
      }
    }

    for (const sessionId of expiredSessions) {
      this.destroySession(sessionId);
    }

    if (expiredSessions.length > 0) {
      this.logger.info('Cleaned up expired sessions', { count: expiredSessions.length });
    }
  }


  /**
   * Get auth token from session
   * 
   * Why public: Allows MCPServer to securely access session tokens without breaking encapsulation
   */
  public getSessionToken(sessionId: string): string | undefined {
    const session = this.sessions.get(sessionId);
    return session?.authToken;
  }

  public getSessionFiltering(sessionId: string): Record<string, string[]> | undefined {
    const session = this.sessions.get(sessionId);
    return session?.filtering;
  }

  public getSessionFilteringHeader(sessionId: string): string | undefined {
    const session = this.sessions.get(sessionId);
    return session?.filteringHeader;
  }

  public getSessionToolFilter(sessionId: string): SessionData['toolFilter'] | undefined {
    const session = this.sessions.get(sessionId);
    return session?.toolFilter;
  }

  /**
   * Get metrics collector (if enabled)
   */
  public getMetrics(): MetricsCollector | null {
    return this.metrics;
  }

  /**
   * Ensure session has a valid access token, refreshing if necessary
   * 
   * Why: Transparently refresh expired OAuth tokens before making API calls
   * Returns true if token is valid (or was successfully refreshed), false otherwise
   */
  public async ensureValidSessionToken(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return false;
    }

    // If no expiration info, assume token is valid (non-OAuth scenarios)
    if (!session.accessTokenExpiresAt) {
      return true;
    }

    const now = Date.now();
    const refreshThresholdMs = this.config.oauthRefreshThresholdMs ?? (60 * 1000); // Default: 60 seconds before expiration
    const timeUntilExpiration = session.accessTokenExpiresAt - now;

    // If token is expired or about to expire, refresh it
    if (timeUntilExpiration <= refreshThresholdMs) {
      this.logger.debug('Access token expired or expiring soon, refreshing', {
        sessionId,
        expiresAt: new Date(session.accessTokenExpiresAt).toISOString(),
        timeUntilExpiration,
      });
      return await this.refreshAccessToken(sessionId);
    }

    return true;
  }

  /**
   * Refresh access token using refresh token
   * 
   * Why: Automatically renew expired OAuth access tokens without user intervention
   * Returns true on success, false on failure
   */
  private async refreshAccessToken(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session || !session.refreshToken || !this.oauthProvider) {
      this.logger.warn('Cannot refresh token: missing session, refreshToken, or OAuth provider', {
        sessionId,
        hasSession: !!session,
        hasRefreshToken: !!session?.refreshToken,
        hasOAuthProvider: !!this.oauthProvider,
      });
      return false;
    }

    try {
      // Get client from OAuth provider
      // Try to find client by clientId stored in session, or use default client
      let client;
      if (session.oauthClientId) {
        await this.oauthProvider.ensureEndpointsInitialized();
        client = await this.oauthProvider.clientsStore.getClient(session.oauthClientId);
      }

      // Fallback to default client from config if session client not found
      if (!client && this.oauthProvider) {
        await this.oauthProvider.ensureEndpointsInitialized();
        // Try common client IDs
        const defaultClientIds = ['mcp-proxy-client'];
        if (this.config.oauthConfig?.client_id) {
          defaultClientIds.unshift(this.config.oauthConfig.client_id);
        }
        
        for (const clientId of defaultClientIds) {
          client = await this.oauthProvider.clientsStore.getClient(clientId);
          if (client) break;
        }
      }

      if (!client) {
        this.logger.error('Cannot refresh token: OAuth client not found', undefined, {
          sessionId,
          oauthClientId: session.oauthClientId,
        });
        return false;
      }

      // Exchange refresh token for new tokens
      const tokens = await this.oauthProvider.exchangeRefreshToken(
        client,
        session.refreshToken,
        session.scopes
      );

      // Update session with new tokens
      const oldAccessToken = session.authToken;
      session.authToken = tokens.access_token;
      session.refreshToken = tokens.refresh_token || session.refreshToken; // Keep old refresh token if new one not provided
      session.accessTokenExpiresAt = tokens.expires_in 
        ? Date.now() + tokens.expires_in * 1000 
        : undefined;

      // Update token map: remove old token, add new one
      if (oldAccessToken) {
        this.oauthTokensByAccessToken.delete(oldAccessToken);
      }
      this.storeOAuthTokens(tokens, client.client_id, session.scopes || []);

      this.logger.info('Access token refreshed successfully', {
        sessionId,
        newExpiresAt: session.accessTokenExpiresAt ? new Date(session.accessTokenExpiresAt).toISOString() : undefined,
      });

      return true;
    } catch (error) {
      this.logger.error('Token refresh failed', error instanceof Error ? error : new Error(String(error)), {
        sessionId,
      });
      return false;
    }
  }

  /**
   * Set message handler for processing incoming JSON-RPC messages
   */
  public setMessageHandler(handler: (message: unknown, sessionId?: string) => Promise<unknown>): void {
    this.messageHandler = handler;
  }

  /**
   * Check if OAuth provider is configured
   */
  public hasOAuthProvider(): boolean {
    return this.oauthProvider !== null;
  }

  /**
   * Get server URL
   */
  public getServerUrl(): string {
    // Prefer base URL derived from OAuth redirect URI if available
    // This ensures consistency with the public address used for OAuth callbacks
    if (this.oauthProvider?.redirectUri) {
        try {
            return new URL(this.oauthProvider.redirectUri).origin;
        } catch (e) {
            // Ignore invalid URL format
        }
    }

    // Fallback to configured host/port
    // If configured with 0.0.0.0, this will return http://0.0.0.0:port
    // which is usually fine for internal communication but not for external clients
    const protocol = this.config.host.includes('://') ? '' : 'http://';
    const host = this.config.host.includes('://') ? this.config.host : this.config.host;
    return `${protocol}${host}:${this.config.port}`;
  }

  /**
   * Get OAuth authorization URL
   */
  public getOAuthAuthorizationUrl(): string {
    return this.oauthProvider?.authorizationEndpoint || '';
  }

  /**
   * Get OAuth scopes
   */
  public getOAuthScopes(): string[] {
    return this.oauthProvider?.scopes || [];
  }

  /**
   * Start HTTP server
   */
  public async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        // Check for SSL configuration from environment variables
        const sslCertFile = process.env.MCP4_SSL_CERT_FILE;
        const sslKeyFile = process.env.MCP4_SSL_KEY_FILE;
        
        if (sslCertFile && sslKeyFile) {
          // Start HTTPS server
          this.logger.info('SSL configuration detected, starting HTTPS server', {
            certFile: sslCertFile,
            keyFile: sslKeyFile,
          });
          
          try {
            const httpsOptions = {
              cert: fs.readFileSync(sslCertFile),
              key: fs.readFileSync(sslKeyFile),
            };
            
            this.server = https.createServer(httpsOptions, this.app);
            this.server.listen(this.config.port, this.config.host, () => {
              this.logger.info('HTTPS transport started', {
                host: this.config.host,
                port: this.config.port,
                heartbeat: this.config.heartbeatEnabled,
                metrics: this.config.metricsEnabled,
              });

              // Start session cleanup interval
              this.cleanupInterval = setInterval(
                () => this.cleanupExpiredSessions(),
                TIMEOUTS.CLEANUP_INTERVAL_MS
              );

              resolve();
            });
          } catch (sslError) {
            this.logger.error('Failed to start HTTPS server', sslError instanceof Error ? sslError : new Error(String(sslError)));
            reject(sslError);
            return;
          }
        } else {
          // Start HTTP server
          this.server = this.app.listen(this.config.port, this.config.host, () => {
            this.logger.info('HTTP transport started', {
              host: this.config.host,
              port: this.config.port,
              heartbeat: this.config.heartbeatEnabled,
              metrics: this.config.metricsEnabled,
            });

            // Start session cleanup interval
            this.cleanupInterval = setInterval(
              () => this.cleanupExpiredSessions(),
              TIMEOUTS.CLEANUP_INTERVAL_MS
            );

            resolve();
          });
        }

        this.server.on('error', reject);
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Stop HTTP server
   */
  public async stop(): Promise<void> {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    // Destroy all sessions
    for (const sessionId of this.sessions.keys()) {
      this.destroySession(sessionId);
    }

    if (this.server) {
      return new Promise((resolve, reject) => {
        this.server!.close((err) => {
          if (err) reject(err);
          else {
            this.logger.info('HTTP transport stopped');
            resolve();
          }
        });
      });
    }
  }
}
