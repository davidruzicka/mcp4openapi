import type { Express, Request, Response } from 'express';
import type { HttpTransport } from './http-transport.js';
import type { HttpProfileContext, SessionData, SessionToolFilterRequest } from '../types/http-transport.js';
import type { HttpTenantIndex, ResolvedTenantContext } from '../types/http-tenants.js';
import type { ToolFilterService } from '../tool-filter/index.js';
import type { OAuthConfig } from '../types/profile.js';
import type { OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';

interface StoredOAuthTokenState {
  refreshToken?: string;
  expiresAt?: number;
  clientId: string;
  scopes: string[];
}

export interface HttpTransportTestProfileState {
  profileId: string;
  context: HttpProfileContext;
  oauthProvider: unknown | null;
  enterpriseAuthProvider: unknown | null;
  toolFilterService?: ToolFilterService;
  oauthTokensByAccessToken: Map<string, StoredOAuthTokenState>;
  sessions: Map<string, SessionData>;
  tenantIndex: HttpTenantIndex;
  tenantOAuthProvidersBySessionId: Map<string, unknown>;
}

export interface HttpTransportSessionOptions {
  authToken?: string;
  refreshToken?: string;
  accessTokenExpiresAt?: number;
  scopes?: string[];
  oauthClientId?: string;
  filtering?: Record<string, string[]>;
  filteringHeader?: string;
  toolFilterRequest?: SessionToolFilterRequest;
  toolFilterHeader?: string;
  tenantContext?: ResolvedTenantContext | null;
  tenantHeaderValue?: string;
}

export interface HeaderRequestLike {
  headers: Request['headers'];
  get?(name: string): string | undefined;
  path?: string;
  originalUrl?: string;
  profileId?: string;
}

interface HttpTransportInternals {
  app: Express;
  profileStates: Map<string, HttpTransportTestProfileState>;
  oauthRedirectHostCache: Map<string, string[]>;
  getProfileState(profileId: string): Promise<HttpTransportTestProfileState | null>;
  getMessageType(body: unknown): 'request' | 'notification-only' | 'response-only' | 'mixed' | 'unknown';
  getFilteringHeaderValue(req: Request): string | undefined;
  getToolFilterHeaderValue(req: Request): string | undefined;
  getTenantIdHeaderValue(req: Request): string | undefined;
  getTenantBaseUrlHeaderValue(req: Request): string | undefined;
  getToolFilterService(profileState: HttpTransportTestProfileState): ToolFilterService;
  createSession(
    profileState: HttpTransportTestProfileState,
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
  ): string;
  destroySession(profileState: HttpTransportTestProfileState, sessionId: string): void;
  cleanupExpiredSessions(): void;
  refreshAccessToken(profileId: string, sessionId: string): Promise<boolean>;
  getOAuthProviderForSession(profileState: HttpTransportTestProfileState, session: SessionData): unknown | null;
  storeOAuthTokens(
    profileState: HttpTransportTestProfileState,
    tokens: OAuthTokens,
    clientId: string,
    scopes: string[],
  ): void;
  startSSEStream(
    response: Response,
    sessionId: string,
    lastEventId: string | undefined,
    profileState: HttpTransportTestProfileState,
  ): void;
  isAllowedOrigin(origin: string): boolean;
  getOAuthRedirectHostPatterns(): string[];
  extractRedirectHostPatterns(oauthConfig: OAuthConfig | undefined, profileId: string): string[];
  resolveRedirectUriFromEnv(value: string, profileId: string): string | undefined;
  resolveProfileIdFromPath(pathname: string): string | null;
  resolveProfileIdForOriginCheck(req: Request): string | null;
  primeOAuthRedirectHosts(profileId: string): Promise<void>;
  isAllowedOriginForRequest(origin: string, req: Request): Promise<boolean>;
  matchOrigin(hostname: string, pattern: string): boolean;
  ipv4ToInt(ip: string): number | null;
  ipv6ToBigInt(ip: string): bigint | null;
  ipv6Mask(maskBits: number): bigint;
}

const toInternals = (transport: HttpTransport): HttpTransportInternals => transport as unknown as HttpTransportInternals;

const createEmptyTenantIndex = (): HttpTenantIndex => ({
  enabled: false,
  byTenantId: new Map(),
  byBaseUrl: new Map(),
  maskSelectors: [],
  selectorTypeByTenantId: new Map(),
});

const toRequest = (request: HeaderRequestLike): Request => request as Request;

const normalizeCreateSessionArguments = (
  optionsOrAuthToken?: HttpTransportSessionOptions | string,
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
): HttpTransportSessionOptions => {
  if (typeof optionsOrAuthToken === 'object' && optionsOrAuthToken !== null && !Array.isArray(optionsOrAuthToken)) {
    return optionsOrAuthToken;
  }

  return {
    authToken: typeof optionsOrAuthToken === 'string' ? optionsOrAuthToken : undefined,
    refreshToken,
    accessTokenExpiresAt,
    scopes,
    oauthClientId,
    filtering,
    filteringHeader,
    toolFilterRequest,
    toolFilterHeader,
    tenantContext,
    tenantHeaderValue,
  };
};

export interface HttpTransportTestHarness {
  readonly app: Express;
  createProfileState(profileId?: string, overrides?: Partial<HttpTransportTestProfileState>): HttpTransportTestProfileState;
  setProfileState(profileState: HttpTransportTestProfileState): void;
  getProfileState(profileId: string): HttpTransportTestProfileState | undefined;
  loadProfileState(profileId: string): Promise<HttpTransportTestProfileState | null>;
  setOAuthRedirectHosts(profileId: string, hosts: string[]): void;
  getOAuthRedirectHosts(profileId: string): string[] | undefined;
  getMessageType(body: unknown): 'request' | 'notification-only' | 'response-only' | 'mixed' | 'unknown';
  getFilteringHeaderValue(request: HeaderRequestLike): string | undefined;
  getToolFilterHeaderValue(request: HeaderRequestLike): string | undefined;
  getTenantIdHeaderValue(request: HeaderRequestLike): string | undefined;
  getTenantBaseUrlHeaderValue(request: HeaderRequestLike): string | undefined;
  getToolFilterService(profileState: HttpTransportTestProfileState): ToolFilterService;
  createSession(profileState: HttpTransportTestProfileState, options?: HttpTransportSessionOptions): string;
  createSession(
    profileState: HttpTransportTestProfileState,
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
  ): string;
  destroySession(profileState: HttpTransportTestProfileState, sessionId: string): void;
  cleanupExpiredSessions(): void;
  refreshAccessToken(profileId: string, sessionId: string): Promise<boolean>;
  getOAuthProviderForSession(profileState: HttpTransportTestProfileState, session: SessionData): unknown | null;
  storeOAuthTokens(profileState: HttpTransportTestProfileState, tokens: OAuthTokens, clientId: string, scopes: string[]): void;
  setStartSseStream(
    implementation: (response: Response, sessionId: string, lastEventId: string | undefined, profileState: HttpTransportTestProfileState) => void,
  ): void;
  isAllowedOrigin(origin: string): boolean;
  getOAuthRedirectHostPatterns(): string[];
  extractRedirectHostPatterns(oauthConfig: OAuthConfig | undefined, profileId: string): string[];
  resolveRedirectUriFromEnv(value: string, profileId: string): string | undefined;
  resolveProfileIdFromPath(pathname: string): string | null;
  resolveProfileIdForOriginCheck(request: HeaderRequestLike): string | null;
  primeOAuthRedirectHosts(profileId: string): Promise<void>;
  isAllowedOriginForRequest(origin: string, request: HeaderRequestLike): Promise<boolean>;
  setIsAllowedOriginForRequest(implementation: (origin: string, request: Request) => Promise<boolean>): void;
  matchOrigin(hostname: string, pattern: string): boolean;
  ipv4ToInt(ip: string): number | null;
  ipv6ToBigInt(ip: string): bigint | null;
  ipv6Mask(maskBits: number): bigint;
}

export const createHttpTransportTestHarness = (transport: HttpTransport): HttpTransportTestHarness => {
  const internals = toInternals(transport);

  return {
    get app() {
      return internals.app;
    },

    createProfileState(profileId = 'default', overrides = {}) {
      const profileState: HttpTransportTestProfileState = {
        profileId,
        context: { profileId },
        oauthProvider: null,
        enterpriseAuthProvider: null,
        oauthTokensByAccessToken: new Map(),
        sessions: new Map(),
        tenantIndex: createEmptyTenantIndex(),
        tenantOAuthProvidersBySessionId: new Map(),
        ...overrides,
      };
      internals.profileStates.set(profileId, profileState);
      return profileState;
    },

    setProfileState(profileState) {
      internals.profileStates.set(profileState.profileId, profileState);
    },

    getProfileState(profileId) {
      return internals.profileStates.get(profileId);
    },

    loadProfileState(profileId) {
      return internals.getProfileState(profileId);
    },

    setOAuthRedirectHosts(profileId, hosts) {
      internals.oauthRedirectHostCache.set(profileId, hosts);
    },

    getOAuthRedirectHosts(profileId) {
      return internals.oauthRedirectHostCache.get(profileId);
    },

    getMessageType(body) {
      return internals.getMessageType(body);
    },

    getFilteringHeaderValue(request) {
      return internals.getFilteringHeaderValue(toRequest(request));
    },

    getToolFilterHeaderValue(request) {
      return internals.getToolFilterHeaderValue(toRequest(request));
    },

    getTenantIdHeaderValue(request) {
      return internals.getTenantIdHeaderValue(toRequest(request));
    },

    getTenantBaseUrlHeaderValue(request) {
      return internals.getTenantBaseUrlHeaderValue(toRequest(request));
    },

    getToolFilterService(profileState) {
      return internals.getToolFilterService(profileState);
    },

    createSession(
      profileState: HttpTransportTestProfileState,
      optionsOrAuthToken?: HttpTransportSessionOptions | string,
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
    ) {
      const options = normalizeCreateSessionArguments(
        optionsOrAuthToken,
        refreshToken,
        accessTokenExpiresAt,
        scopes,
        oauthClientId,
        filtering,
        filteringHeader,
        toolFilterRequest,
        toolFilterHeader,
        tenantContext,
        tenantHeaderValue,
      );
      return internals.createSession(
        profileState,
        options.authToken,
        options.refreshToken,
        options.accessTokenExpiresAt,
        options.scopes,
        options.oauthClientId,
        options.filtering,
        options.filteringHeader,
        options.toolFilterRequest,
        options.toolFilterHeader,
        options.tenantContext,
        options.tenantHeaderValue,
      );
    },

    destroySession(profileState, sessionId) {
      internals.destroySession(profileState, sessionId);
    },

    cleanupExpiredSessions() {
      internals.cleanupExpiredSessions();
    },

    refreshAccessToken(profileId, sessionId) {
      return internals.refreshAccessToken(profileId, sessionId);
    },

    getOAuthProviderForSession(profileState, session) {
      return internals.getOAuthProviderForSession(profileState, session);
    },

    storeOAuthTokens(profileState, tokens, clientId, scopes) {
      internals.storeOAuthTokens(profileState, tokens, clientId, scopes);
    },

    setStartSseStream(implementation) {
      internals.startSSEStream = implementation;
    },

    isAllowedOrigin(origin) {
      return internals.isAllowedOrigin(origin);
    },

    getOAuthRedirectHostPatterns() {
      return internals.getOAuthRedirectHostPatterns();
    },

    extractRedirectHostPatterns(oauthConfig, profileId) {
      return internals.extractRedirectHostPatterns(oauthConfig, profileId);
    },

    resolveRedirectUriFromEnv(value, profileId) {
      return internals.resolveRedirectUriFromEnv(value, profileId);
    },

    resolveProfileIdFromPath(pathname) {
      return internals.resolveProfileIdFromPath(pathname);
    },

    resolveProfileIdForOriginCheck(request) {
      return internals.resolveProfileIdForOriginCheck(toRequest(request));
    },

    primeOAuthRedirectHosts(profileId) {
      return internals.primeOAuthRedirectHosts(profileId);
    },

    isAllowedOriginForRequest(origin, request) {
      return internals.isAllowedOriginForRequest(origin, toRequest(request));
    },

    setIsAllowedOriginForRequest(implementation) {
      internals.isAllowedOriginForRequest = implementation;
    },

    matchOrigin(hostname, pattern) {
      return internals.matchOrigin(hostname, pattern);
    },

    ipv4ToInt(ip) {
      return internals.ipv4ToInt(ip);
    },

    ipv6ToBigInt(ip) {
      return internals.ipv6ToBigInt(ip);
    },

    ipv6Mask(maskBits) {
      return internals.ipv6Mask(maskBits);
    },
  };
};
