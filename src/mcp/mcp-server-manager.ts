/**
 * MCP server manager for multi-profile HTTP routing.
 */

import type { Logger } from '../core/logger.js';
import type { FilteringRules } from '../core/filtering.js';
import { MCPServer } from './mcp-server.js';
import type { HttpProfileContext } from '../types/http-transport.js';
import type { HttpTransport } from '../transport/http-transport.js';
import { ProfileRegistry } from '../profile/profile-registry.js';
import type { ResolvedProfile } from '../profile/profile-resolver.js';

const DEFAULT_PROFILE_SERVER_CACHE_MAX_ENTRIES = 32;
const DEFAULT_PROFILE_SERVER_CACHE_TTL_MS = 15 * 60 * 1000;

interface ServerCacheEntry {
  serverPromise: Promise<MCPServer>;
  lastAccessedAt: number;
  activeSessionIds: Set<string>;
}

export interface MCPServerManagerOptions {
  cacheMaxEntries?: number;
  cacheTtlMs?: number;
  now?: () => number;
  serverFactory?: (profileId: string, resolved: ResolvedProfile) => Promise<MCPServer>;
}

export interface MCPServerManagerConfig {
  cacheMaxEntries: number;
  cacheTtlMs: number;
}

export function buildMCPServerManagerConfigFromEnv(): MCPServerManagerConfig {
  return {
    cacheMaxEntries: parsePositiveIntegerEnv('MCP4_PROFILE_SERVER_CACHE_MAX', DEFAULT_PROFILE_SERVER_CACHE_MAX_ENTRIES),
    cacheTtlMs: parseNonNegativeIntegerEnv('MCP4_PROFILE_SERVER_CACHE_TTL_MS', DEFAULT_PROFILE_SERVER_CACHE_TTL_MS),
  };
}

function parsePositiveIntegerEnv(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw === undefined) {
    return defaultValue;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${name}: expected positive integer`);
  }

  return parsed;
}

function parseNonNegativeIntegerEnv(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw === undefined) {
    return defaultValue;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid ${name}: expected non-negative integer`);
  }

  return parsed;
}

export class MCPServerManager {
  private registry: ProfileRegistry;
  private logger: Logger;
  private httpTransport?: HttpTransport;
  private globalFiltering?: FilteringRules;
  private readonly cacheMaxEntries: number;
  private readonly cacheTtlMs: number;
  private readonly now: () => number;
  private readonly serverFactory?: (profileId: string, resolved: ResolvedProfile) => Promise<MCPServer>;
  private servers = new Map<string, ServerCacheEntry>();

  constructor(
    registry: ProfileRegistry,
    logger: Logger,
    httpTransport?: HttpTransport,
    globalFiltering?: FilteringRules,
    options: MCPServerManagerOptions = {}
  ) {
    this.registry = registry;
    this.logger = logger;
    this.httpTransport = httpTransport;
    this.globalFiltering = globalFiltering;
    this.cacheMaxEntries = options.cacheMaxEntries ?? DEFAULT_PROFILE_SERVER_CACHE_MAX_ENTRIES;
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_PROFILE_SERVER_CACHE_TTL_MS;
    this.now = options.now ?? (() => Date.now());
    this.serverFactory = options.serverFactory;
  }

  getDefaultProfileId(): string | undefined {
    return this.registry.getDefaultProfile()?.profileId;
  }

  async getProfileContext(profileId: string): Promise<HttpProfileContext | null> {
    const server = await this.getServer(profileId);
    return server.getHttpProfileContext();
  }

  async getServer(profileId: string): Promise<MCPServer> {
    this.pruneExpiredInactiveEntries();

    const existing = this.servers.get(profileId);
    if (existing) {
      this.touchEntry(existing);
      return existing.serverPromise;
    }

    const entry = this.createCacheEntry(profileId);
    this.servers.set(profileId, entry);
    this.enforceCacheLimit();
    return entry.serverPromise;
  }

  async handleHttpMessage(message: unknown, sessionId: string | undefined, profileId: string): Promise<unknown> {
    const server = await this.getServer(profileId);
    const response = await server.handleHttpMessage(message, sessionId, profileId);

    if (sessionId) {
      const entry = this.servers.get(profileId);
      if (entry) {
        entry.activeSessionIds.add(sessionId);
        this.touchEntry(entry);
      }
    }

    return response;
  }

  async handleSessionDestroyed(profileId: string, sessionId: string): Promise<void> {
    const entry = this.servers.get(profileId);
    if (!entry) {
      return;
    }

    entry.activeSessionIds.delete(sessionId);
    const server = await entry.serverPromise;
    server.handleSessionDestroyed(profileId, sessionId);
    this.pruneExpiredInactiveEntries();
    this.enforceCacheLimit();
  }

  private createCacheEntry(profileId: string): ServerCacheEntry {
    const entry: ServerCacheEntry = {
      serverPromise: Promise.resolve(null as never),
      lastAccessedAt: this.now(),
      activeSessionIds: new Set<string>(),
    };

    entry.serverPromise = this.createServer(profileId).catch((error) => {
      const current = this.servers.get(profileId);
      if (current === entry) {
        this.servers.delete(profileId);
      }
      throw error;
    });

    return entry;
  }

  private touchEntry(entry: ServerCacheEntry): void {
    entry.lastAccessedAt = this.now();
  }

  private pruneExpiredInactiveEntries(): void {
    if (this.cacheTtlMs === 0) {
      return;
    }

    const now = this.now();
    for (const [profileId, entry] of this.servers.entries()) {
      if (entry.activeSessionIds.size > 0) {
        continue;
      }
      if (now - entry.lastAccessedAt < this.cacheTtlMs) {
        continue;
      }
      this.servers.delete(profileId);
    }
  }

  private enforceCacheLimit(): void {
    while (this.servers.size > this.cacheMaxEntries) {
      const candidate = this.findOldestInactiveProfileId();
      if (!candidate) {
        break;
      }
      this.servers.delete(candidate);
    }
  }

  private findOldestInactiveProfileId(): string | null {
    let oldestProfileId: string | null = null;
    let oldestAccessTime = Number.POSITIVE_INFINITY;

    for (const [profileId, entry] of this.servers.entries()) {
      if (entry.activeSessionIds.size > 0) {
        continue;
      }
      if (entry.lastAccessedAt >= oldestAccessTime) {
        continue;
      }
      oldestProfileId = profileId;
      oldestAccessTime = entry.lastAccessedAt;
    }

    return oldestProfileId;
  }

  private async createServer(profileId: string): Promise<MCPServer> {
    const resolved = await this.registry.resolveProfile(profileId);
    if (this.serverFactory) {
      return this.serverFactory(profileId, resolved);
    }

    const server = new MCPServer(this.logger);
    server.setGlobalFiltering(this.globalFiltering);
    await server.initialize(resolved.specPath, resolved.profilePath);
    if (this.httpTransport) {
      server.attachHttpTransport(this.httpTransport);
    }
    return server;
  }
}
