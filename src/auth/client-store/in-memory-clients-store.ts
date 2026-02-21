import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { OAuthClientStoreCapacityError, ValidationError } from '../../core/errors.js';
import { chooseEvictionDecision } from './policy.js';
import {
  CLIENT_ID_DYNAMIC_PREFIX,
  CLIENT_STORE_DEFAULTS,
  CLIENT_STORE_ENV,
  type ClientStoreLimits,
  type EvictionCandidateRecord,
  type InMemoryClientsStoreOptions,
  type OAuthClientRuntimeMeta,
  type OAuthClientStoreClientKind,
  type OAuthClientStoreStats,
} from './types.js';

export class InMemoryClientsStore implements OAuthRegisteredClientsStore {
  private clients = new Map<string, OAuthClientInformationFull>();
  private metadata = new Map<string, OAuthClientRuntimeMeta>();
  private readonly limits: ClientStoreLimits;
  private readonly nowProvider: () => number;

  constructor(
    options: InMemoryClientsStoreOptions = {},
    env: NodeJS.ProcessEnv = process.env,
    nowProvider: () => number = () => Date.now(),
  ) {
    this.limits = {
      maxClients: resolvePositiveIntegerOptionOrEnv(options.maxClients, env[CLIENT_STORE_ENV.maxClients], CLIENT_STORE_DEFAULTS.maxClients),
      maxRedirectUris: resolvePositiveIntegerOptionOrEnv(
        options.maxRedirectUris,
        env[CLIENT_STORE_ENV.maxRedirectUris],
        CLIENT_STORE_DEFAULTS.maxRedirectUris,
      ),
      maxRedirectUriLength: resolvePositiveIntegerOptionOrEnv(
        options.maxRedirectUriLength,
        env[CLIENT_STORE_ENV.maxRedirectUriLength],
        CLIENT_STORE_DEFAULTS.maxRedirectUriLength,
      ),
      idleGraceMs: resolveNonNegativeIntegerOptionOrEnv(
        options.idleGraceMs,
        env[CLIENT_STORE_ENV.idleGraceMs],
        CLIENT_STORE_DEFAULTS.idleGraceMs,
      ),
    };
    this.nowProvider = nowProvider;
  }

  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    const client = this.clients.get(clientId);
    if (!client) {
      return undefined;
    }

