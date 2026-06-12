import { describe, it, expect, vi } from 'vitest';
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

  it('self-registers onSessionDestroyed cleanup when httpTransport provided', async () => {
    const logger = new ConsoleLogger();
    const defaultProfile: ResolvedProfile = {
      profileId: 'default',
      profileName: 'Default Profile',
      profilePath: '/tmp/profile.json',
      specPath: '/tmp/openapi.yaml',
    };
    const registry = new ProfileRegistry({ defaultProfile });

    const mockHandleSessionDestroyed = vi.fn();
    const mockOnSessionDestroyed = vi.fn();
    const mockSetUpstreamConnectionManager = vi.fn();
    const mockTransport = {
      onSessionDestroyed: mockOnSessionDestroyed,
      setUpstreamConnectionManager: mockSetUpstreamConnectionManager,
    } as unknown as HttpTransport;

    new MCPServerManager(registry, logger, mockTransport);

    expect(mockOnSessionDestroyed).toHaveBeenCalledTimes(1);
    const handler = mockOnSessionDestroyed.mock.calls[0][0];
    expect(typeof handler).toBe('function');

    // Wire mock server returned by getServer
    const mockGetServer = vi.fn().mockResolvedValue({ handleSessionDestroyed: mockHandleSessionDestroyed });
    const manager = new MCPServerManager(registry, logger, mockTransport);
    (manager as any).getServer = mockGetServer;

    // Fire the handler registered by the second manager
    const handler2 = mockOnSessionDestroyed.mock.calls[1][0];
    await handler2('default', 'session-1');

    expect(mockGetServer).toHaveBeenCalledWith('default');
    expect(mockHandleSessionDestroyed).toHaveBeenCalledWith('default', 'session-1');
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
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp4-routing-profiles-'));
    const specPath = path.join(process.cwd(), 'profiles/gitlab/openapi.yaml');

    await fs.writeFile(path.join(root, 'alpha.json'), JSON.stringify({
      profile_name: 'Alpha Profile',
      profile_id: 'alpha',
      openapi_spec_path: specPath,
      tools: [],
    }), 'utf-8');
    await fs.writeFile(path.join(root, 'beta.json'), JSON.stringify({
      profile_name: 'Beta Profile',
      profile_id: 'beta',
      openapi_spec_path: specPath,
      tools: [],
    }), 'utf-8');

    const logger = new ConsoleLogger();
    const registry = new ProfileRegistry({ profilesDir: root });
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

    const sendInitialize = async (profileId: string) => {
      const req: any = {
        method: 'POST',
        path: `/profile/${profileId}/mcp`,
        url: `/profile/${profileId}/mcp`,
        headers: {
          accept: 'application/json',
          host: 'localhost',
        },
        profileId,
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
      return res;
    };

    const alphaResponse = await sendInitialize('alpha');
    const betaResponse = await sendInitialize('beta');

    expect(alphaResponse.statusCode).toBe(200);
    expect(alphaResponse.body?.result?.serverInfo?.name).toBe('mcp4openapi');
    expect(alphaResponse.body?.result?.serverInfo?.title).toBe('Alpha Profile');
    expect(betaResponse.statusCode).toBe(200);
    expect(betaResponse.body?.result?.serverInfo?.name).toBe('mcp4openapi');
    expect(betaResponse.body?.result?.serverInfo?.title).toBe('Beta Profile');
    expect(betaResponse.body?.result?.serverInfo?.title).not.toBe(alphaResponse.body?.result?.serverInfo?.title);

    await httpTransport.stop();
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
    expect(res.body?.result?.serverInfo?.title).toBe('alias-profile');

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
