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
    const mockUpstreamConnectionManager = { validateCredentials: mockValidateCredentials };
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
    const mockUpstreamConnectionManager = { validateCredentials: mockValidateCredentials };
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
    const mockUpstreamConnectionManager = { validateCredentials: mockValidateCredentials };
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
    const mockUpstreamConnectionManager = { validateCredentials: mockValidateCredentials };
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
    const mockUpstreamConnectionManager = { validateCredentials: mockValidateCredentials };
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
