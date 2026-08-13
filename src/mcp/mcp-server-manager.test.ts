/**
 * Consent chokepoint wiring.
 *
 * Enforcement lives in the function injected via `setGetUpstreamClient`, so
 * every upstream dispatch path inherits it. These tests exercise that seam
 * directly: the guard must run before a connection is acquired, and a profile
 * requiring consent must refuse to dispatch when no enforcer is reachable.
 */
import { describe, expect, it, vi } from 'vitest';

import { MCPServerManager } from './mcp-server-manager.js';
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
