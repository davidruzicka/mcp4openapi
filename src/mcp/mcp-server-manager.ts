/**
 * MCP server manager for multi-profile HTTP routing.
 */

import type { Logger } from '../core/logger.js';
import { MCPServer } from './mcp-server.js';
import type { HttpProfileContext } from '../types/http-transport.js';
import type { HttpTransport } from '../transport/http-transport.js';
import { ProfileRegistry } from '../profile/profile-registry.js';

export class MCPServerManager {
  private registry: ProfileRegistry;
  private logger: Logger;
  private httpTransport?: HttpTransport;
  private servers = new Map<string, Promise<MCPServer>>();

  constructor(registry: ProfileRegistry, logger: Logger, httpTransport?: HttpTransport) {
    this.registry = registry;
    this.logger = logger;
    this.httpTransport = httpTransport;
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
    await server.initialize(resolved.specPath, resolved.profilePath);
    if (this.httpTransport) {
      server.attachHttpTransport(this.httpTransport);
    }
    return server;
  }
}
