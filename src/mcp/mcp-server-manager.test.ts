/**
 * MCPServerManager tests.
 *
 * Covers profile-server lifecycle (instance caching, lazy context, session
 * cleanup self-registration), HTTP routing through the manager, ProfileRegistry
 * resolution, and the consent chokepoint: enforcement lives in the wrapper
 * built by `MCPServer.setGetUpstreamClient`, so the manager only injects the
 * plain connection factory and every upstream dispatch path inherits the guard.
 */
import { describe, expect, it, vi } from 'vitest';

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { MCPServerManager } from './mcp-server-manager.js';
import { ProfileRegistry } from '../profile/profile-registry.js';
import { ConsentGateConfigurationError } from '../core/errors.js';
import { ConsoleLogger } from '../core/logger.js';
import type { Logger } from '../core/logger.js';
import type { ResolvedProfile } from '../profile/profile-resolver.js';
import { resolveProfileFromPath } from '../profile/profile-resolver.js';
import { HttpTransport } from '../transport/http-transport.js';

const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

describe('MCPServerManager', () => {
  it('returns same instance for repeated profile requests', async () => {
    const consoleLogger = new ConsoleLogger();
    const registry = new ProfileRegistry({
      profilesDir: path.join(process.cwd(), 'profiles'),
    });
    const manager = new MCPServerManager(registry, consoleLogger);

    const serverA = await manager.getServer('gitlab');
    const serverB = await manager.getServer('gitlab');

    expect(serverA).toBe(serverB);
  });

  it('returns profile context via lazy initialization', async () => {
    const consoleLogger = new ConsoleLogger();
    const registry = new ProfileRegistry({
      profilesDir: path.join(process.cwd(), 'profiles'),
    });
    const manager = new MCPServerManager(registry, consoleLogger);

    const context = await manager.getProfileContext('gitlab');
    expect(context?.profileId).toBe('gitlab');
    expect(context?.baseUrl).toBeTruthy();
  });

  it('self-registers onSessionDestroyed cleanup when httpTransport provided', async () => {
    const consoleLogger = new ConsoleLogger();
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

    new MCPServerManager(registry, consoleLogger, mockTransport);

    expect(mockOnSessionDestroyed).toHaveBeenCalledTimes(1);
    const handler = mockOnSessionDestroyed.mock.calls[0][0];
    expect(typeof handler).toBe('function');

    // Wire mock server returned by getServer
    const mockGetServer = vi.fn().mockResolvedValue({ handleSessionDestroyed: mockHandleSessionDestroyed });
    const manager = new MCPServerManager(registry, consoleLogger, mockTransport);
    (manager as any).getServer = mockGetServer;

    // Fire the handler registered by the second manager
    const handler2 = mockOnSessionDestroyed.mock.calls[1][0];
    await handler2('default', 'session-1');

    expect(mockGetServer).toHaveBeenCalledWith('default');
    expect(mockHandleSessionDestroyed).toHaveBeenCalledWith('default', 'session-1');
  });

  it('returns default profile id from registry', () => {
    const consoleLogger = new ConsoleLogger();
    const defaultProfile: ResolvedProfile = {
      profileId: 'default',
      profileName: 'Default Profile',
      profilePath: '/tmp/profile.json',
      specPath: '/tmp/openapi.yaml',
    };
    const registry = new ProfileRegistry({ defaultProfile });
    const manager = new MCPServerManager(registry, consoleLogger);

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

    const consoleLogger = new ConsoleLogger();
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
      consoleLogger
    );
    const manager = new MCPServerManager(registry, consoleLogger, httpTransport);

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
    const consoleLogger = new ConsoleLogger();
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
      consoleLogger
    );
    const manager = new MCPServerManager(registry, consoleLogger, httpTransport);

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

/**
 * Consent chokepoint through the real `createServer` path.
 *
 * The manager injects the PLAIN connection factory; enforcement lives inside
 * the wrapper `MCPServer.setGetUpstreamClient` builds around it. These tests go
 * through a real `ProfileRegistry` with a profile on disk, so they fail if
 * either side of that wiring disappears: if `createServer` stopped calling
 * `setGetUpstreamClient`, or if the wrapper stopped enforcing consent.
 */
describe('MCPServerManager consent enforcement through createServer', () => {
  const consentProfile = {
    profile_name: 'consent-wiring',
    profile_id: 'consent-wiring',
    tools: [],
    consent_gate: {
      required: true,
      rules_version: 'v1',
      identity_source: 'profile_oauth',
    },
    interceptors: {
      auth: {
        type: 'oauth',
        oauth_config: {
          issuer: 'https://login.example.test/tenant/v2.0',
          client_id: 'client-id',
          redirect_uri: 'https://gateway.example.test/oauth/callback',
          scopes: ['openid'],
        },
      },
    },
    upstream_mcp: {
      name: 'upstream',
      transport: { type: 'http-streamable', url: 'https://upstream.example.test/mcp' },
      auth: { type: 'bearer' },
      tools: { allow: ['list-drives'] },
    },
  };

  const localProfile = {
    profile_name: 'local-wiring',
    profile_id: 'local-wiring',
    tools: [],
    upstream_mcp: {
      name: 'upstream',
      transport: { type: 'http-streamable', url: 'https://upstream.example.test/mcp' },
    },
  };

  const writeProfiles = async (...profiles: Record<string, unknown>[]): Promise<string> => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp4-wiring-'));
    const profilesDir = path.join(root, 'profiles');
    await fs.mkdir(profilesDir, { recursive: true });
    for (const profile of profiles) {
      await fs.writeFile(
        path.join(profilesDir, `${profile.profile_id as string}.json`),
        JSON.stringify(profile, null, 2),
        'utf-8',
      );
    }
    return profilesDir;
  };

  const buildRealManager = async (
    profilesDir: string,
    httpTransport?: Record<string, unknown>,
  ) => {
    const registry = new ProfileRegistry({ profilesDir });
    const transport = httpTransport && {
      setUpstreamConnectionManager: vi.fn(),
      onSessionDestroyed: vi.fn(),
      ...httpTransport,
    };
    const manager = new MCPServerManager(registry, logger, transport as never);
    const getOrConnect = vi.fn(async () => ({ listTools: vi.fn(), callTool: vi.fn() }));
    (manager as any).upstreamManager = { getOrConnect, addToolsListChangedHook: vi.fn() };
    return { manager, getOrConnect };
  };

  it('asserts consent before acquiring an upstream client', async () => {
    const profilesDir = await writeProfiles(consentProfile);
    const assertSessionConsent = vi.fn(async () => undefined);
    const { manager, getOrConnect } = await buildRealManager(profilesDir, { assertSessionConsent });

    const server = await manager.getServer('consent-wiring');
    await (server as any).getUpstreamClientFn('session-1', consentProfile.upstream_mcp, 'token');

    expect(assertSessionConsent).toHaveBeenCalledWith('consent-wiring', 'session-1');
    expect(assertSessionConsent.mock.invocationCallOrder[0]).toBeLessThan(
      getOrConnect.mock.invocationCallOrder[0],
    );
  });

  it('does not acquire an upstream client when consent is denied', async () => {
    const profilesDir = await writeProfiles(consentProfile);
    const assertSessionConsent = vi.fn(async () => {
      throw new Error('Consent required');
    });
    const { manager, getOrConnect } = await buildRealManager(profilesDir, { assertSessionConsent });

    const server = await manager.getServer('consent-wiring');
    await expect(
      (server as any).getUpstreamClientFn('session-1', consentProfile.upstream_mcp, 'token'),
    ).rejects.toThrow('Consent required');

    expect(assertSessionConsent).toHaveBeenCalledWith('consent-wiring', 'session-1');
    expect(getOrConnect).not.toHaveBeenCalled();
  });

  it('refuses to dispatch when consent is required but no enforcer is reachable', async () => {
    // Supported construction: a manager without an HTTP transport still wires
    // setGetUpstreamClient; a consent-gated profile must refuse rather than
    // connect upstream ungated.
    const profilesDir = await writeProfiles(consentProfile);
    const { manager, getOrConnect } = await buildRealManager(profilesDir);

    const server = await manager.getServer('consent-wiring');
    const dispatch = (server as any).getUpstreamClientFn;
    expect(typeof dispatch).toBe('function');

    await expect(dispatch('session-1', consentProfile.upstream_mcp, 'token')).rejects.toBeInstanceOf(
      ConsentGateConfigurationError,
    );
    expect(getOrConnect).not.toHaveBeenCalled();
  });

  it('refuses to dispatch when the transport cannot enforce consent', async () => {
    const profilesDir = await writeProfiles(consentProfile);
    const { manager, getOrConnect } = await buildRealManager(profilesDir, {});

    const server = await manager.getServer('consent-wiring');
    await expect(
      (server as any).getUpstreamClientFn('session-1', consentProfile.upstream_mcp, 'token'),
    ).rejects.toBeInstanceOf(ConsentGateConfigurationError);
    expect(getOrConnect).not.toHaveBeenCalled();
  });

  it('does not gate a profile that declares no consent requirement', async () => {
    const profilesDir = await writeProfiles(localProfile);
    const assertSessionConsent = vi.fn(async () => undefined);
    const { manager, getOrConnect } = await buildRealManager(profilesDir, { assertSessionConsent });

    const server = await manager.getServer('local-wiring');
    await (server as any).getUpstreamClientFn('session-1', localProfile.upstream_mcp, 'token');

    expect(assertSessionConsent).not.toHaveBeenCalled();
    expect(getOrConnect).toHaveBeenCalledWith('session-1', localProfile.upstream_mcp, 'token');
  });
});
