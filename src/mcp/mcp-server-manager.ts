/**
 * MCP server manager for multi-profile HTTP routing.
 */

import type { Logger } from '../core/logger.js';
import type { FilteringRules } from '../core/filtering.js';
import { MCPServer } from './mcp-server.js';
import type { HttpProfileContext } from '../types/http-transport.js';
import type { HttpTransport } from '../transport/http-transport.js';
import { ProfileRegistry } from '../profile/profile-registry.js';
import { UpstreamConnectionManager } from '../upstream/upstream-connection-manager.js';

export class MCPServerManager {
  private registry: ProfileRegistry;
  private logger: Logger;
  private httpTransport?: HttpTransport;
  private globalFiltering?: FilteringRules;
  private servers = new Map<string, Promise<MCPServer>>();
  private upstreamManager: UpstreamConnectionManager;

  constructor(
    registry: ProfileRegistry,
    logger: Logger,
    httpTransport?: HttpTransport,
    globalFiltering?: FilteringRules
  ) {
    this.registry = registry;
    this.logger = logger;
    this.httpTransport = httpTransport;
    this.globalFiltering = globalFiltering;
    this.upstreamManager = new UpstreamConnectionManager({ logger });
    if (httpTransport) {
      httpTransport.setUpstreamConnectionManager(this.upstreamManager);
      // Self-register cleanup so the manager works correctly when used outside
      // the index.ts bootstrap (e.g. direct MCPServerManager + attachHttpTransport usage).
      httpTransport.onSessionDestroyed(async (profileId, sessionId) => {
        try {
          const server = await this.getServer(profileId);
          server.handleSessionDestroyed(profileId, sessionId);
        } catch (error) {
          this.logger.error('Session cleanup failed', error as Error, { profileId, sessionId });
        }
      });
    }
  }

  getDefaultProfileId(): string | undefined {
    return this.registry.getDefaultProfile()?.profileId;
  }

  async getProfileContext(profileId: string): Promise<HttpProfileContext | null> {
    const server = await this.getServer(profileId);
    return server.getHttpProfileContext();
  }

  async getServer(profileId: string): Promise<MCPServer> {
    const existing = this.servers.get(profileId);
    if (existing) {
      return existing;
    }

    const createPromise = this.createServer(profileId);
    this.servers.set(profileId, createPromise);
    return createPromise;
  }

  private async createServer(profileId: string): Promise<MCPServer> {
    const resolved = await this.registry.resolveProfile(profileId);
    const server = new MCPServer(this.logger);
    server.setGlobalFiltering(this.globalFiltering);

    if (resolved.specPath != null) {
      await server.initialize(resolved.specPath, resolved.profilePath);
    } else {
      await server.initializeWithoutSpec(resolved.profilePath);
    }
    if (this.httpTransport) {
      server.attachHttpTransport(this.httpTransport);
    }
    server.setGetUpstreamClient((s, p, t) => this.upstreamManager.getOrConnect(s, p, t));
    this.upstreamManager.addToolsListChangedHook((s, p) => server.invalidateUpstreamToolCache(s, p));
    return server;
  }
}
