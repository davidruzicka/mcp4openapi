/**
 * Consent chokepoint wiring.
 *
 * Enforcement lives in the function injected via `setGetUpstreamClient`, so
 * every upstream dispatch path inherits it. These tests exercise that seam
 * directly: the guard must run before a connection is acquired, and a profile
 * requiring consent must refuse to dispatch when no enforcer is reachable.
 */
import { describe, expect, it, vi } from 'vitest';

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { MCPServerManager } from './mcp-server-manager.js';
import { ProfileRegistry } from '../profile/profile-registry.js';
import { ConsentGateConfigurationError } from '../core/errors.js';
import type { Logger } from '../core/logger.js';
import type { UpstreamMcpServerConfig } from '../types/profile.js';

const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

const provider = {
  name: 'upstream',
  transport: { type: 'http', url: 'https://upstream.example.test/mcp' },
} as unknown as UpstreamMcpServerConfig;

const buildManager = (httpTransport?: Record<string, unknown>) => {
  const registry = { getDefaultProfile: () => undefined } as never;
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

const dispatchFor = (manager: MCPServerManager, consentRequired: boolean) =>
  (manager as any).buildUpstreamDispatch('ms365', { isConsentRequired: () => consentRequired });

describe('MCPServerManager upstream dispatch chokepoint', () => {
  it('asserts consent before acquiring an upstream client', async () => {
    const assertSessionConsent = vi.fn(async () => undefined);
    const { manager, getOrConnect } = buildManager({ assertSessionConsent });

    await dispatchFor(manager, true)('session-1', provider, 'token');

    expect(assertSessionConsent).toHaveBeenCalledWith('ms365', 'session-1');
    expect(assertSessionConsent.mock.invocationCallOrder[0]).toBeLessThan(
      getOrConnect.mock.invocationCallOrder[0],
    );
  });

  it('does not acquire an upstream client when consent is denied', async () => {
    const denial = new Error('Consent required');
    const assertSessionConsent = vi.fn(async () => {
      throw denial;
    });
    const { manager, getOrConnect } = buildManager({ assertSessionConsent });

    await expect(dispatchFor(manager, true)('session-1', provider, 'token')).rejects.toBe(denial);
    expect(getOrConnect).not.toHaveBeenCalled();
  });

  it('refuses to dispatch when consent is required but no enforcer is reachable', async () => {
    // Supported construction: a manager without an HTTP transport still wires
    // setGetUpstreamClient, which used to dispatch upstream ungated.
    const { manager, getOrConnect } = buildManager(undefined);

    await expect(dispatchFor(manager, true)('session-1', provider, 'token')).rejects.toBeInstanceOf(
      ConsentGateConfigurationError,
    );
    expect(getOrConnect).not.toHaveBeenCalled();
  });

  it('refuses to dispatch when the transport cannot enforce consent', async () => {
    const { manager, getOrConnect } = buildManager({});

    await expect(dispatchFor(manager, true)('session-1', provider, 'token')).rejects.toBeInstanceOf(
      ConsentGateConfigurationError,
    );
    expect(getOrConnect).not.toHaveBeenCalled();
  });

  it('does not enforce consent for a profile that does not require it', async () => {
    const assertSessionConsent = vi.fn(async () => undefined);
    const { manager, getOrConnect } = buildManager({ assertSessionConsent });

    await dispatchFor(manager, false)('session-1', provider, 'token');

    expect(assertSessionConsent).not.toHaveBeenCalled();
    expect(getOrConnect).toHaveBeenCalledWith('session-1', provider, 'token');
  });
});

/**
 * The tests above call `buildUpstreamDispatch` directly, which proves the guard
 * works but not that it is attached. If `createServer` were changed to wire
 * `upstreamManager.getOrConnect` straight into `setGetUpstreamClient`, they would
 * all still pass while the chokepoint disappeared. This suite goes through the
 * real `createServer` path with a real `ProfileRegistry` and a profile on disk.
 */
describe('MCPServerManager wiring through createServer', () => {
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

  const buildRealManager = async (profilesDir: string) => {
    const registry = new ProfileRegistry({ profilesDir });
    const manager = new MCPServerManager(registry, logger);
    const getOrConnect = vi.fn(async () => ({ listTools: vi.fn(), callTool: vi.fn() }));
    (manager as any).upstreamManager = { getOrConnect, addToolsListChangedHook: vi.fn() };
    return { manager, getOrConnect };
  };

  it('attaches the consent chokepoint to the server it creates', async () => {
    const profilesDir = await writeProfiles(consentProfile);
    const { manager, getOrConnect } = await buildRealManager(profilesDir);

    const server = await manager.getServer('consent-wiring');
    const dispatch = (server as any).getUpstreamClientFn;
    expect(typeof dispatch).toBe('function');

    // No HTTP transport, so no enforcer is reachable: a consent-gated profile
    // must refuse rather than connect upstream.
    await expect(dispatch('session-1', consentProfile.upstream_mcp, 'token')).rejects.toBeInstanceOf(
      ConsentGateConfigurationError,
    );
    expect(getOrConnect).not.toHaveBeenCalled();
  });

  it('enforces consent through the created server for a session that has none', async () => {
    const profilesDir = await writeProfiles(consentProfile);
    const assertSessionConsent = vi.fn(async () => {
      throw new Error('Consent required');
    });
    const registry = new ProfileRegistry({ profilesDir });
    const manager = new MCPServerManager(registry, logger, {
      setUpstreamConnectionManager: vi.fn(),
      onSessionDestroyed: vi.fn(),
      assertSessionConsent,
    } as never);
    const getOrConnect = vi.fn(async () => ({ listTools: vi.fn(), callTool: vi.fn() }));
    (manager as any).upstreamManager = { getOrConnect, addToolsListChangedHook: vi.fn() };

    const server = await manager.getServer('consent-wiring');
    await expect(
      (server as any).getUpstreamClientFn('session-1', consentProfile.upstream_mcp, 'token'),
    ).rejects.toThrow('Consent required');

    expect(assertSessionConsent).toHaveBeenCalledWith('consent-wiring', 'session-1');
    expect(getOrConnect).not.toHaveBeenCalled();
  });

  it('does not gate a profile that declares no consent requirement', async () => {
    const profilesDir = await writeProfiles(localProfile);
    const { manager, getOrConnect } = await buildRealManager(profilesDir);

    const server = await manager.getServer('local-wiring');
    await (server as any).getUpstreamClientFn('session-1', localProfile.upstream_mcp, 'token');

    expect(getOrConnect).toHaveBeenCalledWith('session-1', localProfile.upstream_mcp, 'token');
  });
});
