import { describe, it, expect } from 'vitest';
import path from 'path';
import { ConsoleLogger } from './logger.js';
import { ProfileRegistry } from './profile-registry.js';
import type { ResolvedProfile } from './profile-resolver.js';
import { MCPServerManager } from './mcp-server-manager.js';
import { HttpTransport } from './http-transport.js';

describe('MCPServerManager', () => {
  it('returns same instance for repeated profile requests', async () => {
    const logger = new ConsoleLogger();
    const registry = new ProfileRegistry({
      profilesDir: path.join(process.cwd(), 'profiles'),
    });
    const manager = new MCPServerManager(registry, logger);

    const serverA = await manager.getServer('gitlab');
    const serverB = await manager.getServer('gitlab');

    expect(serverA).toBe(serverB);
  });

  it('returns profile context via lazy initialization', async () => {
    const logger = new ConsoleLogger();
    const registry = new ProfileRegistry({
      profilesDir: path.join(process.cwd(), 'profiles'),
    });
    const manager = new MCPServerManager(registry, logger);

    const context = await manager.getProfileContext('gitlab');
    expect(context?.profileId).toBe('gitlab');
    expect(context?.baseUrl).toBeTruthy();
  });

  it('returns default profile id from registry', () => {
    const logger = new ConsoleLogger();
    const defaultProfile: ResolvedProfile = {
      profileId: 'default',
      profileName: 'Default Profile',
      profilePath: '/tmp/profile.json',
      specPath: '/tmp/openapi.yaml',
    };
    const registry = new ProfileRegistry({ defaultProfile });
    const manager = new MCPServerManager(registry, logger);

    expect(manager.getDefaultProfileId()).toBe('default');
  });

  it('routes HTTP requests through manager for profile routing', async () => {
    const logger = new ConsoleLogger();
    const registry = new ProfileRegistry({
      profilesDir: path.join(process.cwd(), 'profiles'),
    });
    const httpTransport = new HttpTransport(
      {
        host: '127.0.0.1',
        port: 0,
        sessionTimeoutMs: 1800000,
        heartbeatEnabled: false,
        heartbeatIntervalMs: 30000,
        metricsEnabled: false,
        metricsPath: '/metrics',
        profileRoutingEnabled: true,
      },
      logger
    );
    const manager = new MCPServerManager(registry, logger, httpTransport);

    httpTransport.setProfileContextProvider(async (id) => manager.getProfileContext(id));
    httpTransport.setMessageHandler(async (message, sessionId, profileId) => {
      if (!profileId) {
        throw new Error('Profile ID missing');
      }
      const server = await manager.getServer(profileId);
      return server.handleHttpMessage(message, sessionId, profileId);
    });

    const req: any = {
      method: 'POST',
      path: '/profile/youtrack/mcp',
      url: '/profile/youtrack/mcp',
      headers: {
        accept: 'application/json',
        host: 'localhost',
      },
      profileId: 'youtrack',
      body: {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          clientInfo: { name: 'test', version: '1.0.0' },
        },
      },
    };
    const res: any = {
      statusCode: 200,
      headers: {} as Record<string, string>,
      headersSent: false,
      setHeader: (key: string, value: string) => {
        res.headers[key.toLowerCase()] = value;
      },
      status: (code: number) => {
        res.statusCode = code;
        return res;
      },
      json: (body: unknown) => {
        res.body = body;
        res.headersSent = true;
        return res;
      },
      send: (body?: unknown) => {
        res.body = body;
        res.headersSent = true;
        return res;
      },
      end: () => {
        res.headersSent = true;
      },
      get: () => undefined,
    };

    await (httpTransport as any).handlePost(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body?.result?.serverInfo?.name).toBe('mcp4openapi');

    await httpTransport.stop();
  });
});

describe('ProfileRegistry', () => {
  it('returns default profile when profileId matches', async () => {
    const defaultProfile: ResolvedProfile = {
      profileId: 'default',
      profileName: 'Default Profile',
      profilePath: '/tmp/profile.json',
      specPath: '/tmp/openapi.yaml',
    };
    const registry = new ProfileRegistry({ defaultProfile });

    const resolved = await registry.resolveProfile('default');
    expect(resolved).toBe(defaultProfile);
  });

  it('returns default profile when profileName matches', async () => {
    const defaultProfile: ResolvedProfile = {
      profileId: 'primary',
      profileName: 'Default Profile',
      profilePath: '/tmp/profile.json',
      specPath: '/tmp/openapi.yaml',
    };
    const registry = new ProfileRegistry({ defaultProfile });

    const resolved = await registry.resolveProfile('Default Profile');
    expect(resolved).toBe(defaultProfile);
  });
});
