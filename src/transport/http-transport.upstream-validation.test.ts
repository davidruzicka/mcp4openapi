/**
 * Tests for upstream credential validation at session initialization.
 *
 * Covers: validateCredentials wiring in isInitialization block, 401 response on
 * UpstreamAuthError, skip logic when upstreamMcp is absent or has no validation_endpoint.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { HttpTransport } from './http-transport.js';
import { ConsoleLogger } from '../core/logger.js';
import { UpstreamAuthError } from '../upstream/upstream-errors.js';
import { describeIfListen } from '../testing/listen-support.js';

const INIT_REQUEST = {
  jsonrpc: '2.0',
  method: 'initialize',
  params: {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'test-client', version: '1.0' },
  },
  id: 1,
};

describeIfListen('upstream credential validation at session init', () => {
  let transport: HttpTransport;
  let app: Express;
  const logger = new ConsoleLogger();

  function createProfileState(target: any, profileId: string = 'default', upstreamMcp?: any[]) {
    const state = {
      profileId,
      context: { profileId, upstreamMcp },
      oauthProvider: null,
      oauthTokensByAccessToken: new Map(),
      sessions: new Map(),
    };
    target.profileStates.set(profileId, state);
    return state;
  }

  beforeEach(async () => {
    const config = {
      host: '127.0.0.1',
      port: 0,
      sessionTimeoutMs: 1800000,
      heartbeatEnabled: false,
      heartbeatIntervalMs: 30000,
      metricsEnabled: false,
      metricsPath: '/metrics',
    };
    transport = new HttpTransport(config, logger);
    app = (transport as any).app;
    transport.setMessageHandler(async () => ({ result: { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'test', version: '1.0' } } }));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await transport.stop();
  });

  it('calls validateCredentials during isInitialization when upstreamMcp has validation_endpoint', async () => {
    const mockValidateCredentials = vi.fn().mockResolvedValue(undefined);
    const mockUpstreamConnectionManager = { validateCredentials: mockValidateCredentials, setHasActiveStreamFn: vi.fn(), setDownstreamNotifyFn: vi.fn() };
    transport.setUpstreamConnectionManager(mockUpstreamConnectionManager as any);

    const provider = {
      name: 'test-provider',
      transport: { type: 'http-streamable', url: 'https://upstream.example.com/mcp' },
      validation_endpoint: 'https://api.example.com/validate',
    };
    createProfileState(transport as any, 'default', [provider]);

    await request(app)
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json, text/event-stream')
      .set('Authorization', 'Bearer test-token-abc')
      .send(INIT_REQUEST);

    expect(mockValidateCredentials).toHaveBeenCalledWith(
      'pre-session',
      provider,
      'test-token-abc',
    );
  });

  it('returns 401 when validateCredentials throws UpstreamAuthError', async () => {
    const mockValidateCredentials = vi.fn().mockRejectedValue(new UpstreamAuthError('test-provider'));
    const mockUpstreamConnectionManager = { validateCredentials: mockValidateCredentials, setHasActiveStreamFn: vi.fn(), setDownstreamNotifyFn: vi.fn() };
    transport.setUpstreamConnectionManager(mockUpstreamConnectionManager as any);

    const provider = {
      name: 'test-provider',
      transport: { type: 'http-streamable', url: 'https://upstream.example.com/mcp' },
      validation_endpoint: 'https://api.example.com/validate',
    };
    createProfileState(transport as any, 'default', [provider]);

    const res = await request(app)
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json')
      .set('Authorization', 'Bearer bad-token')
      .send(INIT_REQUEST);

    expect(res.status).toBe(401);
    expect(res.body.message).toContain('Upstream authentication failed');
  });

  it('returns 502 when validateCredentials throws non-auth error', async () => {
    const networkError = new Error('ECONNREFUSED');
    const mockValidateCredentials = vi.fn().mockRejectedValue(networkError);
    const mockUpstreamConnectionManager = { validateCredentials: mockValidateCredentials, setHasActiveStreamFn: vi.fn(), setDownstreamNotifyFn: vi.fn() };
    transport.setUpstreamConnectionManager(mockUpstreamConnectionManager as any);

    const provider = {
      name: 'test-provider',
      transport: { type: 'http-streamable', url: 'https://upstream.example.com/mcp' },
      validation_endpoint: 'https://api.example.com/validate',
    };
    createProfileState(transport as any, 'default', [provider]);

    const res = await request(app)
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json')
      .set('Authorization', 'Bearer valid-token')
      .send(INIT_REQUEST);

    expect(res.status).toBe(502);
    expect(res.body.message).toContain('Upstream credential validation failed');
  });

  it('skips validation when no upstreamMcp providers configured', async () => {
    const mockValidateCredentials = vi.fn();
    const mockUpstreamConnectionManager = { validateCredentials: mockValidateCredentials, setHasActiveStreamFn: vi.fn(), setDownstreamNotifyFn: vi.fn() };
    transport.setUpstreamConnectionManager(mockUpstreamConnectionManager as any);

    createProfileState(transport as any, 'default', undefined);

    await request(app)
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json, text/event-stream')
      .send(INIT_REQUEST);

    expect(mockValidateCredentials).not.toHaveBeenCalled();
  });

  it('skips validation when provider has no validation_endpoint', async () => {
    const mockValidateCredentials = vi.fn();
    const mockUpstreamConnectionManager = { validateCredentials: mockValidateCredentials, setHasActiveStreamFn: vi.fn(), setDownstreamNotifyFn: vi.fn() };
    transport.setUpstreamConnectionManager(mockUpstreamConnectionManager as any);

    const provider = {
      name: 'test-provider',
      transport: { type: 'http-streamable', url: 'https://upstream.example.com/mcp' },
      // no validation_endpoint
    };
    createProfileState(transport as any, 'default', [provider]);

    await request(app)
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json, text/event-stream')
      .send(INIT_REQUEST);

    expect(mockValidateCredentials).not.toHaveBeenCalled();
  });

  it('does not log validation successful when no token is present (no-op path)', async () => {
    const mockValidateCredentials = vi.fn().mockResolvedValue(undefined);
    const mockUpstreamConnectionManager = { validateCredentials: mockValidateCredentials, setHasActiveStreamFn: vi.fn(), setDownstreamNotifyFn: vi.fn() };
    transport.setUpstreamConnectionManager(mockUpstreamConnectionManager as any);

    const infoSpy = vi.spyOn(logger, 'info');

    const provider = {
      name: 'test-provider',
      transport: { type: 'http-streamable', url: 'https://upstream.example.com/mcp' },
      validation_endpoint: 'https://api.example.com/validate',
    };
    createProfileState(transport as any, 'default', [provider]);

    // No Authorization header - token will be undefined
    await request(app)
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json, text/event-stream')
      .send(INIT_REQUEST);

    const successLogs = infoSpy.mock.calls.filter(
      (args) => typeof args[0] === 'string' && args[0].includes('Upstream credential validation successful'),
    );
    expect(successLogs).toHaveLength(0);
  });

  it('validates using env var token when provider has value_from_env and client sends no Authorization', async () => {
    const mockValidateCredentials = vi.fn().mockResolvedValue(undefined);
    const mockUpstreamConnectionManager = { validateCredentials: mockValidateCredentials, setHasActiveStreamFn: vi.fn(), setDownstreamNotifyFn: vi.fn() };
    transport.setUpstreamConnectionManager(mockUpstreamConnectionManager as any);
    vi.stubEnv('UPSTREAM_API_KEY', 'env-secret-token');

    const provider = {
      name: 'env-provider',
      transport: { type: 'http-streamable', url: 'https://upstream.example.com/mcp' },
      auth: { type: 'bearer', value_from_env: 'UPSTREAM_API_KEY' },
      validation_endpoint: 'https://api.example.com/validate',
    };
    createProfileState(transport as any, 'default', [provider]);

    // No Authorization header - client token is undefined
    await request(app)
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json, text/event-stream')
      .send(INIT_REQUEST);

    expect(mockValidateCredentials).toHaveBeenCalledWith(
      'pre-session',
      provider,
      'env-secret-token',
    );
  });

  it('does not validate when provider has value_from_env but env var is not set and client has no token', async () => {
    const mockValidateCredentials = vi.fn().mockResolvedValue(undefined);
    const mockUpstreamConnectionManager = { validateCredentials: mockValidateCredentials, setHasActiveStreamFn: vi.fn(), setDownstreamNotifyFn: vi.fn() };
    transport.setUpstreamConnectionManager(mockUpstreamConnectionManager as any);
    delete process.env['UPSTREAM_API_KEY_MISSING'];

    const provider = {
      name: 'env-provider',
      transport: { type: 'http-streamable', url: 'https://upstream.example.com/mcp' },
      auth: { type: 'bearer', value_from_env: 'UPSTREAM_API_KEY_MISSING' },
      validation_endpoint: 'https://api.example.com/validate',
    };
    createProfileState(transport as any, 'default', [provider]);

    await request(app)
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json, text/event-stream')
      .send(INIT_REQUEST);

    // validateCredentials called with undefined - it will no-op internally
    expect(mockValidateCredentials).toHaveBeenCalledWith(
      'pre-session',
      provider,
      undefined,
    );
  });

  it('calls validateCredentials via buildDefaultProfileContext when upstreamMcp is in transport config (single-profile mode)', async () => {
    // This tests fix for: upstreamMcp was missing from buildDefaultProfileContext, so
    // validateCredentials was silently skipped in single-profile (runHttp) mode even when
    // upstream_mcp[].validation_endpoint was configured.
    const provider = {
      name: 'config-provider',
      transport: { type: 'http-streamable', url: 'https://upstream.example.com/mcp' },
      validation_endpoint: 'https://api.example.com/validate',
    };
    const configWithUpstream = {
      host: '127.0.0.1',
      port: 0,
      sessionTimeoutMs: 1800000,
      heartbeatEnabled: false,
      heartbeatIntervalMs: 30000,
      metricsEnabled: false,
      metricsPath: '/metrics',
      upstreamMcp: [provider],
    };
    const transportWithUpstream = new HttpTransport(configWithUpstream, logger);
    transportWithUpstream.setMessageHandler(async () => ({ result: { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'test', version: '1.0' } } }));

    const mockValidateCredentials = vi.fn().mockResolvedValue(undefined);
    transportWithUpstream.setUpstreamConnectionManager({ validateCredentials: mockValidateCredentials, setHasActiveStreamFn: vi.fn(), setDownstreamNotifyFn: vi.fn() } as any);

    try {
      await request((transportWithUpstream as any).app)
        .post('/mcp')
        .set('Content-Type', 'application/json')
        .set('Accept', 'application/json, text/event-stream')
        .set('Authorization', 'Bearer config-test-token')
        .send(INIT_REQUEST);

      expect(mockValidateCredentials).toHaveBeenCalledWith('pre-session', provider, 'config-test-token');
    } finally {
      await transportWithUpstream.stop();
    }
  });

  it('setUpstreamConnectionManager registers onSessionDestroyed listener only once even when called multiple times', async () => {
    const manager1 = { closeAll: vi.fn().mockResolvedValue(undefined), setHasActiveStreamFn: vi.fn(), setDownstreamNotifyFn: vi.fn() };
    const manager2 = { closeAll: vi.fn().mockResolvedValue(undefined), setHasActiveStreamFn: vi.fn(), setDownstreamNotifyFn: vi.fn() };

    transport.setUpstreamConnectionManager(manager1 as any);
    transport.setUpstreamConnectionManager(manager2 as any);

    const listenerCount = (transport as any).sessionDestroyedListeners.length;
    // Only one upstream closeAll listener should be registered regardless of how many times setter was called
    const upstreamListeners = (transport as any).sessionDestroyedListeners.filter(
      (fn: Function) => fn.toString().includes('closeAll') || fn.toString().includes('upstreamConnectionManager'),
    );
    // Trigger destruction to confirm closeAll fires exactly once (against current manager)
    (transport as any).notifySessionDestroyed('default', 'session-x');
    expect(manager2.closeAll).toHaveBeenCalledTimes(1);
    expect(manager1.closeAll).toHaveBeenCalledTimes(0); // replaced by manager2
    void listenerCount; void upstreamListeners;
  });

  it('skips validation when no upstreamConnectionManager registered', async () => {
    // No setUpstreamConnectionManager call
    const provider = {
      name: 'test-provider',
      transport: { type: 'http-streamable', url: 'https://upstream.example.com/mcp' },
      validation_endpoint: 'https://api.example.com/validate',
    };
    createProfileState(transport as any, 'default', [provider]);

    // Should not throw - validation is skipped when manager is null
    const res = await request(app)
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json, text/event-stream')
      .send(INIT_REQUEST);

    // Should succeed (session created) since no validation manager
    expect(res.status).not.toBe(500);
  });
});
