import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';

export const CLIENT_ID_DYNAMIC_PREFIX = 'mcp-client-';

export const CLIENT_STORE_DEFAULTS = {
  maxClients: 1000,
  maxRedirectUris: 10,
  maxRedirectUriLength: 256,
  idleGraceMs: 0,
} as const;

export const CLIENT_STORE_ENV = {
  maxClients: 'MCP4_OAUTH_CLIENT_STORE_MAX_CLIENTS',
  maxRedirectUris: 'MCP4_OAUTH_CLIENT_STORE_MAX_REDIRECT_URIS',
  maxRedirectUriLength: 'MCP4_OAUTH_CLIENT_STORE_MAX_REDIRECT_URI_LENGTH',
  idleGraceMs: 'MCP4_OAUTH_CLIENT_STORE_IDLE_GRACE_MS',
} as const;

export type OAuthClientStoreClientKind = 'dynamic' | 'static';

export interface InMemoryClientsStoreOptions {
  maxClients?: number;
  maxRedirectUris?: number;
  maxRedirectUriLength?: number;
  idleGraceMs?: number;
}

export interface ClientStoreLimits {
  maxClients: number;
  maxRedirectUris: number;
  maxRedirectUriLength: number;
  idleGraceMs: number;
}

export interface OAuthClientRuntimeMeta {
  clientId: string;
  kind: OAuthClientStoreClientKind;
  createdAt: number;
  lastUsedAt?: number;
  activeSessionCount: number;
  pendingStateCount: number;
  pendingAuthCodeCount: number;
}

export interface EvictionCandidateRecord {
  clientId: string;
  kind: OAuthClientStoreClientKind;
  createdAt: number;
  lastUsedAt?: number;
  activeSessionCount: number;
  pendingStateCount: number;
  pendingAuthCodeCount: number;
  isIdle: boolean;
  isNeverUsed: boolean;
  ageMs: number;
}

export type EvictionTierId = 'tier_a_dynamic_idle_never_used' | 'tier_b_dynamic_idle' | 'tier_c_any_idle';

export interface EvictionDecisionEvict {
  decision: 'evict';
  clientId: string;
  tier: EvictionTierId;
}

export interface EvictionDecisionNoCandidate {
  decision: 'no_candidate';
  reason: 'no_idle_candidates';
}

export type EvictionDecision = EvictionDecisionEvict | EvictionDecisionNoCandidate;

export interface OAuthClientStoreStats {
  totalClients: number;
  dynamicClients: number;
  staticClients: number;
  activeSessionClients: number;
  pendingStateClients: number;
  pendingAuthCodeClients: number;
  idleClients: number;
}

export interface StoredOAuthClient {
  client: OAuthClientInformationFull;
  meta: OAuthClientRuntimeMeta;
}
