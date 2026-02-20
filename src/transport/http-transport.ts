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
import type { Logger } from '../core/logger.js';
import type {
  SessionData,
  SSEStreamState,
  QueuedMessage,
  HttpTransportConfig,
  HttpProfileContext,
  McpRequest
} from '../types/http-transport.js';
import { isInitializeRequest } from '../validation/jsonrpc-validator.js';
import { MetricsCollector } from '../core/metrics.js';
import type { MetricsContextLabels } from '../core/metrics.js';
import { ExternalOAuthProvider } from '../auth/oauth-provider.js';
import { SSRFValidator } from '../security/ssrf-validator.js';
import type { AuthInterceptor, OAuthConfig } from '../types/profile.js';
import { HTTP_STATUS, MIME_TYPES, OAUTH_PATHS, TIMEOUTS, OAUTH_RATE_LIMIT, PROXY_CREDENTIALS } from '../core/constants.js';
import { escapeHtmlSafe, isSafePropertyName } from '../validation/validation-utils.js';
import type { OAuthClientInformationFull, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import {
  AuthenticationError,
  AuthorizationError,
  ConfigurationError,
  RateLimitError,
  ValidationError,
  generateCorrelationId,
} from '../core/errors.js';
import { parseFilteringHeader, normalizeFilteringHeaderValue } from '../core/filtering.js';
import {
  ToolFilterService,
  EnvConfigParser,
  HeaderConfigParser,
  RegexCompiler,
  RegexValidator,
  OperationClassifier,
  OpenAPIOperationResolver,
  OperationDetector,
  normalizeToolFilterHeaderValue,
  parseSessionToolFilterHeader,
} from '../tool-filter/index.js';
import type { SessionToolFilter, SessionToolFilterRequest } from '../types/http-transport.js';
import type { HttpTenantIndex, HttpTenantsConfig, ResolvedTenantContext } from '../types/http-tenants.js';
import { buildTenantIndexForProfile, loadRawTenantsConfigFromEnv, resolveTenantFromHeaders } from './http-tenant-config.js';
import type { ListedProfileDetails } from '../profile/profile-resolver.js';
import {
  buildProfileIndexPayload,
  loadProfileIndexTemplate,
  parseAcceptLanguage,
  renderProfileIndexHtml,
} from './profile-index.js';
import type { ProfileIndexSourceProfile, ProfileIndexTenantSummary } from './profile-index.js';
const DEFAULT_MAX_TOKEN_LENGTH = 1000;

interface ProfileRuntimeState {
  profileId: string;
  context: HttpProfileContext;
  oauthProvider: ExternalOAuthProvider | null;
  toolFilterService?: ToolFilterService;
  oauthTokensByAccessToken: Map<string, { refreshToken?: string; expiresAt?: number; clientId: string; scopes: string[] }>;
  sessions: Map<string, SessionData>;
  tenantIndex: HttpTenantIndex;
  tenantOAuthProvidersBySessionId: Map<string, ExternalOAuthProvider>;
}

interface RequestWithStartTime extends Request {
  startTime?: number;
}

interface OAuthRequiredErrorResponse {
  error?: {
    data?: {
      oauth_required?: boolean;
    };
  };
}

export class HttpTransport {
  private app: express.Application;
  private server: Server | https.Server | null = null;
  private config: HttpTransportConfig;
  private logger: Logger;
  private metrics: MetricsCollector | null = null;
  private cleanupInterval: NodeJS.Timeout | null = null;
  private messageHandler: ((message: unknown, sessionId?: string, profileId?: string) => Promise<unknown>) | null = null;
  private profileContextProvider: ((profileId: string) => Promise<HttpProfileContext | null>) | null = null;
  private profileStates: Map<string, ProfileRuntimeState> = new Map();
  private oauthRedirectHostCache: Map<string, string[]> = new Map();
  private warnedMissingOAuthRedirectEnvVars: Set<string> = new Set();
  private profileHintsByClient: Map<string, { profileId: string; lastSeen: number }> = new Map();
  private static readonly PROFILE_HINT_TTL_MS = 10 * 60 * 1000;
  private profileIndexProvider: (() => Promise<ListedProfileDetails[]>) | null = null;
  private ssrfValidator: SSRFValidator;
  private rawTenantConfig: HttpTenantsConfig | null;

  constructor(config: HttpTransportConfig, logger: Logger) {
    // Freeze config to prevent runtime mutation of security-critical settings (allowedOrigins, rate limits, etc.)
    this.config = Object.freeze({ ...config });
    this.logger = logger;
    this.ssrfValidator = new SSRFValidator(logger);
    this.rawTenantConfig = loadRawTenantsConfigFromEnv();
    
    // Initialize metrics if enabled
    if (config.metricsEnabled) {
      this.metrics = new MetricsCollector({
        enabled: true,
        prefix: 'mcp_',
      });
    }
    
    this.app = express();
    if (this.config.trustProxy !== undefined) {
      this.app.set('trust proxy', this.config.trustProxy);
    }
    this.setupMiddleware();
    this.setupRoutes();
  }

  getMetricsCollector(): MetricsCollector | null {
    return this.metrics;
  }

  setProfileIndexProvider(provider: (() => Promise<ListedProfileDetails[]>) | null): void {
    this.profileIndexProvider = provider;
  }

  /**
   * Setup Express middleware
   * 
   * Why: Security (Origin validation, rate limiting), JSON parsing, session extraction, metrics
   */
  private setupMiddleware(): void {
    // Security: standard headers
    this.app.disable('x-powered-by');
    this.app.use((req: Request, res: Response, next: NextFunction) => {
      res.setHeader('Content-Security-Policy', "default-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'self'");
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=()');

      // Additional security headers
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
      res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
      res.setHeader('X-DNS-Prefetch-Control', 'off');

      next();
    });

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
    // Limit set to 10MB to support large tool inputs/results (e.g. file content)
    // while preventing massive DoS attacks. Default is 100kb.
    this.app.use(express.json({ limit: '10mb' }));

    // Metrics: Track request start time
    this.app.use((req: Request, res: Response, next: NextFunction) => {
      (req as RequestWithStartTime).startTime = Date.now();

      // Log response
      const originalSend = res.send;
      const originalJson = res.json;
      const logger = this.logger;

      res.send = function(body: unknown) {
        logger.debug('Outgoing response', {
          method: req.method,
          url: req.url,
          status: res.statusCode,
          contentType: res.get('content-type'),
          bodyLength: typeof body === 'string'
            ? body.length
            : Buffer.isBuffer(body)
              ? body.length
              : 0,
          bodyPreview: typeof body === 'string' ? body.substring(0, 200) : '[object]'
        });
        return originalSend.call(this, body);
      };

      res.json = function(body: unknown) {
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

    // Capture profile hints for clients using profile routing
    this.app.use((req: Request, _res: Response, next: NextFunction) => {
      if (this.config.profileRoutingEnabled) {
        const profileId = this.resolveProfileIdFromPath(req.path);
        if (profileId) {
          this.storeProfileHint(req, profileId);
        }
      }
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

      // Validate Origin header
      // We do not skip this check for localhost, as requests to localhost can still be CSRF targets
      if (!origin) {
        next();
        return;
      }

      this.isAllowedOriginForRequest(origin, req)
        .then((allowed) => {
          if (!allowed) {
            this.logger.warn('Rejected request from disallowed origin', { origin, ip: req.ip });
            res.status(HTTP_STATUS.FORBIDDEN).json({
              error: 'Forbidden',
              message: 'Origin not allowed'
            });
            return;
          }

          // nosemgrep: javascript.express.security.cors-misconfiguration.cors-misconfiguration
          res.setHeader('Access-Control-Allow-Origin', origin);
          res.setHeader('Vary', 'Origin');
          res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');

          next();
        })
        .catch((error) => {
          this.logger.error('Origin validation failed', error instanceof Error ? error : new Error(String(error)));
          res.status(HTTP_STATUS.FORBIDDEN).json({
            error: 'Forbidden',
            message: 'Origin not allowed'
          });
        });
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

  public setProfileContextProvider(
    provider: (profileId: string) => Promise<HttpProfileContext | null>
  ): void {
    this.profileContextProvider = provider;
  }

  private getDefaultProfileId(): string | undefined {
    if (this.config.defaultProfileId) {
      return this.config.defaultProfileId;
    }
    if (this.config.profileRoutingEnabled) {
      return undefined;
    }
    return 'default';
  }

  private buildDefaultProfileContext(): HttpProfileContext | null {
    const profileId = this.getDefaultProfileId();
    if (!profileId) {
      return null;
    }

    return {
      profileId,
      oauthConfig: this.config.oauthConfig,
      authConfigs: this.config.authConfigs,
      baseUrl: this.config.baseUrl,
      rateLimitOAuthMax: this.config.rateLimitOAuthMax,
      rateLimitOAuthWindowMs: this.config.rateLimitOAuthWindowMs,
      resourceName: this.config.resourceName,
      resourceDocumentation: this.config.resourceDocumentation,
      parser: this.config.parser,
    };
  }

  private async getProfileState(profileId: string): Promise<ProfileRuntimeState | null> {
    const existing = this.profileStates.get(profileId);
    if (existing) {
      return existing;
    }

    let context: HttpProfileContext | null = null;
    if (this.profileContextProvider) {
      try {
        context = await this.profileContextProvider(profileId);
      } catch (error) {
        if (error instanceof ConfigurationError && error.message === 'Profile not found') {
          this.logger.warn('Profile not found during request', { profileId });
          return null;
        }
        throw error;
      }
    } else {
      const defaultContext = this.buildDefaultProfileContext();
      if (defaultContext?.profileId === profileId) {
        context = defaultContext;
      }
    }

    if (!context) {
      return null;
    }

    let oauthProvider: ExternalOAuthProvider | null = null;
    if (context.oauthConfig) {
      this.logger.info('Initializing OAuth provider with config', {
        profileId,
        hasClientId: !!context.oauthConfig.client_id,
      });
      oauthProvider = new ExternalOAuthProvider(context.oauthConfig, this.logger);
      this.logger.info('OAuth provider initialized', {
        profileId,
        endpoint: oauthProvider.authorizationEndpoint || '(to be derived from issuer)',
        hasIssuer: !!context.oauthConfig.issuer,
      });
    } else {
      this.logger.info('No OAuth config provided - OAuth provider not initialized', { profileId });
    }

    const tenantIndex = this.config.tenantIndex || buildTenantIndexForProfile(this.rawTenantConfig, context, this.logger);

    const state: ProfileRuntimeState = {
      profileId,
      context,
      oauthProvider,
      oauthTokensByAccessToken: new Map(),
      sessions: new Map(),
      tenantIndex,
      tenantOAuthProvidersBySessionId: new Map(),
    };

    if (tenantIndex.enabled) {
      this.logger.info('HTTP tenant configuration enabled', { profileId, tenantCount: tenantIndex.byTenantId.size });
    }

    this.profileStates.set(profileId, state);
    return state;
  }

  private getProfileIdForRequest(req: McpRequest): string | undefined {
    if (req.profileId) {
      return req.profileId;
    }
    return this.getDefaultProfileId();
  }

  private async getProfileStateForRequest(req: McpRequest): Promise<ProfileRuntimeState | null> {
    const profileId = this.getProfileIdForRequest(req);
    if (!profileId) {
      return null;
    }
    return await this.getProfileState(profileId);
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

      // Allow OAuth redirect URI hosts (initialized + cached + configured)
      for (const redirectHost of this.getOAuthRedirectHostPatterns()) {
        if (this.matchOrigin(hostname, redirectHost)) {
          return true;
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

  private getOAuthRedirectHostPatterns(): string[] {
    const hosts = new Set<string>();
    const defaultProfileId = this.getDefaultProfileId() ?? 'default';

    for (const state of this.profileStates.values()) {
      const redirectUri = state.oauthProvider?.redirectUri;
      if (!redirectUri) {
        continue;
      }
      try {
        const redirectUrl = new URL(redirectUri);
        hosts.add(redirectUrl.hostname);
      } catch {
        // Ignore invalid URL
      }
    }

    if (this.config.oauthConfig) {
      for (const pattern of this.extractRedirectHostPatterns(this.config.oauthConfig, defaultProfileId)) {
        hosts.add(pattern);
      }
    }

    for (const patterns of this.oauthRedirectHostCache.values()) {
      for (const pattern of patterns) {
        hosts.add(pattern);
      }
    }

    return Array.from(hosts);
  }

  private extractRedirectHostPatterns(oauthConfig: OAuthConfig | undefined, profileId: string): string[] {
    if (!oauthConfig?.redirect_uri) {
      return [];
    }

    const resolvedRedirectUri = this.resolveRedirectUriFromEnv(oauthConfig.redirect_uri, profileId);
    if (!resolvedRedirectUri) {
      return [];
    }

    try {
      const redirectUrl = new URL(resolvedRedirectUri);
      return [redirectUrl.hostname];
    } catch {
      return [];
    }
  }

  private resolveRedirectUriFromEnv(value: string, profileId: string): string | undefined {
    const match = value.match(/^\$\{env:([^}]+)\}$/);
    if (!match) {
      return value;
    }

    const envVar = match[1];
    const envValue = process.env[envVar];
    if (!envValue || envValue.trim().length === 0) {
      const warningKey = `${profileId}:${envVar}`;
      if (!this.warnedMissingOAuthRedirectEnvVars.has(warningKey)) {
        this.warnedMissingOAuthRedirectEnvVars.add(warningKey);
        this.logger.warn('OAuth redirect_uri environment variable is empty', {
          profileId,
          envVar,
        });
      }
      return undefined;
    }

    return envValue;
  }

  private resolveProfileIdFromPath(pathname: string): string | null {
    if (!this.config.profileRoutingEnabled) {
      return null;
    }

    const match = /^\/profile\/([^/]+)/.exec(pathname);
    if (!match) {
      return null;
    }

    try {
      return decodeURIComponent(match[1]);
    } catch {
      return null;
    }
  }

  private getClientHintKey(req: Request): string {
    const userAgent = req.get('user-agent') || '';
    return `${req.ip}|${userAgent}`;
  }

  private storeProfileHint(req: Request, profileId: string): void {
    const key = this.getClientHintKey(req);
    this.profileHintsByClient.set(key, { profileId, lastSeen: Date.now() });
  }

  private resolveProfileIdFromHint(req: Request): string | null {
    const key = this.getClientHintKey(req);
    const hint = this.profileHintsByClient.get(key);
    if (!hint) {
      return null;
    }
    if (Date.now() - hint.lastSeen > HttpTransport.PROFILE_HINT_TTL_MS) {
      this.profileHintsByClient.delete(key);
      return null;
    }
    return hint.profileId;
  }

  private resolveProfileIdForOriginCheck(req: Request): string | null {
    const pathProfileId = this.resolveProfileIdFromPath(req.path);
    if (pathProfileId) {
      return pathProfileId;
    }

    const resource = req.query?.resource;
    if (typeof resource === 'string') {
      const info = this.resolveProfileInfoFromResourceUrl(resource);
      if (info?.profileId) {
        return info.profileId;
      }
    }

    return this.getDefaultProfileId() ?? this.resolveProfileIdFromHint(req) ?? null;
  }

  private async primeOAuthRedirectHosts(profileId: string): Promise<void> {
    if (!this.profileContextProvider) {
      return;
    }

    if (this.oauthRedirectHostCache.has(profileId)) {
      return;
    }

    try {
      const context = await this.profileContextProvider(profileId);
      if (!context?.oauthConfig) {
        this.oauthRedirectHostCache.set(profileId, []);
        return;
      }
      const patterns = this.extractRedirectHostPatterns(context.oauthConfig, profileId);
      this.oauthRedirectHostCache.set(profileId, patterns);
    } catch (error) {
      if (error instanceof ConfigurationError && error.message === 'Profile not found') {
        return;
      }
      this.logger.warn('Failed to preload OAuth redirect hosts', {
        profileId,
        error: String(error),
      });
    }
  }

  private async isAllowedOriginForRequest(origin: string, req: Request): Promise<boolean> {
    if (this.isAllowedOrigin(origin)) {
      return true;
    }

    if (!this.config.profileRoutingEnabled) {
      return false;
    }

    const profileId = this.resolveProfileIdForOriginCheck(req);
    if (!profileId) {
      return false;
    }

    await this.primeOAuthRedirectHosts(profileId);
    return this.isAllowedOrigin(origin);
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

      /* c8 ignore start - defensive check for edge cases where isIP() passes but parsing fails
       * This should never happen in practice, but serves as a fail-safe */
      if (ipInt === null || rangeInt === null) {
        return false;
      }
      /* c8 ignore end */

      const mask = (0xFFFFFFFF << (32 - maskBits)) >>> 0;
      return (ipInt & mask) === (rangeInt & mask);
    }

    if (maskBits < 0 || maskBits > 128) {
      this.logger.warn('Invalid IPv6 CIDR mask bits', { cidr });
      return false;
    }

    const ipInt = this.ipv6ToBigInt(ip);
    const rangeInt = this.ipv6ToBigInt(range);

    /* c8 ignore start - defensive check for edge cases where isIP() passes but parsing fails
     * This should never happen in practice, but serves as a fail-safe */
    if (ipInt === null || rangeInt === null) {
      return false;
    }
    /* c8 ignore end */

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

    /* c8 ignore start - defensive check that should never trigger if logic above is correct */
    if (segments.length !== totalSegmentsNeeded) {
      return null;
    }
    /* c8 ignore end */

    if (ipv4Tail !== null) {
      const high = (ipv4Tail >>> 16) & 0xFFFF;
      const low = ipv4Tail & 0xFFFF;
      segments.push(high, low);
    }

    /* c8 ignore start - defensive check that should never trigger if logic above is correct */
    if (segments.length !== 8) {
      return null;
    }
    /* c8 ignore end */

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
        const rateInfo = (req as Request & {
          rateLimit?: {
            limit?: number;
            current?: number;
            remaining?: number;
            resetTime?: Date;
          };
        }).rateLimit;
        this.logger.warn(options.logMessage, {
          ip: req.ip,
          path: req.path,
          method: req.method,
          limit: rateInfo?.limit,
          current: rateInfo?.current,
          remaining: rateInfo?.remaining,
          resetMs: rateInfo?.resetTime instanceof Date
            ? Math.max(0, rateInfo.resetTime.getTime() - Date.now())
            : undefined,
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

  private getProfilePrefix(profileId?: string, options?: { forceProfilePrefix?: boolean }): string {
    if (!this.config.profileRoutingEnabled) {
      return '';
    }
    if (options?.forceProfilePrefix && profileId) {
      return `/profile/${encodeURIComponent(profileId)}`;
    }
    const defaultProfileId = this.getDefaultProfileId();
    if (!profileId || (defaultProfileId && profileId === defaultProfileId)) {
      return '';
    }
    return `/profile/${encodeURIComponent(profileId)}`;
  }

  private buildProfilePath(profileId: string | undefined, path: string, options?: { forceProfilePrefix?: boolean }): string {
    const prefix = this.getProfilePrefix(profileId, options);
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    return `${prefix}${normalizedPath}`;
  }

  private getServerOrigin(profileId?: string): string {
    if (profileId) {
      const state = this.profileStates.get(profileId);
      if (state?.oauthProvider?.redirectUri) {
        try {
          return new URL(state.oauthProvider.redirectUri).origin;
        } catch {
          // Ignore invalid URL
        }
      }
    }

    const protocol = this.config.host.includes('://') ? '' : 'http://';
    const host = this.config.host.includes('://') ? this.config.host : this.config.host;
    return `${protocol}${host}:${this.config.port}`;
  }

  private buildProfileUrl(profileId: string | undefined, path: string, options?: { forceProfilePrefix?: boolean }): string {
    return `${this.getServerOrigin(profileId)}${this.buildProfilePath(profileId, path, options)}`;
  }

  private normalizeResourcePath(pathname: string): string {
    const normalized = pathname.replace(/\/+$/, '');
    return normalized === '' ? '/' : normalized;
  }

  private resolveProfileInfoFromResourceUrl(
    resource: string
  ): { profileId: string; forceProfilePrefix: boolean } | null {
    let url: URL;
    try {
      url = new URL(resource);
    } catch {
      return null;
    }

    const path = this.normalizeResourcePath(url.pathname);
    if (path === '/mcp') {
      const defaultProfileId = this.getDefaultProfileId();
      if (!defaultProfileId) {
        return null;
      }
      return { profileId: defaultProfileId, forceProfilePrefix: false };
    }

    if (!this.config.profileRoutingEnabled) {
      return null;
    }

    const match = /^\/profile\/([^/]+)\/mcp$/.exec(path);
    if (!match) {
      return null;
    }

    try {
      return { profileId: decodeURIComponent(match[1]), forceProfilePrefix: true };
    } catch {
      return null;
    }
  }

  private resolveProfileIdFromResourceUrl(resource: string): string | null {
    return this.resolveProfileInfoFromResourceUrl(resource)?.profileId ?? null;
  }

  public getOAuthProtectedResourceUrl(profileId?: string): string {
    const effectiveProfileId = profileId ?? this.getDefaultProfileId();
    return this.buildProfileUrl(effectiveProfileId, OAUTH_PATHS.WELL_KNOWN_PROTECTED_RESOURCE);
  }

  private respondProfileNotFound(res: Response, profileId?: string): void {
    res.status(HTTP_STATUS.NOT_FOUND).json({
      error: 'Not Found',
      message: profileId ? `Profile '${profileId}' not found` : 'Profile not found',
    });
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

    const profileRoutingEnabled = this.config.profileRoutingEnabled === true;
    const defaultProfileId = this.getDefaultProfileId();
    const attachProfileId: RequestHandler = (req: Request, _res: Response, next: NextFunction) => {
      const profileParam = req.params.profileId;
      (req as McpRequest).profileId = Array.isArray(profileParam) ? profileParam[0] : profileParam;
      next();
    };

    const oauthRateLimiterByProfile = new Map<string, RequestHandler>();
    const getOAuthRateLimiter = (profileState: ProfileRuntimeState): RequestHandler => {
      const existing = oauthRateLimiterByProfile.get(profileState.profileId);
      if (existing) {
        return existing;
      }

      const oauthWindowMs = profileState.context.rateLimitOAuthWindowMs || OAUTH_RATE_LIMIT.WINDOW_MS;
      const oauthMaxRequests = profileState.context.rateLimitOAuthMax || OAUTH_RATE_LIMIT.MAX_REQUESTS;
      const limiter = this.createRateLimiter({
        enabled: rateLimitEnabled,
        windowMs: oauthWindowMs,
        maxRequests: oauthMaxRequests,
        logMessage: 'Rate limit exceeded for OAuth',
        responseMessage: `Too many OAuth requests. Limit: ${oauthMaxRequests} requests per ${Math.round(oauthWindowMs / 60000)} minutes. Please try again later.`,
      });
      oauthRateLimiterByProfile.set(profileState.profileId, limiter);
      return limiter;
    };

    const oauthRateLimiter: RequestHandler = async (req: Request, res: Response, next: NextFunction) => {
      const profileState = await this.getProfileStateForRequest(req as McpRequest);
      if (!profileState) {
        this.respondProfileNotFound(res, (req as McpRequest).profileId);
        return;
      }
      const limiter = getOAuthRateLimiter(profileState);
      // Defensive runtime guard: keeps behavior safe even if limiter map is corrupted
      // and avoids static-analysis false positives around dynamic call targets.
      if (typeof limiter !== 'function') {
        next(new Error('Invalid OAuth rate limiter handler'));
        return;
      }
      try {
        return limiter(req, res, (err?: unknown) => {
        if (err) {
          next(err as Error);
          return;
        }
        const rateInfo = (req as Request & {
          rateLimit?: {
            limit?: number;
            current?: number;
            remaining?: number;
            resetTime?: Date;
          };
        }).rateLimit;
        this.logger.debug('OAuth rate limit state', {
          profileId: profileState.profileId,
          path: req.path,
          method: req.method,
          limit: rateInfo?.limit,
          current: rateInfo?.current,
          remaining: rateInfo?.remaining,
          resetMs: rateInfo?.resetTime instanceof Date
            ? Math.max(0, rateInfo.resetTime.getTime() - Date.now())
            : undefined,
        });
        next();
      });
      } catch (error) {
        next(error instanceof Error ? error : new Error(String(error)));
      }
    };

    const withProfileState = (handler: (req: Request, res: Response, profileState: ProfileRuntimeState) => Promise<void> | void): RequestHandler => {
      return async (req: Request, res: Response) => {
        const profileState = await this.getProfileStateForRequest(req as McpRequest);
        if (!profileState) {
          this.respondProfileNotFound(res, (req as McpRequest).profileId);
          return;
        }
        await handler(req, res, profileState);
      };
    };

    const registerOAuthRoutes = (basePath: string, includeProfileParam: boolean, includeProtectedResource: boolean): void => {
      const middlewares: RequestHandler[] = includeProfileParam ? [attachProfileId] : [];

      const withProfile = (handler: (req: Request, res: Response, profileState: ProfileRuntimeState) => Promise<void> | void): RequestHandler[] => {
        return [ ...middlewares, oauthRateLimiter, withProfileState(handler) ];
      };

      if (includeProtectedResource) {
        this.app.get(
          `${basePath}${OAUTH_PATHS.WELL_KNOWN_PROTECTED_RESOURCE}`,
          ...withProfile((req, res, profileState) => this.handleOAuthProtectedResource(req, res, profileState))
        );
      }

      this.app.get(
        `${basePath}${OAUTH_PATHS.AUTHORIZE}`,
        ...withProfile((req, res, profileState) => this.handleOAuthAuthorize(req, res, profileState))
      );

      this.app.post(
        `${basePath}${OAUTH_PATHS.TOKEN}`,
        ...middlewares,
        oauthRateLimiter,
        express.urlencoded({ extended: false, limit: '50kb' }),
        withProfileState((req, res, profileState) => this.handleOAuthToken(req, res, profileState))
      );

      this.app.get(
        `${basePath}${OAUTH_PATHS.CALLBACK}`,
        ...middlewares,
        oauthRateLimiter,
        withProfileState((req, res, profileState) => this.handleOAuthCallback(req, res, profileState))
      );

      this.app.get(
        `${basePath}${OAUTH_PATHS.WELL_KNOWN_AUTHORIZATION_SERVER}`,
        ...withProfile((req, res, profileState) => this.handleOAuthAuthorizationServerMetadata(req, res, profileState))
      );

      this.app.get(
        `${basePath}${OAUTH_PATHS.WELL_KNOWN_OPENID_CONFIGURATION}`,
        ...withProfile((req, res, profileState) => this.handleOAuthAuthorizationServerMetadata(req, res, profileState))
      );

      this.app.post(
        `${basePath}${OAUTH_PATHS.REGISTER}`,
        ...middlewares,
        oauthRateLimiter,
        express.json(),
        withProfileState((req, res, profileState) => this.handleOAuthRegister(req, res, profileState))
      );

      this.logger.info('OAuth routes registered', {
        basePath,
        profileRoutingEnabled,
      });
    };

    if (defaultProfileId) {
      registerOAuthRoutes('', false, false);
    }

    if (profileRoutingEnabled) {
      registerOAuthRoutes('/profile/:profileId', true, true);
    }

    const attachProfileFromResourceQuery: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
      const { resource } = req.query;
      if (resource === undefined) {
        next();
        return;
      }

      if (typeof resource !== 'string') {
        res.status(HTTP_STATUS.BAD_REQUEST).json({
          error: 'invalid_request',
          message: 'Invalid resource query parameter',
        });
        return;
      }

      const info = this.resolveProfileInfoFromResourceUrl(resource);
      if (!info?.profileId) {
        res.status(HTTP_STATUS.NOT_FOUND).json({
          error: 'Not Found',
          message: 'OAuth metadata unavailable for requested resource',
        });
        return;
      }

      (req as McpRequest).profileId = info.profileId;
      (req as McpRequest).forceProfilePrefix = info.forceProfilePrefix;
      this.storeProfileHint(req, info.profileId);
      next();
    };

    const attachProfileFromHint: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
      const profileId = this.resolveProfileIdFromHint(req);
      if (!profileId) {
        res.status(HTTP_STATUS.NOT_FOUND).json({
          error: 'Not Found',
          message: 'OAuth metadata unavailable for requested resource',
        });
        return;
      }
      (req as McpRequest).profileId = profileId;
      (req as McpRequest).forceProfilePrefix = true;
      next();
    };

    if (defaultProfileId || profileRoutingEnabled) {
      this.app.get(
        OAUTH_PATHS.WELL_KNOWN_PROTECTED_RESOURCE,
        attachProfileFromResourceQuery,
        oauthRateLimiter,
        // lgtm[js/missing-rate-limiting] Rate limiting is applied by oauthRateLimiter middleware above.
        withProfileState((req, res, profileState) => this.handleOAuthProtectedResource(req, res, profileState))
      );
    }

    if (profileRoutingEnabled) {
      this.app.get(
        '/.well-known/oauth-protected-resource',
        attachProfileFromResourceQuery,
        oauthRateLimiter,
        // lgtm[js/missing-rate-limiting] Rate limiting is applied by oauthRateLimiter middleware above.
        withProfileState((req, res, profileState) => this.handleOAuthProtectedResource(req, res, profileState))
      );

      this.app.get(
        '/.well-known/oauth-protected-resource/profile/:profileId/mcp',
        attachProfileId,
        oauthRateLimiter,
        // lgtm[js/missing-rate-limiting] Rate limiting is applied by oauthRateLimiter middleware above.
        withProfileState((req, res, profileState) => this.handleOAuthProtectedResource(req, res, profileState))
      );

      if (!defaultProfileId) {
        this.app.get(
          OAUTH_PATHS.WELL_KNOWN_AUTHORIZATION_SERVER,
          attachProfileFromHint,
          oauthRateLimiter,
          // lgtm[js/missing-rate-limiting] Rate limiting is applied by oauthRateLimiter middleware above.
          withProfileState((req, res, profileState) => this.handleOAuthAuthorizationServerMetadata(req, res, profileState))
        );

        this.app.get(
          OAUTH_PATHS.WELL_KNOWN_OPENID_CONFIGURATION,
          attachProfileFromHint,
          oauthRateLimiter,
          // lgtm[js/missing-rate-limiting] Rate limiting is applied by oauthRateLimiter middleware above.
          withProfileState((req, res, profileState) => this.handleOAuthAuthorizationServerMetadata(req, res, profileState))
        );

        this.app.post(
          OAUTH_PATHS.REGISTER,
          attachProfileFromHint,
          oauthRateLimiter,
          express.json(),
          // lgtm[js/missing-rate-limiting] Rate limiting is applied by oauthRateLimiter middleware above.
          withProfileState((req, res, profileState) => this.handleOAuthRegister(req, res, profileState))
        );

        this.app.get(
          OAUTH_PATHS.AUTHORIZE,
          attachProfileFromHint,
          oauthRateLimiter,
          // codeql[js/missing-rate-limiting] OAuth limiter is explicitly applied above.
          withProfileState((req, res, profileState) => this.handleOAuthAuthorize(req, res, profileState))
        );

        this.app.post(
          OAUTH_PATHS.TOKEN,
          attachProfileFromHint,
          oauthRateLimiter,
          express.urlencoded({ extended: false, limit: '50kb' }),
          // codeql[js/missing-rate-limiting] OAuth limiter is explicitly applied above.
          withProfileState((req, res, profileState) => this.handleOAuthToken(req, res, profileState))
        );

        this.app.get(
          OAUTH_PATHS.CALLBACK,
          attachProfileFromHint,
          oauthRateLimiter,
          // lgtm[js/missing-rate-limiting] Rate limiting is applied by oauthRateLimiter middleware above.
          withProfileState((req, res, profileState) => this.handleOAuthCallback(req, res, profileState))
        );
      }

      this.app.get(
        `${OAUTH_PATHS.WELL_KNOWN_AUTHORIZATION_SERVER}/profile/:profileId`,
        attachProfileId,
        oauthRateLimiter,
        // lgtm[js/missing-rate-limiting] Rate limiting is applied by oauthRateLimiter middleware above.
        withProfileState((req, res, profileState) => this.handleOAuthAuthorizationServerMetadata(req, res, profileState))
      );

      this.app.get(
        `${OAUTH_PATHS.WELL_KNOWN_OPENID_CONFIGURATION}/profile/:profileId`,
        attachProfileId,
        oauthRateLimiter,
        // lgtm[js/missing-rate-limiting] Rate limiting is applied by oauthRateLimiter middleware above.
        withProfileState((req, res, profileState) => this.handleOAuthAuthorizationServerMetadata(req, res, profileState))
      );
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

    const registerMcpRoutes = (basePath: string, includeProfileParam: boolean, isDefault: boolean): void => {
      const middlewares: RequestHandler[] = includeProfileParam ? [attachProfileId] : [];
      const pathPrefix = basePath || '';

      // Main MCP endpoint - POST for sending messages
      this.app.post(`${pathPrefix}/mcp`, ...middlewares, mcpRateLimiter, this.handlePost.bind(this));
      // CORS preflight handler
      this.app.options(`${pathPrefix}/mcp`, ...middlewares, async (req: Request, res: Response) => {
        const origin = req.headers.origin;
        try {
          // Only send CORS headers for explicitly allowed origins; otherwise reject
          if (origin && await this.isAllowedOriginForRequest(origin, req)) {
            // nosemgrep: javascript.express.security.cors-misconfiguration.cors-misconfiguration
            res.setHeader('Access-Control-Allow-Origin', origin);
            res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept, Mcp-Session-Id, X-Mcp4-Tenant-Id, X-Mcp4-Api-Base-Url');
            res.setHeader('Access-Control-Max-Age', '86400'); // 24 hours cache
            return res.status(HTTP_STATUS.OK).send();
          }
          // Disallowed origin: do not echo origin or emit permissive headers
          res.status(HTTP_STATUS.FORBIDDEN).json({ error: 'Forbidden', message: 'Origin not allowed' });
        } catch (error) {
          this.logger.error('Origin validation failed', error instanceof Error ? error : new Error(String(error)));
          res.status(HTTP_STATUS.FORBIDDEN).json({ error: 'Forbidden', message: 'Origin not allowed' });
        }
      });

      // Main MCP endpoint - GET for SSE streaming
      this.app.get(`${pathPrefix}/mcp`, ...middlewares, mcpRateLimiter, this.handleGet.bind(this));

      // Session termination
      this.app.delete(`${pathPrefix}/mcp`, ...middlewares, mcpRateLimiter, this.handleDelete.bind(this));

      // Legacy alias endpoints - deprecated
      // Why: Backward compatibility for clients using /sse during migration
      this.app.post(`${pathPrefix}/sse`, ...middlewares, mcpRateLimiter, (req: Request, res: Response) => {
        this.logger.warn('Deprecated endpoint used: POST /sse. Please migrate to POST /mcp');
        this.logger.info('Handling POST /sse request');
        return this.handlePost(req as McpRequest, res);
      });
      this.app.get(`${pathPrefix}/sse`, ...middlewares, mcpRateLimiter, (req: Request, res: Response) => {
        this.logger.warn('Deprecated endpoint used: GET /sse. Please migrate to GET /mcp');
        this.logger.info(`Handling GET /sse request from: ${req.ip}`);
        return this.handleGet(req as McpRequest, res);
      });
      this.app.delete(`${pathPrefix}/sse`, ...middlewares, mcpRateLimiter, (req: Request, res: Response) => {
        this.logger.warn('Deprecated endpoint used: DELETE /sse. Please migrate to DELETE /mcp');
        return this.handleDelete(req as McpRequest, res);
      });

      if (isDefault) {
        this.logger.info('Registered MCP routes for default profile', { pathPrefix: pathPrefix || '/mcp' });
      } else {
        this.logger.info('Registered MCP routes for profile routing', { pathPrefix: `${pathPrefix}/mcp` });
      }
    };

    if (defaultProfileId) {
      registerMcpRoutes('', false, true);
    }

    if (profileRoutingEnabled) {
      registerMcpRoutes('/profile/:profileId', true, false);
    }

    // Metrics endpoint (if enabled)
    if (this.config.metricsEnabled) {
      this.app.get(this.config.metricsPath, metricsRateLimiter, this.handleMetrics.bind(this));
    }

    // Health check (with rate limiting)
    this.app.get('/health', mcpRateLimiter, (req: Request, res: Response) => {
      const startTime = Date.now();
      let totalSessions = 0;
      for (const state of this.profileStates.values()) {
        totalSessions += state.sessions.size;
      }
      res.json({ status: 'ok', sessions: totalSessions });

      if (this.metrics) {
        const duration = (Date.now() - startTime) / 1000;
        this.metrics.recordHttpRequest(req.method, req.path, res.statusCode, duration, {
          profileId: 'unknown',
          tenantId: 'none',
        });
      }
    });

    if (this.config.profileIndexEnabled) {
      this.app.get('/', mcpRateLimiter, async (req: Request, res: Response) => {
        await this.handleProfileIndex(req, res);
      });
    }

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
  
  private getProfileIssuerUrl(profileId: string, options?: { forceProfilePrefix?: boolean }): string {
    const origin = this.getServerOrigin(profileId);
    const prefix = this.getProfilePrefix(profileId, options);
    return `${origin}${prefix}`;
  }

  private getRequestOrigin(req: Request): string {
    const hostHeader = req.get('host');
    if (hostHeader) {
      return `${req.protocol}://${hostHeader}`;
    }
    return this.getServerOrigin();
  }

  private async handleProfileIndex(req: Request, res: Response): Promise<void> {
    if (!this.config.profileRoutingEnabled || !this.config.profileIndexEnabled) {
      res.status(HTTP_STATUS.NOT_FOUND).json({
        error: 'Not Found',
        message: 'Endpoint GET / not found',
      });
      return;
    }

    if (!this.profileIndexProvider) {
      res.status(HTTP_STATUS.NOT_FOUND).json({
        error: 'Not Found',
        message: 'Profile index not available',
      });
      return;
    }

    const accept = req.headers.accept || '';
    const prefersJson = accept.includes('application/json') && !accept.includes('text/html');
    const locale = parseAcceptLanguage(req.headers['accept-language'] as string | undefined);

    let profiles: ListedProfileDetails[];
    try {
      profiles = await this.profileIndexProvider();
    } catch (error) {
      this.logger.error('Failed to load profile index', error instanceof Error ? error : new Error(String(error)));
      res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
        error: 'Internal Server Error',
        message: 'Failed to load profile index',
      });
      return;
    }

    const profilesWithTenantSummary = await this.enrichProfilesForIndexWithTenants(profiles);
    const origin = this.getRequestOrigin(req);
    const { payload, templateData } = buildProfileIndexPayload(profilesWithTenantSummary, origin, locale);

    if (prefersJson) {
      res.json(payload);
      return;
    }

    const template = await loadProfileIndexTemplate();
    const nonce = crypto.randomBytes(16).toString('base64');
    const html = renderProfileIndexHtml(template, templateData, nonce);

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader(
      'Content-Security-Policy',
      `default-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'nonce-${nonce}'`
    );
    res.send(html);
  }

  private async enrichProfilesForIndexWithTenants(profiles: ListedProfileDetails[]): Promise<ProfileIndexSourceProfile[]> {
    if (!this.rawTenantConfig || this.rawTenantConfig.tenants.length === 0 || !this.profileContextProvider) {
      return profiles;
    }

    const enriched: ProfileIndexSourceProfile[] = [];
    for (const profile of profiles) {
      try {
        const context = await this.profileContextProvider(profile.profileId);
        if (!context) {
          enriched.push(profile);
          continue;
        }
        const tenantIndex = buildTenantIndexForProfile(this.rawTenantConfig, context, this.logger);
        const tenantSummary = this.buildProfileIndexTenantSummary(tenantIndex);
        enriched.push({
          ...profile,
          tenantSummary,
        });
      } catch (error) {
        this.logger.warn('Failed to build tenant summary for profile index', {
          profileId: profile.profileId,
          error: error instanceof Error ? error.message : String(error),
        });
        enriched.push(profile);
      }
    }

    return enriched;
  }

  private buildProfileIndexTenantSummary(
    tenantIndex: HttpTenantIndex,
  ): ProfileIndexTenantSummary | undefined {
    if (!tenantIndex.enabled || tenantIndex.byTenantId.size === 0) {
      return undefined;
    }

    const tenants = Array.from(tenantIndex.byTenantId.values())
      .map((tenant) => ({
        tenantId: tenant.tenantId,
        selectorType: tenant.tenantSelectorType,
        selectorDisplay: tenant.tenantSelectorValue,
      }))
      .sort((left, right) => left.tenantId.localeCompare(right.tenantId));

    return {
      tenantsEnabled: true,
      selectionHeaderName: 'X-Mcp4-Tenant-Id',
      tenants,
    };
  }


  private async handleOAuthProtectedResource(
    req: Request,
    res: Response,
    profileState: ProfileRuntimeState
  ): Promise<void> {
    if (!profileState.oauthProvider) {
      res.status(HTTP_STATUS.NOT_FOUND).json({ error: 'Not Found', message: 'OAuth not configured for this profile' });
      return;
    }

    const profileId = profileState.profileId;
    const isProfileScoped = typeof req.params?.profileId === 'string';
    const forceProfilePrefix = isProfileScoped || (req as McpRequest).forceProfilePrefix === true;
    const urlOptions = forceProfilePrefix ? { forceProfilePrefix: true } : undefined;
    const serverUrl = new URL(this.buildProfileUrl(profileId, '/mcp', urlOptions));
    const issuerUrl = this.getProfileIssuerUrl(profileId, urlOptions);

    const metadata: {
      resource: string;
      authorization_servers: string[];
      bearer_methods_supported: string[];
      scopes_supported?: string[];
      resource_name?: string;
      resource_documentation?: string;
    } = {
      resource: serverUrl.href,
      authorization_servers: [issuerUrl],
      bearer_methods_supported: ['header'],
    };

    if (profileState.oauthProvider.scopes && profileState.oauthProvider.scopes.length > 0) {
      metadata.scopes_supported = profileState.oauthProvider.scopes;
    }

    if (profileState.context.resourceName) {
      metadata.resource_name = profileState.context.resourceName;
    }

    if (profileState.context.resourceDocumentation) {
      metadata.resource_documentation = profileState.context.resourceDocumentation;
    }

    res.json(metadata);
  }

  private async handleOAuthAuthorize(
    req: Request,
    res: Response,
    profileState: ProfileRuntimeState
  ): Promise<void> {
    if (!profileState.oauthProvider) {
      res.status(HTTP_STATUS.NOT_FOUND).send('OAuth not configured for this profile');
      return;
    }

    try {
      res.setHeader('Cache-Control', 'no-store');

      const { response_type, client_id, redirect_uri, scope, state, code_challenge, code_challenge_method } = req.query;

      if (!client_id || typeof client_id !== 'string') {
        res.status(HTTP_STATUS.BAD_REQUEST).send('Missing client_id');
        return;
      }

      if (!response_type || typeof response_type !== 'string') {
        res.status(HTTP_STATUS.BAD_REQUEST).send('Missing response_type');
        return;
      }

      if (response_type !== 'code') {
        res.status(HTTP_STATUS.BAD_REQUEST).send('Unsupported response_type');
        return;
      }

      if (!redirect_uri || typeof redirect_uri !== 'string') {
        res.status(HTTP_STATUS.BAD_REQUEST).send('Missing redirect_uri');
        return;
      }

      await profileState.oauthProvider.ensureEndpointsInitialized();
      const client = await this.resolveOAuthClientForRequest(profileState, client_id);
      if (!client) {
        this.logger.warn('OAuth authorize rejected invalid client_id', {
          profileId: profileState.profileId,
          client_id,
        });
        res.status(HTTP_STATUS.BAD_REQUEST).send('Invalid client_id');
        return;
      }

      const scopeStr = (scope as string || '').trim();
      const params = {
        responseType: response_type,
        clientId: client.client_id,
        redirectUri: redirect_uri,
        scope: scopeStr ? scopeStr.split(' ') : [],
        state: state as string,
        codeChallenge: code_challenge as string,
        codeChallengeMethod: code_challenge_method as string,
        scopes: scopeStr ? scopeStr.split(' ') : [],
      };

      await profileState.oauthProvider.authorize(client, params, res);
    } catch (error) {
      this.logger.error('OAuth authorize error', error instanceof Error ? error : new Error(String(error)));
      res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).send('OAuth authorization failed');
    }
  }

  private async handleOAuthToken(
    req: Request,
    res: Response,
    profileState: ProfileRuntimeState
  ): Promise<void> {
    if (!profileState.oauthProvider) {
      res.status(HTTP_STATUS.NOT_FOUND).json({ error: 'server_error', error_description: 'OAuth provider not initialized' });
      return;
    }

    try {
      res.setHeader('Cache-Control', 'no-store');

      const { grant_type, code, redirect_uri, client_id, client_secret, code_verifier, refresh_token } = req.body;

      this.logger.debug('OAuth token request', {
        profileId: profileState.profileId,
        grant_type,
        client_id,
        has_code: !!code,
        has_code_verifier: !!code_verifier,
        redirect_uri,
      });

      if (grant_type === 'authorization_code') {
        if (!code) {
          res.status(HTTP_STATUS.BAD_REQUEST).json({ error: 'invalid_request', error_description: 'Missing code' });
          return;
        }

        await profileState.oauthProvider.ensureEndpointsInitialized();
        const client = await this.validateOAuthClientCredentials(
          profileState,
          client_id,
          client_secret,
          res
        );
        if (!client) {
          return;
        }

        const tokens = await profileState.oauthProvider.exchangeAuthorizationCode(
          client,
          code,
          code_verifier,
          redirect_uri
        );

        this.storeOAuthTokens(profileState, tokens, client.client_id, client.scope?.split(' ') || []);
        res.json(tokens);
        return;
      }

      if (grant_type === 'refresh_token') {
        if (!refresh_token) {
          res.status(HTTP_STATUS.BAD_REQUEST).json({ error: 'invalid_request', error_description: 'Missing refresh_token' });
          return;
        }

        await profileState.oauthProvider.ensureEndpointsInitialized();
        const client = await this.validateOAuthClientCredentials(
          profileState,
          client_id,
          client_secret,
          res
        );
        if (!client) {
          return;
        }

        const tokens = await profileState.oauthProvider.exchangeRefreshToken(client, refresh_token);
        this.storeOAuthTokens(profileState, tokens, client.client_id, client.scope?.split(' ') || []);
        res.json(tokens);
        return;
      }

      this.logger.warn('Unsupported grant type', { grant_type, expected: 'authorization_code or refresh_token' });
      res.status(HTTP_STATUS.BAD_REQUEST).json({ error: 'unsupported_grant_type' });
    } catch (error) {
      this.logger.error('OAuth token exchange error', error instanceof Error ? error : new Error(String(error)));
      res.status(HTTP_STATUS.BAD_REQUEST).json({
        error: 'invalid_grant',
        error_description: 'Token exchange failed',
      });
    }
  }

  private compareSecretsConstantTime(expectedSecret: string, providedSecret: string): boolean {
    const expectedBuffer = Buffer.from(expectedSecret, 'utf8');
    const providedBuffer = Buffer.from(providedSecret, 'utf8');
    if (expectedBuffer.length !== providedBuffer.length) {
      return false;
    }
    return crypto.timingSafeEqual(expectedBuffer, providedBuffer);
  }

  private isProxyCompatibilityClient(clientId: string): boolean {
    return clientId === 'mcp-proxy-client' || clientId === PROXY_CREDENTIALS.CLIENT_ID;
  }

  private async resolveOAuthClientForRequest(
    profileState: ProfileRuntimeState,
    clientId: string
  ): Promise<OAuthClientInformationFull | undefined> {
    if (!profileState.oauthProvider) {
      return undefined;
    }

    const client = await profileState.oauthProvider.clientsStore.getClient(clientId);
    if (client) {
      return client;
    }

    // Compatibility fallback: allow legacy hardcoded VS Code client id
    // even when MCP_PROXY_CLIENT_ID is overridden in environment.
    if (clientId === 'mcp-proxy-client' && PROXY_CREDENTIALS.CLIENT_ID !== 'mcp-proxy-client') {
      return profileState.oauthProvider.clientsStore.getClient(PROXY_CREDENTIALS.CLIENT_ID);
    }

    return undefined;
  }

  private async validateOAuthClientCredentials(
    profileState: ProfileRuntimeState,
    clientId: unknown,
    clientSecret: unknown,
    res: Response
  ): Promise<OAuthClientInformationFull | null> {
    if (!profileState.oauthProvider || typeof clientId !== 'string' || clientId.trim().length === 0) {
      res.status(HTTP_STATUS.BAD_REQUEST).json({ error: 'invalid_client' });
      return null;
    }

    const client = await this.resolveOAuthClientForRequest(profileState, clientId);
    if (!client) {
      res.status(HTTP_STATUS.BAD_REQUEST).json({ error: 'invalid_client' });
      return null;
    }

    // Keep VS Code proxy compatibility client public for token exchange.
    if (this.isProxyCompatibilityClient(client.client_id)) {
      return client;
    }

    // Confidential clients must present matching client_secret.
    if (typeof client.client_secret === 'string' && client.client_secret.length > 0) {
      if (typeof clientSecret !== 'string' || clientSecret.length === 0) {
        res.status(HTTP_STATUS.BAD_REQUEST).json({ error: 'invalid_client' });
        return null;
      }
      if (!this.compareSecretsConstantTime(client.client_secret, clientSecret)) {
        res.status(HTTP_STATUS.BAD_REQUEST).json({ error: 'invalid_client' });
        return null;
      }
    }

    return client;
  }

  private async handleOAuthCallback(
    req: Request,
    res: Response,
    profileState: ProfileRuntimeState
  ): Promise<void> {
    if (!profileState.oauthProvider) {
      res.status(HTTP_STATUS.NOT_FOUND).send('OAuth provider not initialized');
      return;
    }

    try {
      const { code, state, error, error_description } = req.query;

      this.logger.info('OAuth callback received', {
        profileId: profileState.profileId,
        hasCode: !!code,
        hasState: !!state,
        error: error,
        errorDescription: error_description,
      });

      if (error) {
        const safeError = escapeHtmlSafe(error as string);
        const safeErrorDesc = escapeHtmlSafe(error_description as string);

        res.status(HTTP_STATUS.BAD_REQUEST).json({
          error: safeError,
          error_description: safeErrorDesc || safeError,
        });
        return;
      }

      if (!code || typeof code !== 'string') {
        res.status(HTTP_STATUS.BAD_REQUEST).send('Missing authorization code');
        return;
      }

      await profileState.oauthProvider.handleCallback(req, res);
    } catch (error) {
      this.logger.error('OAuth callback error', error instanceof Error ? error : new Error(String(error)));
      if (!res.headersSent) {
        res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).send('OAuth callback failed');
      }
    }
  }

  private async handleOAuthAuthorizationServerMetadata(
    req: Request,
    res: Response,
    profileState: ProfileRuntimeState
  ): Promise<void> {
    if (!profileState.oauthProvider) {
      res.status(HTTP_STATUS.NOT_FOUND).send('OAuth metadata unavailable');
      return;
    }

    try {
      const profileId = profileState.profileId;
      const isProfileScoped = typeof req.params?.profileId === 'string';
      const forceProfilePrefix = isProfileScoped || (req as McpRequest).forceProfilePrefix === true;
      const urlOptions = forceProfilePrefix ? { forceProfilePrefix: true } : undefined;
      const issuer = this.getProfileIssuerUrl(profileId, urlOptions);

      res.json({
        issuer,
        authorization_endpoint: this.buildProfileUrl(profileId, OAUTH_PATHS.AUTHORIZE, urlOptions),
        token_endpoint: this.buildProfileUrl(profileId, OAUTH_PATHS.TOKEN, urlOptions),
        registration_endpoint: this.buildProfileUrl(profileId, OAUTH_PATHS.REGISTER, urlOptions),
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        scopes_supported: profileState.oauthProvider.scopes || ['api'],
      });
    } catch (error) {
      this.logger.error('OAuth authorization server metadata error', error instanceof Error ? error : new Error(String(error)));
      res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).send('OAuth metadata failed');
    }
  }

  private async handleOAuthRegister(
    req: Request,
    res: Response,
    profileState: ProfileRuntimeState
  ): Promise<void> {
    if (!profileState.oauthProvider) {
      res.status(HTTP_STATUS.NOT_FOUND).json({ error: 'server_error', error_description: 'Registration unavailable' });
      return;
    }

    try {
      const { redirect_uris } = req.body;
      this.logger.info('Dynamic client registration request', {
        profileId: profileState.profileId,
        redirect_uris,
      });

      const clientId = `mcp-client-${crypto.randomUUID()}`;
      const clientSecret = crypto.randomBytes(32).toString('base64url');

      const client = {
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uris: redirect_uris || [],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        scope: (profileState.oauthProvider.scopes || []).join(' '),
      };

      const registerClient = profileState.oauthProvider.clientsStore.registerClient?.bind(
        profileState.oauthProvider.clientsStore
      );
      if (!registerClient) {
        throw new Error('OAuth clients store does not support registration');
      }
      await registerClient(client);

      res.status(HTTP_STATUS.CREATED).json({
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uris: redirect_uris,
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        scope: (profileState.oauthProvider.scopes || []).join(' '),
        token_endpoint_auth_method: 'client_secret_post',
      });
    } catch (error) {
      this.logger.error('Client registration failed', error instanceof Error ? error : new Error(String(error)));
      res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ error: 'server_error', error_description: 'Registration failed' });
    }
  }

  /**
   * Handle metrics endpoint
   * 
   * Why: Prometheus scraping endpoint
   */
  private async handleMetrics(_req: Request, res: Response): Promise<void> {
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
      const correlationId = generateCorrelationId();
      this.logger.error('Metrics endpoint error', error as Error, { correlationId });
      res.setHeader('Cache-Control', 'no-store');
      res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
        error: 'Internal Server Error',
        message: `Internal error (correlation ID: ${correlationId})`,
        correlationId
      });
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
    const baseUrlObj = new URL(baseUrl);
    const absoluteEndpoint =
      authConfig.validation_endpoint.startsWith('http://') ||
      authConfig.validation_endpoint.startsWith('https://');
    const allowedHosts = [baseUrlObj.hostname, ...(authConfig.validation_allowed_hosts || [])];
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

      if (
        absoluteEndpoint &&
        url.origin !== baseUrlObj.origin &&
        !this.isAllowedValidationHost(url.hostname, authConfig.validation_allowed_hosts)
      ) {
        throw new ValidationError(
          `validation_endpoint host '${url.hostname}' is not allowed (must match base_url origin or validation_allowed_hosts)`
        );
      }

      // Validate URL against SSRF rules before fetching
      await this.ssrfValidator.validate(url.toString(), {
        allowPrivateNetwork: process.env.MCP4_SSRF_ALLOW_PRIVATE_NETWORK === 'true',
        allowedHosts,
      });

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      const response = await fetch(url.toString(), {
        method,
        headers,
        signal: controller.signal,
        redirect: 'error', // Prevent redirects to avoid SSRF bypass
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

  private isAllowedValidationHost(hostname: string, allowedHosts?: string[]): boolean {
    if (!allowedHosts || allowedHosts.length === 0) {
      return false;
    }

    const lower = hostname.toLowerCase();
    return allowedHosts.some(patternRaw => {
      const pattern = patternRaw.toLowerCase().trim();
      if (!pattern) return false;
      if (pattern.startsWith('*.')) {
        const suffix = pattern.slice(2);
        if (!suffix) return false;
        return lower.endsWith(`.${suffix}`);
      }
      return lower === pattern;
    });
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

  private hasServerEnvAuthToken(authConfigs?: AuthInterceptor[]): boolean {
    if (!authConfigs || authConfigs.length === 0) {
      return false;
    }

    return authConfigs.some((config) => {
      if (!config.value_from_env) {
        return false;
      }
      const envValue = process.env[config.value_from_env];
      return typeof envValue === 'string' && envValue.trim().length > 0;
    });
  }

  private resolveEffectiveAuthContext(
    profileState: ProfileRuntimeState,
    resolvedTenant?: ResolvedTenantContext | null,
    session?: SessionData,
  ): { authConfigs: AuthInterceptor[]; oauthConfig?: OAuthConfig } {
    if (resolvedTenant) {
      return {
        authConfigs: resolvedTenant.tenantAuthConfigs,
        oauthConfig: resolvedTenant.tenantOAuthConfig,
      };
    }
    if (session && session.tenantAuthMode) {
      return {
        authConfigs: session.tenantAuthConfigs || [],
        oauthConfig: session.tenantOAuthConfig,
      };
    }
    return {
      authConfigs: profileState.context.authConfigs || [],
      oauthConfig: profileState.context.oauthConfig,
    };
  }

  private getTenantIndex(profileState: ProfileRuntimeState): HttpTenantIndex {
    if (profileState.tenantIndex) {
      return profileState.tenantIndex;
    }
    profileState.tenantIndex = {
      enabled: false,
      byTenantId: new Map(),
      byBaseUrl: new Map(),
      maskSelectors: [],
      selectorTypeByTenantId: new Map(),
    };
    return profileState.tenantIndex;
  }

  private getTenantOAuthProviderCache(profileState: ProfileRuntimeState): Map<string, ExternalOAuthProvider> {
    if (!profileState.tenantOAuthProvidersBySessionId) {
      profileState.tenantOAuthProvidersBySessionId = new Map<string, ExternalOAuthProvider>();
    }
    return profileState.tenantOAuthProvidersBySessionId;
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
  private extractAuthToken(
    req: McpRequest,
    profileState: ProfileRuntimeState,
    authConfigOverride?: AuthInterceptor[],
  ): { type: 'bearer' | 'oauth' | 'api-token' | 'none', token?: string, sessionId?: string } {
    const sessionId = req.sessionId || req.headers['mcp-session-id'] as string | undefined;
    const session = sessionId ? profileState.sessions.get(sessionId) : undefined;
    const authConfigs = authConfigOverride ?? profileState.context.authConfigs;
    const configs = authConfigs ? (Array.isArray(authConfigs) ? authConfigs : [authConfigs]) : [];
    const hasOAuth = authConfigOverride
      ? configs.some((config) => config.type === 'oauth')
      : (!!profileState.oauthProvider || configs.some((config) => config.type === 'oauth'));
    
    // 1. Check Authorization: Bearer header
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
    
    // 2. Check configured custom header (if any)
    if (configs.length > 0) {
      const sortedConfigs = [...configs].sort((a, b) => (a.priority || 0) - (b.priority || 0));
      const customHeaderConfig = sortedConfigs.find(c => c.type === 'custom-header' && c.header_name);
      if (customHeaderConfig && customHeaderConfig.header_name) {
        if (!isSafePropertyName(customHeaderConfig.header_name)) {
          throw new ValidationError(`Invalid custom auth header name: ${customHeaderConfig.header_name}`);
        }
        const headerKey = customHeaderConfig.header_name.toLowerCase();
        const headerValue = req.headers[headerKey];
        if (headerValue) {
          if (typeof headerValue !== 'string') {
            throw new ValidationError(`${customHeaderConfig.header_name} must be a string`);
          }
          this.validateToken(headerValue, customHeaderConfig.header_name);
          return { type: 'api-token', token: headerValue };
        }
      }
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

    // 4. Fall back to session token (OAuth only when configured)
    if (session && session.authToken) {
      return { type: hasOAuth ? 'oauth' : 'api-token', token: session.authToken, sessionId };
    }
    
    return { type: 'none' };
  }

  /**
   * Lazy initialization of ToolFilterService
   */
  private getToolFilterService(profileState: ProfileRuntimeState): ToolFilterService {
    if (!profileState.toolFilterService) {
      const validator = new RegexValidator();
      const compiler = new RegexCompiler(validator);
      const envParser = new EnvConfigParser(compiler);
      const headerParser = new HeaderConfigParser(compiler);
      
      // Create OperationDetector for category filtering (if parser available)
      let detector: OperationDetector | undefined;
      if (profileState.context.parser) {
        const classifier = new OperationClassifier();
        const resolver = new OpenAPIOperationResolver(profileState.context.parser);
        detector = new OperationDetector(classifier, resolver);
      }
      
      profileState.toolFilterService = new ToolFilterService(
        envParser,
        headerParser,
        this.logger,
        detector
      );
    }
    return profileState.toolFilterService;
  }

  /**
   * Handle POST requests - Client sending messages to server
   * 
   * MCP Spec: POST can contain requests, notifications, or responses
   */
  private async handlePost(req: McpRequest, res: Response): Promise<void> {
    const startTime = Date.now();
    let metricsProfileState: ProfileRuntimeState | null = null;
    let metricsTenantId: string | null = null;
    try {
      this.logger.debug('handlePost called', { method: req.method, path: req.path, sessionId: req.sessionId, accept: req.headers.accept });
      const profileState = await this.getProfileStateForRequest(req);
      if (!profileState) {
        this.respondProfileNotFound(res, req.profileId);
        return;
      }
      metricsProfileState = profileState;
      const requestProfileId = req.profileId ?? profileState.profileId;
      const sessionId = req.sessionId;
      const body = req.body;
      const filteringHeader = normalizeFilteringHeaderValue(this.getFilteringHeaderValue(req));
      const parsedFiltering = filteringHeader ? parseFilteringHeader(filteringHeader) : undefined;
      const toolFilterHeader = normalizeToolFilterHeaderValue(this.getToolFilterHeaderValue(req));
      const parsedToolFilter =
        toolFilterHeader !== undefined ? parseSessionToolFilterHeader(toolFilterHeader) : undefined;
      const normalizedToolFilterHeader = parsedToolFilter?.normalizedHeader;
      const tenantIdHeaderValue = this.getTenantIdHeaderValue(req);
      const tenantBaseUrlHeaderValue = this.getTenantBaseUrlHeaderValue(req);

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
      const bodyMethod =
        typeof body === 'object' && body !== null && 'method' in body
          ? (body as { method?: unknown }).method
          : undefined;
      this.logger.debug('Session validation', { isInitialization, sessionId, bodyMethod });

      // Validate session (except for initialization)
      if (!isInitialization && sessionId) {
        const session = profileState.sessions.get(sessionId);
        if (!session) {
          res.status(HTTP_STATUS.NOT_FOUND).json({ error: 'Not Found', message: 'Session not found or expired' });
          return;
        }
        metricsTenantId = session.tenantId || null;
        if (filteringHeader !== undefined) {
          if (!session.filteringHeader || session.filteringHeader !== filteringHeader) {
            throw new ValidationError('X-Mcp4-Params header mismatch for existing session.');
          }
        }
        if (normalizedToolFilterHeader !== undefined) {
          if (!session.toolFilterHeader || session.toolFilterHeader !== normalizedToolFilterHeader) {
            throw new ValidationError(
              `X-Mcp4-Tools header mismatch for existing session. Expected: '${session.toolFilterHeader ?? ''}', Got: '${normalizedToolFilterHeader}'.`
            );
          }
        }
        if (tenantIdHeaderValue !== undefined || tenantBaseUrlHeaderValue !== undefined) {
          const resolvedTenantForRequest = resolveTenantFromHeaders(
            this.getTenantIndex(profileState),
            tenantIdHeaderValue,
            tenantBaseUrlHeaderValue,
          );
          metricsTenantId = resolvedTenantForRequest?.tenantId || metricsTenantId;
          if (
            resolvedTenantForRequest?.tenantId !== session.tenantId ||
            resolvedTenantForRequest?.tenantBaseUrl !== session.tenantBaseUrl
          ) {
            throw new ValidationError('Tenant selector header mismatch for existing session.');
          }
        }
        this.updateSessionActivity(profileState, sessionId);
        const effectiveAuthContext = this.resolveEffectiveAuthContext(profileState, undefined, session);
        const authInfo = this.extractAuthToken(req, profileState, effectiveAuthContext.authConfigs);
        if (authInfo.token && authInfo.type !== 'oauth') {
          const previousToken = session.authToken;
          if (!previousToken || previousToken !== authInfo.token) {
            session.authToken = authInfo.token;
            this.logger.info('Session auth token updated', {
              profileId: profileState.profileId,
              sessionId,
              authType: authInfo.type,
              replaced: !!previousToken,
            });
          }
        }
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
          await this.messageHandler(body, undefined, requestProfileId);
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
          const resolvedTenant = resolveTenantFromHeaders(
            this.getTenantIndex(profileState),
            tenantIdHeaderValue,
            tenantBaseUrlHeaderValue,
          );
          metricsTenantId = resolvedTenant?.tenantId || null;
          const effectiveAuthContext = this.resolveEffectiveAuthContext(profileState, resolvedTenant);
          const authInfo = this.extractAuthToken(req, profileState, effectiveAuthContext.authConfigs);
          this.logger.debug('Auth token extracted', { authType: authInfo?.type, hasToken: !!authInfo?.token });

          // If OAuth is configured, require authentication for initialization
          // This ensures clients like Cursor properly handle OAuth flow
          if (effectiveAuthContext.oauthConfig && !authInfo.token) {
            this.logger.debug('OAuth configured but no token provided, triggering OAuth flow');
            const resourceMetadataUrl = this.getOAuthProtectedResourceUrl(requestProfileId);
            const scopeValue = effectiveAuthContext.oauthConfig.scopes?.join(' ') || 'api';
            res.setHeader('WWW-Authenticate', `Bearer resource_metadata="${resourceMetadataUrl}", scope="${scopeValue}"`);
            res.status(HTTP_STATUS.UNAUTHORIZED).json({
              error: 'Unauthorized',
              message: 'Authentication required for OAuth'
            });
            return;
          }

          // Require a client token only when auth is configured and server env fallback is unavailable
          const authConfigs = effectiveAuthContext.authConfigs;
          if (authConfigs.length > 0 && !authInfo.token && !this.hasServerEnvAuthToken(authConfigs)) {
            this.logger.debug('Auth configured but no token provided, rejecting initialization', {
              profileId: requestProfileId,
              authConfigsCount: authConfigs.length
            });
            res.status(HTTP_STATUS.UNAUTHORIZED).json({
              error: 'Unauthorized',
              message: 'Authentication required'
            });
            return;
          }

          // Validate token if auth is configured and token is provided
          if (authInfo && authInfo.token && authConfigs.length > 0 && (resolvedTenant?.tenantBaseUrl || profileState.context.baseUrl)) {
            // Find matching auth config based on priority (authConfigs is sorted)
            // For 'bearer' token type, 'oauth' config is also a match
            const authConfig = authConfigs.find(c =>
                c.type === authInfo.type || 
                (authInfo.type === 'bearer' && c.type === 'oauth')
            );
            
            if (authConfig && authConfig.validation_endpoint) {
              this.logger.info('Validating auth token during initialization', {
                authType: authConfig.type, // Use config type for logging
                endpoint: authConfig.validation_endpoint,
              });
              
              const isValid = await this.validateAuthToken(authConfig, authInfo.token, resolvedTenant?.tenantBaseUrl || profileState.context.baseUrl || '');
              
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
            const tokenData = profileState.oauthTokensByAccessToken.get(authInfo.token);
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
            profileState,
            authInfo.token,
            refreshToken,
            accessTokenExpiresAt,
            scopes,
            oauthClientId,
            parsedFiltering?.filtering,
            parsedFiltering?.normalizedHeader,
            parsedToolFilter,
            normalizedToolFilterHeader,
            resolvedTenant,
            tenantBaseUrlHeaderValue
          );
        }

        this.logger.debug('Calling messageHandler', { body, sessionId: isInitialization ? newSessionId : sessionId });
        const response = await this.messageHandler(body, isInitialization ? newSessionId : sessionId, requestProfileId);
        this.logger.debug('MessageHandler response', { response });

        // Debug: Check OAuth conditions
        const responseObj = response as OAuthRequiredErrorResponse;
        this.logger.debug('Checking OAuth conditions', {
          responseError: responseObj.error,
          hasOAuthProvider: !!profileState.oauthProvider,
          oauthProviderType: typeof profileState.oauthProvider
        });


        // Check if response contains OAuth error and add WWW-Authenticate header
        if (responseObj.error && responseObj.error.data && responseObj.error.data.oauth_required) {
          const resourceMetadataUrl = this.getOAuthProtectedResourceUrl(requestProfileId);
          res.setHeader('WWW-Authenticate', `Bearer resource_metadata="${resourceMetadataUrl}", scope="api"`);
          res.status(HTTP_STATUS.UNAUTHORIZED); // Set 401 status for OAuth errors
        }

        // Decide response format based on Accept header
        const accept = req.headers.accept || '';
        const wantsOnlySSE = accept.trim() === MIME_TYPES.EVENT_STREAM;

        if (wantsOnlySSE) {
          // Return SSE response only when client explicitly wants text/event-stream only
          this.logger.debug('Sending SSE response', { response, newSessionId });
          this.startSSEResponse(res, response, newSessionId);
        } else {
          // Return JSON response (default for requests)
          if (newSessionId) {
            res.setHeader('Mcp-Session-Id', newSessionId);
          }
          // Security: Prevent caching of sensitive API responses
          res.setHeader('Cache-Control', 'no-store');
          this.logger.debug('Sending JSON response', { response, newSessionId });
          res.json(response);
        }
        return;
      }

      res.status(HTTP_STATUS.BAD_REQUEST).json({ error: 'Bad Request', message: 'Invalid message type' });
    } catch (error) {
      const correlationId = generateCorrelationId();
      this.logger.error('POST request error', error as Error, { correlationId });
      res.setHeader('Cache-Control', 'no-store');

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
        this.metrics.recordHttpRequest(
          req.method,
          req.path,
          status,
          duration,
          this.resolveMetricsContext(metricsProfileState, metricsTenantId)
        );
      }
    } finally {
      // Record success metrics (if not already recorded in catch)
      if (this.metrics && res.statusCode !== 500) {
        const duration = (Date.now() - startTime) / 1000;
        this.metrics.recordHttpRequest(
          req.method,
          req.path,
          res.statusCode,
          duration,
          this.resolveMetricsContext(metricsProfileState, metricsTenantId)
        );
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
    let metricsProfileState: ProfileRuntimeState | null = null;
    let metricsTenantId: string | null = null;
    try {
      const profileState = await this.getProfileStateForRequest(req);
      if (!profileState) {
        this.respondProfileNotFound(res, req.profileId);
        return;
      }
      metricsProfileState = profileState;
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

      const session = profileState.sessions.get(sessionId);
      if (!session) {
        res.status(HTTP_STATUS.NOT_FOUND).json({ error: 'Not Found', message: 'Session not found or expired' });
        return;
      }
      metricsTenantId = session.tenantId || null;

      this.updateSessionActivity(profileState, sessionId);

      // Start SSE stream
      this.startSSEStream(res, sessionId, lastEventId, profileState);
      
      // Record metrics for successful SSE start
      if (this.metrics) {
        const duration = (Date.now() - startTime) / 1000;
        this.metrics.recordHttpRequest(
          req.method,
          req.path,
          200,
          duration,
          this.resolveMetricsContext(metricsProfileState, metricsTenantId)
        );
      }
    } catch (error) {
      const correlationId = generateCorrelationId();
      this.logger.error('GET request error', error as Error, { correlationId });
      const status = 500;
      if (!res.headersSent) {
        res.setHeader('Cache-Control', 'no-store');
        res.status(status).json({
          error: 'Internal Server Error',
          message: `Internal error (correlation ID: ${correlationId})`,
          correlationId
        });
      }
      
      // Record error metrics
      if (this.metrics) {
        const duration = (Date.now() - startTime) / 1000;
        this.metrics.recordHttpRequest(
          req.method,
          req.path,
          status,
          duration,
          this.resolveMetricsContext(metricsProfileState, metricsTenantId)
        );
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
    const profileId = this.getProfileIdForRequest(req);

    if (!profileId) {
      this.respondProfileNotFound(res, req.profileId);
      return;
    }

    if (!sessionId) {
      const status = 400;
      res.status(status).json({ error: 'Bad Request', message: 'Mcp-Session-Id header required' });
      if (this.metrics) {
        const duration = (Date.now() - startTime) / 1000;
        this.metrics.recordHttpRequest(
          req.method,
          req.path,
          status,
          duration,
          this.resolveMetricsContext(undefined, null, profileId)
        );
      }
      return;
    }

    const profileState = this.profileStates.get(profileId);
    if (!profileState) {
      this.respondProfileNotFound(res, profileId);
      return;
    }

    const session = profileState.sessions.get(sessionId);
    if (!session) {
      const status = 404;
      res.status(status).json({ error: 'Not Found', message: 'Session not found' });
      if (this.metrics) {
        const duration = (Date.now() - startTime) / 1000;
        this.metrics.recordHttpRequest(
          req.method,
          req.path,
          status,
          duration,
          this.resolveMetricsContext(profileState, null)
        );
      }
      return;
    }

    this.destroySession(profileState, sessionId);
    const status = 204;
    res.status(status).send();
    
    if (this.metrics) {
      const duration = (Date.now() - startTime) / 1000;
      this.metrics.recordHttpRequest(
        req.method,
        req.path,
        status,
        duration,
        this.resolveMetricsContext(profileState, session.tenantId || null)
      );
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
    newSessionId: string | undefined
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
  private startSSEStream(
    res: Response,
    sessionId: string,
    lastEventId: string | undefined,
    profileState: ProfileRuntimeState
  ): void {
    res.setHeader('Content-Type', MIME_TYPES.EVENT_STREAM);
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const streamId = crypto.randomBytes(16).toString('hex');
    const session = profileState.sessions.get(sessionId)!;

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
  public sendToClient(profileId: string, sessionId: string, message: unknown): void {
    const session = this.profileStates.get(profileId)?.sessions.get(sessionId);
    if (!session) {
      this.logger.warn('Cannot send to client: session not found', { profileId, sessionId });
      return;
    }

    const eventId = Date.now();
    const queuedMessage: QueuedMessage = {
      eventId,
      data: message,
      timestamp: Date.now(),
    };

    // Send to all active streams for this session
    for (const streamState of session.sseStreams.values()) {
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
    const headerValue = req.headers['x-mcp4-params'];
    if (Array.isArray(headerValue)) {
      if (headerValue.length === 0) {
        return undefined;
      }
      if (headerValue.length > 1) {
        throw new ValidationError('Invalid X-Mcp4-Params header. Expected comma-separated key=value pairs.');
      }
      return headerValue[0];
    }
    return headerValue;
  }

  private getToolFilterHeaderValue(req: Request): string | undefined {
    const headerValue = req.headers['x-mcp4-tools'];
    if (Array.isArray(headerValue)) {
      if (headerValue.length === 0) {
        return undefined;
      }
      if (headerValue.length > 1) {
        throw new ValidationError('Invalid X-Mcp4-Tools header. Expected comma-separated tool names.');
      }
      return headerValue[0];
    }
    return headerValue;
  }


  private validateTenantHeaderValue(headerName: string, value: string): string {
    const trimmed = value.trim();
    if (!trimmed) {
      throw new ValidationError(`Invalid ${headerName} header. Value must not be empty.`);
    }
    if (trimmed.length > 256) {
      throw new ValidationError(`Invalid ${headerName} header. Value is too long.`);
    }
    if (/[\r\n]/.test(trimmed)) {
      throw new ValidationError(`Invalid ${headerName} header. Control characters are not allowed.`);
    }
    if (trimmed.includes(',')) {
      throw new ValidationError(`Invalid ${headerName} header. Multiple values are not allowed.`);
    }
    return trimmed;
  }

  private getTenantIdHeaderValue(req: Request): string | undefined {
    const headerValue = req.headers['x-mcp4-tenant-id'];
    if (Array.isArray(headerValue)) {
      if (headerValue.length === 0) {
        return undefined;
      }
      if (headerValue.length > 1) {
        throw new ValidationError('Invalid X-Mcp4-Tenant-Id header. Expected a single value.');
      }
      return this.validateTenantHeaderValue('X-Mcp4-Tenant-Id', headerValue[0]);
    }
    return headerValue ? this.validateTenantHeaderValue('X-Mcp4-Tenant-Id', headerValue) : undefined;
  }

  private getTenantBaseUrlHeaderValue(req: Request): string | undefined {
    const headerValue = req.headers['x-mcp4-api-base-url'];
    if (Array.isArray(headerValue)) {
      if (headerValue.length === 0) {
        return undefined;
      }
      if (headerValue.length > 1) {
        throw new ValidationError('Invalid X-Mcp4-Api-Base-Url header. Expected a single value.');
      }
      return this.validateTenantHeaderValue('X-Mcp4-Api-Base-Url', headerValue[0]);
    }
    return headerValue ? this.validateTenantHeaderValue('X-Mcp4-Api-Base-Url', headerValue) : undefined;
  }

  /**
   * Create new session
   *
   * Why: Stateful sessions for MCP protocol
   */
  private createSession(
    profileState: ProfileRuntimeState,
    authToken?: string,
    refreshToken?: string,
    accessTokenExpiresAt?: number,
    scopes?: string[],
    oauthClientId?: string,
    filtering?: Record<string, string[]>,
    filteringHeader?: string,
    toolFilterRequest?: SessionToolFilterRequest,
    toolFilterHeader?: string,
    tenantContext?: ResolvedTenantContext | null,
    tenantHeaderValue?: string
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
      toolFilterRequest,
      toolFilterHeader,
      tenantId: tenantContext?.tenantId,
      tenantBaseUrl: tenantContext?.tenantBaseUrl,
      tenantHeaderValue: tenantHeaderValue || tenantContext?.tenantBaseUrl,
      tenantAuthMode: tenantContext?.tenantAuthMode,
      tenantOAuthConfig: tenantContext?.tenantOAuthConfig,
      tenantAuthConfigs: tenantContext?.tenantAuthConfigs,
    };
    profileState.sessions.set(sessionId, session);
    this.logger.info('Session created', { 
      profileId: profileState.profileId,
      sessionId, 
      hasAuthToken: !!authToken,
      hasRefreshToken: !!refreshToken,
      hasExpiration: !!accessTokenExpiresAt,
    });

    // Record metrics
    if (this.metrics) {
      this.metrics.recordSessionCreated({
        profileId: profileState.profileId,
        tenantId: tenantContext?.tenantId || null,
      });
    }

    return sessionId;
  }

  /**
   * Update session activity timestamp
   */
  private updateSessionActivity(profileState: ProfileRuntimeState, sessionId: string): void {
    const session = profileState.sessions.get(sessionId);
    if (session) {
      session.lastActivityAt = Date.now();
    }
  }

  /**
   * Destroy session and cleanup resources
   * 
   * Why: Free memory, close streams
   */
  private destroySession(profileState: ProfileRuntimeState, sessionId: string): void {
    const session = profileState.sessions.get(sessionId);
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
        profileState.oauthTokensByAccessToken.delete(session.authToken);
      }

      const tenantOAuthProvider = this.getTenantOAuthProviderCache(profileState).get(sessionId);
      if (tenantOAuthProvider) {
        tenantOAuthProvider.cleanup();
        this.getTenantOAuthProviderCache(profileState).delete(sessionId);
      }
      
      profileState.sessions.delete(sessionId);
      this.logger.info('Session destroyed', { profileId: profileState.profileId, sessionId });
      
      // Notify session destruction listeners (for cleanup in MCPServer)
      this.notifySessionDestroyed(profileState.profileId, sessionId);
      
      // Record metrics
      if (this.metrics) {
        this.metrics.recordSessionDestroyed({
          profileId: profileState.profileId,
          tenantId: session.tenantId || null,
        });
        this.metrics.clearToolsSession(sessionId);
      }
    }
  }

  /**
   * Session destruction listeners for cleanup in other components
   */
  private sessionDestroyedListeners: Array<(profileId: string, sessionId: string) => void> = [];

  /**
   * Register listener for session destruction events
   * 
   * Why: Allows MCPServer to cleanup per-session HTTP clients
   */
  public onSessionDestroyed(listener: (profileId: string, sessionId: string) => void): void {
    this.sessionDestroyedListeners.push(listener);
  }

  /**
   * Notify all listeners about session destruction
   */
  private notifySessionDestroyed(profileId: string, sessionId: string): void {
    for (const listener of this.sessionDestroyedListeners) {
      try {
        listener(profileId, sessionId);
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
  private storeOAuthTokens(
    profileState: ProfileRuntimeState,
    tokens: OAuthTokens,
    clientId: string,
    scopes: string[]
  ): void {
    if (!tokens.access_token) {
      this.logger.warn('OAuth tokens missing access_token, skipping storage');
      return;
    }

    const expiresAt = tokens.expires_in 
      ? Date.now() + tokens.expires_in * 1000 
      : undefined;

    profileState.oauthTokensByAccessToken.set(tokens.access_token, {
      refreshToken: tokens.refresh_token,
      expiresAt,
      clientId,
      scopes,
    });

    this.logger.debug('Stored OAuth tokens', {
      profileId: profileState.profileId,
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
    const expiredSessions: Array<{ profileId: string; sessionId: string }> = [];
    
    // Default OAuth session timeout: 24 hours (or configurable)
    const oauthSessionTimeoutMs = this.config.oauthSessionTimeoutMs 
      ?? (24 * 60 * 60 * 1000); // 24 hours default

    for (const profileState of this.profileStates.values()) {
      // Cleanup OAuth provider resources (states, codes, tokens)
      if (profileState.oauthProvider) {
        profileState.oauthProvider.cleanup();
      }
      for (const tenantOAuthProvider of this.getTenantOAuthProviderCache(profileState).values()) {
        tenantOAuthProvider.cleanup();
      }

      for (const [sessionId, session] of profileState.sessions) {
        const age = now - session.lastActivityAt;
        
        // OAuth sessions with refresh tokens: use extended timeout or never expire
        if (session.refreshToken) {
          // If oauthSessionTimeoutMs is 0 or negative, never expire OAuth sessions
          if (oauthSessionTimeoutMs > 0 && age > oauthSessionTimeoutMs) {
            expiredSessions.push({ profileId: profileState.profileId, sessionId });
          }
        } else {
          // Non-OAuth sessions: use standard timeout
          if (age > this.config.sessionTimeoutMs) {
            expiredSessions.push({ profileId: profileState.profileId, sessionId });
          }
        }
      }
    }

    for (const entry of expiredSessions) {
      const state = this.profileStates.get(entry.profileId);
      if (state) {
        this.destroySession(state, entry.sessionId);
      }
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
  public getSessionToken(profileId: string, sessionId: string): string | undefined {
    const session = this.profileStates.get(profileId)?.sessions.get(sessionId);
    return session?.authToken;
  }

  public getSessionFiltering(profileId: string, sessionId: string): Record<string, string[]> | undefined {
    const session = this.profileStates.get(profileId)?.sessions.get(sessionId);
    return session?.filtering;
  }

  public getSessionFilteringHeader(profileId: string, sessionId: string): string | undefined {
    const session = this.profileStates.get(profileId)?.sessions.get(sessionId);
    return session?.filteringHeader;
  }

  public getSessionToolFilterRequest(profileId: string, sessionId: string): SessionToolFilterRequest | undefined {
    const session = this.profileStates.get(profileId)?.sessions.get(sessionId);
    return session?.toolFilterRequest;
  }

  public getSessionToolFilter(profileId: string, sessionId: string): SessionToolFilter | undefined {
    const session = this.profileStates.get(profileId)?.sessions.get(sessionId);
    return session?.toolFilter;
  }

  public getSessionToolFilterHeader(profileId: string, sessionId: string): string | undefined {
    const session = this.profileStates.get(profileId)?.sessions.get(sessionId);
    return session?.toolFilterHeader;
  }

  public getSessionTenantContext(profileId: string, sessionId: string): {
    tenantId?: string;
    tenantBaseUrl?: string;
    tenantAuthMode?: 'oauth' | 'token';
    tenantOAuthConfig?: OAuthConfig;
    tenantAuthConfigs?: AuthInterceptor[];
  } | undefined {
    const session = this.profileStates.get(profileId)?.sessions.get(sessionId);
    if (!session) {
      return undefined;
    }

    return {
      tenantId: session.tenantId,
      tenantBaseUrl: session.tenantBaseUrl,
      tenantAuthMode: session.tenantAuthMode,
      tenantOAuthConfig: session.tenantOAuthConfig,
      tenantAuthConfigs: session.tenantAuthConfigs,
    };
  }

  public setSessionToolFilter(profileId: string, sessionId: string, toolFilter: SessionToolFilter): void {
    const session = this.profileStates.get(profileId)?.sessions.get(sessionId);
    if (!session) {
      return;
    }
    session.toolFilter = toolFilter;
  }

  public recordGlobalToolFilterMetrics(summary: {
    originalCount: number;
    allowedCount: number;
    removedCount: number;
    patternCounts: Record<string, number>;
  }): void {
    if (!this.metrics) {
      return;
    }

    this.metrics.recordToolsTotal('profile', summary.originalCount);
    this.metrics.recordToolsFiltered('global_env', 'allowed', summary.allowedCount);
    this.metrics.recordToolsFiltered('global_env', 'denied', summary.removedCount);

    for (const [type, count] of Object.entries(summary.patternCounts)) {
      this.metrics.recordToolFilterPatternCount(type, count);
    }
  }

  public recordSessionToolFilterMetrics(
    sessionId: string,
    allowedCount: number,
    request: SessionToolFilterRequest
  ): void {
    if (!this.metrics) {
      return;
    }

    this.metrics.recordToolsSession(sessionId, allowedCount);
    this.metrics.recordToolFilterPatternCount('session_allow_list', request.exactNames.size);
    this.metrics.recordToolFilterPatternCount('session_allow_regex', request.regexPatterns.length);
  }

  public recordToolFilterRejection(tool: string, source: 'env' | 'session'): void {
    if (!this.metrics) {
      return;
    }
    this.metrics.recordToolFilterRejection(tool, source);
  }

  private resolveMetricsContext(
    profileState?: ProfileRuntimeState | null,
    tenantId?: string | null,
    profileId?: string | null
  ): MetricsContextLabels {
    const resolvedProfileId = profileState?.profileId || profileId || 'unknown';
    const resolvedTenantId = tenantId || 'none';
    return {
      profileId: resolvedProfileId,
      tenantId: resolvedTenantId,
    };
  }

  /**
   * Ensure session has a valid access token, refreshing if necessary
   * 
   * Why: Transparently refresh expired OAuth tokens before making API calls
   * Returns true if token is valid (or was successfully refreshed), false otherwise
   */
  public async ensureValidSessionToken(profileId: string, sessionId: string): Promise<boolean> {
    const profileState = this.profileStates.get(profileId);
    const session = profileState?.sessions.get(sessionId);
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
        profileId,
        sessionId,
        expiresAt: new Date(session.accessTokenExpiresAt).toISOString(),
        timeUntilExpiration,
      });
      return await this.refreshAccessToken(profileId, sessionId);
    }

    return true;
  }


  private getOAuthProviderForSession(profileState: ProfileRuntimeState, session: SessionData): ExternalOAuthProvider | null {
    if (session.tenantOAuthConfig) {
      const providerCache = this.getTenantOAuthProviderCache(profileState);
      const cachedProvider = providerCache.get(session.id);
      if (cachedProvider) {
        return cachedProvider;
      }
      const newProvider = new ExternalOAuthProvider(session.tenantOAuthConfig, this.logger);
      providerCache.set(session.id, newProvider);
      return newProvider;
    }
    return profileState.oauthProvider;
  }

  /**
   * Refresh access token using refresh token
   * 
   * Why: Automatically renew expired OAuth access tokens without user intervention
   * Returns true on success, false on failure
   */
  private async refreshAccessToken(profileId: string, sessionId: string): Promise<boolean> {
    const profileState = this.profileStates.get(profileId);
    const session = profileState?.sessions.get(sessionId);
    if (!profileState || !session || !session.refreshToken) {
      this.logger.warn('Cannot refresh token: missing session, refreshToken, or OAuth provider', {
        profileId,
        sessionId,
        hasSession: !!session,
        hasRefreshToken: !!session?.refreshToken,
        hasOAuthProvider: !!(profileState && session && (session.tenantOAuthConfig || profileState.oauthProvider)),
      });
      return false;
    }

    try {
      const oauthProvider = this.getOAuthProviderForSession(profileState, session);
      if (!oauthProvider) {
        return false;
      }
      // Get client from OAuth provider
      // Try to find client by clientId stored in session, or use default client
      let client;
      if (session.oauthClientId) {
        await oauthProvider.ensureEndpointsInitialized();
        client = await oauthProvider.clientsStore.getClient(session.oauthClientId);
      }

      // Fallback to default client from config if session client not found
      if (!client) {
        await oauthProvider.ensureEndpointsInitialized();
        // Try common client IDs
        const defaultClientIds = [PROXY_CREDENTIALS.CLIENT_ID];
        if (session.tenantOAuthConfig?.client_id) {
          defaultClientIds.unshift(session.tenantOAuthConfig.client_id);
        } else if (profileState.context.oauthConfig?.client_id) {
          defaultClientIds.unshift(profileState.context.oauthConfig.client_id);
        }
        
        for (const clientId of defaultClientIds) {
          client = await oauthProvider.clientsStore.getClient(clientId);
          if (client) break;
        }
      }

      if (!client) {
        this.logger.error('Cannot refresh token: OAuth client not found', undefined, {
          profileId,
          sessionId,
          oauthClientId: session.oauthClientId,
        });
        return false;
      }

      // Exchange refresh token for new tokens
      const tokens = await oauthProvider.exchangeRefreshToken(
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
        profileState.oauthTokensByAccessToken.delete(oldAccessToken);
      }
      this.storeOAuthTokens(profileState, tokens, client.client_id, session.scopes || []);

      this.logger.info('Access token refreshed successfully', {
        profileId,
        sessionId,
        newExpiresAt: session.accessTokenExpiresAt ? new Date(session.accessTokenExpiresAt).toISOString() : undefined,
      });

      return true;
    } catch (error) {
      this.logger.error('Token refresh failed', error instanceof Error ? error : new Error(String(error)), {
        profileId,
        sessionId,
      });
      return false;
    }
  }

  /**
   * Set message handler for processing incoming JSON-RPC messages
   */
  public setMessageHandler(handler: (message: unknown, sessionId?: string, profileId?: string) => Promise<unknown>): void {
    this.messageHandler = handler;
  }

  /**
   * Check if OAuth provider is configured
   */
  public hasOAuthProvider(profileId?: string): boolean {
    if (!profileId) {
      const defaultProfileId = this.getDefaultProfileId();
      if (!defaultProfileId) {
        return false;
      }
      const state = this.profileStates.get(defaultProfileId);
      return state ? state.oauthProvider !== null : false;
    }
    const state = this.profileStates.get(profileId);
    return state ? state.oauthProvider !== null : false;
  }

  /**
   * Get server URL
   */
  public getServerUrl(profileId?: string): string {
    return this.getServerOrigin(profileId);
  }

  /**
   * Get OAuth authorization URL
   */
  public getOAuthAuthorizationUrl(profileId?: string, sessionId?: string): string {
    if (profileId && sessionId) {
      const profileState = this.profileStates.get(profileId);
      const session = profileState?.sessions.get(sessionId);
      if (profileState && session) {
        const provider = this.getOAuthProviderForSession(profileState, session);
        if (provider) {
          return provider.authorizationEndpoint || '';
        }
      }
    }

    if (!profileId) {
      const defaultProfileId = this.getDefaultProfileId();
      if (!defaultProfileId) {
        return '';
      }
      return this.profileStates.get(defaultProfileId)?.oauthProvider?.authorizationEndpoint || '';
    }
    return this.profileStates.get(profileId)?.oauthProvider?.authorizationEndpoint || '';
  }

  /**
   * Get OAuth scopes
   */
  public getOAuthScopes(profileId?: string): string[] {
    if (!profileId) {
      const defaultProfileId = this.getDefaultProfileId();
      if (!defaultProfileId) {
        return [];
      }
      return this.profileStates.get(defaultProfileId)?.oauthProvider?.scopes || [];
    }
    return this.profileStates.get(profileId)?.oauthProvider?.scopes || [];
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
    for (const profileState of this.profileStates.values()) {
      for (const sessionId of profileState.sessions.keys()) {
        this.destroySession(profileState, sessionId);
      }
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