    this.markClientUsed(clientId);
    return client;
  }

  async registerClient(clientMetadata: OAuthClientInformationFull): Promise<OAuthClientInformationFull> {
    if (isDynamicClientId(clientMetadata.client_id)) {
      this.validateClientMetadata(clientMetadata);
    }

    const isExistingClient = this.clients.has(clientMetadata.client_id);
    if (!isExistingClient && this.clients.size >= this.limits.maxClients) {
      const decision = chooseEvictionDecision(this.buildEvictionCandidates(), this.limits.idleGraceMs);
      if (decision.decision === 'no_candidate') {
        const stats = this.getStats();
        throw new OAuthClientStoreCapacityError(
          'OAuth client registration temporarily unavailable: no idle client can be evicted',
          {
            maxClients: this.limits.maxClients,
            totalClients: stats.totalClients,
            dynamicClients: stats.dynamicClients,
            activeSessionClients: stats.activeSessionClients,
            pendingStateClients: stats.pendingStateClients,
            pendingAuthCodeClients: stats.pendingAuthCodeClients,
            idleClients: stats.idleClients,
          },
        );
      }

      this.removeClient(decision.clientId);
    }

    this.clients.set(clientMetadata.client_id, clientMetadata);

    const existingMetadata = this.metadata.get(clientMetadata.client_id);
    if (existingMetadata) {
      existingMetadata.kind = getClientKind(clientMetadata.client_id);
      this.metadata.set(clientMetadata.client_id, existingMetadata);
    } else {
      this.metadata.set(clientMetadata.client_id, {
        clientId: clientMetadata.client_id,
        kind: getClientKind(clientMetadata.client_id),
        createdAt: this.nowProvider(),
        activeSessionCount: 0,
        pendingStateCount: 0,
        pendingAuthCodeCount: 0,
      });
    }

    return clientMetadata;
  }

  getClientCount(): number {
    return this.clients.size;
  }

  getLimits(): ClientStoreLimits {
    return { ...this.limits };
  }

  getClientMetadataSnapshot(): OAuthClientRuntimeMeta[] {
    return Array.from(this.metadata.values()).map((meta) => ({ ...meta }));
  }

  markClientUsed(clientId: string): void {
    const metadata = this.getMutableMetadata(clientId);
    if (!metadata) {
      return;
    }

    metadata.lastUsedAt = this.nowProvider();
  }

  markSessionAttached(clientId: string): void {
    this.incrementCounter(clientId, 'activeSessionCount');
  }

  markSessionDetached(clientId: string): void {
    this.decrementCounter(clientId, 'activeSessionCount');
  }

  markAuthStateOpened(clientId: string): void {
    this.incrementCounter(clientId, 'pendingStateCount');
  }

  markAuthStateClosed(clientId: string): void {
    this.decrementCounter(clientId, 'pendingStateCount');
  }

  markAuthCodeOpened(clientId: string): void {
    this.incrementCounter(clientId, 'pendingAuthCodeCount');
  }

  markAuthCodeClosed(clientId: string): void {
    this.decrementCounter(clientId, 'pendingAuthCodeCount');
  }

  getStats(): OAuthClientStoreStats {
    let dynamicClients = 0;
    let staticClients = 0;
    let activeSessionClients = 0;
    let pendingStateClients = 0;
    let pendingAuthCodeClients = 0;
    let idleClients = 0;

    for (const metadata of this.metadata.values()) {
      if (metadata.kind === 'dynamic') {
        dynamicClients += 1;
      } else {
        staticClients += 1;
      }

      if (metadata.activeSessionCount > 0) {
        activeSessionClients += 1;
      }
      if (metadata.pendingStateCount > 0) {
        pendingStateClients += 1;
      }
      if (metadata.pendingAuthCodeCount > 0) {
        pendingAuthCodeClients += 1;
      }
      if (isIdle(metadata)) {
        idleClients += 1;
      }
    }

    return {
      totalClients: this.clients.size,
      dynamicClients,
      staticClients,
      activeSessionClients,
      pendingStateClients,
      pendingAuthCodeClients,
      idleClients,
    };
  }

  private buildEvictionCandidates(): EvictionCandidateRecord[] {
    const now = this.nowProvider();

    return Array.from(this.metadata.values())
      .filter((meta) => this.clients.has(meta.clientId))
      .map((meta) => ({
        clientId: meta.clientId,
        kind: meta.kind,
        createdAt: meta.createdAt,
        lastUsedAt: meta.lastUsedAt,
        activeSessionCount: meta.activeSessionCount,
        pendingStateCount: meta.pendingStateCount,
        pendingAuthCodeCount: meta.pendingAuthCodeCount,
        isIdle: isIdle(meta),
        isNeverUsed: meta.lastUsedAt === undefined,
        ageMs: now - meta.createdAt,
      }));
  }

  private validateClientMetadata(client: OAuthClientInformationFull): void {
    if (!client.redirect_uris || !Array.isArray(client.redirect_uris)) {
      throw new ValidationError('redirect_uris must be an array');
    }

    if (client.redirect_uris.length > this.limits.maxRedirectUris) {
      throw new ValidationError(`Too many redirect_uris (max ${this.limits.maxRedirectUris})`);
    }

    for (const uri of client.redirect_uris) {
      if (typeof uri !== 'string') {
        throw new ValidationError('redirect_uri must be a string');
      }
      if (uri.length > this.limits.maxRedirectUriLength) {
        throw new ValidationError(`redirect_uri too long (max ${this.limits.maxRedirectUriLength} chars)`);
      }
    }
  }

  private incrementCounter(
    clientId: string,
    field: 'activeSessionCount' | 'pendingStateCount' | 'pendingAuthCodeCount',
  ): void {
    const metadata = this.getMutableMetadata(clientId);
    if (!metadata) {
      return;
    }

    metadata[field] += 1;
    metadata.lastUsedAt = this.nowProvider();
  }

  private decrementCounter(
    clientId: string,
    field: 'activeSessionCount' | 'pendingStateCount' | 'pendingAuthCodeCount',
  ): void {
    const metadata = this.getMutableMetadata(clientId);
    if (!metadata) {
      return;
    }

    metadata[field] = Math.max(0, metadata[field] - 1);
    metadata.lastUsedAt = this.nowProvider();
  }

  private getMutableMetadata(clientId: string): OAuthClientRuntimeMeta | undefined {
    const metadata = this.metadata.get(clientId);
    if (!metadata) {
      return undefined;
    }

    return metadata;
  }

  private removeClient(clientId: string): void {
    this.clients.delete(clientId);
    this.metadata.delete(clientId);
  }
}

function isIdle(meta: Pick<OAuthClientRuntimeMeta, 'activeSessionCount' | 'pendingStateCount' | 'pendingAuthCodeCount'>): boolean {
  return meta.activeSessionCount === 0
    && meta.pendingStateCount === 0
    && meta.pendingAuthCodeCount === 0;
}

function isDynamicClientId(clientId: string): boolean {
  return clientId.startsWith(CLIENT_ID_DYNAMIC_PREFIX);
}

function getClientKind(clientId: string): OAuthClientStoreClientKind {
  return isDynamicClientId(clientId) ? 'dynamic' : 'static';
}

function resolvePositiveIntegerOptionOrEnv(optionValue: number | undefined, envValue: string | undefined, fallback: number): number {
  if (typeof optionValue === 'number' && Number.isInteger(optionValue) && optionValue > 0) {
    return optionValue;
  }

  if (envValue !== undefined) {
    const parsed = Number.parseInt(envValue, 10);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return fallback;
}

function resolveNonNegativeIntegerOptionOrEnv(optionValue: number | undefined, envValue: string | undefined, fallback: number): number {
  if (typeof optionValue === 'number' && Number.isInteger(optionValue) && optionValue >= 0) {
    return optionValue;
  }

  if (envValue !== undefined) {
    const parsed = Number.parseInt(envValue, 10);
    if (Number.isInteger(parsed) && parsed >= 0) {
      return parsed;
    }
  }

  return fallback;
}
