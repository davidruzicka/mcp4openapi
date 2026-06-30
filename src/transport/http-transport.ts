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
  McpRequest,
  EnterpriseAuthorizationRuntimeConfig,
} from '../types/http-transport.js';
import { isInitializeRequest } from '../validation/jsonrpc-validator.js';
import { MetricsCollector } from '../core/metrics.js';
import type { UpstreamConnectionManager } from '../upstream/upstream-connection-manager.js';
import { UpstreamAuthError } from '../upstream/upstream-errors.js';
import type { MetricsContextLabels } from '../core/metrics.js';
import { ExternalOAuthProvider, isOAuthConfigOperational } from '../auth/oauth-provider.js';
import { encryptTokenPayload, decryptTokenPayload, isEncryptedToken, type TokenEnvelopePayload } from '../auth/token-envelope.js';
import { EnterpriseAuthProvider } from '../auth/enterprise-auth-provider.js';
import { InboundAuthTokenStore } from '../auth/inbound-auth-token-store.js';
import { EnterpriseReplayStore } from '../auth/enterprise-replay-store.js';
import { JwksCache } from '../auth/jwks-cache.js';
import { ClientAuthGate } from '../auth/client-auth-gate.js';
import type { AuthorizedPrincipal } from '../auth/inbound-auth-principal.js';
import { ClientAuthGateError } from '../core/errors.js';
import { buildAuthorizationServerMetadata, buildProtectedResourceMetadata } from '../auth/enterprise-metadata.js';
import { mapAuthError } from '../auth/auth-error-mapper.js';
import { redactAuthPayload } from '../auth/auth-redaction.js';
import { OAuthGrantRouter } from './oauth-grant-router.js';
import { SSRFValidator } from '../security/ssrf-validator.js';
import type { AuthInterceptor, OAuthConfig, UpstreamMcpServerConfig } from '../types/profile.js';
import { resolveClientAuthGateConfig } from '../profile/client-auth-gate-validator.js';
import {
  DEFAULT_ALLOWED_REDIRECT_HOSTS,
  HTTP_STATUS,
  MIME_TYPES,
  OAUTH_PATHS,
  TIMEOUTS,
  OAUTH_RATE_LIMIT,
  PROXY_CREDENTIALS,
} from '../core/constants.js';
import { escapeHtmlSafe, isSafePropertyName } from '../validation/validation-utils.js';
import type { OAuthClientInformationFull, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import {
  AuthenticationError,
  AuthorizationError,
  ConfigurationError,
  OAuthClientStoreCapacityError,
  RateLimitError,
  ValidationError,
  generateCorrelationId,
} from '../core/errors.js';
import { mergeFilteringRules, parseFilteringHeader, normalizeFilteringHeaderValue } from '../core/filtering.js';
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
const DEFAULT_MAX_TOKEN_LENGTH = 4096;
// Envelopes older than 30 days are rejected during restart-recovery to bound token lifetime at rest.
const MAX_ENVELOPE_AGE_MS = 30 * 24 * 60 * 60 * 1000;

interface ProfileRuntimeState {
  profileId: string;
  context: HttpProfileContext;
  oauthProvider: ExternalOAuthProvider | null;
  /**
   * Set when OAuth config is present but not operationally complete (missing env vars or
   * required fields). When set, oauthProvider is null and no OAuth challenge is sent.
   * Two independent checks: profile-resolver (HTML index) and http-transport (auth gate).
   * Both checks are intentional - profile-resolver filters the UI surface while
   * http-transport guards the runtime auth gate; they operate on different config shapes.
   */
  oauthDisabledReason?: string;
  enterpriseAuthProvider: EnterpriseAuthProvider | null;
  /**
   * Inbound client auth gate (Phase 3: API key path only). Constructed lazily
   * inside `getProfileState()` from `context.client_auth_gate`. Phase 4 will
   * widen this gate to cover JWT validation; the field stays the same.
   */
  clientAuthGate?: ClientAuthGate;
  toolFilterService?: ToolFilterService;
  oauthTokensByAccessToken: Map<string, { refreshToken?: string; expiresAt?: number; clientId: string; scopes: string[]; rawAccessToken?: string }>;
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
  private static readonly HTTP_ERROR_RESPONSE_RULES: ReadonlyArray<{
    ctor: new (...args: any[]) => Error;
    status: number;
    errorLabel: string;
    messagePrefix: string;
  }> = [
    {
      ctor: ValidationError,
      status: HTTP_STATUS.BAD_REQUEST,
      errorLabel: 'Bad Request',
      messagePrefix: 'Validation error',
    },
    {
      ctor: AuthenticationError,
      status: HTTP_STATUS.UNAUTHORIZED,
      errorLabel: 'Unauthorized',
      messagePrefix: 'Authentication failed',
    },
    {
      ctor: AuthorizationError,
      status: HTTP_STATUS.FORBIDDEN,
      errorLabel: 'Forbidden',
      messagePrefix: 'Authorization failed',
    },
    {
      ctor: RateLimitError,
      status: HTTP_STATUS.TOO_MANY_REQUESTS,
      errorLabel: 'Too Many Requests',
      messagePrefix: 'Rate limit exceeded',
    },
    {
      ctor: ClientAuthGateError,
      status: HTTP_STATUS.INTERNAL_SERVER_ERROR,
      errorLabel: 'Gateway Configuration Error',
      messagePrefix: 'Client auth gate misconfigured',
    },
  ];

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
  private profileAdminDescriptions: Map<string, string> | null = null;
  private ssrfValidator: SSRFValidator;
  private rawTenantConfig: HttpTenantsConfig | null;
  private readonly enterpriseRuntimeConfig: Required<EnterpriseAuthorizationRuntimeConfig>;
  private readonly inboundAuthTokenStore: InboundAuthTokenStore;
  private readonly enterpriseJwksCache: JwksCache;
  private readonly enterpriseReplayStore: EnterpriseReplayStore;
  private readonly enterpriseGrantAttemptsByProfile = new Map<string, number[]>();
  private readonly enterpriseGrantConcurrencyByProfile = new Map<string, number>();
  private upstreamConnectionManager: UpstreamConnectionManager | null = null;

  constructor(config: HttpTransportConfig, logger: Logger) {
    // Freeze config to prevent runtime mutation of security-critical settings (allowedOrigins, rate limits, etc.)
    this.config = Object.freeze({ ...config });
    this.logger = logger;
    if (!this.config.tokenKey) {
      this.logger.warn(
        'MCP4_OAUTH_KEY not set - encrypted token envelopes disabled. ' +
        'OAuth clients will need to re-authenticate after every gateway restart. ' +
        'Set MCP4_OAUTH_KEY (any passphrase, or a 64-char hex string) for restart-resilient OAuth.',
      );
    } else {
      const rawKey = process.env.MCP4_OAUTH_KEY?.trim();
      if (rawKey && !(rawKey.length === 64 && /^[0-9a-fA-F]+$/.test(rawKey))) {
        this.logger.warn(
          'MCP4_OAUTH_KEY is a passphrase (SHA-256 derived, no salt/work factor). ' +
          'Weak passphrases offer little protection. For production use a random hex key: openssl rand -hex 32',
        );
      }
    }
    this.ssrfValidator = new SSRFValidator(logger);
    this.rawTenantConfig = loadRawTenantsConfigFromEnv();
    this.enterpriseRuntimeConfig = this.resolveEnterpriseRuntimeConfig(config.enterpriseAuthorizationRuntimeConfig);
    this.inboundAuthTokenStore = new InboundAuthTokenStore({
      maxTokens: this.enterpriseRuntimeConfig.global_max_enterprise_tokens,
    });
    this.enterpriseJwksCache = new JwksCache({
      maxCachedIssuers: this.enterpriseRuntimeConfig.global_max_cached_issuers,
      maxCachedKeys: this.enterpriseRuntimeConfig.global_max_cached_jwks_keys,
      refreshTimeoutMs: this.enterpriseRuntimeConfig.jwks_refresh_timeout_ms,
      refreshBackoffMs: this.enterpriseRuntimeConfig.jwks_refresh_backoff_ms,
    }, logger);
    this.enterpriseReplayStore = new EnterpriseReplayStore({
      maxEntries: this.enterpriseRuntimeConfig.global_max_replay_entries,
    });
    
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

  private resolveEnterpriseRuntimeConfig(config?: EnterpriseAuthorizationRuntimeConfig): Required<EnterpriseAuthorizationRuntimeConfig> {
    return {
      enabled: config?.enabled ?? true,
      global_max_cached_jwks_keys: config?.global_max_cached_jwks_keys ?? 64,
      global_max_cached_issuers: config?.global_max_cached_issuers ?? 16,
      global_max_replay_entries: config?.global_max_replay_entries ?? 2048,
      global_max_enterprise_tokens: config?.global_max_enterprise_tokens ?? 2048,
      jwks_refresh_timeout_ms: config?.jwks_refresh_timeout_ms ?? 5000,
      jwks_refresh_backoff_ms: config?.jwks_refresh_backoff_ms ?? 1000,
      enterprise_grant_rate_limit_max: config?.enterprise_grant_rate_limit_max ?? 10,
      enterprise_grant_rate_limit_window_ms: config?.enterprise_grant_rate_limit_window_ms ?? 60_000,
      enterprise_grant_max_concurrency_per_profile: config?.enterprise_grant_max_concurrency_per_profile ?? 4,
    };
  }

  private enforceEnterpriseGrantRateLimit(profileId: string): void {
    const now = Date.now();
    const attempts = (this.enterpriseGrantAttemptsByProfile.get(profileId) || [])
      .filter((timestamp) => now - timestamp < this.enterpriseRuntimeConfig.enterprise_grant_rate_limit_window_ms);
    if (attempts.length >= this.enterpriseRuntimeConfig.enterprise_grant_rate_limit_max) {
      throw new RateLimitError('Enterprise token exchange rate limit exceeded');
    }
    attempts.push(now);
    this.enterpriseGrantAttemptsByProfile.set(profileId, attempts);
  }

  private acquireEnterpriseGrantConcurrency(profileId: string): void {
    const current = this.enterpriseGrantConcurrencyByProfile.get(profileId) || 0;
    if (current >= this.enterpriseRuntimeConfig.enterprise_grant_max_concurrency_per_profile) {
      throw new RateLimitError('Enterprise token exchange concurrency limit exceeded');
    }
    this.enterpriseGrantConcurrencyByProfile.set(profileId, current + 1);
  }

  private releaseEnterpriseGrantConcurrency(profileId: string): void {
    const current = this.enterpriseGrantConcurrencyByProfile.get(profileId) || 0;
    if (current <= 1) {
      this.enterpriseGrantConcurrencyByProfile.delete(profileId);
      return;
    }
    this.enterpriseGrantConcurrencyByProfile.set(profileId, current - 1);
  }

  setProfileIndexProvider(provider: (() => Promise<ListedProfileDetails[]>) | null): void {
    this.profileIndexProvider = provider;
  }

  setProfileAdminDescriptions(map: Map<string, string> | null): void {
    this.profileAdminDescriptions = map;
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
        const expectedHosts = new Set<string>(DEFAULT_ALLOWED_REDIRECT_HOSTS);
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
          body: redactAuthPayload(body)
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
      enterpriseAuthorization: this.config.enterpriseAuthorization,
      baseUrl: this.config.baseUrl,
      rateLimitOAuthMax: this.config.rateLimitOAuthMax,
      rateLimitOAuthWindowMs: this.config.rateLimitOAuthWindowMs,
      resourceName: this.config.resourceName,
      resourceDocumentation: this.config.resourceDocumentation,
      parser: this.config.parser,
      upstreamMcp: this.config.upstreamMcp,
      client_auth_gate: this.config.client_auth_gate,
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
    let oauthDisabledReason: string | undefined;

    if (context.oauthConfig) {
      // Pre-flight check before constructor to intercept synchronous throws from unresolved env vars.
      const { operational, missing } = isOAuthConfigOperational(context.oauthConfig);
      if (!operational) {
        oauthDisabledReason = `incomplete OAuth config, missing: ${missing.join(', ')}`;
      } else {
        this.logger.info('Initializing OAuth provider with config', {
          profileId,
          hasClientId: !!context.oauthConfig.client_id,
        });
        try {
          oauthProvider = new ExternalOAuthProvider(context.oauthConfig, this.logger);
          this.logger.info('OAuth provider initialized', {
            profileId,
            endpoint: oauthProvider.authorizationEndpoint || '(to be derived from issuer)',
            hasIssuer: !!context.oauthConfig.issuer,
          });
        } catch (err) {
          // Catches edge cases: env var changed between check and construction, etc.
          // Use a generic message — err.message from resolveEnvVars contains raw env var names.
          oauthDisabledReason = 'OAuth provider construction failed after pre-flight check (env var removed at runtime)';
        }
      }

      if (oauthDisabledReason) {
        this.logger.warn('OAuth config not operational - OAuth disabled for profile', {
          profileId,
          reason: oauthDisabledReason,
        });
      }
    } else {
      this.logger.info('No OAuth config provided - OAuth provider not initialized', { profileId });
    }

    const enterpriseAuthProvider = context.enterpriseAuthorization?.enabled && this.enterpriseRuntimeConfig.enabled
      ? new EnterpriseAuthProvider({
          profileId,
          config: context.enterpriseAuthorization,
          jwksCache: this.enterpriseJwksCache,
          replayStore: this.enterpriseReplayStore,
          logger: this.logger,
        })
      : null;

    const tenantIndex = this.config.tenantIndex || buildTenantIndexForProfile(this.rawTenantConfig, context, this.logger);

    const state: ProfileRuntimeState = {
      profileId,
      context,
      oauthProvider,
      oauthDisabledReason,
      enterpriseAuthProvider,
      oauthTokensByAccessToken: new Map(),
      sessions: new Map(),
      tenantIndex,
      tenantOAuthProvidersBySessionId: new Map(),
    };

    if (tenantIndex.enabled) {
      this.logger.info('HTTP tenant configuration enabled', { profileId, tenantCount: tenantIndex.byTenantId.size });
    }

    // Construct the client auth gate when the profile context carries config.
    // No JwksCache injection in Phase 3 — the API key path does not need it.
    // Phase 4 will pass `this.enterpriseJwksCache` (or a dedicated cache) here
    // when the JWT path lands.
    if (context.client_auth_gate) {
      // Normalize config before construction: resolves mode_from_env, validates
      // api_keys env vars. In the profile-loader path this is a no-op (validator
      // already ran at load time and mode is a literal string). For direct
      // HttpTransport construction the call provides the same fail-fast guarantees.
      // Wrap in try/catch so a misconfigured gate produces a clear error log and a
      // descriptive 500 (via the handlePost outer catch) rather than a generic one.
      try {
        const gateConfig = resolveClientAuthGateConfig(context.client_auth_gate);
        state.clientAuthGate = new ClientAuthGate(profileId, gateConfig, this.logger);
        this.logger.info('Client auth gate initialized', {
          profileId,
          mode: gateConfig.mode,
          hasApiKeys: !!gateConfig.api_keys,
        });
      } catch (err) {
        this.logger.error(
          'Client auth gate configuration error — profile will be unavailable',
          err instanceof Error ? err : new Error(String(err)),
          { profileId },
        );
        throw err;
      }
    }

    this.profileStates.set(profileId, state);
    return state;
  }

  private hasTrustedEnterpriseToken(
    profileId: string,
    token: string | undefined,
    tenantId?: string,
  ): boolean {
    if (!token) {
      return false;
    }

    const internalToken = this.inboundAuthTokenStore.get(token);
    if (!internalToken || internalToken.principal.authType !== 'enterprise' || internalToken.principal.profileId !== profileId) {
      return false;
    }

    if (tenantId && internalToken.principal.tenantId && internalToken.principal.tenantId !== tenantId) {
      return false;
    }

    return true;
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

    // Readiness probe - unauthenticated, distinct from /health (liveness).
    // Shallow readiness check: verifies at least one profile is loaded; does not probe
    // upstream connectivity, spec parsing, or auth token presence.
    // Startup validation in index.ts guarantees at least one profile exists before
    // listen() is called, so profileStates.size > 0 is the correct readiness condition.
    this.app.get('/ready', mcpRateLimiter, (req: Request, res: Response) => {
      const startTime = Date.now();
      const profilesInitialized = this.profileStates.size;
      const ready = profilesInitialized > 0;
      const statusCode = ready ? 200 : 503;
      res.status(statusCode).json(
        ready
          ? { status: 'ready', profiles: profilesInitialized }
          : { status: 'not ready', reason: 'no profiles loaded' }
      );

      if (this.metrics) {
        const duration = (Date.now() - startTime) / 1000;
        // Pass the local statusCode (not res.statusCode) to avoid any race with res state.
        this.metrics.recordHttpRequest(req.method, req.path, statusCode, duration, {
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
    const { payload, templateData } = buildProfileIndexPayload(
      profilesWithTenantSummary,
      origin,
      locale,
      this.profileAdminDescriptions ?? undefined
    );

    if (prefersJson) {
      const safePayload = {
        ...payload,
        profiles: payload.profiles.map(({ adminDescription: _omit, ...rest }) => rest),
      };
      res.json(safePayload);
      return;
    }

    const template = await loadProfileIndexTemplate();
    const nonce = crypto.randomBytes(16).toString('base64');
    const html = renderProfileIndexHtml(template, templateData, nonce);

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader(
      'Content-Security-Policy',
      `default-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'nonce-${nonce}'; img-src 'self' data:; connect-src 'none'`
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
    if (!profileState.oauthProvider && !profileState.context.enterpriseAuthorization?.enabled) {
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

    if (profileState.oauthProvider?.scopes && profileState.oauthProvider.scopes.length > 0) {
      metadata.scopes_supported = profileState.oauthProvider.scopes;
    }

    if (profileState.context.resourceName) {
      metadata.resource_name = profileState.context.resourceName;
    }

    if (profileState.context.resourceDocumentation) {
      metadata.resource_documentation = profileState.context.resourceDocumentation;
    }

    res.json(buildProtectedResourceMetadata(metadata, profileState.context.enterpriseAuthorization));
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
      const client = await this.resolveOAuthClientForRequest(profileState, client_id, redirect_uri);
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
    const enterpriseEnabled = profileState.context.enterpriseAuthorization?.enabled === true;
    if (!profileState.oauthProvider && !enterpriseEnabled) {
      res.status(HTTP_STATUS.NOT_FOUND).json({ error: 'server_error', error_description: 'OAuth provider not initialized' });
      return;
    }

    const grantType = typeof req.body?.grant_type === 'string' ? req.body.grant_type : undefined;
    if (grantType === 'urn:ietf:params:oauth:grant-type:jwt-bearer' && !this.isFormUrlEncodedRequest(req)) {
      res.status(HTTP_STATUS.BAD_REQUEST).json({
        error: 'invalid_request',
        error_description: 'Content-Type must be application/x-www-form-urlencoded',
      });
      return;
    }

    const router = new OAuthGrantRouter();

    router.register('authorization_code', {
      required: ['code', 'client_id'],
      optional: ['redirect_uri', 'client_secret', 'code_verifier', 'resource', 'scope', 'client_assertion', 'client_assertion_type'],
      handler: async (request, response) => {
        if (!profileState.oauthProvider) {
          response.status(HTTP_STATUS.NOT_FOUND).json({ error: 'server_error', error_description: 'OAuth provider not initialized' });
          return;
        }
        try {
          await profileState.oauthProvider.ensureEndpointsInitialized();
          const client = await this.validateOAuthClientCredentials(profileState, request.body.client_id, request.body.client_secret, response);
          if (!client) {
            return;
          }
          const tokens = await profileState.oauthProvider.exchangeAuthorizationCode(client, request.body.code, request.body.code_verifier, request.body.redirect_uri);
          // Fetch the registered client so creg can be embedded for restart-resilient session recovery.
          const registeredClient = await profileState.oauthProvider.clientsStore.getClient(client.client_id);
          const clientToken = this.storeOAuthTokens(profileState, tokens, client.client_id, client.scope?.split(' ') || [], registeredClient ?? undefined);
          response.json(
            clientToken !== tokens.access_token
              ? { ...tokens, access_token: clientToken }
              : tokens,
          );
        } catch {
          response.status(HTTP_STATUS.BAD_REQUEST).json({ error: 'invalid_grant', error_description: 'Token exchange failed' });
        }
      },
    });

    router.register('refresh_token', {
      required: ['refresh_token', 'client_id'],
      optional: ['client_secret', 'resource', 'scope', 'client_assertion', 'client_assertion_type'],
      handler: async (request, response) => {
        if (!profileState.oauthProvider) {
          response.status(HTTP_STATUS.NOT_FOUND).json({ error: 'server_error', error_description: 'OAuth provider not initialized' });
          return;
        }
        try {
          await profileState.oauthProvider.ensureEndpointsInitialized();
          const client = await this.validateOAuthClientCredentials(profileState, request.body.client_id, request.body.client_secret, response);
          if (!client) {
            return;
          }
          const tokens = await profileState.oauthProvider.exchangeRefreshToken(client, request.body.refresh_token);
          const registeredClient = await profileState.oauthProvider.clientsStore.getClient(client.client_id);
          const clientToken = this.storeOAuthTokens(profileState, tokens, client.client_id, client.scope?.split(' ') || [], registeredClient ?? undefined);
          response.json(
            clientToken !== tokens.access_token
              ? { ...tokens, access_token: clientToken }
              : tokens,
          );
        } catch {
          response.status(HTTP_STATUS.BAD_REQUEST).json({ error: 'invalid_grant', error_description: 'Token exchange failed' });
        }
      },
    });

    router.register('urn:ietf:params:oauth:grant-type:jwt-bearer', {
      required: ['assertion'],
      optional: ['client_id', 'scope'],
      handler: async (request, response) => {
        if (!profileState.enterpriseAuthProvider || !profileState.context.enterpriseAuthorization?.enabled) {
          response.status(HTTP_STATUS.BAD_REQUEST).json({ error: 'unsupported_grant_type' });
          return;
        }
        this.enforceEnterpriseGrantRateLimit(profileState.profileId);
        this.acquireEnterpriseGrantConcurrency(profileState.profileId);
        try {
          const principal = await profileState.enterpriseAuthProvider.validateAssertion(request.body.assertion, request.body.client_id);
          const issuedToken = this.inboundAuthTokenStore.issue(principal);
          profileState.oauthTokensByAccessToken.set(issuedToken.token, {
            expiresAt: principal.expiresAt,
            clientId: principal.clientId ?? request.body.client_id ?? 'enterprise-client',
            scopes: principal.scopes,
          });
          this.metrics?.recordApiCall('enterprise_token_exchange', 200, 0, { profileId: profileState.profileId, tenantId: principal.tenantId ?? null });
          response.json({
            access_token: issuedToken.token,
            token_type: 'Bearer',
            expires_in: principal.expiresAt ? Math.max(1, Math.floor((principal.expiresAt - Date.now()) / 1000)) : undefined,
            scope: principal.scopes.join(' '),
          });
        } catch (error) {
          this.metrics?.recordApiCallError('enterprise_token_exchange', error instanceof Error ? error.name : 'UnknownError', { profileId: profileState.profileId, tenantId: null });
          throw error;
        } finally {
          this.releaseEnterpriseGrantConcurrency(profileState.profileId);
        }
      },
    });

    try {
      res.setHeader('Cache-Control', 'no-store');
      await router.route(req, res);
    } catch (error) {
      const mapped = mapAuthError(error);
      this.logger.error('OAuth token exchange error', error instanceof Error ? error : new Error(String(error)), { correlationId: mapped.correlationId });
      res.status(mapped.status).json(mapped.body);
    }
  }

  private isFormUrlEncodedRequest(req: Request): boolean {
    if (typeof req.is === 'function') {
      return Boolean(req.is('application/x-www-form-urlencoded'));
    }

    const contentType = typeof req.headers['content-type'] === 'string'
      ? req.headers['content-type']
      : Array.isArray(req.headers['content-type'])
        ? req.headers['content-type'][0]
        : undefined;

    if (!contentType) {
      return false;
    }

    return contentType.toLowerCase().includes('application/x-www-form-urlencoded');
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
    clientId: string,
    redirectUri?: string,
  ): Promise<OAuthClientInformationFull | undefined> {
    if (!profileState.oauthProvider) {
      return undefined;
    }

    const shouldTryUnregisteredProvisioning =
      typeof redirectUri === 'string'
      && redirectUri.length > 0
      && typeof profileState.oauthProvider.getOrProvisionUnregisteredClient === 'function';

    const client = await profileState.oauthProvider.clientsStore.getClient(clientId);
    if (client) {
      if (
        shouldTryUnregisteredProvisioning
        && typeof profileState.oauthProvider.hasMaterializedUnregisteredClient === 'function'
        && profileState.oauthProvider.hasMaterializedUnregisteredClient(clientId)
      ) {
        return profileState.oauthProvider.getOrProvisionUnregisteredClient(clientId, redirectUri);
      }
      return client;
    }

    // Compatibility fallback: allow legacy hardcoded VS Code client id
    // even when MCP_PROXY_CLIENT_ID is overridden in environment.
    if (clientId === 'mcp-proxy-client' && PROXY_CREDENTIALS.CLIENT_ID !== 'mcp-proxy-client') {
      return profileState.oauthProvider.clientsStore.getClient(PROXY_CREDENTIALS.CLIENT_ID);
    }

    if (shouldTryUnregisteredProvisioning) {
      return profileState.oauthProvider.getOrProvisionUnregisteredClient(clientId, redirectUri);
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

      const metadata = {
        issuer,
        authorization_endpoint: this.buildProfileUrl(profileId, OAUTH_PATHS.AUTHORIZE, urlOptions),
        token_endpoint: this.buildProfileUrl(profileId, OAUTH_PATHS.TOKEN, urlOptions),
        registration_endpoint: this.buildProfileUrl(profileId, OAUTH_PATHS.REGISTER, urlOptions),
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        scopes_supported: profileState.oauthProvider?.scopes || profileState.context.enterpriseAuthorization?.access_policy?.scopes_supported || ['api'],
      };
      res.json(buildAuthorizationServerMetadata(metadata, profileState.context.enterpriseAuthorization));
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
      if (error instanceof OAuthClientStoreCapacityError) {
        const correlationId = generateCorrelationId();
        this.logger.warn('Client registration rejected: OAuth client store at capacity', {
          profileId: profileState.profileId,
          correlationId,
          details: error.details,
        });
        res.status(HTTP_STATUS.TOO_MANY_REQUESTS).json({
          error: 'temporarily_unavailable',
          error_description: error.message,
          correlationId,
        });
        return;
      }

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
      const { status, errorLabel, message } = this.buildHttpErrorResponse(error, correlationId);
      res.setHeader('Cache-Control', 'no-store');
      res.status(status).json({
        error: errorLabel,
        message,
        correlationId
      });
    }
  }

  /**
   * Validate authentication token by making a probe request to the API
   * 
   * Supports all auth types: bearer, token, query, custom-header
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
      
      case 'token':
        headers['Authorization'] = `Token ${token}`;
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

  /**
   * Validate a raw header value used as a credential (custom-header auth).
   *
   * Why separate from validateToken: custom-header values may include a scheme prefix
   * with a space (e.g. DRF "Token <api-key>", AWS "AWS4-HMAC-SHA256 ..."). Stripping the
   * prefix before storage would break upstream forwarding, so we allow a single internal
   * space while still blocking header-injection characters (CR, LF, NUL).
   */
  private validateRawHeaderCredential(value: string, source: string): void {
    const maxLength = this.config.maxTokenLength ?? DEFAULT_MAX_TOKEN_LENGTH;
    if (value.length > maxLength) {
      throw new ValidationError(`${source} too long (max ${maxLength} characters)`);
    }
    if (value.trim().length === 0) {
      throw new ValidationError(`${source} is empty`);
    }
    // Block characters that could enable header injection: CR, LF, NUL
    if (/[\r\n\0]/.test(value)) {
      throw new ValidationError(`Invalid ${source} format`);
    }
  }

  private hasServerEnvAuthToken(authConfigs?: AuthInterceptor[]): boolean {
    if (!authConfigs || authConfigs.length === 0) {
      return false;
    }

    return authConfigs.some((config) => {
      if (config.type === 'session-cookie' && config.session_cookie_config) {
        const username = process.env[config.session_cookie_config.username_from_env];
        const password = process.env[config.session_cookie_config.password_from_env];
        return typeof username === 'string' && username.trim().length > 0
          && typeof password === 'string' && password.trim().length > 0;
      }

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
  ): { authConfigs: AuthInterceptor[]; oauthConfig?: OAuthConfig; enterpriseAuthorization?: HttpProfileContext['enterpriseAuthorization'] } {
    if (resolvedTenant) {
      return {
        authConfigs: resolvedTenant.tenantAuthConfigs,
        oauthConfig: resolvedTenant.tenantOAuthConfig,
        enterpriseAuthorization: profileState.context.enterpriseAuthorization,
      };
    }
    if (session && session.tenantAuthMode) {
      return {
        authConfigs: session.tenantAuthConfigs || [],
        oauthConfig: session.tenantOAuthConfig,
        enterpriseAuthorization: profileState.context.enterpriseAuthorization,
      };
    }
    return {
      authConfigs: profileState.context.authConfigs || [],
      oauthConfig: profileState.context.oauthConfig,
      enterpriseAuthorization: profileState.context.enterpriseAuthorization,
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
  ): { type: 'bearer' | 'token' | 'oauth' | 'api-token' | 'none', token?: string, sessionId?: string } {
    const sessionId = req.sessionId || req.headers['mcp-session-id'] as string | undefined;
    const session = sessionId ? profileState.sessions.get(sessionId) : undefined;
    const authConfigs = authConfigOverride ?? profileState.context.authConfigs;
    const configs = authConfigs ? (Array.isArray(authConfigs) ? authConfigs : [authConfigs]) : [];
    const hasOAuth = authConfigOverride
      ? configs.some((config) => config.type === 'oauth')
      : (!!profileState.oauthProvider || configs.some((config) => config.type === 'oauth'));

    // 1. Check Authorization header — Bearer first, then Token (DRF-style), then custom-header fallback
    const authHeader = req.headers.authorization;
    if (authHeader) {
      const maxHeaderLength = (this.config.maxTokenLength ?? DEFAULT_MAX_TOKEN_LENGTH) + 10;
      if (authHeader.length > maxHeaderLength) {
        throw new ValidationError(`Authorization header too long (max ${maxHeaderLength} characters)`);
      }
      const trimmed = authHeader.trim();

      const bearerMatch = trimmed.match(/^Bearer\s+(.+)$/);
      if (bearerMatch) {
        const token = bearerMatch[1].trim();
        this.validateToken(token, 'Authorization token');
        return { type: 'bearer', token };
      }

      // DRF Token auth: Authorization: Token <key>
      const hasTokenAuth = configs.some(c => c.type === 'token');
      if (hasTokenAuth) {
        const tokenMatch = trimmed.match(/^Token\s+(.+)$/i);
        if (tokenMatch) {
          const token = tokenMatch[1].trim();
          this.validateToken(token, 'Authorization token');
          return { type: 'token', token };
        }
      }

      // Custom-header on Authorization: accept raw value verbatim
      const hasAuthCustomHeader = configs.some(
        c => c.type === 'custom-header' && c.header_name?.toLowerCase() === 'authorization',
      );
      if (hasAuthCustomHeader) {
        this.validateRawHeaderCredential(trimmed, 'Authorization');
        return { type: 'api-token', token: trimmed };
      }

      throw new ValidationError('Invalid Authorization header format. Expected: Bearer <token>');
    }

    // 2. Check configured non-Authorization custom headers
    if (configs.length > 0) {
      const sortedConfigs = [...configs].sort((a, b) => (a.priority || 0) - (b.priority || 0));
      const customHeaderConfig = sortedConfigs.find(
        c => c.type === 'custom-header' && c.header_name && c.header_name.toLowerCase() !== 'authorization',
      );
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
          this.validateRawHeaderCredential(headerValue, customHeaderConfig.header_name);
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
    let metricsRecorded = false;
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
          const internalToken = authInfo.token
            ? this.inboundAuthTokenStore.get(authInfo.token)
            : undefined;
          this.logger.debug('Auth token extracted', { authType: authInfo?.type, hasToken: !!authInfo?.token });

          // If OAuth is configured (and operational), require authentication for initialization
          // This ensures clients like Cursor properly handle OAuth flow.
          // Two-part operational check: profile-level uses cached oauthDisabledReason;
          // effectiveAuthContext.oauthConfig may be a tenant-specific config (different object
          // from profile-level), so run isOAuthConfigOperational on it directly.
          const oauthActive = !!effectiveAuthContext.oauthConfig &&
            !profileState.oauthDisabledReason &&
            isOAuthConfigOperational(effectiveAuthContext.oauthConfig).operational;
          if (oauthActive && !authInfo.token) {
            this.logger.debug('OAuth configured but no token provided, triggering OAuth flow');
            const resourceMetadataUrl = this.getOAuthProtectedResourceUrl(requestProfileId);
            const scopeValue = effectiveAuthContext.oauthConfig?.scopes?.join(' ') || 'api';
            res.setHeader('WWW-Authenticate', `Bearer resource_metadata="${resourceMetadataUrl}", scope="${scopeValue}"`);
            res.status(HTTP_STATUS.UNAUTHORIZED).json({
              error: 'Unauthorized',
              message: 'Authentication required for OAuth'
            });
            return;
          }

          if (effectiveAuthContext.enterpriseAuthorization?.enabled && effectiveAuthContext.enterpriseAuthorization.mode === 'required') {
            if (!this.hasTrustedEnterpriseToken(requestProfileId, authInfo.token, resolvedTenant?.tenantId)) {
              const resourceMetadataUrl = this.getOAuthProtectedResourceUrl(requestProfileId);
              const scopeValue = effectiveAuthContext.enterpriseAuthorization.access_policy?.scopes_supported?.join(' ') || 'api';
              res.setHeader('WWW-Authenticate', `Bearer resource_metadata="${resourceMetadataUrl}", scope="${scopeValue}"`);
              res.status(HTTP_STATUS.UNAUTHORIZED).json({
                error: 'Unauthorized',
                message: 'Enterprise authorization required'
              });
              return;
            }
          }

          // CLIENT AUTH GATE (AUTH-02, AUTH-03 partial — Phase 3)
          //
          // Runs AFTER the enterprise auth check (so enterprise tokens still
          // gate first when configured) and BEFORE the authConfigs token guard
          // below. Placement matters: when mode='optional' the gate must be
          // able to allow anonymous sessions even if authConfigs are present
          // (the gate is the inbound auth authority once configured), so we
          // also bypass that downstream guard when the gate is present.
          let resolvedClientPrincipal: AuthorizedPrincipal | undefined;
          if (profileState.clientAuthGate) {
            try {
              const gatePrincipal = await profileState.clientAuthGate.validate(authInfo.token);
              resolvedClientPrincipal = gatePrincipal ?? undefined;
            } catch (err) {
              // ALL gate exceptions map to 401 to avoid leaking validator
              // internals (e.g., upstream Sasanka HTTP body) to clients.
              const isClientAuthGateError = err instanceof ClientAuthGateError;
              this.logger.warn('Client auth gate rejected session init', {
                profileId: requestProfileId,
                error: err instanceof Error ? err.message : String(err),
                errorType: isClientAuthGateError ? 'ClientAuthGateError' : 'unknown',
                ...(isClientAuthGateError ? {} : { errorStack: err instanceof Error ? err.stack : undefined }),
              });
              res.status(HTTP_STATUS.UNAUTHORIZED).json({
                error: 'Unauthorized',
                message: 'Client authentication failed',
              });
              return;
            }
          }

          // Require a client token only when auth is configured and server env fallback is unavailable.
          // Skip this guard when the client auth gate is configured — the gate is the inbound auth authority,
          // and mode='optional' must be able to allow anonymous sessions independently of authConfigs.
          const authConfigs = effectiveAuthContext.authConfigs;
          if (!profileState.clientAuthGate && authConfigs.length > 0 && !authInfo.token && !this.hasServerEnvAuthToken(authConfigs)) {
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
          if (!profileState.clientAuthGate && authInfo && authInfo.token && !internalToken && authConfigs.length > 0 && (resolvedTenant?.tenantBaseUrl || profileState.context.baseUrl)) {
            // Find exact type match and oauth fallback in one pass.
            // When oauth is active, bearer tokens may be OAuth access tokens (Cursor/VS Code
            // send them via Authorization header on initialize) — oauth config takes priority.
            // When oauth is not active, exact type match wins so PATs use the bearer config's
            // endpoint (may require fewer scopes); oauth config is still the fallback when no
            // bearer config exists.
            const isAuthBearer = authInfo.type === 'bearer';
            let exactMatch: AuthInterceptor | undefined;
            let oauthFallback: AuthInterceptor | undefined;
            for (const c of authConfigs) {
              if (c.type === authInfo.type) exactMatch ??= c;
              else if (isAuthBearer && c.type === 'oauth') oauthFallback ??= c;
              if (exactMatch && oauthFallback) break;
            }
            const authConfig = oauthActive ? (oauthFallback ?? exactMatch) : (exactMatch ?? oauthFallback);
            
            if (authConfig && authConfig.validation_endpoint) {
              // When the client presents an envelope token (mcp4.v1.*), decrypt it first and
              // validate the inner access_token against the upstream endpoint. Sending the raw
              // envelope string would fail because the IdP only knows its own token format.
              // Plain tokens pass through unchanged. Decrypt failure falls through to the raw
              // envelope string, which the IdP will reject — correct rejection behavior.
              let tokenToValidate = authInfo.token;
              const tokenShape = isEncryptedToken(authInfo.token) ? 'envelope' : 'plain';
              if (this.config.tokenKey && isEncryptedToken(authInfo.token)) {
                const envelope = decryptTokenPayload(
                  authInfo.token,
                  this.config.tokenKey,
                  profileState.profileId,
                );
                if (envelope) {
                  tokenToValidate = envelope.at;
                }
              }

              this.logger.info('Validating auth token during initialization', {
                authType: authConfig.type,
                endpoint: authConfig.validation_endpoint,
                tokenShape,
              });

              const isValid = await this.validateAuthToken(authConfig, tokenToValidate, resolvedTenant?.tenantBaseUrl || profileState.context.baseUrl || '');

              if (!isValid) {
                this.logger.warn('Auth token validation failed during initialization', {
                  authType: authInfo.type,
                  tokenShape,
                });
                // When OAuth is active, return HTTP 401 with WWW-Authenticate so OAuth-aware
                // clients (e.g. Cursor) trigger re-auth automatically instead of surfacing a
                // generic error. Without OAuth, fall back to the JSON-RPC error form.
                if (oauthActive) {
                  const resourceMetadataUrl = this.getOAuthProtectedResourceUrl(requestProfileId);
                  const scopeValue = effectiveAuthContext.oauthConfig?.scopes?.join(' ') || 'api';
                  res.setHeader('WWW-Authenticate', `Bearer resource_metadata="${resourceMetadataUrl}", scope="${scopeValue}"`);
                  res.status(HTTP_STATUS.UNAUTHORIZED).json({
                    error: 'Unauthorized',
                    message: 'Supplied authentication token is invalid or expired',
                  });
                } else {
                  this.sendInitializeJsonRpcError(
                    res,
                    body,
                    'Supplied authentication token is invalid or expired',
                  );
                }
                return;
              }

              this.logger.info('Auth token validation successful', { tokenShape });
            }
          }

          // Validate server-side env token when client provided no token.
          // Fail-fast: surface invalid/expired env tokens at session init rather than
          // at first tool call, avoiding misleading successful connections.
          if (!profileState.clientAuthGate && !authInfo.token && authConfigs.length > 0
            && (resolvedTenant?.tenantBaseUrl || profileState.context.baseUrl)) {
            for (const config of authConfigs) {
              if (!config.value_from_env || !config.validation_endpoint) continue;
              const envToken = process.env[config.value_from_env]?.trim();
              if (!envToken) continue;

              this.logger.info('Validating server-side env auth token during initialization', {
                authType: config.type,
                endpoint: config.validation_endpoint,
              });
              const isValid = await this.validateAuthToken(
                config,
                envToken,
                resolvedTenant?.tenantBaseUrl || profileState.context.baseUrl || '',
              );
              if (!isValid) {
                this.logger.warn('Server-side env auth token validation failed during initialization', {
                  authType: config.type,
                });
                this.sendInitializeJsonRpcError(
                  res,
                  body,
                  'Configured server-side authentication token is invalid or expired',
                );
                return;
              }
              this.logger.info('Server-side env auth token validation successful', {
                authType: config.type,
              });
              break; // validate highest-priority config with validation_endpoint only
            }
          }

          // Validate upstream credentials if upstream_mcp.validation_endpoint is set
          const upstreamProvider = profileState.context.upstreamMcp;
          if (this.upstreamConnectionManager && upstreamProvider?.validation_endpoint) {
            try {
              // Use only the verified client token. env-backed upstream credentials are
              // never forwarded in HTTP mode (getUpstreamToken throws for unauthenticated
              // HTTP sessions) — falling back to envToken here would expose upstream
              // reachability and credential validity to unauthenticated callers.
              const effectiveUpstreamToken = authInfo?.token;
              await this.upstreamConnectionManager.validateCredentials(
                undefined,
                upstreamProvider,
                effectiveUpstreamToken,
              );
              if (effectiveUpstreamToken) {
                this.logger.info('Upstream credential validation successful', {
                  provider: upstreamProvider.name,
                });
              } else {
                this.logger.debug('Upstream credential validation skipped - no client token present', {
                  provider: upstreamProvider.name,
                });
              }
            } catch (error) {
              this.logger.warn('Upstream credential validation failed', {
                provider: upstreamProvider.name,
                error: error instanceof Error ? error.message : String(error),
              });
              if (error instanceof UpstreamAuthError) {
                res.status(HTTP_STATUS.UNAUTHORIZED).json({
                  error: 'Unauthorized',
                  message: 'Upstream authentication failed',
                });
                return;
              }
              // SSRF, timeout, or connection errors - return 502 Bad Gateway
              res.status(502).json({
                error: 'Bad Gateway',
                message: 'Upstream credential validation failed',
              });
              return;
            }
          }

          // Look up OAuth tokens if this is an OAuth token
          let refreshToken: string | undefined;
          let accessTokenExpiresAt: number | undefined;
          let scopes: string[] | undefined;
          let oauthClientId: string | undefined;
          let recoveredEnvelope: TokenEnvelopePayload | null = null;
          
          if (authInfo.token && (authInfo.type === 'oauth' || authInfo.type === 'bearer')) {
            if (internalToken) {
              if (internalToken.principal.profileId !== requestProfileId) {
                throw new AuthenticationError('Enterprise token is not valid for this profile');
              }
              if (internalToken.principal.tenantId && resolvedTenant?.tenantId && internalToken.principal.tenantId !== resolvedTenant.tenantId) {
                throw new AuthenticationError('Enterprise token is not valid for this tenant');
              }
              accessTokenExpiresAt = internalToken.expiresAt;
              scopes = internalToken.principal.scopes;
              oauthClientId = internalToken.principal.clientId;
            }
            const tokenData = profileState.oauthTokensByAccessToken.get(authInfo.token);
            if (tokenData) {
              refreshToken = tokenData.refreshToken;
              accessTokenExpiresAt = tokenData.expiresAt ?? accessTokenExpiresAt;
              scopes = tokenData.scopes;
              oauthClientId = tokenData.clientId;
              this.logger.debug('Found OAuth token data for session', {
                hasRefreshToken: !!refreshToken,
                hasExpiration: !!accessTokenExpiresAt,
                scopesCount: scopes.length,
              });
            } else if (!internalToken) {
              this.logger.debug('No OAuth token data found in map (may be non-OAuth bearer token)', {
                hasToken: true,
              });
            }

            // Restart-recovery path: if both Map lookups missed AND we hold a token-envelope key
            // AND the token has the mcp4.v1.* prefix, attempt to decrypt and rehydrate session
            // metadata (refresh token, expiry, scopes, client_id, optional client registration)
            // directly from the envelope. This is the only path that lets a client survive a
            // gateway restart without re-running the OAuth browser flow.
            if (
              !internalToken &&
              !tokenData &&
              this.config.tokenKey &&
              isEncryptedToken(authInfo.token)
            ) {
              const envelope = decryptTokenPayload(
                authInfo.token,
                this.config.tokenKey,
                profileState.profileId,
              );
              if (envelope) {
                // Issue #3: reject stale envelopes to bound token lifetime at rest.
                if (Date.now() - envelope.iat > MAX_ENVELOPE_AGE_MS) {
                  this.logger.warn('Encrypted token envelope expired (iat too old)', {
                    profileId: profileState.profileId,
                    ageMs: Date.now() - envelope.iat,
                    maxAgeMs: MAX_ENVELOPE_AGE_MS,
                  });
                  res.status(HTTP_STATUS.UNAUTHORIZED).json({
                    error: 'Unauthorized',
                    message: 'Session token expired, please re-authenticate',
                  });
                  return;
                } else {
                  refreshToken = envelope.rt;
                  accessTokenExpiresAt = envelope.exp;
                  scopes = envelope.sc;
                  oauthClientId = envelope.cid;

                  // Save envelope for post-createSession map population (both stores must be
                  // populated atomically after the session is confirmed created, to avoid leaking
                  // map entries if createSession throws).
                  recoveredEnvelope = envelope;

                  let restoredClientReg = false;
                  if (envelope.creg && profileState.oauthProvider) {
                    // Issue #4: skip registration if client already exists to avoid
                    // overwriting active registrations with envelope-embedded data.
                    const existingClient = await profileState.oauthProvider.clientsStore.getClient(envelope.creg.id);
                    if (!existingClient) {
                      try {
                        await profileState.oauthProvider.clientsStore.registerClient({
                          client_id: envelope.creg.id,
                          redirect_uris: envelope.creg.ru ?? [],
                          grant_types: envelope.creg.gt ?? ['authorization_code', 'refresh_token'],
                          response_types: envelope.creg.rt_ ?? ['code'],
                          scope: envelope.creg.sc ?? '',
                        });
                        restoredClientReg = true;
                      } catch (regErr) {
                        // Issue #2: OAuthClientStoreCapacityError must not crash session init.
                        // Session partially rehydrates without DCR re-registration - the
                        // refresh token is still available for token renewal on next tool call.
                        this.logger.warn('Failed to re-register OAuth client from envelope during restart recovery', {
                          profileId: profileState.profileId,
                          clientId: envelope.creg.id,
                          errorType: regErr instanceof Error ? regErr.constructor.name : 'unknown',
                        });
                      }
                    } else {
                      restoredClientReg = true;
                    }
                  }

                  this.logger.info('Session restored from encrypted token envelope after restart', {
                    profileId: profileState.profileId,
                    hasRefreshToken: !!refreshToken,
                    hasExpiry: !!accessTokenExpiresAt,
                    oauthClientId,
                    restoredClientReg,
                  });
                }
              } else {
                this.logger.debug(
                  'Encrypted token failed to decrypt (wrong key, tampered, or wrong profile)',
                  { profileId: profileState.profileId },
                );
              }
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
            tenantBaseUrlHeaderValue,
            resolvedClientPrincipal,
          );

          // Populate token stores after session is confirmed created to avoid
          // leaking map entries on createSession failure. Both stores keyed by
          // authInfo.token (the envelope) so getSessionToken and enterprise
          // enforcement checks can resolve the restored session correctly.
          if (recoveredEnvelope !== null) {
            const envelopeToken = authInfo.token!;
            profileState.oauthTokensByAccessToken.set(envelopeToken, {
              refreshToken: recoveredEnvelope.rt,
              expiresAt: recoveredEnvelope.exp,
              clientId: recoveredEnvelope.cid ?? '',
              scopes: recoveredEnvelope.sc ?? [],
              rawAccessToken: recoveredEnvelope.at,
            });
            this.inboundAuthTokenStore.store(envelopeToken, {
              authType: 'oauth',
              profileId: profileState.profileId,
              subject: recoveredEnvelope.cid ?? '',
              clientId: recoveredEnvelope.cid ?? '',
              scopes: recoveredEnvelope.sc ?? [],
              expiresAt: recoveredEnvelope.exp,
            });
          }
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
          const effectiveSessionId = isInitialization ? newSessionId! : sessionId!;
          // Session may have been destroyed concurrently (DELETE /mcp or reaper) while
          // this POST was in flight. startSSEResponse accepts undefined and falls back to
          // Date.now() for the event ID, so a missing session is handled gracefully.
          const sseSession = profileState.sessions.get(effectiveSessionId);
          this.startSSEResponse(res, response, newSessionId, sseSession);
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
      const { status, errorLabel, message } = this.buildHttpErrorResponse(error, correlationId);

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
        metricsRecorded = true;
      }
    } finally {
      if (this.metrics && !metricsRecorded) {
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
      const toolFilterHeader = normalizeToolFilterHeaderValue(this.getToolFilterHeaderValue(req));
      const parsedToolFilter =
        toolFilterHeader !== undefined ? parseSessionToolFilterHeader(toolFilterHeader) : undefined;

      // Validate Accept header
      const accept = req.headers.accept || '';
      if (!accept.includes(MIME_TYPES.EVENT_STREAM)) {
        res.status(HTTP_STATUS.METHOD_NOT_ALLOWED).json({ error: 'Method Not Allowed', message: `Must accept ${MIME_TYPES.EVENT_STREAM}` });
        return;
      }

      this.rejectUnsupportedUpstreamToolCategoryFilter(profileState, parsedToolFilter);

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
      const { status, errorLabel, message } = this.buildHttpErrorResponse(error, correlationId);

      if (!res.headersSent) {
        res.setHeader('Cache-Control', 'no-store');
        res.status(status).json({
          error: errorLabel,
          message,
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
    let metricsProfileState: ProfileRuntimeState | null = null;
    let metricsTenantId: string | null = null;
    let profileId: string | undefined;

    try {
      const sessionId = req.sessionId;
      profileId = this.getProfileIdForRequest(req);

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
      metricsProfileState = profileState;

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
      metricsTenantId = session.tenantId || null;

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
          this.resolveMetricsContext(profileState, metricsTenantId)
        );
      }
    } catch (error) {
      const correlationId = generateCorrelationId();
      this.logger.error('DELETE request error', error as Error, { correlationId });
      const { status, errorLabel, message } = this.buildHttpErrorResponse(error, correlationId);

      if (!res.headersSent) {
        res.setHeader('Cache-Control', 'no-store');
        res.status(status).json({ error: errorLabel, message, correlationId });
      }

      if (this.metrics) {
        const duration = (Date.now() - startTime) / 1000;
        this.metrics.recordHttpRequest(
          req.method,
          req.path,
          status,
          duration,
          this.resolveMetricsContext(metricsProfileState, metricsTenantId, profileId)
        );
      }
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
    session?: SessionData
  ): void {
    res.setHeader('Content-Type', MIME_TYPES.EVENT_STREAM);
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    if (newSessionId) {
      res.setHeader('Mcp-Session-Id', newSessionId);
    }

    // Use session-scoped monotonic counter so Last-Event-ID from POST responses stays
    // in the same ID space as GET SSE replay events. Fall back to Date.now() when no
    // session exists (e.g. error responses before session creation).
    const eventId = session ? ++session.nextEventId : Date.now();
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
      active: true,
      response: res,
    };

    session.sseStreams.set(streamId, streamState);

    // Replay missed messages if resuming
    if (lastEventId) {
      this.replayMessages(res, streamState, session);
    }

    // Flush any buffered upstream notifications (D-08: replay on reconnect)
    // Route through sendToClient() so each notification enters the session replayQueue
    // and can be re-replayed on any subsequent reconnect via Last-Event-ID.
    if (this.upstreamConnectionManager) {
      const buffered = this.upstreamConnectionManager.drainNotifications(sessionId);
      for (const entry of buffered) {
        const notification: Record<string, unknown> = { jsonrpc: '2.0', method: entry.method };
        if (entry.params !== undefined) notification.params = entry.params;
        this.sendToClient(profileState.profileId, sessionId, notification);
      }
      if (buffered.length > 0) {
        this.logger.debug('Replayed buffered upstream notifications', { sessionId, count: buffered.length });
      }
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
      session.sseStreams.delete(streamId);
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
   * Why: Resumability - client can reconnect and receive missed messages.
   * Uses session-scoped replayQueue so messages survive across multiple reconnects.
   */
  private replayMessages(res: Response, streamState: SSEStreamState, session: SessionData): void {
    const missedMessages = session.replayQueue.filter(
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

    const eventId = ++session.nextEventId;
    const queuedMessage: QueuedMessage = {
      eventId,
      data: message,
      timestamp: Date.now(),
    };

    // Push to session-scoped replay queue so messages survive stream reconnects
    session.replayQueue.push(queuedMessage);
    if (session.replayQueue.length > 100) {
      session.replayQueue.shift();
    }

    // Send to all active streams for this session
    for (const streamState of session.sseStreams.values()) {
      if (streamState.active) {
        // Write to active SSE stream for real-time delivery
        try {
          streamState.response.write(`id: ${eventId}\n`);
          streamState.response.write(`data: ${JSON.stringify(message)}\n\n`);
        } catch (writeError) {
          // Stream may have closed between active check and write; mark inactive
          streamState.active = false;
          this.logger.debug('Failed to write to SSE stream', { sessionId, error: (writeError as Error).message });
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

  private rejectUnsupportedUpstreamToolCategoryFilter(
    profileState: ProfileRuntimeState,
    toolFilterRequest?: SessionToolFilterRequest,
  ): void {
    if (!toolFilterRequest || toolFilterRequest.allowCategories.size === 0) {
      return;
    }

    if (!profileState.context.upstreamMcp) {
      return;
    }

    throw new ValidationError(
      '_allow_list/_allow_read not supported for upstream proxy profiles. Use exact names or regex patterns instead.'
    );
  }

  private buildHttpErrorResponse(
    error: unknown,
    correlationId: string,
  ): { status: number; errorLabel: string; message: string } {
    for (const rule of HttpTransport.HTTP_ERROR_RESPONSE_RULES) {
      if (error instanceof rule.ctor) {
        return {
          status: rule.status,
          errorLabel: rule.errorLabel,
          message: `${rule.messagePrefix}: ${error.message} (correlation ID: ${correlationId})`,
        };
      }
    }

    return {
      status: HTTP_STATUS.INTERNAL_SERVER_ERROR,
      errorLabel: 'Internal Server Error',
      message: `Internal error (correlation ID: ${correlationId})`,
    };
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
    tenantHeaderValue?: string,
    clientPrincipal?: AuthorizedPrincipal,
  ): string {
    // Validate token if provided (defense in depth); use raw-credential validator since
    // custom-header auth stores the full header value which may include a scheme prefix with a space.
    if (authToken) {
      this.validateRawHeaderCredential(authToken, 'Session auth token');
    }

    const effectiveFiltering = mergeFilteringRules(this.config.globalFiltering, filtering);

    const sessionId = crypto.randomUUID();
    const session: SessionData = {
      id: sessionId,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      sseStreams: new Map(),
      replayQueue: [],
      nextEventId: 0,
      authToken,
      refreshToken,
      accessTokenExpiresAt,
      scopes,
      oauthClientId,
      filtering: effectiveFiltering,
      filteringHeader,
      toolFilterRequest,
      toolFilterHeader,
      tenantId: tenantContext?.tenantId,
      tenantBaseUrl: tenantContext?.tenantBaseUrl,
      tenantHeaderValue: tenantHeaderValue || tenantContext?.tenantBaseUrl,
      tenantAuthMode: tenantContext?.tenantAuthMode,
      tenantOAuthConfig: tenantContext?.tenantOAuthConfig,
      tenantAuthConfigs: tenantContext?.tenantAuthConfigs,
      clientPrincipal,
    };
    profileState.sessions.set(sessionId, session);
    if (oauthClientId) {
      this.attachOAuthClientSession(profileState, session, oauthClientId);
    }
    this.logger.info('Session created', {
      profileId: profileState.profileId,
      sessionId,
      hasAuthToken: !!authToken,
      hasRefreshToken: !!refreshToken,
      hasExpiration: !!accessTokenExpiresAt,
      // Phase 3 partial AUTH-03: include resolved client identity in
      // session-creation log entries. Phase 5 (audit log) reads
      // session.clientPrincipal directly for per-tool-call attribution.
      clientSubject: clientPrincipal?.subject,
      clientAuthType: clientPrincipal?.authType,
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
      if (session.oauthClientId) {
        this.detachOAuthClientSession(profileState, session, session.oauthClientId);
      }

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
      
      // Clean up inbound auth token state if present
      if (session.authToken) {
        profileState.oauthTokensByAccessToken.delete(session.authToken);
        this.inboundAuthTokenStore.delete(session.authToken);
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

  private attachOAuthClientSession(profileState: ProfileRuntimeState, session: SessionData, clientId: string): void {
    const oauthProvider = this.getOAuthProviderForSession(profileState, session);
    oauthProvider?.clientsStore.markSessionAttached?.(clientId);
  }

  private detachOAuthClientSession(profileState: ProfileRuntimeState, session: SessionData, clientId: string): void {
    const oauthProvider = session.tenantOAuthConfig
      ? this.getTenantOAuthProviderCache(profileState).get(session.id) || null
      : profileState.oauthProvider;
    oauthProvider?.clientsStore.markSessionDetached?.(clientId);
  }

  /**
   * Session destruction listeners for cleanup in other components
   */
  private sessionDestroyedListeners: Array<(profileId: string, sessionId: string) => void> = [];
  private upstreamManagerListenerRegistered = false;

  /**
   * Register listener for session destruction events
   * 
   * Why: Allows MCPServer to cleanup per-session HTTP clients
   */
  public onSessionDestroyed(listener: (profileId: string, sessionId: string) => void): void {
    this.sessionDestroyedListeners.push(listener);
  }

  /**
   * Register UpstreamConnectionManager for session-scoped upstream cleanup.
   *
   * Wires closeAll into the session destruction lifecycle so upstream connections
   * are closed when sessions expire (reaper), are explicitly terminated (DELETE /mcp),
   * or during shutdown. Errors in closeAll are caught and logged to never break
   * session destruction.
   */
  public setUpstreamConnectionManager(manager: UpstreamConnectionManager): void {
    if (this.upstreamConnectionManager && this.upstreamConnectionManager !== manager) {
      throw new Error(
        'UpstreamConnectionManager already wired — setUpstreamConnectionManager must be called only once per HttpTransport lifetime. ' +
        'Replacing the manager would orphan the first manager\'s connections (its closeAll is never called).',
      );
    }
    this.upstreamConnectionManager = manager;

    // Wire stream presence check: upstream manager checks if SSE stream is active
    // before attempting to forward (avoids exception-as-control-flow anti-pattern)
    manager.setHasActiveStreamFn((sessionId: string): boolean => {
      return this.hasActiveStream(sessionId);
    });

    // Wire notification forwarding path: upstream -> downstream SSE
    manager.setDownstreamNotifyFn((sessionId: string, method: string, params?: unknown) => {
      const profileId = this.findProfileIdForSession(sessionId);
      if (!profileId) {
        // Session not found - likely already destroyed; caller will queue
        return;
      }
      // Forward as JSON-RPC notification (no id field per spec)
      const notification: Record<string, unknown> = { jsonrpc: '2.0', method };
      if (params !== undefined) notification.params = params;
      this.sendToClient(profileId, sessionId, notification);
    });

    if (!this.upstreamManagerListenerRegistered) {
      this.upstreamManagerListenerRegistered = true;
      this.onSessionDestroyed((_profileId: string, sessionId: string) => {
        this.upstreamConnectionManager?.closeAll(sessionId).catch((error) => {
          this.logger.error('Failed to close upstream connections on session destroy', error as Error);
        });
      });
    }
  }

  /**
   * Check if a session has at least one active SSE stream attached.
   * Used by UpstreamConnectionManager to decide between forwarding and queuing notifications.
   */
  public hasActiveStream(sessionId: string): boolean {
    for (const [, profileState] of this.profileStates.entries()) {
      const session = profileState.sessions.get(sessionId);
      if (session) {
        for (const streamState of session.sseStreams.values()) {
          if (streamState.active) return true;
        }
        return false;
      }
    }
    return false;
  }

  /**
   * Find the profileId that owns a given sessionId.
   * O(n) over profileStates - acceptable for phase 2 scale.
   */
  private findProfileIdForSession(sessionId: string): string | undefined {
    for (const [profileId, profileState] of this.profileStates.entries()) {
      if (profileState.sessions.has(sessionId)) {
        return profileId;
      }
    }
    return undefined;
  }

  /**
   * Return upstream_mcp config for a profile.
   * Used by MCPServer to determine whether to branch to upstream handling.
   */
  public getUpstreamMcpConfig(profileId: string): UpstreamMcpServerConfig | undefined {
    return this.profileStates.get(profileId)?.context.upstreamMcp;
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

  private sendInitializeJsonRpcError(res: Response, body: unknown, message: string): void {
    const requestId = this.getJsonRpcRequestId(body);
    res.status(HTTP_STATUS.OK).json({
      jsonrpc: '2.0',
      id: requestId,
      error: {
        code: ErrorCode.InvalidRequest,
        message,
      },
    });
  }

  private getJsonRpcRequestId(body: unknown): string | number | null {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return null;
    }

    const value = (body as Record<string, unknown>).id;
    return typeof value === 'string' || typeof value === 'number' ? value : null;
  }

  /**
   * Store OAuth tokens in internal map for later session initialization.
   *
   * When MCP4_OAUTH_KEY is configured AND tokens.refresh_token is present, builds an encrypted
   * `mcp4.v1.*` envelope binding {access_token, refresh_token, expiry, client_id, scopes,
   * profile_id, optional client registration} under AES-256-GCM with profile_id as AAD.
   * Both the per-profile map and InboundAuthTokenStore are keyed by the RETURNED token (envelope
   * if encryption succeeded, raw access_token otherwise). On encryption failure - logs warn and
   * falls back to plain access_token (no crash).
   *
   * @returns the token string the caller should give to the OAuth client
   *          (mcp4.v1.* envelope, or tokens.access_token unchanged in plain-token mode)
   */
  private storeOAuthTokens(
    profileState: ProfileRuntimeState,
    tokens: OAuthTokens,
    clientId: string,
    scopes: string[],
    registeredClient?: OAuthClientInformationFull,
  ): string {
    if (!tokens.access_token) {
      throw new AuthenticationError('OAuth tokens missing access_token');
    }

    const expiresAt = tokens.expires_in
      ? Date.now() + tokens.expires_in * 1000
      : undefined;

    let clientToken = tokens.access_token;
    if (this.config.tokenKey && tokens.refresh_token) {
      try {
        clientToken = encryptTokenPayload(
          {
            v: 1,
            at: tokens.access_token,
            rt: tokens.refresh_token,
            exp: expiresAt,
            cid: clientId,
            sc: scopes,
            pid: profileState.profileId,
            iat: Date.now(),
            creg: registeredClient
              ? {
                  id: registeredClient.client_id,
                  ru: registeredClient.redirect_uris,
                  gt: registeredClient.grant_types,
                  rt_: registeredClient.response_types,
                  sc: registeredClient.scope,
                }
              : undefined,
          },
          this.config.tokenKey,
        );
      } catch (err) {
        this.logger.warn('Token envelope encryption failed - falling back to plain access_token', {
          profileId: profileState.profileId,
          error: err instanceof Error ? err.message : String(err),
        });
        clientToken = tokens.access_token;
      }
    }

    profileState.oauthTokensByAccessToken.set(clientToken, {
      refreshToken: tokens.refresh_token,
      expiresAt,
      clientId,
      scopes,
      rawAccessToken: clientToken !== tokens.access_token ? tokens.access_token : undefined,
    });
    this.inboundAuthTokenStore.store(clientToken, {
      authType: 'oauth',
      profileId: profileState.profileId,
      subject: clientId,
      clientId,
      scopes,
      expiresAt,
    });

    this.logger.debug('Stored OAuth tokens', {
      profileId: profileState.profileId,
      hasRefreshToken: !!tokens.refresh_token,
      expiresAt,
      clientId,
      scopesCount: scopes.length,
      encrypted: clientToken !== tokens.access_token,
      hasClientRegistration: !!registeredClient,
    });

    return clientToken;
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
    const profileState = this.profileStates.get(profileId);
    const session = profileState?.sessions.get(sessionId);
    if (!session?.authToken) return undefined;
    // When session.authToken is an encrypted envelope (mcp4.v1.*), the envelope is only
    // the inbound session-lookup key. Upstream API calls must use the embedded raw access_token.
    const tokenData = profileState?.oauthTokensByAccessToken.get(session.authToken);
    return tokenData?.rawAccessToken ?? session.authToken;
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

  public getSessionEnterpriseAllowedToolCategories(
    profileId: string,
    sessionId: string,
  ): Set<'list' | 'read' | 'modify' | 'admin'> | undefined {
    const profileState = this.profileStates.get(profileId);
    const session = profileState?.sessions.get(sessionId);
    if (!profileState || !session?.authToken) {
      return undefined;
    }

    const internalToken = this.inboundAuthTokenStore.get(session.authToken);
    if (!internalToken || internalToken.principal.authType !== 'enterprise' || internalToken.principal.profileId !== profileId) {
      return undefined;
    }

    const allowedCategories = profileState.context.enterpriseAuthorization?.access_policy?.allowed_tool_categories;
    if (!allowedCategories || allowedCategories.length === 0) {
      return undefined;
    }

    return new Set(allowedCategories);
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

  /**
   * Accessor for the AuthorizedPrincipal resolved for an inbound session, used by
   * observability (audit log + metrics) to label tool calls with the client identity.
   *
   * Returns undefined when the profile/session is unknown or the session is anonymous
   * (no client_auth_gate configured or no principal resolved). Callers should treat
   * undefined as 'anonymous' for audit/metrics labels.
   */
  public getSessionClientPrincipal(profileId: string, sessionId: string): AuthorizedPrincipal | undefined {
    return this.profileStates.get(profileId)?.sessions.get(sessionId)?.clientPrincipal;
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
      const { operational } = isOAuthConfigOperational(session.tenantOAuthConfig);
      if (!operational) {
        this.logger.warn('Tenant OAuth config not operational - tenant OAuth disabled for session', {
          profileId: profileState.profileId,
          sessionId: session.id,
        });
        return null;
      }
      try {
        const newProvider = new ExternalOAuthProvider(session.tenantOAuthConfig, this.logger);
        providerCache.set(session.id, newProvider);
        return newProvider;
      } catch (err) {
        // Catches edge cases: env var changed between check and construction, etc.
        // Generic message — err.message from resolveEnvVars contains raw env var names.
        this.logger.warn('Tenant OAuth provider construction failed - tenant OAuth disabled for session', {
          profileId: profileState.profileId,
          sessionId: session.id,
          reason: 'Tenant OAuth provider construction failed after pre-flight check (env var removed at runtime)',
        });
        return null;
      }
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
      session.refreshToken = tokens.refresh_token || session.refreshToken; // Keep old refresh token if new one not provided
      session.accessTokenExpiresAt = tokens.expires_in
        ? Date.now() + tokens.expires_in * 1000
        : undefined;

      // Update token map: remove old token, add new one
      if (oldAccessToken) {
        profileState.oauthTokensByAccessToken.delete(oldAccessToken);
        this.inboundAuthTokenStore.delete(oldAccessToken);
      }
      // Issue new envelope (or plain token in plain-token mode) and use it as the new session.authToken.
      // Pass client so creg is re-embedded: without it, post-refresh envelopes lose the client
      // registration and a subsequent restart can no longer re-register the DCR client.
      const newClientToken = this.storeOAuthTokens(profileState, tokens, client.client_id, session.scopes || [], client);
      session.authToken = newClientToken;

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
