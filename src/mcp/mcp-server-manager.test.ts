import { describe, it, expect } from 'vitest';
import path from 'path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { ConsoleLogger } from '../core/logger.js';
import { ProfileRegistry } from '../profile/profile-registry.js';
import type { ResolvedProfile } from '../profile/profile-resolver.js';
import { resolveProfileFromPath } from '../profile/profile-resolver.js';
import { MCPServerManager } from './mcp-server-manager.js';
import { HttpTransport } from '../transport/http-transport.js';

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
    const previousYouTrackToken = process.env.YOUTRACK_TOKEN;
    process.env.YOUTRACK_TOKEN = previousYouTrackToken ?? 'test-youtrack-token';

    try {
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
    } finally {
      if (previousYouTrackToken === undefined) {
        delete process.env.YOUTRACK_TOKEN;
      } else {
        process.env.YOUTRACK_TOKEN = previousYouTrackToken;
      }
    }
  });

  it('routes HTTP requests through manager when profile id is an alias of default profile', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp4-alias-routing-'));
    const profilePath = path.join(root, 'profile.json');
    const specPath = path.join(process.cwd(), 'profiles/gitlab/openapi.yaml');

    await fs.writeFile(profilePath, JSON.stringify({
      profile_name: 'alias-profile',
      profile_id: 'alias-profile',
      profile_aliases: ['alias-one'],
      openapi_spec_path: specPath,
      tools: [],
    }), 'utf-8');

    const defaultProfile = await resolveProfileFromPath(profilePath);
    const logger = new ConsoleLogger();
    const registry = new ProfileRegistry({ defaultProfile });
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
      path: '/profile/alias-one/mcp',
      url: '/profile/alias-one/mcp',
      headers: {
        accept: 'application/json',
        host: 'localhost',
      },
      profileId: 'alias-one',
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

  it('returns default profile when alias matches', async () => {
    const defaultProfile: ResolvedProfile = {
      profileId: 'primary',
      profileName: 'Default Profile',
      profileAliases: ['alias-one', 'alias-two'],
      profilePath: '/tmp/profile.json',
      specPath: '/tmp/openapi.yaml',
    };
    const registry = new ProfileRegistry({ defaultProfile });

    const resolved = await registry.resolveProfile('alias-two');
    expect(resolved).toBe(defaultProfile);
  });

  it('uses spec path override for profiles missing openapi_spec_path', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp4-registry-'));
    const profilesDir = path.join(root, 'profiles');
    const profilePath = path.join(profilesDir, 'profile.json');
    const specPath = path.join(root, 'openapi.yaml');

    await fs.mkdir(profilesDir, { recursive: true });
    await fs.writeFile(profilePath, JSON.stringify({
      profile_name: 'missing-spec',
      profile_id: 'missing',
      tools: [],
    }), 'utf-8');
    await fs.writeFile(specPath, 'openapi: 3.1.0', 'utf-8');

    const registry = new ProfileRegistry({
      profilesDir,
      specPathOverride: specPath,
    });

    const resolved = await registry.resolveProfile('missing');
    expect(resolved.specPath).toBe(specPath);
  });
});
