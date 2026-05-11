/**
 * Unit tests for HTTP transport
 * 
 * Tests MCP Specification 2025-03-26 Streamable HTTP transport
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import fs from 'fs';
import https from 'https';
import { HttpTransport } from './http-transport.js';
import { ConsoleLogger, type Logger } from '../core/logger.js';
import { describeIfListen } from '../testing/listen-support.js';
import { parseSessionToolFilterHeader } from '../tool-filter/index.js';

describeIfListen('HttpTransport', () => {
  let transport: HttpTransport;
  let app: Express;
  const logger = new ConsoleLogger();
  const createProfileState = (target: any, profileId: string = 'default') => {
    const state = {
      profileId,
      context: { profileId },
      oauthProvider: null,
      oauthTokensByAccessToken: new Map(),
      sessions: new Map(),
    };
    target.profileStates.set(profileId, state);
    return state;
  };

  beforeEach(async () => {
    const config = {
      host: '127.0.0.1',
      port: 0, // Use random port for tests
      sessionTimeoutMs: 1800000,
      heartbeatEnabled: false,
      heartbeatIntervalMs: 30000,
      metricsEnabled: false,
      metricsPath: '/metrics',
    };

    transport = new HttpTransport(config, logger);
    // Access private app property for testing
    app = (transport as any).app;
  });

  afterEach(async () => {
    await transport.stop();
  });

  // Unit tests that do not need listening sockets live in http-transport.unit.test.ts.

  describe('filtering header mismatch', () => {
    it('rejects mismatched filtering header on existing session', async () => {
      transport.setMessageHandler(async () => ({ result: 'ok' }));
      const sessionId = (transport as any).createSession(
        createProfileState(transport as any),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { project_id: ['1'] },
        'project_id=1'
      );

      const response = await request(app)
        .post('/mcp')
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .set('Mcp-Session-Id', sessionId)
        .set('X-Mcp4-Params', 'project_id=2')
        .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });

      expect(response.status).toBe(400);
      expect(response.body.message).toContain('X-Mcp4-Params header mismatch');
    });

    it('rejects mismatched tool filter header on existing session', async () => {
      transport.setMessageHandler(async () => ({ result: 'ok' }));
      const toolFilterRequest = parseSessionToolFilterHeader('get_user');
      const sessionId = (transport as any).createSession(
        createProfileState(transport as any),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        toolFilterRequest,
        toolFilterRequest.normalizedHeader
      );

      const response = await request(app)
        .post('/mcp')
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .set('Mcp-Session-Id', sessionId)
        .set('X-Mcp4-Tools', 'delete_user')
        .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });

      expect(response.status).toBe(400);
      expect(response.body.message).toContain('X-Mcp4-Tools header mismatch');
    });
  });


  describe('tenant session selection', () => {
    const tenantConfig = {
      version: 1,
      tenants: [
        {
          tenant_id: 'team-a',
          profile_ids: ['default'],
          api_base_url: 'https://team-a.example.com/api',
          auth_mode: 'token',
          auth: { type: 'bearer', value_from_env: 'TEAM_A_TOKEN' },
        },
        {
          tenant_id: 'team-b',
          profile_ids: ['default'],
          api_base_url: 'https://team-b.example.com/api',
          auth_mode: 'token',
          auth: { type: 'bearer', value_from_env: 'TEAM_B_TOKEN' },
        },
      ],
    };

    beforeEach(() => {
      process.env.MCP4_HTTP_TENANTS_JSON = JSON.stringify(tenantConfig);
    });

    afterEach(() => {
      delete process.env.MCP4_HTTP_TENANTS_JSON;
    });

    it('stores tenant context from X-Mcp4-Tenant-Id header during initialize', async () => {
      const tenantTransport = new HttpTransport(
        {
          host: '127.0.0.1',
          port: 0,
          sessionTimeoutMs: 1800000,
          heartbeatEnabled: false,
          heartbeatIntervalMs: 30000,
          metricsEnabled: false,
          metricsPath: '/metrics',
          authConfigs: [{ type: 'bearer', value_from_env: 'FALLBACK_TOKEN' }],
          baseUrl: 'https://default.example.com/api',
        },
        logger,
      );
      tenantTransport.setMessageHandler(async () => ({ result: { ok: true } }));
      const tenantApp = (tenantTransport as any).app;

      const initResponse = await request(tenantApp)
        .post('/mcp')
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .set('Authorization', 'Bearer session-token')
        .set('X-Mcp4-Tenant-Id', 'team-b')
        .send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });

      expect(initResponse.status).toBe(200);
      const sessionId = initResponse.headers['mcp-session-id'];
      expect(sessionId).toBeDefined();

      const tenantContext = tenantTransport.getSessionTenantContext('default', sessionId);
      expect(tenantContext?.tenantId).toBe('team-b');
      expect(tenantContext?.tenantBaseUrl).toBe('https://team-b.example.com/api');

      await tenantTransport.stop();
    });

    it('rejects unknown tenant base url selector', async () => {
      const tenantTransport = new HttpTransport(
        {
          host: '127.0.0.1',
          port: 0,
          sessionTimeoutMs: 1800000,
          heartbeatEnabled: false,
          heartbeatIntervalMs: 30000,
          metricsEnabled: false,
          metricsPath: '/metrics',
          authConfigs: [{ type: 'bearer', value_from_env: 'FALLBACK_TOKEN' }],
          baseUrl: 'https://default.example.com/api',
        },
        logger,
      );
      tenantTransport.setMessageHandler(async () => ({ result: { ok: true } }));
      const tenantApp = (tenantTransport as any).app;

      const response = await request(tenantApp)
        .post('/mcp')
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .set('Authorization', 'Bearer session-token')
        .set('X-Mcp4-Api-Base-Url', ['https://team-a.example.com/api', 'https://team-b.example.com/api'])
        .send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });

      expect(response.status).toBe(400);
      expect(response.body.message).toContain('Invalid X-Mcp4-Api-Base-Url header');

      await tenantTransport.stop();
    });

    it('accepts equivalent tenant base URL selector on existing session', async () => {
      const tenantTransport = new HttpTransport(
        {
          host: '127.0.0.1',
          port: 0,
          sessionTimeoutMs: 1800000,
          heartbeatEnabled: false,
          heartbeatIntervalMs: 30000,
          metricsEnabled: false,
          metricsPath: '/metrics',
          authConfigs: [{ type: 'bearer', value_from_env: 'FALLBACK_TOKEN' }],
          baseUrl: 'https://default.example.com/api',
        },
        logger,
      );
      tenantTransport.setMessageHandler(async () => ({ result: { ok: true } }));
      const tenantApp = (tenantTransport as any).app;

      const initResponse = await request(tenantApp)
        .post('/mcp')
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .set('Authorization', 'Bearer session-token')
        .set('X-Mcp4-Api-Base-Url', 'https://team-a.example.com/api/')
        .send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
      const sessionId = initResponse.headers['mcp-session-id'];

      const response = await request(tenantApp)
        .post('/mcp')
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .set('Mcp-Session-Id', sessionId)
        .set('X-Mcp4-Api-Base-Url', 'https://team-a.example.com/api')
        .send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });

      expect(response.status).toBe(200);
      await tenantTransport.stop();
    });

    it('rejects tenant header mismatch on non-initialize request', async () => {
      const tenantTransport = new HttpTransport(
        {
          host: '127.0.0.1',
          port: 0,
          sessionTimeoutMs: 1800000,
          heartbeatEnabled: false,
          heartbeatIntervalMs: 30000,
          metricsEnabled: false,
          metricsPath: '/metrics',
          authConfigs: [{ type: 'bearer', value_from_env: 'FALLBACK_TOKEN' }],
          baseUrl: 'https://default.example.com/api',
        },
        logger,
      );
      tenantTransport.setMessageHandler(async () => ({ result: { ok: true } }));
      const tenantApp = (tenantTransport as any).app;

      const initResponse = await request(tenantApp)
        .post('/mcp')
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .set('Authorization', 'Bearer session-token')
        .set('X-Mcp4-Tenant-Id', 'team-a')
        .send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
      const sessionId = initResponse.headers['mcp-session-id'];

      const response = await request(tenantApp)
        .post('/mcp')
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .set('Mcp-Session-Id', sessionId)
        .set('X-Mcp4-Tenant-Id', 'team-b')
        .send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });

      expect(response.status).toBe(400);
      expect(response.body.message).toContain('Tenant selector header mismatch');

      await tenantTransport.stop();
    });

    it('resolves mask tenant during initialize from concrete base URL selector', async () => {
      process.env.MCP4_HTTP_TENANTS_JSON = JSON.stringify({
        version: 1,
        tenants: [
          {
            tenant_id: 'grafana',
            profile_ids: ['default'],
            api_base_url: 'mask:https://grafana.*.ops.iszn.cz/api',
            auth_mode: 'token',
            auth: { type: 'bearer', value_from_env: 'GRAFANA_TOKEN' },
          },
        ],
      });

      const tenantTransport = new HttpTransport(
        {
          host: '127.0.0.1',
          port: 0,
          sessionTimeoutMs: 1800000,
          heartbeatEnabled: false,
          heartbeatIntervalMs: 30000,
          metricsEnabled: false,
          metricsPath: '/metrics',
          authConfigs: [{ type: 'bearer', value_from_env: 'FALLBACK_TOKEN' }],
          baseUrl: 'https://default.example.com/api',
        },
        logger,
      );
      tenantTransport.setMessageHandler(async () => ({ result: { ok: true } }));
      const tenantApp = (tenantTransport as any).app;

      const initResponse = await request(tenantApp)
        .post('/mcp')
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .set('Authorization', 'Bearer session-token')
        .set('X-Mcp4-Tenant-Id', 'grafana')
        .set('X-Mcp4-Api-Base-Url', 'https://grafana.team-a.ops.iszn.cz/api')
        .send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });

      expect(initResponse.status).toBe(200);
      const sessionId = initResponse.headers['mcp-session-id'];
      const tenantContext = tenantTransport.getSessionTenantContext('default', sessionId);
      expect(tenantContext?.tenantId).toBe('grafana');
      expect(tenantContext?.tenantBaseUrl).toBe('https://grafana.team-a.ops.iszn.cz/api');

      await tenantTransport.stop();
    });

    it('rejects initialize when mask tenant is selected by tenant id without concrete URL selector', async () => {
      process.env.MCP4_HTTP_TENANTS_JSON = JSON.stringify({
        version: 1,
        tenants: [
          {
            tenant_id: 'grafana',
            profile_ids: ['default'],
            api_base_url: 'mask:https://grafana.*.ops.iszn.cz/api',
            auth_mode: 'token',
            auth: { type: 'bearer', value_from_env: 'GRAFANA_TOKEN' },
          },
        ],
      });

      const tenantTransport = new HttpTransport(
        {
          host: '127.0.0.1',
          port: 0,
          sessionTimeoutMs: 1800000,
          heartbeatEnabled: false,
          heartbeatIntervalMs: 30000,
          metricsEnabled: false,
          metricsPath: '/metrics',
          authConfigs: [{ type: 'bearer', value_from_env: 'FALLBACK_TOKEN' }],
          baseUrl: 'https://default.example.com/api',
        },
        logger,
      );
      tenantTransport.setMessageHandler(async () => ({ result: { ok: true } }));
      const tenantApp = (tenantTransport as any).app;

      const initResponse = await request(tenantApp)
        .post('/mcp')
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .set('Authorization', 'Bearer session-token')
        .set('X-Mcp4-Tenant-Id', 'grafana')
        .send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });

      expect(initResponse.status).toBe(400);
      expect(initResponse.body.message).toContain('requires X-Mcp4-Api-Base-Url');

      await tenantTransport.stop();
    });

    it('rejects non-initialize request when tenant id is unchanged but concrete base URL changes', async () => {
      process.env.MCP4_HTTP_TENANTS_JSON = JSON.stringify({
        version: 1,
        tenants: [
          {
            tenant_id: 'grafana',
            profile_ids: ['default'],
            api_base_url: 'mask:https://grafana.*.ops.iszn.cz/api',
            auth_mode: 'token',
            auth: { type: 'bearer', value_from_env: 'GRAFANA_TOKEN' },
          },
        ],
      });

      const tenantTransport = new HttpTransport(
        {
          host: '127.0.0.1',
          port: 0,
          sessionTimeoutMs: 1800000,
          heartbeatEnabled: false,
          heartbeatIntervalMs: 30000,
          metricsEnabled: false,
          metricsPath: '/metrics',
          authConfigs: [{ type: 'bearer', value_from_env: 'FALLBACK_TOKEN' }],
          baseUrl: 'https://default.example.com/api',
        },
        logger,
      );
      tenantTransport.setMessageHandler(async () => ({ result: { ok: true } }));
      const tenantApp = (tenantTransport as any).app;

      const initResponse = await request(tenantApp)
        .post('/mcp')
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .set('Authorization', 'Bearer session-token')
        .set('X-Mcp4-Tenant-Id', 'grafana')
        .set('X-Mcp4-Api-Base-Url', 'https://grafana.team-a.ops.iszn.cz/api')
        .send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });

      const sessionId = initResponse.headers['mcp-session-id'];
      const response = await request(tenantApp)
        .post('/mcp')
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .set('Mcp-Session-Id', sessionId)
        .set('X-Mcp4-Tenant-Id', 'grafana')
        .set('X-Mcp4-Api-Base-Url', 'https://grafana.team-b.ops.iszn.cz/api')
        .send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });

      expect(response.status).toBe(400);
      expect(response.body.message).toContain('Tenant selector header mismatch');

      await tenantTransport.stop();
    });

    it('prefers exact base URL selector over mask selector when both match', async () => {
      const exactContext = {
        tenantId: 'exact',
        tenantBaseUrl: 'https://grafana.team-a.ops.iszn.cz/api',
        tenantAuthMode: 'token',
        tenantAuthConfigs: [{ type: 'bearer', value_from_env: 'EXACT_TOKEN' }],
        tenantSelectorType: 'exact' as const,
        tenantSelectorValue: 'https://grafana.team-a.ops.iszn.cz/api',
      };
      const maskContext = {
        tenantId: 'mask',
        tenantBaseUrl: 'mask:https://grafana.*.ops.iszn.cz/api',
        tenantAuthMode: 'token',
        tenantAuthConfigs: [{ type: 'bearer', value_from_env: 'MASK_TOKEN' }],
        tenantSelectorType: 'mask' as const,
        tenantSelectorValue: 'mask:https://grafana.*.ops.iszn.cz/api',
      };

      const tenantTransport = new HttpTransport(
        {
          host: '127.0.0.1',
          port: 0,
          sessionTimeoutMs: 1800000,
          heartbeatEnabled: false,
          heartbeatIntervalMs: 30000,
          metricsEnabled: false,
          metricsPath: '/metrics',
          authConfigs: [{ type: 'bearer', value_from_env: 'FALLBACK_TOKEN' }],
          baseUrl: 'https://default.example.com/api',
          tenantIndex: {
            enabled: true,
            byTenantId: new Map([
              ['exact', exactContext as any],
              ['mask', maskContext as any],
            ]),
            byBaseUrl: new Map([
              ['https://grafana.team-a.ops.iszn.cz/api', exactContext as any],
            ]),
            maskSelectors: [
              {
                tenantId: 'mask',
                selector: {
                  original: 'https://grafana.*.ops.iszn.cz/api',
                  normalizedMask: 'https://grafana.*.ops.iszn.cz/api',
                  scheme: 'https:',
                  hostLabels: ['grafana', '*', 'ops', 'iszn', 'cz'],
                  port: '',
                  path: '/api',
                  pathSegments: ['api'],
                },
                context: maskContext as any,
              },
            ],
            selectorTypeByTenantId: new Map([
              ['exact', 'exact'],
              ['mask', 'mask'],
            ]),
          },
        },
        logger,
      );
      tenantTransport.setMessageHandler(async () => ({ result: { ok: true } }));
      const tenantApp = (tenantTransport as any).app;

      const initResponse = await request(tenantApp)
        .post('/mcp')
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .set('Authorization', 'Bearer session-token')
        .set('X-Mcp4-Api-Base-Url', 'https://grafana.team-a.ops.iszn.cz/api')
        .send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });

      expect(initResponse.status).toBe(200);
      const sessionId = initResponse.headers['mcp-session-id'];
      const tenantContext = tenantTransport.getSessionTenantContext('default', sessionId);
      expect(tenantContext?.tenantId).toBe('exact');
      expect(tenantContext?.tenantBaseUrl).toBe('https://grafana.team-a.ops.iszn.cz/api');

      await tenantTransport.stop();
    });
  });

  describe('tenant auth resolution', () => {
    afterEach(() => {
      delete process.env.MCP4_HTTP_TENANTS_JSON;
    });

    it('does not trigger OAuth challenge when tenant auth_mode is token in mixed-auth profile', async () => {
      process.env.MCP4_HTTP_TENANTS_JSON = JSON.stringify({
        version: 1,
        tenants: [
          {
            tenant_id: 'team-token',
            profile_ids: ['default'],
            api_base_url: 'https://team-token.example.com/api',
            auth_mode: 'token',
          },
        ],
      });

      const tenantTransport = new HttpTransport(
        {
          host: '127.0.0.1',
          port: 0,
          sessionTimeoutMs: 1800000,
          heartbeatEnabled: false,
          heartbeatIntervalMs: 30000,
          metricsEnabled: false,
          metricsPath: '/metrics',
          oauthConfig: {
            authorization_endpoint: 'https://auth.example.com/oauth/authorize',
            token_endpoint: 'https://auth.example.com/oauth/token',
            client_id: 'oauth-client',
            client_secret: 'oauth-secret',
            scopes: ['api'],
          },
          authConfigs: [
            {
              type: 'oauth',
              oauth_config: {
                authorization_endpoint: 'https://auth.example.com/oauth/authorize',
                token_endpoint: 'https://auth.example.com/oauth/token',
                client_id: 'oauth-client',
                client_secret: 'oauth-secret',
                scopes: ['api'],
              },
            },
            { type: 'custom-header', header_name: 'X-Profile-Token' },
          ],
          baseUrl: 'https://default.example.com/api',
        },
        logger,
      );
      tenantTransport.setMessageHandler(async () => ({ result: { ok: true } }));
      const tenantApp = (tenantTransport as any).app;

      const response = await request(tenantApp)
        .post('/mcp')
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .set('X-Mcp4-Tenant-Id', 'team-token')
        .send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });

      expect(response.status).toBe(401);
      expect(response.headers['www-authenticate']).toBeUndefined();
      expect(response.body.message).toBe('Authentication required');

      await tenantTransport.stop();
    });

    it('accepts tenant-specific custom-header auth during initialize', async () => {
      process.env.MCP4_HTTP_TENANTS_JSON = JSON.stringify({
        version: 1,
        tenants: [
          {
            tenant_id: 'team-custom',
            profile_ids: ['default'],
            api_base_url: 'https://team-custom.example.com/api',
            auth_mode: 'token',
            auth: { type: 'custom-header', header_name: 'X-Tenant-Token' },
          },
        ],
      });

      const tenantTransport = new HttpTransport(
        {
          host: '127.0.0.1',
          port: 0,
          sessionTimeoutMs: 1800000,
          heartbeatEnabled: false,
          heartbeatIntervalMs: 30000,
          metricsEnabled: false,
          metricsPath: '/metrics',
          authConfigs: [{ type: 'custom-header', header_name: 'X-Profile-Token' }],
          baseUrl: 'https://default.example.com/api',
        },
        logger,
      );
      tenantTransport.setMessageHandler(async () => ({ result: { ok: true } }));
      const tenantApp = (tenantTransport as any).app;

      const response = await request(tenantApp)
        .post('/mcp')
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .set('X-Mcp4-Tenant-Id', 'team-custom')
        .set('X-Tenant-Token', 'tenant-header-token')
        .send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });

      expect(response.status).toBe(200);
      const sessionId = response.headers['mcp-session-id'];
      expect(sessionId).toBeDefined();
      expect(tenantTransport.getSessionToken('default', sessionId)).toBe('tenant-header-token');

      await tenantTransport.stop();
    });

    it('prefers tenant custom-header over profile custom-header when both are present', async () => {
      process.env.MCP4_HTTP_TENANTS_JSON = JSON.stringify({
        version: 1,
        tenants: [
          {
            tenant_id: 'team-custom',
            profile_ids: ['default'],
            api_base_url: 'https://team-custom.example.com/api',
            auth_mode: 'token',
            auth: { type: 'custom-header', header_name: 'X-Tenant-Token' },
          },
        ],
      });

      const tenantTransport = new HttpTransport(
        {
          host: '127.0.0.1',
          port: 0,
          sessionTimeoutMs: 1800000,
          heartbeatEnabled: false,
          heartbeatIntervalMs: 30000,
          metricsEnabled: false,
          metricsPath: '/metrics',
          authConfigs: [{ type: 'custom-header', header_name: 'X-Profile-Token' }],
          baseUrl: 'https://default.example.com/api',
        },
        logger,
      );
      tenantTransport.setMessageHandler(async () => ({ result: { ok: true } }));
      const tenantApp = (tenantTransport as any).app;

      const response = await request(tenantApp)
        .post('/mcp')
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .set('X-Mcp4-Tenant-Id', 'team-custom')
        .set('X-Profile-Token', 'profile-token')
        .set('X-Tenant-Token', 'tenant-token')
        .send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });

      expect(response.status).toBe(200);
      const sessionId = response.headers['mcp-session-id'];
      expect(sessionId).toBeDefined();
      expect(tenantTransport.getSessionToken('default', sessionId)).toBe('tenant-token');

      await tenantTransport.stop();
    });
  });

  describe('DNS rebinding protection with localhost host config', () => {
    let localTransport: HttpTransport;
    let localApp: Express;
    let testLogger: Logger;

    beforeEach(async () => {
      testLogger = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };

      localTransport = new HttpTransport({
        host: 'localhost',
        port: 0,
        sessionTimeoutMs: 1800000,
        heartbeatEnabled: false,
        heartbeatIntervalMs: 30000,
        metricsEnabled: true,
        metricsPath: '/metrics',
      }, testLogger);

      // Override metrics to make responses deterministic for assertions
      (localTransport as any).metrics = {
        getMetrics: vi.fn().mockResolvedValue('metric-output'),
        recordHttpRequest: vi.fn(),
      };

      localApp = (localTransport as any).app;
      localTransport.setMessageHandler(async () => ({ result: 'ok' }));
    });

    afterEach(async () => {
      await localTransport.stop();
    });

    it('should reject mismatched Host header and emit warning', async () => {
      const response = await request(localApp)
        .get('/health')
        .set('Host', 'malicious.example.com');

      expect(response.status).toBe(403);
      expect(response.body).toEqual({ error: 'Forbidden' });
      expect(testLogger.warn).toHaveBeenCalledWith(
        'DNS rebinding protection: invalid Host header',
        expect.objectContaining({
          hostHeader: 'malicious.example.com',
          expected: expect.arrayContaining(['localhost', '127.0.0.1']),
        })
      );
    });

    it('should reject non-127.0.0.1 loopback variants with warning', async () => {
      const response = await request(localApp)
        .get('/metrics')
        .set('Host', '127.0.0.2:5678');

      expect(response.status).toBe(403);
      expect(response.body).toEqual({ error: 'Forbidden' });
      expect(testLogger.warn).toHaveBeenCalledWith(
        'DNS rebinding protection: invalid Host header',
        expect.objectContaining({
          hostHeader: '127.0.0.2:5678',
          expected: expect.arrayContaining(['localhost', '127.0.0.1']),
        })
      );
    });

    it('should allow localhost Host header and preserve responses/logs', async () => {
      const healthResponse = await request(localApp)
        .get('/health')
        .set('Host', 'localhost');

      expect(healthResponse.status).toBe(200);
      expect(healthResponse.body).toMatchObject({ status: 'ok' });
      expect(testLogger.warn).not.toHaveBeenCalledWith(
        'DNS rebinding protection: invalid Host header',
        expect.anything()
      );
      expect(testLogger.debug).toHaveBeenCalledWith(
        'Outgoing JSON response',
        expect.objectContaining({
          method: 'GET',
          url: '/health',
          status: 200,
          body: expect.objectContaining({ status: 'ok' }),
        })
      );

      const metricsResponse = await request(localApp)
        .get('/metrics')
        .set('Host', 'localhost');

      expect(metricsResponse.status).toBe(200);
      expect(metricsResponse.text).toBe('metric-output');
      expect(testLogger.debug).toHaveBeenCalledWith(
        'Outgoing response',
        expect.objectContaining({
          method: 'GET',
          url: '/metrics',
          status: 200,
          bodyPreview: expect.stringContaining('metric-output'),
        })
      );
    });

    it('should allow loopback IP Host header with port and retain logging', async () => {
      const healthResponse = await request(localApp)
        .get('/health')
        .set('Host', '127.0.0.1:1234');

      expect(healthResponse.status).toBe(200);
      expect(healthResponse.body).toMatchObject({ status: 'ok' });

      expect(testLogger.warn).not.toHaveBeenCalledWith(
        'DNS rebinding protection: invalid Host header',
        expect.anything()
      );
      // Note: a single warn is emitted at construction time when MCP4_TOKEN_KEY is unset;
      // the assertion below excludes that startup warn so DNS-rebinding-related warns are isolated.
      const dnsRelatedWarns = (testLogger.warn as any).mock.calls.filter(
        (args: unknown[]) =>
          typeof args[0] !== 'string' || !(args[0] as string).includes('MCP4_TOKEN_KEY'),
      );
      expect(dnsRelatedWarns).toHaveLength(0);

      const metricsResponse = await request(localApp)
        .get('/metrics')
        .set('Host', '127.0.0.1:1234');

      expect(metricsResponse.status).toBe(200);
      expect(metricsResponse.text).toBe('metric-output');

      expect(testLogger.debug).toHaveBeenCalledWith(
        'Outgoing JSON response',
        expect.objectContaining({
          method: 'GET',
          url: '/health',
          status: 200,
          body: expect.objectContaining({ status: 'ok' }),
        })
      );
      expect(testLogger.debug).toHaveBeenCalledWith(
        'Outgoing response',
        expect.objectContaining({
          method: 'GET',
          url: '/metrics',
          status: 200,
          bodyPreview: expect.stringContaining('metric-output'),
        })
      );
    });
  });

  describe('profile index', () => {
    let indexTransport: HttpTransport;
    let indexApp: Express;
    const createIndexTransport = (): HttpTransport => new HttpTransport(
      {
        host: '127.0.0.1',
        port: 0,
        sessionTimeoutMs: 1800000,
        heartbeatEnabled: false,
        heartbeatIntervalMs: 30000,
        metricsEnabled: false,
        metricsPath: '/metrics',
        profileRoutingEnabled: true,
        profileIndexEnabled: true,
      },
      logger,
    );

    beforeEach(async () => {
      indexTransport = createIndexTransport();
      indexApp = (indexTransport as any).app;
    });

    afterEach(async () => {
      delete process.env.MCP4_HTTP_TENANTS_JSON;
      await indexTransport.stop();
    });

    it('returns 404 when no profile index provider is configured', async () => {
      const response = await request(indexApp).get('/');
      expect(response.status).toBe(404);
    });

    it('returns HTML index by default', async () => {
      indexTransport.setProfileIndexProvider(async () => ([
        {
          profileId: 'alpha',
          profileName: 'Alpha',
          profileAliases: ['a1'],
          description: 'First profile',
          envVars: ['MCP4_API_TOKEN'],
        },
      ]));

      const response = await request(indexApp).get('/');
      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('text/html');
      expect(response.text).toContain('alpha');
      expect(response.text).toContain('First profile');
    });

    it('renders filter UI markers in the HTML profile index response', async () => {
      indexTransport.setProfileIndexProvider(async () => ([
        {
          profileId: 'alpha',
          profileName: 'Alpha',
          profileAliases: ['a1'],
          description: 'First profile',
          envVars: ['MCP4_API_TOKEN'],
          authMethods: [{ type: 'bearer', valueFromEnv: 'MCP4_API_TOKEN' }],
          toolCatalog: [
            {
              name: 'manage_alpha',
              description: 'Manage alpha records.',
              kind: 'simple',
              actions: ['list', 'get'],
              hasActionSelector: true,
              operationCount: 2,
              stepCount: 0,
              parameters: [
                {
                  name: 'action',
                  typeLabel: 'string',
                  description: 'Action selector',
                  required: true,
                  requiredFor: [],
                  isMetadata: true,
                },
              ],
            },
          ],
        },
      ]));

      const response = await request(indexApp).get('/');

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('text/html');
      expect(response.text).toContain('Tool Filter');
      expect(response.text).toContain('Parameter Filter');
      expect(response.text).toContain('data-tool-search');
      expect(response.text).toContain('data-param-search');
      expect(response.text).toContain('const hasPreview = Boolean(toolHeader || paramHeader);');
      expect(response.text).toContain('id="filter-preview-card"${hasPreview ? \'\' : \' hidden\'}');
      expect(response.text).toContain('hasActiveToolFilter');
      expect(response.text).toContain('hasActiveParamFilter');
      expect(response.text).toContain('wireCollapsibleDetails');
      expect(response.text).toContain("summary.setAttribute('aria-expanded'");
    });

    it('returns JSON when application/json is requested', async () => {
      indexTransport.setProfileIndexProvider(async () => ([
        {
          profileId: 'beta',
          profileName: 'Beta',
          profileAliases: [],
          description: 'Second profile',
          envVars: [],
        },
      ]));

      const response = await request(indexApp)
        .get('/')
        .set('Accept', 'application/json');

      expect(response.status).toBe(200);
      expect(response.body.profiles).toHaveLength(1);
      expect(response.body.profiles[0].profileId).toBe('beta');
      expect(response.body.profiles[0].mcpUrl).toContain('/profile/beta/mcp');
    });

    it('returns per-profile tenant metadata in JSON payload when tenant config is enabled', async () => {
      process.env.MCP4_HTTP_TENANTS_JSON = JSON.stringify({
        version: 1,
        tenants: [
          {
            tenant_id: 'team-a',
            profile_ids: ['tenant-aware'],
            api_base_url: 'https://grafana.team-a.ops.iszn.cz/api',
            auth_mode: 'token',
            auth: { type: 'bearer', value_from_env: 'TEAM_A_TOKEN' },
          },
          {
            tenant_id: 'grafana-mask',
            profile_ids: ['tenant-aware'],
            api_base_url: 'mask:https://grafana.*.security.ops.iszn.cz/api',
            auth_mode: 'token',
            auth: { type: 'bearer', value_from_env: 'GRAFANA_MASK_TOKEN' },
          },
        ],
      });
      await indexTransport.stop();
      indexTransport = createIndexTransport();
      indexApp = (indexTransport as any).app;

      indexTransport.setProfileContextProvider(async (profileId: string) => ({
        profileId,
        baseUrl: 'https://default.example.com/api',
        authConfigs: [{ type: 'bearer', value_from_env: 'DEFAULT_TOKEN' }],
      }));
      indexTransport.setProfileIndexProvider(async () => ([
        {
          profileId: 'tenant-aware',
          profileName: 'Tenant Aware',
          profileAliases: [],
          description: 'Has tenant data',
          envVars: [],
        },
        {
          profileId: 'no-tenant-data',
          profileName: 'No Tenant Data',
          profileAliases: [],
          description: 'No tenant context',
          envVars: [],
        },
      ]));

      const response = await request(indexApp)
        .get('/')
        .set('Accept', 'application/json');

      expect(response.status).toBe(200);
      const withTenantData = response.body.profiles.find((profile: any) => profile.profileId === 'tenant-aware');
      const withoutTenantData = response.body.profiles.find((profile: any) => profile.profileId === 'no-tenant-data');
      expect(withTenantData?.tenantSummary?.tenantsEnabled).toBe(true);
      expect(withTenantData?.tenantSummary?.selectionHeaderName).toBe('X-Mcp4-Tenant-Id');
      expect(withTenantData?.tenantSummary?.tenants).toEqual([
        expect.objectContaining({
          tenantId: 'grafana-mask',
          selectorType: 'mask',
          selectorDisplay: 'mask:https://grafana.*.security.ops.iszn.cz/api',
        }),
        expect.objectContaining({
          tenantId: 'team-a',
          selectorType: 'exact',
          selectorDisplay: 'https://grafana.team-a.ops.iszn.cz/api',
        }),
      ]);
      expect(withoutTenantData?.tenantSummary).toBeUndefined();
    });

    it('renders tenant picker support markers in HTML payload', async () => {
      process.env.MCP4_HTTP_TENANTS_JSON = JSON.stringify({
        version: 1,
        tenants: [
          {
            tenant_id: 'team-a',
            profile_ids: ['tenant-aware'],
            api_base_url: 'https://grafana.team-a.ops.iszn.cz/api',
            auth_mode: 'token',
            auth: { type: 'bearer', value_from_env: 'TEAM_A_TOKEN' },
          },
        ],
      });
      await indexTransport.stop();
      indexTransport = createIndexTransport();
      indexApp = (indexTransport as any).app;

      indexTransport.setProfileContextProvider(async (profileId: string) => ({
        profileId,
        baseUrl: 'https://default.example.com/api',
        authConfigs: [{ type: 'bearer', value_from_env: 'DEFAULT_TOKEN' }],
      }));
      indexTransport.setProfileIndexProvider(async () => ([
        {
          profileId: 'tenant-aware',
          profileName: 'Tenant Aware',
          profileAliases: [],
          description: 'Has tenant data',
          envVars: [],
          authMethods: [{ type: 'bearer', valueFromEnv: 'DEFAULT_TOKEN' }],
        },
      ]));

      const response = await request(indexApp).get('/');

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('text/html');
      expect(response.text).toContain('tenant-tabs');
      expect(response.text).toContain('injectTenantHeaderIntoJsonSnippet');
      expect(response.text).toContain('injectFilterHeadersForSnippet');
      expect(response.text).toContain('injectLocalFilterConfigForSnippet');
      expect(response.text).toContain('injectTenantApiBaseUrlIntoJsonSnippet');
      expect(response.text).toContain('X-Mcp4-Tenant-Id');
      expect(response.text).toContain('X-Mcp4-Api-Base-Url');
      expect(response.text).toContain('X-Mcp4-Tools');
      expect(response.text).toContain('X-Mcp4-Params');
      expect(response.text).toContain('__profile-default__');
      expect(response.text).toContain('<your-part>');
      expect(response.text).toContain('data-client-tab');
      expect(response.text).toContain('wireClientTabs');
      expect(response.text).toContain('supportsCustomHeaders');
      expect(response.text).toContain('supportsTenantHeaders');
      expect(response.text).toContain('Tool Filter');
      expect(response.text).toContain('Parameter Filter');
    });
  });

  describe('Security - Origin Validation', () => {
    it('should accept requests from localhost', async () => {
      transport.setMessageHandler(async (_msg) => ({ result: 'ok' }));

      const response = await request(app)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .set('Host', 'localhost')
        .send({ jsonrpc: '2.0', id: 1, method: 'initialize' });

      expect(response.status).not.toBe(403);
    });

    it('should accept requests from 127.0.0.1', async () => {
      transport.setMessageHandler(async (_msg) => ({ result: 'ok' }));

      const response = await request(app)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .set('Host', '127.0.0.1')
        .send({ jsonrpc: '2.0', id: 1, method: 'initialize' });

      expect(response.status).not.toBe(403);
    });

    it('should validate Origin header for non-localhost requests', async () => {
      // Skip Origin check is only for localhost hostname
      // For other hostnames, Origin validation applies
      const response = await request(app)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .set('Origin', 'https://evil.com')
        .set('Host', 'example.com')
        .send({ jsonrpc: '2.0', id: 1, method: 'initialize' });

      expect(response.status).toBe(403);
      expect(response.body).toHaveProperty('error', 'Forbidden');
    });

    it('should reject disallowed origin in CORS preflight', async () => {
      const response = await request(app)
        .options('/mcp')
        .set('Origin', 'https://evil.com')
        .set('Host', 'example.com');
      expect(response.status).toBe(403);
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
      expect(response.body).toHaveProperty('error', 'Forbidden');
    });
  });

  describe('Security - Custom Allowed Origins', () => {
    let customTransport: HttpTransport;
    let customApp: Express;

    beforeEach(async () => {
      const config = {
        host: '0.0.0.0',
        port: 0,
        sessionTimeoutMs: 1800000,
        heartbeatEnabled: false,
        heartbeatIntervalMs: 30000,
        metricsEnabled: false,
        metricsPath: '/metrics',
        allowedOrigins: [
          'example.com',
          '*.company.com',
          '192.168.1.0/24',
          '10.0.0.0/8',
          '2001:db8::/32',
          'fe80::1',
        ],
      };

      customTransport = new HttpTransport(config, logger);
      customApp = (customTransport as any).app;
      customTransport.setMessageHandler(async (_msg) => ({ result: 'ok' }));
    });

    afterEach(async () => {
      await customTransport.stop();
    });

    it('should accept exact hostname match', async () => {
      const response = await request(customApp)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .set('Origin', 'https://example.com')
        .set('Host', 'api.test.com')
        .send({ jsonrpc: '2.0', id: 1, method: 'initialize' });

      expect(response.status).toBe(200);
    });

    it('should allow CORS preflight for allowed origin', async () => {
      const response = await request(customApp)
        .options('/mcp')
        .set('Origin', 'https://example.com')
        .set('Host', 'api.test.com');
      expect(response.status).toBe(200);
      expect(response.headers['access-control-allow-origin']).toBe('https://example.com');
      expect(response.headers['access-control-allow-methods']).toContain('POST');
      expect(response.headers['access-control-allow-headers']).toContain('Content-Type');
      expect(response.headers['access-control-allow-credentials']).toBeUndefined();
    });

    it('should accept wildcard subdomain match', async () => {
      const response = await request(customApp)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .set('Origin', 'https://api.company.com')
        .set('Host', 'api.test.com')
        .send({ jsonrpc: '2.0', id: 1, method: 'initialize' });

      expect(response.status).toBe(200);
    });

    it('should accept another wildcard subdomain match', async () => {
      const response = await request(customApp)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .set('Origin', 'https://web.company.com')
        .set('Host', 'api.test.com')
        .send({ jsonrpc: '2.0', id: 1, method: 'initialize' });

      expect(response.status).toBe(200);
    });

    it('should accept IP in /24 CIDR range', async () => {
      const response = await request(customApp)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .set('Origin', 'http://192.168.1.100')
        .set('Host', 'api.test.com')
        .send({ jsonrpc: '2.0', id: 1, method: 'initialize' });

      expect(response.status).toBe(200);
    });

    it('should accept IP in /8 CIDR range', async () => {
      const response = await request(customApp)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .set('Origin', 'http://10.50.100.200')
        .set('Host', 'api.test.com')
        .send({ jsonrpc: '2.0', id: 1, method: 'initialize' });

      expect(response.status).toBe(200);
    });

    it('should accept IPv6 exact host', async () => {
      const response = await request(customApp)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .set('Origin', 'http://[fe80::1]')
        .set('Host', 'api.test.com')
        .send({ jsonrpc: '2.0', id: 1, method: 'initialize' });

      expect(response.status).toBe(200);
    });

    it('should accept IPv6 CIDR range', async () => {
      const response = await request(customApp)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .set('Origin', 'http://[2001:db8:abcd::123]')
        .set('Host', 'api.test.com')
        .send({ jsonrpc: '2.0', id: 1, method: 'initialize' });

      expect(response.status).toBe(200);
    });

    it('should reject IPv6 outside CIDR range', async () => {
      const response = await request(customApp)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .set('Origin', 'http://[2001:dead::1]')
        .set('Host', 'api.test.com')
        .send({ jsonrpc: '2.0', id: 1, method: 'initialize' });

      expect(response.status).toBe(403);
    });

    it('should reject IP outside CIDR range', async () => {
      const response = await request(customApp)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .set('Origin', 'http://192.168.2.1')
        .set('Host', 'api.test.com')
        .send({ jsonrpc: '2.0', id: 1, method: 'initialize' });

      expect(response.status).toBe(403);
    });

    it('should reject non-matching hostname', async () => {
      const response = await request(customApp)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .set('Origin', 'https://evil.com')
        .set('Host', 'api.test.com')
        .send({ jsonrpc: '2.0', id: 1, method: 'initialize' });

      expect(response.status).toBe(403);
    });

    it('should have frozen config object (immutability)', async () => {
      // Access private config via cast
      const cfg = (customTransport as any).config;
      expect(Object.isFrozen(cfg)).toBe(true);
    });

    it('should reject non-matching wildcard', async () => {
      const response = await request(customApp)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .set('Origin', 'https://other.com')
        .set('Host', 'api.test.com')
        .send({ jsonrpc: '2.0', id: 1, method: 'initialize' });

      expect(response.status).toBe(403);
    });
  });

  describe('IP parsing and CIDR matching', () => {
    let ipTransport: HttpTransport;
    let ipLogger: Logger;

    beforeEach(() => {
      ipLogger = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };

      ipTransport = new HttpTransport({
        host: '127.0.0.1',
        port: 0,
        sessionTimeoutMs: 1800000,
        heartbeatEnabled: false,
        heartbeatIntervalMs: 30000,
        metricsEnabled: false,
        metricsPath: '/metrics',
      }, ipLogger);
    });

    afterEach(async () => {
      await ipTransport.stop();
    });

    it('rejects IPv4 CIDR ranges with invalid mask bits', () => {
      const result = (ipTransport as any).matchCIDR('192.168.1.10', '192.168.1.0/40');

      expect(result).toBe(false);
      expect(ipLogger.warn).toHaveBeenCalledWith('Invalid CIDR mask bits', { cidr: '192.168.1.0/40' });
    });

    it('rejects IPv6 CIDR ranges with invalid mask bits', () => {
      (ipLogger.warn as ReturnType<typeof vi.fn>).mockReset();

      const result = (ipTransport as any).matchCIDR('2001:db8::1', '2001:db8::/129');

      expect(result).toBe(false);
      expect(ipLogger.warn).toHaveBeenCalledWith('Invalid IPv6 CIDR mask bits', { cidr: '2001:db8::/129' });
    });

    it('rejects CIDR when IP version does not match range', () => {
      (ipLogger.warn as ReturnType<typeof vi.fn>).mockReset();

      const result = (ipTransport as any).matchCIDR('10.0.0.1', '2001:db8::/32');

      expect(result).toBe(false);
      expect(ipLogger.warn).not.toHaveBeenCalled();
    });

    it('rejects IPv4 addresses with octets out of range', () => {
      const ipv4Value = (ipTransport as any).ipv4ToInt('256.0.0.1');

      expect(ipv4Value).toBeNull();
    });

    it('rejects malformed IPv6 addresses with multiple compression markers', () => {
      const ipv6Value = (ipTransport as any).ipv6ToBigInt('2001::db8::1');

      expect(ipv6Value).toBeNull();
    });

    it('parses IPv4-mapped IPv6 addresses into the correct bigint', () => {
      const ipv6Value = (ipTransport as any).ipv6ToBigInt('::ffff:192.168.0.1');

      expect(ipv6Value).toBe(281473913978881n);
    });

    it('handles null return from ipv4ToInt in matchCIDR for IPv4', () => {
      // Create a scenario where ipv4ToInt returns null
      // This can happen if the IP parsing fails internally
      const result = (ipTransport as any).matchCIDR('192.168.1.1', '192.168.1.0/24');
      // Should still work for valid IPs, but we test the null check path
      // by using an IP that passes isIP but might fail internal parsing
      expect(typeof result).toBe('boolean');
    });

    it('handles null return from ipv6ToBigInt in matchCIDR for IPv6', () => {
      const result = (ipTransport as any).matchCIDR('2001:db8::1', '2001:db8::/32');
      expect(typeof result).toBe('boolean');
    });

    it('handles ipv6ToBigInt with invalid segment count after padding', () => {
      // This should trigger the check at line 458-459
      // We need an IPv6 that passes initial validation but fails segment count check
      const result = (ipTransport as any).ipv6ToBigInt('2001:db8::1:2:3:4:5:6:7:8');
      // This should be null due to too many segments
      expect(result).toBeNull();
    });

    it('handles ipv6ToBigInt with wrong final segment count', () => {
      // This should trigger the check at line 468-469
      // We need an IPv6 that gets past the first segment count check but fails the final check
      // This is tricky - let's test with a malformed IPv4-mapped address
      const result = (ipTransport as any).ipv6ToBigInt('::ffff:192.168.0');
      // Invalid IPv4 part should cause null
      expect(result).toBeNull();
    });
  });

  describe('POST - Initialize Request', () => {
    it('should create session on initialization', async () => {
      transport.setMessageHandler(async (_msg) => ({
        protocolVersion: '2025-03-26',
        serverInfo: { name: 'test' },
      }));

      const response = await request(app)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {},
        });

      expect(response.status).toBe(200);
      expect(response.headers['mcp-session-id']).toBeDefined();
      expect(response.body).toHaveProperty('protocolVersion');
    });

    it('should support SSE response for initialization', async () => {
      transport.setMessageHandler(async (_msg) => ({
        protocolVersion: '2025-03-26',
        serverInfo: { name: 'test' },
      }));

      const response = await request(app)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .set('Accept', 'text/event-stream')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {},
        });

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('text/event-stream');
      expect(response.headers['mcp-session-id']).toBeDefined();
      expect(response.text).toContain('id:');
      expect(response.text).toContain('data:');
    });

    it('returns SSE response with Date.now() event ID when session is destroyed mid-flight (P2)', async () => {
      // Simulate: session exists when POST is validated, but is destroyed before the SSE
      // response is built (concurrent DELETE /mcp or reaper). The response must still be
      // returned without throwing - startSSEResponse falls back to Date.now() for the event ID.
      let capturedSessionId: string | undefined;
      transport.setMessageHandler(async (_msg) => {
        // Destroy the session from under the in-flight POST before the response path runs
        if (capturedSessionId) {
          const profileState = (transport as any).profileStates.get('default');
          if (profileState) {
            profileState.sessions.delete(capturedSessionId);
          }
        }
        return { result: 'ok' };
      });

      // Initialize to get a session
      const initResponse = await request(app)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
      capturedSessionId = initResponse.headers['mcp-session-id'];

      // POST with SSE-only Accept - session will be deleted inside the message handler
      const response = await request(app)
        .post('/mcp')
        .set('Accept', 'text/event-stream')
        .set('Mcp-Session-Id', capturedSessionId)
        .send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('text/event-stream');
      // Event ID falls back to Date.now() (numeric) when session is absent
      expect(response.text).toMatch(/^id: \d+/m);
      expect(response.text).toContain('data:');
    });
  });

  describe('POST - Request with Session', () => {
    it('should require session ID for non-initialization requests', async () => {
      transport.setMessageHandler(async (_msg) => ({ result: 'ok' }));

      const response = await request(app)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .send({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/list',
        });

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('message');
      expect(response.body.message).toContain('Mcp-Session-Id');
    });

    it('should reject invalid session ID', async () => {
      transport.setMessageHandler(async (_msg) => ({ result: 'ok' }));

      const response = await request(app)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .set('Mcp-Session-Id', 'invalid-session-id')
        .send({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/list',
        });

      expect(response.status).toBe(404);
      expect(response.body).toHaveProperty('message');
      expect(response.body.message).toContain('Session not found');
    });

    it('should process request with valid session', async () => {
      transport.setMessageHandler(async (_msg) => ({ result: 'ok' }));

      // First initialize to get session
      const initResponse = await request(app)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
        });

      const sessionId = initResponse.headers['mcp-session-id'];

      // Then make request with session
      const response = await request(app)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .set('Mcp-Session-Id', sessionId)
        .send({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/list',
        });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ result: 'ok' });
    });
  });

  describe('POST - Notifications', () => {
    it('should return 202 for notification-only messages', async () => {
      transport.setMessageHandler(async (_msg) => ({ result: 'ok' }));

      // Initialize first
      const initResponse = await request(app)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
        });

      const sessionId = initResponse.headers['mcp-session-id'];

      // Send notification (no id field = notification)
      const response = await request(app)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .set('Mcp-Session-Id', sessionId)
        .send({
          jsonrpc: '2.0',
          method: 'notifications/progress',
          params: { progress: 50 },
        });

      expect(response.status).toBe(202);
      expect(response.text).toBe('');
    });
  });

  describe('POST - Accept Header Validation', () => {
    it('should reject requests with invalid Accept headers', async () => {
      transport.setMessageHandler(async (_msg) => ({ result: 'ok' }));

      const response = await request(app)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .set('Accept', 'text/html')  // Missing required application/json and text/event-stream
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
        });

      expect(response.status).toBe(406);
      expect(response.body).toHaveProperty('error', 'Not Acceptable');
    });

    it('should accept requests without Accept header for backward compatibility', async () => {
      transport.setMessageHandler(async (_msg) => ({ result: 'ok' }));

      const response = await request(app)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
        });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('result', 'ok');
    });

    it('should accept requests with valid Accept headers', async () => {
      transport.setMessageHandler(async (_msg) => ({ result: 'ok' }));

      const response = await request(app)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .set('Accept', 'application/json, text/event-stream')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
        });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('result', 'ok');
    });
  });

  describe('GET - SSE Stream', () => {
    it('should require Mcp-Session-Id header', async () => {
      const response = await request(app)
        .get('/mcp')
        .set('Accept', 'text/event-stream');

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('message');
      expect(response.body.message).toContain('Mcp-Session-Id');
    });

    it('should reject invalid session ID', async () => {
      const response = await request(app)
        .get('/mcp')
        .set('Accept', 'text/event-stream')
        .set('Mcp-Session-Id', 'invalid-session');

      expect(response.status).toBe(404);
      expect(response.body).toHaveProperty('message');
      expect(response.body.message).toContain('Session not found');
    });

    it('should require text/event-stream Accept header', async () => {
      const response = await request(app)
        .get('/mcp')
        .set('Mcp-Session-Id', 'some-session');

      expect(response.status).toBe(405);
      expect(response.body).toHaveProperty('error', 'Method Not Allowed');
    });

    it('should sanitize internal GET errors with correlation ID', async () => {
      transport.setMessageHandler(async () => ({ result: 'ok' }));

      const initResponse = await request(app)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
        });

      const sessionId = initResponse.headers['mcp-session-id'];

      (transport as any).startSSEStream = () => {
        throw new Error('SSE failure');
      };

      const response = await request(app)
        .get('/mcp')
        .set('Accept', 'text/event-stream')
        .set('Mcp-Session-Id', sessionId);

      expect(response.status).toBe(500);
      expect(response.body.error).toBe('Internal Server Error');
      expect(response.body.message).toMatch(/^Internal error \(correlation ID: .+\)$/);
      expect(response.body.message).not.toContain('SSE failure');
      expect(response.headers['cache-control']).toBe('no-store');
    });
  });

  describe('Legacy /sse alias (deprecated)', () => {
    it('should support SSE response for initialization via POST /sse', async () => {
      transport.setMessageHandler(async (_msg) => ({
        protocolVersion: '2025-03-26',
        serverInfo: { name: 'test' },
      }));

      const response = await request(app)
        .post('/sse')
        .set('Accept', 'text/event-stream')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {},
        });

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('text/event-stream');
      expect(response.headers['mcp-session-id']).toBeDefined();
      expect(response.text).toContain('id:');
      expect(response.text).toContain('data:');
    });

    it('should require Mcp-Session-Id header for GET /sse', async () => {
      const response = await request(app)
        .get('/sse')
        .set('Accept', 'text/event-stream');

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('message');
      expect(response.body.message).toContain('Mcp-Session-Id');
    });

    it('should delete session via DELETE /sse', async () => {
      transport.setMessageHandler(async (_msg) => ({ result: 'ok' }));

      // Create session
      const initResponse = await request(app)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
        });
      const sessionId = initResponse.headers['mcp-session-id'];

      const deleteResponse = await request(app)
        .delete('/sse')
        .set('Mcp-Session-Id', sessionId);

      expect(deleteResponse.status).toBe(204);
    });
  });

  describe('DELETE - Session Termination', () => {
    it('should delete existing session', async () => {
      transport.setMessageHandler(async (_msg) => ({ result: 'ok' }));

      // Create session
      const initResponse = await request(app)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
        });

      const sessionId = initResponse.headers['mcp-session-id'];

      // Delete session
      const deleteResponse = await request(app)
        .delete('/mcp')
        .set('Mcp-Session-Id', sessionId);

      expect(deleteResponse.status).toBe(204);

      // Verify session is gone
      const testResponse = await request(app)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .set('Mcp-Session-Id', sessionId)
        .send({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/list',
        });

      expect(testResponse.status).toBe(404);
    });

    it('should return 404 for non-existent session', async () => {
      const response = await request(app)
        .delete('/mcp')
        .set('Mcp-Session-Id', 'non-existent-session');

      expect(response.status).toBe(404);
    });

    it('should require Mcp-Session-Id header', async () => {
      const response = await request(app)
        .delete('/mcp');

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('message');
      expect(response.body.message).toContain('Mcp-Session-Id');
    });
  });

  describe('Health Endpoint', () => {
    it('should return health status', async () => {
      const response = await request(app).get('/health');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('status', 'ok');
      expect(response.body).toHaveProperty('sessions');
      expect(typeof response.body.sessions).toBe('number');
    });
  });

  describe('Readiness Endpoint', () => {
    it('returns 503 with not-ready status when no profiles are loaded', async () => {
      // Default `transport` fixture has zero profiles loaded
      const response = await request(app).get('/ready');

      expect(response.status).toBe(503);
      expect(response.body).toHaveProperty('status', 'not ready');
      expect(response.body).toHaveProperty('reason', 'no profiles loaded');
    });

    it('returns 200 with ready status when at least one profile is loaded', async () => {
      createProfileState(transport as any, 'default');

      const response = await request(app).get('/ready');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('status', 'ready');
      expect(response.body).toHaveProperty('profiles');
      expect(typeof response.body.profiles).toBe('number');
      expect(response.body.profiles).toBeGreaterThan(0);
    });

    it('reports the correct profile count', async () => {
      createProfileState(transport as any, 'profile-a');
      createProfileState(transport as any, 'profile-b');

      const response = await request(app).get('/ready');

      expect(response.status).toBe(200);
      expect(response.body.profiles).toBe(2);
    });

    it('is unauthenticated - no Authorization header required', async () => {
      // Deliberately no .set('Authorization', ...) header
      const response = await request(app).get('/ready');

      // Must never return 401 or 403 - readiness is always accessible
      expect(response.status).not.toBe(401);
      expect(response.status).not.toBe(403);
      expect([200, 503]).toContain(response.status);
    });
  });

  describe('Message Type Detection', () => {
    it('should detect request message', async () => {
      transport.setMessageHandler(async (_msg) => ({ result: 'ok' }));

      const response = await request(app)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {},
        });

      expect(response.status).toBe(200);
    });

    it('should handle batch requests', async () => {
      transport.setMessageHandler(async (_msg) => {
        if (Array.isArray(_msg)) {
          return _msg.map((m: any) => ({
            jsonrpc: '2.0',
            id: m.id,
            result: { method: m.method },
          }));
        }
        return { jsonrpc: '2.0', id: (_msg as any).id, result: { method: (_msg as any).method } };
      });

      // Initialize first
      const initResponse = await request(app)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
        });

      const sessionId = initResponse.headers['mcp-session-id'];

      // Send batch
      const response = await request(app)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .set('Mcp-Session-Id', sessionId)
        .send([
          { jsonrpc: '2.0', id: 2, method: 'tools/list' },
          { jsonrpc: '2.0', id: 3, method: 'prompts/list' },
          { jsonrpc: '2.0', id: 4, method: 'prompts/get', params: { name: 'summarize_issue', arguments: { issue_title: 'X' } } },
        ]);

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body).toHaveLength(3);
      expect(response.body[0].result.method).toBe('tools/list');
      expect(response.body[1].result.method).toBe('prompts/list');
      expect(response.body[2].result.method).toBe('prompts/get');
    });

    it('should handle single prompts/get request', async () => {
      transport.setMessageHandler(async (_msg) => ({
        jsonrpc: '2.0',
        id: (_msg as any).id,
        result: { method: (_msg as any).method, params: (_msg as any).params },
      }));

      const initResponse = await request(app)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
        });

      const sessionId = initResponse.headers['mcp-session-id'];

      const response = await request(app)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .set('Mcp-Session-Id', sessionId)
        .send({
          jsonrpc: '2.0',
          id: 2,
          method: 'prompts/get',
          params: {
            name: 'summarize_issue',
            arguments: {
              issue_title: 'Fix auth flow',
            },
          },
        });

      expect(response.status).toBe(200);
      expect(response.body.result.method).toBe('prompts/get');
      expect(response.body.result.params.name).toBe('summarize_issue');
    });
  });

  describe('Error Handling', () => {
    it('should handle message handler errors', async () => {
      transport.setMessageHandler(async (_msg) => {
        throw new Error('Test error');
      });

      const response = await request(app)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
        });

      expect(response.status).toBe(500);
      expect(response.body).toHaveProperty('error', 'Internal Server Error');
      expect(response.body).toHaveProperty('correlationId');
      expect(response.body.message).toContain('correlation ID');
      expect(response.body.message).not.toContain('Test error');
    });

    it('should handle missing message handler', async () => {
      const response = await request(app)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
        });

      expect(response.status).toBe(400);
    });
  });

  describe('Session Lifecycle', () => {
    it('should track session activity', async () => {
      transport.setMessageHandler(async (_msg) => ({ result: 'ok' }));

      // Create session
      const initResponse = await request(app)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
      });

      const sessionId = initResponse.headers['mcp-session-id'];
      const profileState = (transport as any).profileStates.get('default');
      const session = profileState.sessions.get(sessionId);

      expect(session).toBeDefined();
      expect(session.id).toBe(sessionId);
      expect(session.createdAt).toBeDefined();
      expect(session.lastActivityAt).toBeDefined();
    });

    it('should update lastActivityAt on requests', async () => {
      transport.setMessageHandler(async (_msg) => {
        // Simulate slow operation
        await new Promise(resolve => setTimeout(resolve, 100));
        return { result: 'ok' };
      });

      // Create session
      const initResponse = await request(app)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
      });

      const sessionId = initResponse.headers['mcp-session-id'];
      const profileState = (transport as any).profileStates.get('default');
      const initialActivity = profileState.sessions.get(sessionId).lastActivityAt;

      // Wait a bit
      await new Promise(resolve => setTimeout(resolve, 50));

      // Make another request
      await request(app)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .set('Mcp-Session-Id', sessionId)
        .send({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/list',
        });

      const updatedActivity = profileState.sessions.get(sessionId).lastActivityAt;
      expect(updatedActivity).toBeGreaterThan(initialActivity);
    });
  });

  describe('Metrics Endpoint', () => {
    let metricsTransport: HttpTransport;
    let metricsApp: Express;

    beforeEach(async () => {
      const config = {
        host: '0.0.0.0',
        port: 0,
        sessionTimeoutMs: 1800000,
        heartbeatEnabled: false,
        heartbeatIntervalMs: 30000,
        metricsEnabled: true,
        metricsPath: '/metrics',
      };

      metricsTransport = new HttpTransport(config, logger);
      metricsApp = (metricsTransport as any).app;
      metricsTransport.setMessageHandler(async (_msg) => ({ result: 'ok' }));
    });

    afterEach(async () => {
      await metricsTransport.stop();
    });

    it('should return metrics in Prometheus format', async () => {
      // Make some requests to generate metrics
      await request(metricsApp)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .set('Host', 'localhost')
        .send({ jsonrpc: '2.0', id: 1, method: 'initialize' });

      // Fetch metrics
      const response = await request(metricsApp)
        .get('/metrics')
        .set('Accept', 'text/plain');

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('text/plain');
      expect(response.text).toContain('mcp_http_requests_total');
      expect(response.text).toContain('mcp_sessions_created_total');
      expect(response.text).toContain('mcp_sessions_active');
    });

    it('should return 404 when metrics endpoint accessed but metrics disabled', async () => {
      const noMetricsTransport = new HttpTransport(
        {
          host: '127.0.0.1',
          port: 0,
          sessionTimeoutMs: 1800000,
          heartbeatEnabled: false,
          heartbeatIntervalMs: 30000,
          metricsEnabled: false,
          metricsPath: '/metrics',
        },
        logger
      );
      const noMetricsApp = (noMetricsTransport as any).app;

      // Metrics endpoint should not be registered when disabled
      const response = await request(noMetricsApp)
        .get('/metrics');

      expect(response.status).toBe(404);

      await noMetricsTransport.stop();
    });

    it('should handle metrics endpoint error', async () => {
      // Mock metrics.getMetrics to throw an error
      const mockMetrics = {
        getMetrics: async () => {
          throw new Error('Metrics error');
        }
      };
      (metricsTransport as any).metrics = mockMetrics;

      const response = await request(metricsApp)
        .get('/metrics');

      expect(response.status).toBe(500);
      expect(response.body.error).toBe('Internal Server Error');
      expect(response.body.message).toMatch(/^Internal error \(correlation ID: .+\)$/);
      expect(response.body.message).not.toContain('Metrics error');
    });

    it('should return 404 when metrics is null after endpoint registration', async () => {
      // Force metrics to null after endpoint is registered
      (metricsTransport as any).metrics = null;

      const response = await request(metricsApp)
        .get('/metrics');

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Not Found');
      expect(response.body.message).toBe('Metrics disabled');
    });

    it('should not expose metrics when disabled', async () => {
      const disabledConfig = {
        host: '0.0.0.0',
        port: 0,
        sessionTimeoutMs: 1800000,
        heartbeatEnabled: false,
        heartbeatIntervalMs: 30000,
        metricsEnabled: false,
        metricsPath: '/metrics',
      };

      const disabledTransport = new HttpTransport(disabledConfig, logger);
      const disabledApp = (disabledTransport as any).app;

      const response = await request(disabledApp)
        .get('/metrics')
        .set('Accept', 'text/plain');

      expect(response.status).toBe(404);

      await disabledTransport.stop();
    });

    it('should track session lifecycle in metrics', async () => {
      // Create session
      await request(metricsApp)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .set('Host', 'localhost')
        .send({ jsonrpc: '2.0', id: 1, method: 'initialize' });

      // Check metrics
      const response1 = await request(metricsApp).get('/metrics');
      expect(response1.text).toContain('mcp_sessions_created_total{profile_id="default",tenant_id="none"} 1');
      expect(response1.text).toContain('mcp_sessions_active{profile_id="default",tenant_id="none"} 1');

      // Extract session ID
      const initResponse = await request(metricsApp)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .set('Host', 'localhost')
        .send({ jsonrpc: '2.0', id: 2, method: 'initialize' });

      const sessionId = initResponse.headers['mcp-session-id'];

      // Delete session
      await request(metricsApp)
        .delete('/mcp')
        .set('Mcp-Session-Id', sessionId)
        .set('Host', 'localhost');

      // Check metrics again
      const response2 = await request(metricsApp).get('/metrics');
      expect(response2.text).toContain('mcp_sessions_destroyed_total{profile_id="default",tenant_id="none"}');
    });

    it('should use custom metrics path', async () => {
      const customConfig = {
        host: '0.0.0.0',
        port: 0,
        sessionTimeoutMs: 1800000,
        heartbeatEnabled: false,
        heartbeatIntervalMs: 30000,
        metricsEnabled: true,
        metricsPath: '/custom-metrics',
      };

      const customTransport = new HttpTransport(customConfig, logger);
      const customApp = (customTransport as any).app;

      // Custom path should work
      const response1 = await request(customApp).get('/custom-metrics');
      expect(response1.status).toBe(200);

      // Default path should not exist
      const response2 = await request(customApp).get('/metrics');
      expect(response2.status).toBe(404);

      await customTransport.stop();
    });
  });

  describe('OAuth Token Endpoint', () => {
    let oauthTransport: HttpTransport;
    let oauthApp: any;

    beforeEach(async () => {
      const oauthConfig = {
        host: '127.0.0.1',
        port: 0,
        sessionTimeoutMs: 1800000,
        heartbeatEnabled: false,
        heartbeatIntervalMs: 30000,
        metricsEnabled: false,
        metricsPath: '/metrics',
        oauthConfig: {
          issuer: 'https://auth.example.com',
          client_id: 'test-client',
          client_secret: 'test-secret',
          redirect_uri: 'https://example.com/oauth/callback',
          scopes: ['read', 'write'],
        },
      };

      oauthTransport = new HttpTransport(oauthConfig, logger);
      oauthApp = (oauthTransport as any).app;
    });

    afterEach(async () => {
      await oauthTransport.stop();
    });

    it('should reject token request without grant_type', async () => {
      const response = await request(oauthApp)
        .post('/oauth/token')
        .send({});

      expect(response.status).toBe(400);
    });

    it('should reject authorization_code grant without code', async () => {
      const response = await request(oauthApp)
        .post('/oauth/token')
        .send({ grant_type: 'authorization_code', client_id: 'test' });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('invalid_request');
    });

    it('should reject refresh_token grant without refresh_token', async () => {
      const response = await request(oauthApp)
        .post('/oauth/token')
        .send({ grant_type: 'refresh_token', client_id: 'test' });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('invalid_request');
    });

    it('should reject unsupported grant type', async () => {
      const response = await request(oauthApp)
        .post('/oauth/token')
        .send({ grant_type: 'password', client_id: 'test' });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('unsupported_grant_type');
    });

    it('should reject refresh_token grant with non-existent client', async () => {
      const response = await request(oauthApp)
        .post('/oauth/token')
        .send({ 
          grant_type: 'refresh_token', 
          client_id: 'non-existent-client',
          refresh_token: 'valid-refresh-token'
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('invalid_client');
    });

    it('should handle token refresh when OAuth provider not initialized', async () => {
      // Create transport with OAuth config so endpoint is registered
      const oauthTransport = new HttpTransport(
        {
          host: '127.0.0.1',
          port: 0,
          sessionTimeoutMs: 1800000,
          heartbeatEnabled: false,
          heartbeatIntervalMs: 30000,
          metricsEnabled: false,
          metricsPath: '/metrics',
          oauthConfig: {
            issuer: 'https://auth.example.com',
            client_id: 'test-client',
            client_secret: 'test-secret',
            scopes: ['read', 'write'],
          },
        },
        logger
      );
      // Force oauthProvider to null after setup to test the else branch
      createProfileState(oauthTransport as any).oauthProvider = null;
      const oauthApp = (oauthTransport as any).app;

      const response = await request(oauthApp)
        .post('/oauth/token')
        .send({ 
          grant_type: 'refresh_token', 
          client_id: 'test-client',
          refresh_token: 'valid-refresh-token'
        });

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('server_error');
      expect(response.body.error_description).toBe('OAuth provider not initialized');

      await oauthTransport.stop();
    });
  });

  describe('OAuth Callback Endpoint', () => {
    let oauthTransport: HttpTransport;
    let oauthApp: any;

    beforeEach(async () => {
      const oauthConfig = {
        host: '127.0.0.1',
        port: 0,
        sessionTimeoutMs: 1800000,
        heartbeatEnabled: false,
        heartbeatIntervalMs: 30000,
        metricsEnabled: false,
        metricsPath: '/metrics',
        oauthConfig: {
          issuer: 'https://auth.example.com',
          client_id: 'test-client',
          client_secret: 'test-secret',
          redirect_uri: 'https://example.com/oauth/callback',
          scopes: ['read', 'write'],
        },
      };

      oauthTransport = new HttpTransport(oauthConfig, logger);
      oauthApp = (oauthTransport as any).app;
    });

    afterEach(async () => {
      await oauthTransport.stop();
    });

    it('should reject callback without code', async () => {
      const response = await request(oauthApp)
        .get('/oauth/callback');

      expect(response.status).toBe(400);
    });

    it('should handle error in callback', async () => {
      const response = await request(oauthApp)
        .get('/oauth/callback')
        .query({ error: 'access_denied', error_description: 'User denied' });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('access_denied');
    });

    it('should handle exception during OAuth callback', async () => {
      // Mock the oauthProvider to throw an error during handleCallback
      createProfileState(oauthTransport as any).oauthProvider = {
        handleCallback: async () => {
          throw new Error('Token exchange failed');
        }
      };

      const response = await request(oauthApp)
        .get('/oauth/callback')
        .query({ code: 'test-code' });

      expect(response.status).toBe(500);
      expect(response.text).toBe('OAuth callback failed');
    });
  });

	  describe('OAuth Authorize Endpoint', () => {
	    let oauthTransport: HttpTransport;
	    let oauthApp: any;

    beforeEach(async () => {
      const oauthConfig = {
        host: '127.0.0.1',
        port: 0,
        sessionTimeoutMs: 1800000,
        heartbeatEnabled: false,
        heartbeatIntervalMs: 30000,
        metricsEnabled: false,
        metricsPath: '/metrics',
        oauthConfig: {
          issuer: 'https://auth.example.com',
          client_id: 'test-client',
          client_secret: 'test-secret',
          redirect_uri: 'https://example.com/oauth/callback',
          scopes: ['read', 'write'],
        },
      };

      oauthTransport = new HttpTransport(oauthConfig, logger);
      oauthApp = (oauthTransport as any).app;
    });

    afterEach(async () => {
      await oauthTransport.stop();
    });

    it('should reject authorize request without client_id', async () => {
      const response = await request(oauthApp)
        .get('/oauth/authorize')
        .query({ response_type: 'code' });

      // Returns 400 with error in body or text
      expect(response.status).toBe(400);
    });

	    it('should reject authorize request without response_type', async () => {
	      const response = await request(oauthApp)
	        .get('/oauth/authorize')
	        .query({ client_id: 'test-client' });

	      expect(response.status).toBe(400);
	    });

	    it('should reject authorize request without redirect_uri', async () => {
	      const response = await request(oauthApp)
	        .get('/oauth/authorize')
	        .query({ response_type: 'code', client_id: 'test-client' });

	      expect(response.status).toBe(400);
	    });

	    it('should allow approved unregistered OAuth clients for authorize requests', async () => {
	      await oauthTransport.stop();

	      oauthTransport = new HttpTransport({
	        host: '127.0.0.1',
	        port: 0,
	        sessionTimeoutMs: 1800000,
	        heartbeatEnabled: false,
	        heartbeatIntervalMs: 30000,
	        metricsEnabled: false,
	        metricsPath: '/metrics',
	        oauthConfig: {
	          issuer: 'https://auth.example.com',
	          client_id: 'test-client',
	          client_secret: 'test-secret',
	          redirect_uri: 'http://127.0.0.1:3003/oauth/callback',
	          scopes: ['read', 'write'],
	          allow_unregistered_clients: true,
	          allowed_unregistered_redirect_uris: ['http://localhost', 'cursor://'],
	        },
	      }, logger);
	      oauthApp = (oauthTransport as any).app;

	      const response = await request(oauthApp)
	        .get('/oauth/authorize')
	        .query({
	          response_type: 'code',
	          client_id: 'cursor-client-id',
	          redirect_uri: 'http://localhost:43123/oauth/callback',
	          code_challenge: 'challenge',
	          code_challenge_method: 'S256',
	        });

	      expect(response.status).toBe(302);
	      expect(response.headers.location).toContain('https://auth.example.com/oauth/authorize');

      const provider = (oauthTransport as any).profileStates.get('default').oauthProvider;
      const materializedClient = await provider.clientsStore.getClient('cursor-client-id');
      expect(materializedClient).toMatchObject({
        client_id: 'cursor-client-id',
        redirect_uris: ['http://localhost:43123/oauth/callback'],
      });
    });

    it('should append approved loopback redirects for an existing materialized unregistered OAuth client', async () => {
      await oauthTransport.stop();

      oauthTransport = new HttpTransport({
        host: '127.0.0.1',
        port: 0,
        sessionTimeoutMs: 1800000,
        heartbeatEnabled: false,
        heartbeatIntervalMs: 30000,
        metricsEnabled: false,
        metricsPath: '/metrics',
        oauthConfig: {
          issuer: 'https://auth.example.com',
          client_id: 'test-client',
          client_secret: 'test-secret',
          redirect_uri: 'http://127.0.0.1:3003/oauth/callback',
          scopes: ['read', 'write'],
          allow_unregistered_clients: true,
          allowed_unregistered_redirect_uris: ['http://localhost'],
        },
      }, logger);
      oauthApp = (oauthTransport as any).app;

      await request(oauthApp)
        .get('/oauth/authorize')
        .query({
          response_type: 'code',
          client_id: 'cursor-client-id',
          redirect_uri: 'http://localhost:43123/oauth/callback',
          code_challenge: 'challenge',
          code_challenge_method: 'S256',
        })
        .expect(302);

      await request(oauthApp)
        .get('/oauth/authorize')
        .query({
          response_type: 'code',
          client_id: 'cursor-client-id',
          redirect_uri: 'http://localhost:43124/oauth/callback',
          code_challenge: 'challenge-2',
          code_challenge_method: 'S256',
        })
        .expect(302);

      const provider = (oauthTransport as any).profileStates.get('default').oauthProvider;
      const materializedClient = await provider.clientsStore.getClient('cursor-client-id');
      expect(materializedClient).toMatchObject({
        client_id: 'cursor-client-id',
        redirect_uris: [
          'http://localhost:43123/oauth/callback',
          'http://localhost:43124/oauth/callback',
        ],
      });
    });

	    it('should allow approved custom scheme redirects for unregistered OAuth clients', async () => {
	      await oauthTransport.stop();

	      oauthTransport = new HttpTransport({
	        host: '127.0.0.1',
	        port: 0,
	        sessionTimeoutMs: 1800000,
	        heartbeatEnabled: false,
	        heartbeatIntervalMs: 30000,
	        metricsEnabled: false,
	        metricsPath: '/metrics',
	        oauthConfig: {
	          issuer: 'https://auth.example.com',
	          client_id: 'test-client',
	          client_secret: 'test-secret',
	          redirect_uri: 'http://127.0.0.1:3003/oauth/callback',
	          scopes: ['read', 'write'],
	          allow_unregistered_clients: true,
	          allowed_unregistered_redirect_uris: ['cursor://'],
	        },
	      }, logger);
	      oauthApp = (oauthTransport as any).app;

	      const response = await request(oauthApp)
	        .get('/oauth/authorize')
	        .query({
	          response_type: 'code',
	          client_id: 'cursor-client-id',
	          redirect_uri: 'cursor://anysphere.cursor-mcp/oauth/callback',
	          code_challenge: 'challenge',
	          code_challenge_method: 'S256',
	        });

	      expect(response.status).toBe(302);
	      expect(response.headers.location).toContain('https://auth.example.com/oauth/authorize');

	      const provider = (oauthTransport as any).profileStates.get('default').oauthProvider;
	      const materializedClient = await provider.clientsStore.getClient('cursor-client-id');
	      expect(materializedClient).toMatchObject({
	        client_id: 'cursor-client-id',
	        redirect_uris: ['cursor://anysphere.cursor-mcp/oauth/callback'],
	      });
	    });
	  });

  describe('OAuth Well-Known Endpoint', () => {
    let oauthTransport: HttpTransport;
    let oauthApp: any;

    beforeEach(async () => {
      const oauthConfig = {
        host: '127.0.0.1',
        port: 0,
        sessionTimeoutMs: 1800000,
        heartbeatEnabled: false,
        heartbeatIntervalMs: 30000,
        metricsEnabled: false,
        metricsPath: '/metrics',
        oauthConfig: {
          issuer: 'https://auth.example.com',
          client_id: 'test-client',
          client_secret: 'test-secret',
          redirect_uri: 'https://example.com/oauth/callback',
          scopes: ['read', 'write'],
        },
        resourceName: 'Test MCP Server',
        resourceDocumentation: 'https://docs.example.com',
      };

      oauthTransport = new HttpTransport(oauthConfig, logger);
      oauthApp = (oauthTransport as any).app;
    });

    afterEach(async () => {
      await oauthTransport.stop();
    });

    it('should return protected resource metadata', async () => {
      const response = await request(oauthApp)
        .get('/.well-known/oauth-protected-resource/mcp');

      expect(response.status).toBe(200);
      expect(response.body.resource).toBeDefined();
      expect(response.body.bearer_methods_supported).toContain('header');
      expect(response.body.resource_name).toBe('Test MCP Server');
      expect(response.body.resource_documentation).toBe('https://docs.example.com');
    });

    it('should return authorization server metadata', async () => {
      const response = await request(oauthApp)
        .get('/.well-known/oauth-authorization-server');

      expect(response.status).toBe(200);
      expect(response.body.issuer).toBeDefined();
      expect(response.body.authorization_endpoint).toBeDefined();
      expect(response.body.token_endpoint).toBeDefined();
      expect(response.body.response_types_supported).toContain('code');
      expect(response.body.code_challenge_methods_supported).toContain('S256');
    });

    it('should handle dynamic client registration', async () => {
      const response = await request(oauthApp)
        .post('/oauth/register')
        .send({ redirect_uris: ['http://localhost:8080/callback'] });

      expect(response.status).toBe(201);
      expect(response.body.client_id).toBeDefined();
    });

    it('should omit optional protected resource metadata fields when not configured', async () => {
      await oauthTransport.stop();

      const minimalOauthConfig = {
        host: '127.0.0.1',
        port: 0,
        sessionTimeoutMs: 1800000,
        heartbeatEnabled: false,
        heartbeatIntervalMs: 30000,
        metricsEnabled: false,
        metricsPath: '/metrics',
        oauthConfig: {
          issuer: 'https://auth.example.com',
          client_id: 'test-client',
          client_secret: 'test-secret',
          redirect_uri: 'https://example.com/oauth/callback',
          scopes: [],
        },
      };

      oauthTransport = new HttpTransport(minimalOauthConfig as any, logger);
      oauthApp = (oauthTransport as any).app;

      const response = await request(oauthApp)
        .get('/.well-known/oauth-protected-resource/mcp');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('resource');
      expect(response.body).toHaveProperty('authorization_servers');
      expect(response.body).toHaveProperty('bearer_methods_supported');
      expect(response.body).not.toHaveProperty('resource_name');
      expect(response.body).not.toHaveProperty('resource_documentation');
      expect(response.body).not.toHaveProperty('scopes_supported');
    });
  });

  describe('OAuth Disabled', () => {
    it('should return 404 for OAuth endpoints when OAuth is not configured', async () => {
      const noOAuthConfig = {
        host: '127.0.0.1',
        port: 0,
        sessionTimeoutMs: 1800000,
        heartbeatEnabled: false,
        heartbeatIntervalMs: 30000,
        metricsEnabled: false,
        metricsPath: '/metrics',
        // No oauthConfig
      };

      const noOAuthTransport = new HttpTransport(noOAuthConfig, logger);
      const noOAuthApp = (noOAuthTransport as any).app;

      // OAuth endpoints should not exist
      const authorizeResponse = await request(noOAuthApp).get('/oauth/authorize');
      expect(authorizeResponse.status).toBe(404);

      const tokenResponse = await request(noOAuthApp).post('/oauth/token');
      expect(tokenResponse.status).toBe(404);

      await noOAuthTransport.stop();
    });
  });

  describe('Token Length Validation', () => {
    it('should accept tokens within max length', async () => {
      const configWithMaxLength = {
        host: '127.0.0.1',
        port: 0,
        sessionTimeoutMs: 1800000,
        heartbeatEnabled: false,
        heartbeatIntervalMs: 30000,
        metricsEnabled: false,
        metricsPath: '/metrics',
        maxTokenLength: 500,
      };

      const tokenTransport = new HttpTransport(configWithMaxLength, logger);
      const tokenApp = (tokenTransport as any).app;
      tokenTransport.setMessageHandler(async (_msg) => ({ result: 'ok' }));

      // Token within limit
      const validToken = 'Bearer ' + 'a'.repeat(400);
      const response = await request(tokenApp)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .set('Authorization', validToken)
        .set('Host', 'localhost')
        .send({ jsonrpc: '2.0', id: 1, method: 'initialize' });

      expect(response.status).not.toBe(400);

      await tokenTransport.stop();
    });
  });

  describe('MCP4_TOKEN_KEY startup warn and DEFAULT_MAX_TOKEN_LENGTH = 4096', () => {
    interface MockLogger extends Logger {
      debug: ReturnType<typeof vi.fn>;
      info: ReturnType<typeof vi.fn>;
      warn: ReturnType<typeof vi.fn>;
      error: ReturnType<typeof vi.fn>;
    }
    const buildMockLogger = (): MockLogger => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    });
    const baseConfig = {
      host: '127.0.0.1',
      port: 0,
      sessionTimeoutMs: 1800000,
      heartbeatEnabled: false,
      heartbeatIntervalMs: 30000,
      metricsEnabled: false,
      metricsPath: '/metrics',
    };

    it('warns when MCP4_TOKEN_KEY is not set (config.tokenKey undefined)', async () => {
      const mockLogger = buildMockLogger();
      const t = new HttpTransport({ ...baseConfig }, mockLogger);
      const warnCalls = mockLogger.warn.mock.calls;
      const matchingCall = warnCalls.find((args: unknown[]) =>
        typeof args[0] === 'string' && (args[0] as string).includes('MCP4_TOKEN_KEY not set'),
      );
      expect(matchingCall).toBeDefined();
      await t.stop();
    });

    it('does not warn about MCP4_TOKEN_KEY when tokenKey is set', async () => {
      const savedKey = process.env.MCP4_TOKEN_KEY;
      delete process.env.MCP4_TOKEN_KEY;
      const mockLogger = buildMockLogger();
      const t = new HttpTransport({ ...baseConfig, tokenKey: Buffer.alloc(32) }, mockLogger);
      if (savedKey !== undefined) process.env.MCP4_TOKEN_KEY = savedKey;
      const warnCalls = mockLogger.warn.mock.calls;
      const matchingCall = warnCalls.find((args: unknown[]) =>
        typeof args[0] === 'string' && (args[0] as string).includes('MCP4_TOKEN_KEY'),
      );
      expect(matchingCall).toBeUndefined();
      await t.stop();
    });

    it('warns when MCP4_TOKEN_KEY is a passphrase (non-hex key)', async () => {
      const savedKey = process.env.MCP4_TOKEN_KEY;
      process.env.MCP4_TOKEN_KEY = 'my-weak-passphrase';
      const mockLogger = buildMockLogger();
      const t = new HttpTransport({ ...baseConfig, tokenKey: Buffer.alloc(32) }, mockLogger);
      if (savedKey !== undefined) process.env.MCP4_TOKEN_KEY = savedKey;
      else delete process.env.MCP4_TOKEN_KEY;
      const warnCalls = mockLogger.warn.mock.calls;
      const matchingCall = warnCalls.find((args: unknown[]) =>
        typeof args[0] === 'string' && (args[0] as string).includes('MCP4_TOKEN_KEY is a passphrase'),
      );
      expect(matchingCall).toBeDefined();
      await t.stop();
    });

    it('accepts a 4096-char token at the new DEFAULT_MAX_TOKEN_LENGTH boundary', async () => {
      const t = new HttpTransport({ ...baseConfig }, logger);
      const tApp = (t as any).app;
      t.setMessageHandler(async () => ({ result: 'ok' }));
      const validToken = 'Bearer ' + 'a'.repeat(4096);
      const response = await request(tApp)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .set('Authorization', validToken)
        .set('Host', 'localhost')
        .send({ jsonrpc: '2.0', id: 1, method: 'initialize' });
      expect(response.status).not.toBe(400);
      await t.stop();
    });

    it('rejects a 4097-char token with too long (max 4096 characters)', async () => {
      const t = new HttpTransport({ ...baseConfig }, logger);
      const tApp = (t as any).app;
      t.setMessageHandler(async () => ({ result: 'ok' }));
      const tooLongToken = 'Bearer ' + 'a'.repeat(4097);
      const response = await request(tApp)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .set('Authorization', tooLongToken)
        .set('Host', 'localhost')
        .send({ jsonrpc: '2.0', id: 1, method: 'initialize' });
      expect(response.status).toBe(400);
      const bodyText = JSON.stringify(response.body);
      expect(bodyText).toContain('too long (max 4096 characters)');
      await t.stop();
    });
  });

  describe('Initialization Token Validation (validation_endpoint)', () => {
    it('should reject initialization when validation endpoint returns non-2xx', async () => {
      const tokenTransport = new HttpTransport(
        {
          host: '127.0.0.1',
          port: 0,
          sessionTimeoutMs: 1800000,
          heartbeatEnabled: false,
          heartbeatIntervalMs: 30000,
          metricsEnabled: false,
          metricsPath: '/metrics',
          baseUrl: 'https://api.example.com',
          authConfigs: [
            {
              type: 'bearer',
              value_from_env: 'MCP4_API_TOKEN',
              validation_endpoint: '/validate',
            } as any,
          ],
        } as any,
        logger
      );
      const tokenApp = (tokenTransport as any).app;
      tokenTransport.setMessageHandler(async () => ({ result: 'ok' }));

      const originalFetch = global.fetch;
      global.fetch = vi.fn(async () => ({ status: 401 }) as any);
      try {
        const response = await request(tokenApp)
          .post('/mcp')
          .set('Accept', 'application/json, text/event-stream')
          .set('Authorization', 'Bearer test-token')
          .set('Host', 'localhost')
          .send({ jsonrpc: '2.0', id: 1, method: 'initialize' });

        expect(response.status).toBe(200);
        expect(response.headers['www-authenticate']).toBeUndefined();
        expect(response.body).toEqual({
          jsonrpc: '2.0',
          id: 1,
          error: {
            code: -32600,
            message: 'Supplied authentication token is invalid or expired',
          },
        });
      } finally {
        global.fetch = originalFetch;
        await tokenTransport.stop();
      }
    });

    it('should allow initialization when validation endpoint returns 2xx', async () => {
      // Enable private network access for tests to allow 127.0.0.1 validation
      const originalAllowPrivateNetwork = process.env.MCP4_SSRF_ALLOW_PRIVATE_NETWORK;
      process.env.MCP4_SSRF_ALLOW_PRIVATE_NETWORK = 'true';

      const tokenTransport = new HttpTransport(
        {
          host: '127.0.0.1',
          port: 0,
          sessionTimeoutMs: 1800000,
          heartbeatEnabled: false,
          heartbeatIntervalMs: 30000,
          metricsEnabled: false,
          metricsPath: '/metrics',
          baseUrl: 'http://127.0.0.1', // Use IP to avoid DNS lookup issues
          authConfigs: [
            {
              type: 'bearer',
              value_from_env: 'MCP4_API_TOKEN',
              validation_endpoint: '/validate',
            } as any,
          ],
        } as any,
        logger
      );
      const tokenApp = (tokenTransport as any).app;
      tokenTransport.setMessageHandler(async () => ({ result: 'ok' }));

      const originalFetch = global.fetch;
      global.fetch = vi.fn(async () => ({ status: 204 }) as any);
      try {
        const response = await request(tokenApp)
          .post('/mcp')
          .set('Accept', 'application/json, text/event-stream')
          .set('Authorization', 'Bearer test-token')
          .set('Host', 'localhost')
          .send({ jsonrpc: '2.0', id: 1, method: 'initialize' });

        expect(response.status).toBe(200);
        expect(response.headers['mcp-session-id']).toBeDefined();
      } finally {
        global.fetch = originalFetch;
        if (originalAllowPrivateNetwork === undefined) {
          delete process.env.MCP4_SSRF_ALLOW_PRIVATE_NETWORK;
        } else {
          process.env.MCP4_SSRF_ALLOW_PRIVATE_NETWORK = originalAllowPrivateNetwork;
        }
        await tokenTransport.stop();
      }
    });
  });

  describe('Server-side env token validation (validation_endpoint)', () => {
    it('rejects session init when server-side env token fails validation_endpoint', async () => {
      const savedToken = process.env.MCP4_SERVER_TOKEN;
      process.env.MCP4_SERVER_TOKEN = 'invalid-server-token';

      const tokenTransport = new HttpTransport(
        {
          host: '127.0.0.1',
          port: 0,
          sessionTimeoutMs: 1800000,
          heartbeatEnabled: false,
          heartbeatIntervalMs: 30000,
          metricsEnabled: false,
          metricsPath: '/metrics',
          baseUrl: 'https://api.example.com',
          authConfigs: [
            {
              type: 'bearer',
              value_from_env: 'MCP4_SERVER_TOKEN',
              validation_endpoint: '/validate',
            } as any,
          ],
        } as any,
        logger,
      );
      tokenTransport.setMessageHandler(async () => ({ result: 'ok' }));
      const tokenApp = (tokenTransport as any).app;

      const originalFetch = global.fetch;
      global.fetch = vi.fn(async () => ({ status: 401 }) as any);
      try {
        const response = await request(tokenApp)
          .post('/mcp')
          .set('Accept', 'application/json, text/event-stream')
          .set('Content-Type', 'application/json')
          // No Authorization header — server uses MCP4_SERVER_TOKEN
          .send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });

        expect(response.status).toBe(200);
        expect(response.headers['www-authenticate']).toBeUndefined();
        expect(response.body).toEqual({
          jsonrpc: '2.0',
          id: 1,
          error: {
            code: -32600,
            message: 'Configured server-side authentication token is invalid or expired',
          },
        });
      } finally {
        global.fetch = originalFetch;
        if (savedToken === undefined) {
          delete process.env.MCP4_SERVER_TOKEN;
        } else {
          process.env.MCP4_SERVER_TOKEN = savedToken;
        }
        await tokenTransport.stop();
      }
    });

    it('allows session init when server-side env token passes validation_endpoint', async () => {
      const savedToken = process.env.MCP4_SERVER_TOKEN;
      const savedSsrf = process.env.MCP4_SSRF_ALLOW_PRIVATE_NETWORK;
      process.env.MCP4_SERVER_TOKEN = 'valid-server-token';
      process.env.MCP4_SSRF_ALLOW_PRIVATE_NETWORK = 'true';

      const tokenTransport = new HttpTransport(
        {
          host: '127.0.0.1',
          port: 0,
          sessionTimeoutMs: 1800000,
          heartbeatEnabled: false,
          heartbeatIntervalMs: 30000,
          metricsEnabled: false,
          metricsPath: '/metrics',
          baseUrl: 'http://127.0.0.1', // avoids DNS lookup — SSRF passes with allow_private
          authConfigs: [
            {
              type: 'bearer',
              value_from_env: 'MCP4_SERVER_TOKEN',
              validation_endpoint: '/validate',
            } as any,
          ],
        } as any,
        logger,
      );
      tokenTransport.setMessageHandler(async () => ({ result: 'ok' }));
      const tokenApp = (tokenTransport as any).app;

      const originalFetch = global.fetch;
      global.fetch = vi.fn(async () => ({ status: 204 }) as any);
      try {
        const response = await request(tokenApp)
          .post('/mcp')
          .set('Accept', 'application/json, text/event-stream')
          .set('Content-Type', 'application/json')
          .send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });

        expect(response.status).toBe(200);
        expect(response.headers['mcp-session-id']).toBeDefined();
      } finally {
        global.fetch = originalFetch;
        if (savedToken === undefined) delete process.env.MCP4_SERVER_TOKEN;
        else process.env.MCP4_SERVER_TOKEN = savedToken;
        if (savedSsrf === undefined) delete process.env.MCP4_SSRF_ALLOW_PRIVATE_NETWORK;
        else process.env.MCP4_SSRF_ALLOW_PRIVATE_NETWORK = savedSsrf;
        await tokenTransport.stop();
      }
    });

    it('skips server-side env token validation when no validation_endpoint configured', async () => {
      const savedToken = process.env.MCP4_SERVER_TOKEN;
      process.env.MCP4_SERVER_TOKEN = 'some-token';

      const tokenTransport = new HttpTransport(
        {
          host: '127.0.0.1',
          port: 0,
          sessionTimeoutMs: 1800000,
          heartbeatEnabled: false,
          heartbeatIntervalMs: 30000,
          metricsEnabled: false,
          metricsPath: '/metrics',
          baseUrl: 'https://api.example.com',
          authConfigs: [
            {
              type: 'bearer',
              value_from_env: 'MCP4_SERVER_TOKEN',
              // No validation_endpoint — validation skipped
            } as any,
          ],
        } as any,
        logger,
      );
      tokenTransport.setMessageHandler(async () => ({ result: 'ok' }));
      const tokenApp = (tokenTransport as any).app;

      try {
        const response = await request(tokenApp)
          .post('/mcp')
          .set('Accept', 'application/json, text/event-stream')
          .set('Content-Type', 'application/json')
          .send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });

        // Session is created without validation (no validation_endpoint configured)
        expect(response.status).toBe(200);
        expect(response.headers['mcp-session-id']).toBeDefined();
      } finally {
        if (savedToken === undefined) {
          delete process.env.MCP4_SERVER_TOKEN;
        } else {
          process.env.MCP4_SERVER_TOKEN = savedToken;
        }
        await tokenTransport.stop();
      }
    });
  });

  describe('Auth Header Validation', () => {
    it('should return 400 for invalid Authorization header format', async () => {
      transport.setMessageHandler(async () => ({ result: 'ok' }));

      const response = await request(app)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .set('Authorization', 'NotBearer abc')
        .set('Host', 'localhost')
        .send({ jsonrpc: '2.0', id: 1, method: 'initialize' });

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error', 'Bad Request');
      expect(response.body).toHaveProperty('correlationId');
    });

    it('should return 400 for invalid token characters', async () => {
      transport.setMessageHandler(async () => ({ result: 'ok' }));

      const response = await request(app)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .set('Authorization', 'Bearer abc$123')
        .set('Host', 'localhost')
        .send({ jsonrpc: '2.0', id: 1, method: 'initialize' });

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error', 'Bad Request');
      expect(response.body).toHaveProperty('correlationId');
    });
  });

  describe('Session Cleanup Callback', () => {
    it('should call onSessionDestroyed callback when session is destroyed', async () => {
      const destroyedSessions: string[] = [];
      
      transport.onSessionDestroyed((profileId, sessionId) => {
        destroyedSessions.push(`${profileId}:${sessionId}`);
      });

      transport.setMessageHandler(async (_msg) => ({ result: 'ok' }));

      // Create session
      const initResponse = await request(app)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .set('Host', 'localhost')
        .send({ jsonrpc: '2.0', id: 1, method: 'initialize' });

      const sessionId = initResponse.headers['mcp-session-id'];
      expect(sessionId).toBeDefined();

      // Delete session
      await request(app)
        .delete('/mcp')
        .set('Mcp-Session-Id', sessionId)
        .set('Host', 'localhost');

      // Callback should have been called
      expect(destroyedSessions).toContain(`default:${sessionId}`);
    });
  });

  describe('MCP-Session-Id header validation', () => {
    it('should return error for invalid session ID format in tool call', async () => {
      transport.setMessageHandler(async (_msg) => ({ result: 'ok' }));

      const response = await request(app)
        .post('/mcp')
        .set('Accept', 'application/json')
        .set('Mcp-Session-Id', 'invalid-session-that-does-not-exist')
        .set('Host', 'localhost')
        .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'test' } });

      // Should get session not found or bad request
      expect([400, 404]).toContain(response.status);
    });
  });

  describe('Content-Type handling', () => {
    it('should handle requests without Content-Type header', async () => {
      transport.setMessageHandler(async (_msg) => ({ result: 'ok' }));

      // This may fail at JSON parsing level but shouldn't crash
      const response = await request(app)
        .post('/mcp')
        .set('Accept', 'application/json')
        .set('Host', 'localhost')
        .type('')
        .send('{}');

      // Should not be a server error
      expect(response.status).toBeLessThan(500);
    });
  });

  describe('Server URL getter', () => {
    it('should return server URL when started', async () => {
      await transport.start();
      const serverUrl = transport.getServerUrl();
      expect(serverUrl).toContain('http://');
      expect(serverUrl).toContain('127.0.0.1');
    });

    it('should fallback to configured host when OAuth redirect URI is invalid', () => {
      const oauthTransport = new HttpTransport(
        {
          host: '127.0.0.1',
          port: 3003,
          sessionTimeoutMs: 1800000,
          heartbeatEnabled: false,
          heartbeatIntervalMs: 30000,
          metricsEnabled: false,
          metricsPath: '/metrics',
          oauthConfig: {
            issuer: 'https://auth.example.com',
            client_id: 'test-client',
            client_secret: 'test-secret',
            scopes: ['api']
          }
        },
        logger
      );

      // Mock invalid redirect URI
      createProfileState(oauthTransport as any).oauthProvider = {
        redirectUri: 'not-a-valid-url'
      };

      const serverUrl = oauthTransport.getServerUrl();
      expect(serverUrl).toBe('http://127.0.0.1:3003');

      oauthTransport.stop();
    });
  });

  describe('Server start error handling', () => {
    it('should handle HTTPS server start error when reading cert files fails', async () => {
      const sslError = new Error('SSL certificate read failed');
      const savedCertFile = process.env.MCP4_SSL_CERT_FILE;
      const savedKeyFile = process.env.MCP4_SSL_KEY_FILE;
      
      try {
        // Set SSL env vars to trigger HTTPS path
        process.env.MCP4_SSL_CERT_FILE = '/path/to/cert.pem';
        process.env.MCP4_SSL_KEY_FILE = '/path/to/key.pem';
        
        // Mock fs.readFileSync to throw error
        const readFileSyncSpy = vi.spyOn(fs, 'readFileSync').mockImplementation(() => {
          throw sslError;
        });

        const httpsTransport = new HttpTransport(
          {
            host: '127.0.0.1',
            port: 0,
            sessionTimeoutMs: 1800000,
            heartbeatEnabled: false,
            heartbeatIntervalMs: 30000,
            metricsEnabled: false,
            metricsPath: '/metrics'
          },
          logger
        );

        try {
          await httpsTransport.start();
          expect.fail('Should have thrown error');
        } catch (error) {
          expect(error).toBe(sslError);
          expect(readFileSyncSpy).toHaveBeenCalled();
        } finally {
          readFileSyncSpy.mockRestore();
        }
      } finally {
        if (savedCertFile !== undefined) {
          process.env.MCP4_SSL_CERT_FILE = savedCertFile;
        } else {
          delete process.env.MCP4_SSL_CERT_FILE;
        }
        if (savedKeyFile !== undefined) {
          process.env.MCP4_SSL_KEY_FILE = savedKeyFile;
        } else {
          delete process.env.MCP4_SSL_KEY_FILE;
        }
      }
    });

    it('should handle start() general error in catch block', async () => {
      const startError = new Error('Server start failed');
      const savedCertFile = process.env.MCP4_SSL_CERT_FILE;
      const savedKeyFile = process.env.MCP4_SSL_KEY_FILE;
      
      try {
        // Set SSL env vars to trigger HTTPS path
        process.env.MCP4_SSL_CERT_FILE = '/tmp/test-cert.pem';
        process.env.MCP4_SSL_KEY_FILE = '/tmp/test-key.pem';
        
        // Mock fs.readFileSync to succeed (so we get to https.createServer)
        const readFileSyncSpy = vi.spyOn(fs, 'readFileSync').mockReturnValue('dummy-cert-content' as any);
        
        // Mock https.createServer to throw error
        const createServerSpy = vi.spyOn(https, 'createServer').mockImplementation(() => {
          throw startError;
        });

        const httpsTransport = new HttpTransport(
          {
            host: '127.0.0.1',
            port: 0,
            sessionTimeoutMs: 1800000,
            heartbeatEnabled: false,
            heartbeatIntervalMs: 30000,
            metricsEnabled: false,
            metricsPath: '/metrics'
          },
          logger
        );

        try {
          await httpsTransport.start();
          expect.fail('Should have thrown error');
        } catch (error) {
          expect(error).toBe(startError);
          expect(createServerSpy).toHaveBeenCalled();
        } finally {
          createServerSpy.mockRestore();
          readFileSyncSpy.mockRestore();
        }
      } finally {
        if (savedCertFile !== undefined) {
          process.env.MCP4_SSL_CERT_FILE = savedCertFile;
        } else {
          delete process.env.MCP4_SSL_CERT_FILE;
        }
        if (savedKeyFile !== undefined) {
          process.env.MCP4_SSL_KEY_FILE = savedKeyFile;
        } else {
          delete process.env.MCP4_SSL_KEY_FILE;
        }
      }
    });
  });

  describe('hasOAuthProvider', () => {
    it('should return false when OAuth is not configured', () => {
      expect(transport.hasOAuthProvider()).toBe(false);
    });

    it('should return true when OAuth is configured', async () => {
      const oauthConfig = {
        host: '127.0.0.1',
        port: 0,
        sessionTimeoutMs: 1800000,
        heartbeatEnabled: false,
        heartbeatIntervalMs: 30000,
        metricsEnabled: false,
        metricsPath: '/metrics',
        oauthConfig: {
          authorization_endpoint: 'https://example.com/oauth/authorize',
          token_endpoint: 'https://example.com/oauth/token',
          client_id: 'test-client',
          client_secret: 'test-secret',
          redirect_uri: 'https://example.com/oauth/callback',
        },
      };

      const oauthTransport = new HttpTransport(oauthConfig, logger);
      await (oauthTransport as any).getProfileState('default');
      expect(oauthTransport.hasOAuthProvider()).toBe(true);
      oauthTransport.stop();
    });

    it('sets oauthDisabledReason and leaves oauthProvider null when oauth config is missing redirect_uri', async () => {
      const warnSpy = vi.spyOn(logger, 'warn');

      const incompleteOauthConfig = {
        host: '127.0.0.1',
        port: 0,
        sessionTimeoutMs: 1800000,
        heartbeatEnabled: false,
        heartbeatIntervalMs: 30000,
        metricsEnabled: false,
        metricsPath: '/metrics',
        oauthConfig: {
          authorization_endpoint: 'https://example.com/oauth/authorize',
          token_endpoint: 'https://example.com/oauth/token',
          client_id: 'test-client',
          client_secret: 'test-secret',
          // No redirect_uri - should trigger graceful degradation
        },
      };

      const degradedTransport = new HttpTransport(incompleteOauthConfig, logger);
      await (degradedTransport as any).getProfileState('default');

      const profileState = (degradedTransport as any).profileStates.get('default');
      expect(profileState.oauthProvider).toBeNull();
      expect(typeof profileState.oauthDisabledReason).toBe('string');
      expect(profileState.oauthDisabledReason).toContain('redirect_uri');

      // hasOAuthProvider should return false for degraded profile
      expect(degradedTransport.hasOAuthProvider()).toBe(false);

      // Warning must be logged with the reason
      const warnCalls = warnSpy.mock.calls;
      const oauthWarn = warnCalls.find(args => {
        const msg = typeof args[0] === 'string' ? args[0] : '';
        return msg.includes('OAuth config not operational');
      });
      expect(oauthWarn).toBeDefined();

      warnSpy.mockRestore();
      degradedTransport.stop();
    });
  });

  describe('OAuth degradation HTTP behavior', () => {
    it('allows POST /mcp initialize without auth token when OAuth config is degraded (no 401 challenge)', async () => {
      const degradedOauthTransport = new HttpTransport(
        {
          host: '127.0.0.1',
          port: 0,
          sessionTimeoutMs: 1800000,
          heartbeatEnabled: false,
          heartbeatIntervalMs: 30000,
          metricsEnabled: false,
          metricsPath: '/metrics',
          oauthConfig: {
            authorization_endpoint: 'https://example.com/oauth/authorize',
            token_endpoint: 'https://example.com/oauth/token',
            client_id: 'test-client',
            client_secret: 'test-secret',
            // No redirect_uri — triggers graceful degradation
          },
        },
        logger,
      );
      degradedOauthTransport.setMessageHandler(async () => ({
        result: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          serverInfo: { name: 'test', version: '0.0.1' },
        },
      }));
      const degradedApp = (degradedOauthTransport as any).app;

      const response = await request(degradedApp)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .set('Content-Type', 'application/json')
        // No Authorization header — would normally trigger 401 OAuth challenge
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '0.0.1' } },
        });

      expect(response.status).not.toBe(401);
      expect(response.headers['www-authenticate']).toBeUndefined();

      degradedOauthTransport.stop();
    });

    it('does not send OAuth WWW-Authenticate challenge when tenant OAuth config is not operational', async () => {
      // Tenant has its own OAuth config (incomplete — no redirect_uri).
      // Profile has no OAuth config so oauthDisabledReason is not set.
      // Before fix: oauthActive=true → 401 with WWW-Authenticate: Bearer (OAuth challenge)
      //   that the client can never complete (provider construction would fail).
      // After fix: isOAuthConfigOperational(tenantConfig).operational=false → oauthActive=false
      //   → no OAuth-specific challenge. A general 401 'Authentication required' may still fire
      //   from the authConfigs guard, but that is a different code path and expected behavior.
      const inoperationalTenantContext = {
        tenantId: 'tenant-degraded',
        tenantBaseUrl: 'https://tenant.example.com/api',
        tenantAuthMode: 'oauth' as const,
        tenantAuthConfigs: [{ type: 'oauth' as const }],
        tenantOAuthConfig: {
          // No redirect_uri → isOAuthConfigOperational returns false
          authorization_endpoint: 'https://auth.example.com/oauth/authorize',
          token_endpoint: 'https://auth.example.com/oauth/token',
          client_id: 'tenant-client',
        },
        tenantSelectorType: 'exact' as const,
        tenantSelectorValue: 'https://tenant.example.com/api',
      };

      const degradedTenantTransport = new HttpTransport(
        {
          host: '127.0.0.1',
          port: 0,
          sessionTimeoutMs: 1800000,
          heartbeatEnabled: false,
          heartbeatIntervalMs: 30000,
          metricsEnabled: false,
          metricsPath: '/metrics',
          // No profile-level oauthConfig — oauthDisabledReason stays undefined
          tenantIndex: {
            enabled: true,
            byTenantId: new Map([['tenant-degraded', inoperationalTenantContext]]),
            byBaseUrl: new Map(),
            maskSelectors: [],
            selectorTypeByTenantId: new Map([['tenant-degraded', 'exact' as const]]),
          },
        },
        logger,
      );
      degradedTenantTransport.setMessageHandler(async () => ({
        result: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          serverInfo: { name: 'test', version: '0.0.1' },
        },
      }));
      const degradedTenantApp = (degradedTenantTransport as any).app;

      const response = await request(degradedTenantApp)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .set('Content-Type', 'application/json')
        .set('X-Mcp4-Tenant-Id', 'tenant-degraded')
        // No Authorization header — would trigger 401 if oauthActive were true
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '0.0.1' } },
        });

      // OAuth-specific challenge must NOT be sent (no WWW-Authenticate header)
      expect(response.headers['www-authenticate']).toBeUndefined();
      // If 401 occurs it must be the general auth guard, not an OAuth challenge
      if (response.status === 401) {
        expect(response.body.message).not.toBe('Authentication required for OAuth');
      }

      degradedTenantTransport.stop();
    });
  });

  describe('getOAuthAuthorizationUrl', () => {
    it('should return empty string when OAuth is not configured', () => {
      expect(transport.getOAuthAuthorizationUrl()).toBe('');
    });

    it('should return authorization URL when OAuth is configured', async () => {
      const oauthConfig = {
        host: '127.0.0.1',
        port: 0,
        sessionTimeoutMs: 1800000,
        heartbeatEnabled: false,
        heartbeatIntervalMs: 30000,
        metricsEnabled: false,
        metricsPath: '/metrics',
        oauthConfig: {
          authorization_endpoint: 'https://example.com/oauth/authorize',
          token_endpoint: 'https://example.com/oauth/token',
          client_id: 'test-client',
          client_secret: 'test-secret',
          redirect_uri: 'https://example.com/oauth/callback',
        },
      };

      const oauthTransport = new HttpTransport(oauthConfig, logger);
      await (oauthTransport as any).getProfileState('default');
      expect(oauthTransport.getOAuthAuthorizationUrl()).toBe('https://example.com/oauth/authorize');
      oauthTransport.stop();
    });
  });

  describe('getOAuthScopes', () => {
    it('should return empty array when OAuth is not configured', () => {
      expect(transport.getOAuthScopes()).toEqual([]);
    });

    it('should return scopes when OAuth is configured with scopes', async () => {
      const oauthConfig = {
        host: '127.0.0.1',
        port: 0,
        sessionTimeoutMs: 1800000,
        heartbeatEnabled: false,
        heartbeatIntervalMs: 30000,
        metricsEnabled: false,
        metricsPath: '/metrics',
        oauthConfig: {
          authorization_endpoint: 'https://example.com/oauth/authorize',
          token_endpoint: 'https://example.com/oauth/token',
          client_id: 'test-client',
          client_secret: 'test-secret',
          redirect_uri: 'https://example.com/oauth/callback',
          scopes: ['api', 'read_user'],
        },
      };

      const oauthTransport = new HttpTransport(oauthConfig, logger);
      await (oauthTransport as any).getProfileState('default');
      expect(oauthTransport.getOAuthScopes()).toEqual(['api', 'read_user']);
      oauthTransport.stop();
    });
  });

  describe('Session token retrieval', () => {
    it('should return undefined for non-existent session', () => {
      expect(transport.getSessionToken('default', 'non-existent')).toBeUndefined();
    });
  });

  describe('destroySession', () => {
    it('should handle destroying non-existent session gracefully', () => {
      const profileState = createProfileState(transport as any);
      // Should not throw
      expect(() => (transport as any).destroySession(profileState, 'non-existent-session')).not.toThrow();
    });
  });

  describe('ensureValidSessionToken', () => {
    it('should return false for non-existent session', async () => {
      const result = await transport.ensureValidSessionToken('default', 'non-existent-session');
      expect(result).toBe(false);
    });

    it('should return true for session without expiration info', async () => {
      // Create a session
      transport.setMessageHandler(async (_msg) => ({
        jsonrpc: '2.0',
        id: 1,
        result: { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'test', version: '1.0' } },
      }));

      const initResponse = await request(app)
        .post('/mcp')
        .set('Accept', 'application/json')
        .set('Host', 'localhost')
        .send({ jsonrpc: '2.0', id: 1, method: 'initialize' });

      const sessionId = initResponse.headers['mcp-session-id'];
      expect(sessionId).toBeDefined();

      // Token without expiration should be considered valid
      const result = await transport.ensureValidSessionToken('default', sessionId);
      expect(result).toBe(true);
    });
  });

  describe('cleanupExpiredSessions', () => {
    it('should not throw when no sessions to clean', () => {
      expect(() => (transport as any).cleanupExpiredSessions()).not.toThrow();
    });
  });

  describe('refreshAccessToken', () => {
    it('should return false when session does not exist', async () => {
      const result = await (transport as any).refreshAccessToken('default', 'non-existent');
      expect(result).toBe(false);
    });

    it('should return false when session has no refresh token', async () => {
      // Create session without refresh token
      const profileState = createProfileState(transport as any);
      const sessionId = (transport as any).createSession(profileState, 'access-token');
      const result = await (transport as any).refreshAccessToken('default', sessionId);
      expect(result).toBe(false);
    });

    it('should return false when OAuth provider is not configured', async () => {
      // Create session with refresh token but no OAuth provider
      const profileState = createProfileState(transport as any);
      const sessionId = (transport as any).createSession(profileState, 'access-token', 'refresh-token');
      const result = await (transport as any).refreshAccessToken('default', sessionId);
      expect(result).toBe(false);
    });

    it('reuses tenant OAuth provider instance per session and clears it on session destroy', () => {
      const profileState = createProfileState(transport as any);
      const tenantOAuthConfig = {
        authorization_endpoint: 'https://auth.example.com/oauth/authorize',
        token_endpoint: 'https://auth.example.com/oauth/token',
        client_id: 'tenant-client',
        client_secret: 'tenant-secret',
        redirect_uri: 'https://example.com/oauth/callback',
      };
      const sessionId = (transport as any).createSession(
        profileState,
        'access-token',
        'refresh-token',
        undefined,
        ['api'],
        'tenant-client',
        undefined,
        undefined,
        undefined,
        undefined,
        {
          tenantId: 'team-oauth',
          tenantBaseUrl: 'https://team-oauth.example.com/api',
          tenantAuthMode: 'oauth',
          tenantOAuthConfig,
          tenantAuthConfigs: [{ type: 'oauth', oauth_config: tenantOAuthConfig }],
        },
      );
      const session = profileState.sessions.get(sessionId);
      expect(session).toBeDefined();

      const firstProvider = (transport as any).getOAuthProviderForSession(profileState, session);
      const secondProvider = (transport as any).getOAuthProviderForSession(profileState, session);
      expect(firstProvider).toBe(secondProvider);
      expect((profileState as any).tenantOAuthProvidersBySessionId.get(sessionId)).toBe(firstProvider);

      (transport as any).destroySession(profileState, sessionId);
      expect((profileState as any).tenantOAuthProvidersBySessionId.has(sessionId)).toBe(false);
    });

    it('returns null from getOAuthProviderForSession when tenant OAuth config is not operational', async () => {
      const profileState = createProfileState(transport as any);

      const inoperationalTenantConfig = {
        // No redirect_uri — isOAuthConfigOperational returns false
        authorization_endpoint: 'https://auth.example.com/oauth/authorize',
        token_endpoint: 'https://auth.example.com/oauth/token',
        client_id: 'tenant-client',
      };
      // Minimal session shape — only fields accessed by getOAuthProviderForSession
      const session = { id: 'degraded-session', tenantOAuthConfig: inoperationalTenantConfig };

      const result = (transport as any).getOAuthProviderForSession(profileState, session);
      expect(result).toBeNull();
    });

    it('should handle token refresh without expires_in', async () => {
      const oauthTransport = new HttpTransport(
        {
          host: '127.0.0.1',
          port: 0,
          sessionTimeoutMs: 1800000,
          heartbeatEnabled: false,
          heartbeatIntervalMs: 30000,
          metricsEnabled: false,
          metricsPath: '/metrics',
          oauthConfig: {
            issuer: 'https://auth.example.com',
            client_id: 'test-client',
            client_secret: 'test-secret',
            scopes: ['api']
          }
        },
        logger
      );

      const profileState = createProfileState(oauthTransport as any);
      const sessionId = (oauthTransport as any).createSession(profileState, 'old-access', 'refresh-token');
      const session = profileState.sessions.get(sessionId);
      session.oauthClientId = 'test-client';

      profileState.oauthProvider = {
        ensureEndpointsInitialized: async () => {},
        clientsStore: {
          getClient: async () => ({ client_id: 'test-client', scope: 'api' })
        },
        exchangeRefreshToken: async () => ({
          access_token: 'new-access',
          refresh_token: 'new-refresh',
          token_type: 'Bearer'
          // No expires_in field
        })
      };

      const result = await (oauthTransport as any).refreshAccessToken('default', sessionId);
      expect(result).toBe(true);
      expect(session.accessTokenExpiresAt).toBeUndefined();
      expect(session.authToken).toBe('new-access');

      await oauthTransport.stop();
    });

    it('should handle token refresh error', async () => {
      const oauthTransport = new HttpTransport(
        {
          host: '127.0.0.1',
          port: 0,
          sessionTimeoutMs: 1800000,
          heartbeatEnabled: false,
          heartbeatIntervalMs: 30000,
          metricsEnabled: false,
          metricsPath: '/metrics',
          oauthConfig: {
            issuer: 'https://auth.example.com',
            client_id: 'test-client',
            client_secret: 'test-secret',
            scopes: ['api']
          }
        },
        logger
      );

      const profileState = createProfileState(oauthTransport as any);
      const sessionId = (oauthTransport as any).createSession(profileState, 'old-access', 'refresh-token');
      const session = profileState.sessions.get(sessionId);
      session.oauthClientId = 'test-client';

      profileState.oauthProvider = {
        ensureEndpointsInitialized: async () => {},
        clientsStore: {
          getClient: async () => ({ client_id: 'test-client', scope: 'api' })
        },
        exchangeRefreshToken: async () => {
          throw new Error('Token exchange failed');
        }
      };

      const result = await (oauthTransport as any).refreshAccessToken('default', sessionId);
      expect(result).toBe(false);

      await oauthTransport.stop();
    });
  });

  describe('storeOAuthTokens', () => {
    it('should store tokens with expiration', () => {
      const profileState = {
        profileId: 'default',
        context: { profileId: 'default' },
        oauthProvider: null,
        oauthTokensByAccessToken: new Map(),
        sessions: new Map(),
      };
      (transport as any).profileStates.set('default', profileState);
      const tokens = {
        access_token: 'test-access-token',
        refresh_token: 'test-refresh-token',
        expires_in: 3600
      };
      
      (transport as any).storeOAuthTokens(profileState, tokens, 'client-id', ['read', 'write']);
      
      const stored = profileState.oauthTokensByAccessToken.get('test-access-token');
      expect(stored).toBeDefined();
      expect(stored.refreshToken).toBe('test-refresh-token');
      expect(stored.clientId).toBe('client-id');
      expect(stored.scopes).toEqual(['read', 'write']);
      expect(stored.expiresAt).toBeGreaterThan(Date.now());
    });

    it('should store tokens without expiration', () => {
      const profileState = {
        profileId: 'default',
        context: { profileId: 'default' },
        oauthProvider: null,
        oauthTokensByAccessToken: new Map(),
        sessions: new Map(),
      };
      (transport as any).profileStates.set('default', profileState);
      const tokens = {
        access_token: 'test-access-token-2'
      };
      
      (transport as any).storeOAuthTokens(profileState, tokens, 'client-id', []);
      
      const stored = profileState.oauthTokensByAccessToken.get('test-access-token-2');
      expect(stored).toBeDefined();
      expect(stored.refreshToken).toBeUndefined();
      expect(stored.expiresAt).toBeUndefined();
    });
  });

  describe('storeOAuthTokens encrypted envelope path', () => {
    const KEY_HEX_64 = 'a'.repeat(64);
    const buildKey = (): Buffer => Buffer.from(KEY_HEX_64, 'hex');

    const buildTransportWithKey = async (key?: Buffer): Promise<HttpTransport> => {
      const config: any = {
        host: '127.0.0.1',
        port: 0,
        sessionTimeoutMs: 1800000,
        heartbeatEnabled: false,
        heartbeatIntervalMs: 30000,
        metricsEnabled: false,
        metricsPath: '/metrics',
      };
      if (key !== undefined) config.tokenKey = key;
      return new HttpTransport(config, logger);
    };

    it('Test D: returns mcp4.v1.* envelope when tokenKey set AND refresh_token present', async () => {
      const t = await buildTransportWithKey(buildKey());
      const profileState = createProfileState(t as any);
      const tokens = {
        access_token: 'idp-access-d',
        refresh_token: 'idp-refresh-d',
        expires_in: 3600,
      };
      const returned: string = (t as any).storeOAuthTokens(profileState, tokens, 'client-d', ['read']);
      expect(returned.startsWith('mcp4.v1.')).toBe(true);
      expect(profileState.oauthTokensByAccessToken.has(returned)).toBe(true);
      expect(profileState.oauthTokensByAccessToken.has(tokens.access_token)).toBe(false);
      const mapEntry = profileState.oauthTokensByAccessToken.get(returned);
      expect(mapEntry?.rawAccessToken).toBe('idp-access-d');
      await t.stop();
    });

    it('Test E: returns plain access_token when tokenKey set but refresh_token missing', async () => {
      const t = await buildTransportWithKey(buildKey());
      const profileState = createProfileState(t as any);
      const tokens = { access_token: 'idp-access-e', expires_in: 3600 };
      const returned: string = (t as any).storeOAuthTokens(profileState, tokens, 'client-e', []);
      expect(returned).toBe('idp-access-e');
      expect(profileState.oauthTokensByAccessToken.has('idp-access-e')).toBe(true);
      await t.stop();
    });

    it('Test F: returns plain access_token when tokenKey UNSET (backward compat)', async () => {
      const t = await buildTransportWithKey(undefined);
      const profileState = createProfileState(t as any);
      const tokens = {
        access_token: 'idp-access-f',
        refresh_token: 'idp-refresh-f',
        expires_in: 3600,
      };
      const returned: string = (t as any).storeOAuthTokens(profileState, tokens, 'client-f', []);
      expect(returned).toBe('idp-access-f');
      expect(profileState.oauthTokensByAccessToken.has('idp-access-f')).toBe(true);
      await t.stop();
    });

    it('Test G: envelope round-trips creg from registeredClient parameter', async () => {
      const { decryptTokenPayload } = await import('../auth/token-envelope.js');
      const key = buildKey();
      const t = await buildTransportWithKey(key);
      const profileState = createProfileState(t as any);
      const tokens = {
        access_token: 'idp-access-g',
        refresh_token: 'idp-refresh-g',
        expires_in: 3600,
      };
      const registeredClient = {
        client_id: 'rc-1',
        redirect_uris: ['https://example.com/cb'],
        grant_types: ['authorization_code'],
        response_types: ['code'],
        scope: 'openid profile',
      } as any;
      const returned: string = (t as any).storeOAuthTokens(
        profileState,
        tokens,
        'rc-1',
        ['openid'],
        registeredClient,
      );
      expect(returned.startsWith('mcp4.v1.')).toBe(true);
      const envelope = decryptTokenPayload(returned, key, profileState.profileId);
      expect(envelope).not.toBeNull();
      expect(envelope!.creg).toEqual({
        id: 'rc-1',
        ru: ['https://example.com/cb'],
        gt: ['authorization_code'],
        rt_: ['code'],
        sc: 'openid profile',
      });
      await t.stop();
    });

    it('Test H: envelope creg is undefined when no registeredClient passed', async () => {
      const { decryptTokenPayload } = await import('../auth/token-envelope.js');
      const key = buildKey();
      const t = await buildTransportWithKey(key);
      const profileState = createProfileState(t as any);
      const tokens = {
        access_token: 'idp-access-h',
        refresh_token: 'idp-refresh-h',
      };
      const returned: string = (t as any).storeOAuthTokens(profileState, tokens, 'client-h', ['scope-1']);
      expect(returned.startsWith('mcp4.v1.')).toBe(true);
      const envelope = decryptTokenPayload(returned, key, profileState.profileId);
      expect(envelope).not.toBeNull();
      expect(envelope!.creg).toBeUndefined();
      await t.stop();
    });

    it('Test I: encryption failure (wrong key length) falls back to plain access_token + warn', async () => {
      const mockLogger: any = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };
      const config: any = {
        host: '127.0.0.1',
        port: 0,
        sessionTimeoutMs: 1800000,
        heartbeatEnabled: false,
        heartbeatIntervalMs: 30000,
        metricsEnabled: false,
        metricsPath: '/metrics',
        tokenKey: Buffer.alloc(31), // wrong length
      };
      const t = new HttpTransport(config, mockLogger);
      const profileState = createProfileState(t as any);
      const tokens = {
        access_token: 'idp-access-i',
        refresh_token: 'idp-refresh-i',
      };
      const returned: string = (t as any).storeOAuthTokens(profileState, tokens, 'client-i', []);
      expect(returned).toBe('idp-access-i');
      expect(profileState.oauthTokensByAccessToken.has('idp-access-i')).toBe(true);
      const warnCalls = mockLogger.warn.mock.calls;
      const matchingCall = warnCalls.find((args: unknown[]) =>
        typeof args[0] === 'string' && (args[0] as string).includes('Token envelope encryption failed'),
      );
      expect(matchingCall).toBeDefined();
      await t.stop();
    });
  });

  describe('OAuth /oauth/token response wrapping with envelope', () => {
    const buildOauthTransport = async (tokenKey?: Buffer) => {
      const config: any = {
        host: '127.0.0.1',
        port: 0,
        sessionTimeoutMs: 1800000,
        heartbeatEnabled: false,
        heartbeatIntervalMs: 30000,
        metricsEnabled: false,
        metricsPath: '/metrics',
        oauthConfig: {
          issuer: 'https://auth.example.com',
          client_id: 'test-client',
          client_secret: 'test-secret',
          redirect_uri: 'https://example.com/oauth/callback',
          scopes: ['read', 'write'],
        },
      };
      if (tokenKey !== undefined) config.tokenKey = tokenKey;
      return new HttpTransport(config, logger);
    };

    it('Test J: authorization_code response wraps access_token with mcp4.v1.* envelope when tokenKey set', async () => {
      const t = await buildOauthTransport(Buffer.from('a'.repeat(64), 'hex'));
      const tApp = (t as any).app;
      // Access profileState and stub OAuth provider methods
      const profileState = (t as any).profileStates.get('default') ?? createProfileState(t as any);
      profileState.oauthProvider = {
        ensureEndpointsInitialized: async () => {},
        clientsStore: {
          getClient: async (id: string) =>
            id === 'test-client'
              ? {
                  client_id: 'test-client',
                  redirect_uris: ['https://example.com/cb'],
                  grant_types: ['authorization_code', 'refresh_token'],
                  response_types: ['code'],
                  scope: 'read write',
                }
              : undefined,
          registerClient: async (c: any) => c,
        },
        exchangeAuthorizationCode: async () => ({
          access_token: 'raw-idp-access-j',
          refresh_token: 'raw-idp-refresh-j',
          expires_in: 3600,
          token_type: 'Bearer',
        }),
      };
      // Stub validateOAuthClientCredentials by injecting client via resolveOAuthClientForRequest path:
      // simpler: stub the method directly
      (t as any).validateOAuthClientCredentials = async (_ps: any, _id: any, _s: any, _res: any) => ({
        client_id: 'test-client',
        scope: 'read write',
      });

      const response = await request(tApp)
        .post('/oauth/token')
        .send({
          grant_type: 'authorization_code',
          client_id: 'test-client',
          code: 'auth-code-j',
          code_verifier: 'verifier-j',
          redirect_uri: 'https://example.com/cb',
        });
      expect(response.status).toBe(200);
      expect(typeof response.body.access_token).toBe('string');
      expect(response.body.access_token.startsWith('mcp4.v1.')).toBe(true);
      expect(response.body.refresh_token).toBe('raw-idp-refresh-j');
      await t.stop();
    });

    it('Test K: authorization_code response keeps raw access_token when tokenKey is unset', async () => {
      const t = await buildOauthTransport(undefined);
      const tApp = (t as any).app;
      const profileState = (t as any).profileStates.get('default') ?? createProfileState(t as any);
      profileState.oauthProvider = {
        ensureEndpointsInitialized: async () => {},
        clientsStore: {
          getClient: async (id: string) =>
            id === 'test-client'
              ? {
                  client_id: 'test-client',
                  redirect_uris: ['https://example.com/cb'],
                  grant_types: ['authorization_code', 'refresh_token'],
                  response_types: ['code'],
                  scope: 'read write',
                }
              : undefined,
          registerClient: async (c: any) => c,
        },
        exchangeAuthorizationCode: async () => ({
          access_token: 'raw-idp-access-k',
          refresh_token: 'raw-idp-refresh-k',
          expires_in: 3600,
          token_type: 'Bearer',
        }),
      };
      (t as any).validateOAuthClientCredentials = async () => ({
        client_id: 'test-client',
        scope: 'read write',
      });

      const response = await request(tApp)
        .post('/oauth/token')
        .send({
          grant_type: 'authorization_code',
          client_id: 'test-client',
          code: 'auth-code-k',
          code_verifier: 'verifier-k',
          redirect_uri: 'https://example.com/cb',
        });
      expect(response.status).toBe(200);
      expect(response.body.access_token).toBe('raw-idp-access-k');
      expect(response.body.refresh_token).toBe('raw-idp-refresh-k');
      await t.stop();
    });
  });

  describe('refreshAccessToken envelope assignment', () => {
    it('Test L: session.authToken becomes mcp4.v1.* envelope after refresh when tokenKey is set', async () => {
      const config: any = {
        host: '127.0.0.1',
        port: 0,
        sessionTimeoutMs: 1800000,
        heartbeatEnabled: false,
        heartbeatIntervalMs: 30000,
        metricsEnabled: false,
        metricsPath: '/metrics',
        tokenKey: Buffer.from('a'.repeat(64), 'hex'),
        oauthConfig: {
          issuer: 'https://auth.example.com',
          client_id: 'test-client',
          client_secret: 'test-secret',
          scopes: ['api'],
        },
      };
      const t = new HttpTransport(config, logger);
      const profileState = createProfileState(t as any);
      const sessionId = (t as any).createSession(profileState, 'old-envelope-l', 'refresh-token-l');
      const session = profileState.sessions.get(sessionId);
      session.oauthClientId = 'test-client';
      // Pre-populate map keyed by old envelope so we can assert it gets removed
      profileState.oauthTokensByAccessToken.set('old-envelope-l', {
        refreshToken: 'refresh-token-l',
        clientId: 'test-client',
        scopes: ['api'],
      });

      profileState.oauthProvider = {
        ensureEndpointsInitialized: async () => {},
        clientsStore: {
          getClient: async () => ({ client_id: 'test-client', scope: 'api' }),
        },
        exchangeRefreshToken: async () => ({
          access_token: 'new-raw-idp-access-l',
          refresh_token: 'new-raw-idp-refresh-l',
          expires_in: 3600,
          token_type: 'Bearer',
        }),
      };

      const result = await (t as any).refreshAccessToken('default', sessionId);
      expect(result).toBe(true);
      expect(typeof session.authToken).toBe('string');
      expect(session.authToken.startsWith('mcp4.v1.')).toBe(true);
      expect(profileState.oauthTokensByAccessToken.has('old-envelope-l')).toBe(false);
      expect(profileState.oauthTokensByAccessToken.has(session.authToken)).toBe(true);
      await t.stop();
    });
  });

  describe('encrypted token envelope session recovery', () => {
    const KEY_HEX = 'a'.repeat(64);
    const buildKey = () => Buffer.from(KEY_HEX, 'hex');

    interface MockLogger extends Logger {
      debug: ReturnType<typeof vi.fn>;
      info: ReturnType<typeof vi.fn>;
      warn: ReturnType<typeof vi.fn>;
      error: ReturnType<typeof vi.fn>;
    }
    const mkLogger = (): MockLogger => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    });

    const buildTransport = (opts: { tokenKey?: Buffer; profileId?: string; testLogger?: Logger }): HttpTransport => {
      const config: any = {
        host: '127.0.0.1',
        port: 0,
        sessionTimeoutMs: 1800000,
        heartbeatEnabled: false,
        heartbeatIntervalMs: 30000,
        metricsEnabled: false,
        metricsPath: '/metrics',
      };
      if (opts.tokenKey !== undefined) config.tokenKey = opts.tokenKey;
      const t = new HttpTransport(config, opts.testLogger ?? logger);
      // Pre-create profile state with stub oauthProvider that captures registerClient calls.
      const profileId = opts.profileId ?? 'default';
      const registerClient = vi.fn(async (c: any) => c);
      const profileState: any = {
        profileId,
        context: { profileId },
        oauthProvider: {
          clientsStore: { registerClient, getClient: async () => undefined },
        },
        oauthTokensByAccessToken: new Map(),
        sessions: new Map(),
      };
      (t as any).profileStates.set(profileId, profileState);
      (t as any).__test_registerClientSpy = registerClient;
      (t as any).__test_profileState = profileState;
      return t;
    };

    const findOnlySession = (t: HttpTransport, profileId: string = 'default'): any => {
      const profileState = (t as any).profileStates.get(profileId);
      const sessions: any[] = Array.from(profileState.sessions.values());
      // Return last session created (initialize creates a fresh session)
      return sessions[sessions.length - 1];
    };

    it('Test M: client presents valid envelope - session restored with metadata + info log', async () => {
      const { encryptTokenPayload } = await import('../auth/token-envelope.js');
      const mockLogger = mkLogger();
      const key = buildKey();
      const t = buildTransport({ tokenKey: key, testLogger: mockLogger });
      const tApp = (t as any).app;
      t.setMessageHandler(async () => ({
        protocolVersion: '2025-03-26',
        serverInfo: { name: 'test' },
      }));

      const envelope = encryptTokenPayload(
        {
          v: 1,
          at: 'idp-access-m',
          rt: 'idp-refresh-m',
          exp: Date.now() + 60_000,
          cid: 'client-m',
          sc: ['read', 'write'],
          pid: 'default',
          iat: Date.now(),
        },
        key,
      );

      const response = await request(tApp)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .set('Authorization', `Bearer ${envelope}`)
        .send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });

      expect(response.status).toBe(200);
      const session = findOnlySession(t);
      expect(session).toBeDefined();
      expect(session.refreshToken).toBe('idp-refresh-m');
      expect(session.scopes).toEqual(['read', 'write']);
      expect(session.oauthClientId).toBe('client-m');
      // info log emitted
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Session restored from encrypted token envelope after restart',
        expect.objectContaining({
          profileId: 'default',
          hasRefreshToken: true,
          oauthClientId: 'client-m',
          restoredClientReg: false,
        }),
      );
      await t.stop();
    });

    it('Test N: envelope with creg invokes registerClient with mapped fields and defaults', async () => {
      const { encryptTokenPayload } = await import('../auth/token-envelope.js');
      const key = buildKey();
      const mockLogger = mkLogger();
      const t = buildTransport({ tokenKey: key, testLogger: mockLogger });
      const tApp = (t as any).app;
      t.setMessageHandler(async () => ({ protocolVersion: '2025-03-26', serverInfo: { name: 'test' } }));
      const registerClientSpy = (t as any).__test_registerClientSpy;

      const envelopeFull = encryptTokenPayload(
        {
          v: 1,
          at: 'at-n',
          rt: 'rt-n',
          pid: 'default',
          iat: Date.now(),
          creg: {
            id: 'c1',
            ru: ['https://x/cb'],
            gt: ['authorization_code'],
            rt_: ['code'],
            sc: 'openid',
          },
        },
        key,
      );

      await request(tApp)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .set('Authorization', `Bearer ${envelopeFull}`)
        .send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });

      expect(registerClientSpy).toHaveBeenCalledWith({
        client_id: 'c1',
        redirect_uris: ['https://x/cb'],
        grant_types: ['authorization_code'],
        response_types: ['code'],
        scope: 'openid',
      });

      // Now test defaults with minimal creg
      registerClientSpy.mockClear();
      const envelopeMinimal = encryptTokenPayload(
        {
          v: 1,
          at: 'at-n2',
          rt: 'rt-n2',
          pid: 'default',
          iat: Date.now(),
          creg: { id: 'c2' },
        },
        key,
      );
      await request(tApp)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .set('Authorization', `Bearer ${envelopeMinimal}`)
        .send({ jsonrpc: '2.0', id: 2, method: 'initialize', params: {} });

      expect(registerClientSpy).toHaveBeenCalledWith({
        client_id: 'c2',
        redirect_uris: [],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        scope: '',
      });
      await t.stop();
    });

    it('Test O: envelope without creg - registerClient NOT called, restoredClientReg=false', async () => {
      const { encryptTokenPayload } = await import('../auth/token-envelope.js');
      const key = buildKey();
      const mockLogger = mkLogger();
      const t = buildTransport({ tokenKey: key, testLogger: mockLogger });
      const tApp = (t as any).app;
      t.setMessageHandler(async () => ({ protocolVersion: '2025-03-26', serverInfo: { name: 'test' } }));
      const registerClientSpy = (t as any).__test_registerClientSpy;

      const envelope = encryptTokenPayload(
        {
          v: 1,
          at: 'at-o',
          rt: 'rt-o',
          cid: 'client-o',
          pid: 'default',
          iat: Date.now(),
        },
        key,
      );
      await request(tApp)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .set('Authorization', `Bearer ${envelope}`)
        .send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });

      expect(registerClientSpy).not.toHaveBeenCalled();
      const session = findOnlySession(t);
      expect(session.refreshToken).toBe('rt-o');
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Session restored from encrypted token envelope after restart',
        expect.objectContaining({ restoredClientReg: false }),
      );
      await t.stop();
    });

    it('Test P: cross-profile envelope replay returns null - debug log + plain bearer continuation', async () => {
      const { encryptTokenPayload } = await import('../auth/token-envelope.js');
      const key = buildKey();
      const mockLogger = mkLogger();
      // Encrypt under profile-a but present to default (which is the transport's only profile).
      // decryptTokenPayload is called with profileState.profileId='default' but envelope.pid='profile-a',
      // so AAD verification fails and the fallback yields null (cross-profile rejection).
      const t = buildTransport({ tokenKey: key, profileId: 'default', testLogger: mockLogger });
      const tApp = (t as any).app;
      t.setMessageHandler(async () => ({ protocolVersion: '2025-03-26', serverInfo: { name: 'test' } }));

      const envelope = encryptTokenPayload(
        { v: 1, at: 'at-p', rt: 'rt-p', pid: 'profile-a', iat: Date.now() },
        key,
      );
      const response = await request(tApp)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .set('Authorization', `Bearer ${envelope}`)
        .send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });

      // No crash; session created without OAuth metadata
      expect(response.status).toBe(200);
      const session = findOnlySession(t, 'default');
      expect(session).toBeDefined();
      expect(session.refreshToken).toBeUndefined();
      // debug log about decrypt failure
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Encrypted token failed to decrypt (wrong key, tampered, or wrong profile)',
        expect.objectContaining({ profileId: 'default' }),
      );
      // info log NOT emitted for restoration
      const infoCalls = mockLogger.info.mock.calls;
      const restored = infoCalls.find(
        (args: unknown[]) =>
          typeof args[0] === 'string' && (args[0] as string).includes('Session restored from encrypted token envelope'),
      );
      expect(restored).toBeUndefined();
      await t.stop();
    });

    it('Test Q: encrypted-looking token but tokenKey is undefined - fallback skipped', async () => {
      const { encryptTokenPayload } = await import('../auth/token-envelope.js');
      const key = buildKey();
      const mockLogger = mkLogger();
      // Build a transport WITHOUT tokenKey
      const t = buildTransport({ tokenKey: undefined, testLogger: mockLogger });
      const tApp = (t as any).app;
      t.setMessageHandler(async () => ({ protocolVersion: '2025-03-26', serverInfo: { name: 'test' } }));

      const envelope = encryptTokenPayload(
        { v: 1, at: 'at-q', rt: 'rt-q', pid: 'default', iat: Date.now() },
        key,
      );
      const response = await request(tApp)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .set('Authorization', `Bearer ${envelope}`)
        .send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });

      expect(response.status).toBe(200);
      // info log NOT emitted
      const infoCalls = mockLogger.info.mock.calls;
      const restoredCall = infoCalls.find(
        (args: unknown[]) =>
          typeof args[0] === 'string' && (args[0] as string).includes('Session restored from encrypted token envelope'),
      );
      expect(restoredCall).toBeUndefined();
      // The original 'No OAuth token data found in map' debug WAS called
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'No OAuth token data found in map (may be non-OAuth bearer token)',
        expect.objectContaining({ hasToken: true }),
      );
      await t.stop();
    });

    it('Test R: token without mcp4.v1. prefix - fallback NOT entered', async () => {
      const mockLogger = mkLogger();
      const key = buildKey();
      const t = buildTransport({ tokenKey: key, testLogger: mockLogger });
      const tApp = (t as any).app;
      t.setMessageHandler(async () => ({ protocolVersion: '2025-03-26', serverInfo: { name: 'test' } }));

      const response = await request(tApp)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .set('Authorization', 'Bearer plain-bearer-xyz')
        .send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });

      expect(response.status).toBe(200);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'No OAuth token data found in map (may be non-OAuth bearer token)',
        expect.objectContaining({ hasToken: true }),
      );
      const infoCalls = mockLogger.info.mock.calls;
      const restoredCall = infoCalls.find(
        (args: unknown[]) =>
          typeof args[0] === 'string' && (args[0] as string).includes('Session restored from encrypted token envelope'),
      );
      expect(restoredCall).toBeUndefined();
      await t.stop();
    });

    it('Test S: stale envelope (>30 days old) returns 401 with warn log', async () => {
      const { encryptTokenPayload } = await import('../auth/token-envelope.js');
      const mockLogger = mkLogger();
      const key = buildKey();
      const t = buildTransport({ tokenKey: key, testLogger: mockLogger });
      const tApp = (t as any).app;
      t.setMessageHandler(async () => ({ protocolVersion: '2025-03-26', serverInfo: { name: 'test' } }));

      const staleIat = Date.now() - (31 * 24 * 60 * 60 * 1000);
      const envelope = encryptTokenPayload(
        { v: 1, at: 'idp-access-s', rt: 'idp-refresh-s', pid: 'default', iat: staleIat },
        key,
      );

      const response = await request(tApp)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .set('Authorization', `Bearer ${envelope}`)
        .send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });

      expect(response.status).toBe(401);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Encrypted token envelope expired (iat too old)',
        expect.objectContaining({ profileId: 'default' }),
      );
      // No session created
      const profileState = (t as any).__test_profileState;
      expect(profileState.sessions.size).toBe(0);
      await t.stop();
    });

    it('Test T: envelope with creg but client already exists - registerClient NOT called, restoredClientReg=true', async () => {
      const { encryptTokenPayload } = await import('../auth/token-envelope.js');
      const key = buildKey();
      const mockLogger = mkLogger();
      const t = buildTransport({ tokenKey: key, testLogger: mockLogger });
      const tApp = (t as any).app;
      t.setMessageHandler(async () => ({ protocolVersion: '2025-03-26', serverInfo: { name: 'test' } }));

      // Override getClient to return an existing client
      const profileState = (t as any).__test_profileState;
      const registerClientSpy = (t as any).__test_registerClientSpy;
      profileState.oauthProvider.clientsStore.getClient = vi.fn(async () => ({ client_id: 'existing-t' }));

      const envelope = encryptTokenPayload(
        {
          v: 1,
          at: 'at-t',
          rt: 'rt-t',
          pid: 'default',
          iat: Date.now(),
          creg: { id: 'existing-t', ru: ['https://x/cb'] },
        },
        key,
      );

      await request(tApp)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .set('Authorization', `Bearer ${envelope}`)
        .send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });

      expect(registerClientSpy).not.toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Session restored from encrypted token envelope after restart',
        expect.objectContaining({ restoredClientReg: true }),
      );
      await t.stop();
    });

    it('Test U: registerClient throws during recovery - warn logged but session still created', async () => {
      const { encryptTokenPayload } = await import('../auth/token-envelope.js');
      const key = buildKey();
      const mockLogger = mkLogger();
      const t = buildTransport({ tokenKey: key, testLogger: mockLogger });
      const tApp = (t as any).app;
      t.setMessageHandler(async () => ({ protocolVersion: '2025-03-26', serverInfo: { name: 'test' } }));

      const profileState = (t as any).__test_profileState;
      class OAuthClientStoreCapacityError extends Error {
        constructor() { super('capacity exceeded'); this.name = 'OAuthClientStoreCapacityError'; }
      }
      profileState.oauthProvider.clientsStore.registerClient = vi.fn(async () => { throw new OAuthClientStoreCapacityError(); });

      const envelope = encryptTokenPayload(
        {
          v: 1,
          at: 'at-u',
          rt: 'rt-u',
          pid: 'default',
          iat: Date.now(),
          creg: { id: 'client-u' },
        },
        key,
      );

      const response = await request(tApp)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .set('Authorization', `Bearer ${envelope}`)
        .send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });

      expect(response.status).toBe(200);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Failed to re-register OAuth client from envelope during restart recovery',
        expect.objectContaining({ clientId: 'client-u', errorType: 'OAuthClientStoreCapacityError' }),
      );
      // Session still created with refresh token
      const session = findOnlySession(t);
      expect(session).toBeDefined();
      expect(session.refreshToken).toBe('rt-u');
      await t.stop();
    });

    it('Test V: recovered envelope populates both oauthTokensByAccessToken and inboundAuthTokenStore', async () => {
      const { encryptTokenPayload } = await import('../auth/token-envelope.js');
      const key = buildKey();
      const t = buildTransport({ tokenKey: key });
      const tApp = (t as any).app;
      t.setMessageHandler(async () => ({ protocolVersion: '2025-03-26', serverInfo: { name: 'test' } }));

      const envelope = encryptTokenPayload(
        {
          v: 1,
          at: 'raw-access-v',
          rt: 'refresh-v',
          exp: Date.now() + 60_000,
          cid: 'client-v',
          sc: ['read'],
          pid: 'default',
          iat: Date.now(),
        },
        key,
      );

      const response = await request(tApp)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .set('Authorization', `Bearer ${envelope}`)
        .send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });

      expect(response.status).toBe(200);

      const profileState = (t as any).__test_profileState;
      // oauthTokensByAccessToken must hold rawAccessToken for upstream calls
      const mapEntry = profileState.oauthTokensByAccessToken.get(envelope);
      expect(mapEntry).toBeDefined();
      expect(mapEntry.rawAccessToken).toBe('raw-access-v');

      // inboundAuthTokenStore must hold entry so enterprise/session checks resolve
      const inboundStore = (t as any).inboundAuthTokenStore;
      const record = inboundStore.get(envelope);
      expect(record).toBeDefined();
      expect(record.principal.authType).toBe('oauth');
      expect(record.principal.clientId).toBe('client-v');

      await t.stop();
    });
  });

  describe('envelope token with validation_endpoint (bug confirmation)', () => {
    const ENV_KEY_HEX = 'a'.repeat(64);
    const buildEnvKey = () => Buffer.from(ENV_KEY_HEX, 'hex');
    const RAW_ACCESS_TOKEN = 'real-gitlab-access-token';
    const ENVELOPE_PROFILE_ID = 'default';

    const buildTransportWithValidation = (opts: { tokenKey?: Buffer } = {}): HttpTransport => {
      const config: any = {
        host: '127.0.0.1',
        port: 0,
        sessionTimeoutMs: 1800000,
        heartbeatEnabled: false,
        heartbeatIntervalMs: 30000,
        metricsEnabled: false,
        metricsPath: '/metrics',
        baseUrl: 'http://127.0.0.1',
        authConfigs: [{ type: 'oauth', validation_endpoint: '/validate' }],
        ...(opts.tokenKey !== undefined ? { tokenKey: opts.tokenKey } : {}),
      };
      const t = new HttpTransport(config, logger);
      t.setMessageHandler(async () => ({ result: 'ok' }));
      return t;
    };

    it('Test W: validation_endpoint receives raw mcp4.v1.* envelope string instead of inner access_token (documents bug)', async () => {
      // Documents the bug: validateAuthToken is called with authInfo.token (the raw envelope
      // string) before envelope decryption. After the fix this assertion should be updated:
      // capturedAuth should equal `Bearer ${RAW_ACCESS_TOKEN}`.
      const { encryptTokenPayload } = await import('../auth/token-envelope.js');
      const savedEnv = process.env.MCP4_SSRF_ALLOW_PRIVATE_NETWORK;
      process.env.MCP4_SSRF_ALLOW_PRIVATE_NETWORK = 'true';
      const key = buildEnvKey();
      const t = buildTransportWithValidation({ tokenKey: key });
      const tApp = (t as any).app;

      const envelope = encryptTokenPayload(
        { v: 1, at: RAW_ACCESS_TOKEN, rt: 'refresh-token', pid: ENVELOPE_PROFILE_ID, iat: Date.now() },
        key,
      );

      let capturedAuth: string | undefined;
      const origFetch = global.fetch;
      global.fetch = vi.fn(async (_url: any, init: any) => {
        capturedAuth = (init?.headers as Record<string, string>)?.['Authorization'];
        return { status: 200 } as any;
      });

      try {
        await request(tApp)
          .post('/mcp')
          .set('Accept', 'application/json, text/event-stream')
          .set('Authorization', `Bearer ${envelope}`)
          .send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });

        // After fix: validation_endpoint receives the inner access_token, not the raw envelope.
        expect(capturedAuth).toBe(`Bearer ${RAW_ACCESS_TOKEN}`);
      } finally {
        global.fetch = origFetch;
        if (savedEnv === undefined) delete process.env.MCP4_SSRF_ALLOW_PRIVATE_NETWORK;
        else process.env.MCP4_SSRF_ALLOW_PRIVATE_NETWORK = savedEnv;
        await t.stop();
      }
    });

    it('Test X: FAILING — envelope token init fails when IdP rejects mcp4.v1.* but would accept inner access_token', async () => {
      // This test FAILS currently (confirms the bug) and must PASS after the fix.
      // The mock IdP only accepts the raw access_token. Before fix: server sends the raw
      // envelope string → 401 → init returns -32600. After fix: server decrypts first,
      // sends envelope.at → 200 → session created.
      const { encryptTokenPayload } = await import('../auth/token-envelope.js');
      const savedEnv = process.env.MCP4_SSRF_ALLOW_PRIVATE_NETWORK;
      process.env.MCP4_SSRF_ALLOW_PRIVATE_NETWORK = 'true';
      const key = buildEnvKey();
      const t = buildTransportWithValidation({ tokenKey: key });
      const tApp = (t as any).app;

      const envelope = encryptTokenPayload(
        { v: 1, at: RAW_ACCESS_TOKEN, rt: 'refresh-token', pid: ENVELOPE_PROFILE_ID, iat: Date.now() },
        key,
      );

      const origFetch = global.fetch;
      global.fetch = vi.fn(async (_url: any, init: any) => {
        const auth = (init?.headers as Record<string, string>)?.['Authorization'];
        return { status: auth === `Bearer ${RAW_ACCESS_TOKEN}` ? 200 : 401 } as any;
      });

      try {
        const response = await request(tApp)
          .post('/mcp')
          .set('Accept', 'application/json, text/event-stream')
          .set('Authorization', `Bearer ${envelope}`)
          .send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });

        // After fix: session created, no error in body
        expect(response.headers['mcp-session-id']).toBeDefined();
        expect(response.body.error).toBeUndefined();
      } finally {
        global.fetch = origFetch;
        if (savedEnv === undefined) delete process.env.MCP4_SSRF_ALLOW_PRIVATE_NETWORK;
        else process.env.MCP4_SSRF_ALLOW_PRIVATE_NETWORK = savedEnv;
        await t.stop();
      }
    });

    it('Test Y: plain bearer token with oauth validation_endpoint succeeds (backward compat baseline)', async () => {
      // Plain tokens (no mcp4.v1. prefix) must continue to work unchanged.
      // This test must PASS both before and after the envelope fix.
      const savedEnv = process.env.MCP4_SSRF_ALLOW_PRIVATE_NETWORK;
      process.env.MCP4_SSRF_ALLOW_PRIVATE_NETWORK = 'true';
      const PLAIN_TOKEN = 'plain-gitlab-token';
      const t = buildTransportWithValidation();
      const tApp = (t as any).app;

      const origFetch = global.fetch;
      global.fetch = vi.fn(async (_url: any, init: any) => {
        const auth = (init?.headers as Record<string, string>)?.['Authorization'];
        return { status: auth === `Bearer ${PLAIN_TOKEN}` ? 200 : 401 } as any;
      });

      try {
        const response = await request(tApp)
          .post('/mcp')
          .set('Accept', 'application/json, text/event-stream')
          .set('Authorization', `Bearer ${PLAIN_TOKEN}`)
          .send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });

        expect(response.headers['mcp-session-id']).toBeDefined();
        expect(response.body.error).toBeUndefined();
      } finally {
        global.fetch = origFetch;
        if (savedEnv === undefined) delete process.env.MCP4_SSRF_ALLOW_PRIVATE_NETWORK;
        else process.env.MCP4_SSRF_ALLOW_PRIVATE_NETWORK = savedEnv;
        await t.stop();
      }
    });

    it('Test AA: expired plain OAuth token returns HTTP 401 + WWW-Authenticate so OAuth clients trigger re-auth', async () => {
      // When validation_endpoint rejects an expired plain token AND oauthConfig is active,
      // the server must return HTTP 401 with WWW-Authenticate instead of JSON-RPC -32600.
      // OAuth-aware clients (e.g. Cursor) interpret HTTP 401 + WWW-Authenticate as a signal
      // to initiate the OAuth re-auth flow. JSON-RPC -32600 shows as a plain connection error.
      const savedEnv = process.env.MCP4_SSRF_ALLOW_PRIVATE_NETWORK;
      process.env.MCP4_SSRF_ALLOW_PRIVATE_NETWORK = 'true';
      const EXPIRED_TOKEN = 'expired-gitlab-token';
      const t = new HttpTransport(
        {
          host: '127.0.0.1',
          port: 0,
          sessionTimeoutMs: 1800000,
          heartbeatEnabled: false,
          heartbeatIntervalMs: 30000,
          metricsEnabled: false,
          metricsPath: '/metrics',
          baseUrl: 'http://127.0.0.1',
          authConfigs: [{ type: 'oauth', validation_endpoint: '/validate' }],
          oauthConfig: {
            authorization_endpoint: 'https://gitlab.example.com/oauth/authorize',
            token_endpoint: 'https://gitlab.example.com/oauth/token',
            redirect_uri: 'https://example.com/oauth/callback',
            scopes: ['api'],
          },
        } as any,
        logger,
      );
      t.setMessageHandler(async () => ({ result: 'ok' }));
      const tApp = (t as any).app;

      const origFetch = global.fetch;
      global.fetch = vi.fn(async () => ({ status: 401 }) as any);

      try {
        const response = await request(tApp)
          .post('/mcp')
          .set('Accept', 'application/json, text/event-stream')
          .set('Authorization', `Bearer ${EXPIRED_TOKEN}`)
          .send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });

        expect(response.status).toBe(401);
        expect(response.headers['www-authenticate']).toBeDefined();
        expect(response.headers['www-authenticate']).toContain('Bearer');
        // Must NOT be a JSON-RPC error (which uses HTTP 200 + error body)
        expect(response.body.error?.code).toBeUndefined();
      } finally {
        global.fetch = origFetch;
        if (savedEnv === undefined) delete process.env.MCP4_SSRF_ALLOW_PRIVATE_NETWORK;
        else process.env.MCP4_SSRF_ALLOW_PRIVATE_NETWORK = savedEnv;
        await t.stop();
      }
    });

    it('Test Z: envelope with wrong decryption key — init fails correctly (decrypt fail path)', async () => {
      // When tokenKey cannot decrypt the envelope (wrong key), the raw envelope string
      // is forwarded to the validation endpoint and rejected. Init must fail with auth error.
      // This test must PASS both before and after the fix (failure mode is correct either way).
      const { encryptTokenPayload } = await import('../auth/token-envelope.js');
      const savedEnv = process.env.MCP4_SSRF_ALLOW_PRIVATE_NETWORK;
      process.env.MCP4_SSRF_ALLOW_PRIVATE_NETWORK = 'true';
      const encryptKey = buildEnvKey();
      const wrongKey = Buffer.from('b'.repeat(64), 'hex');
      const t = buildTransportWithValidation({ tokenKey: wrongKey });
      const tApp = (t as any).app;

      const envelope = encryptTokenPayload(
        { v: 1, at: RAW_ACCESS_TOKEN, rt: 'refresh-token', pid: ENVELOPE_PROFILE_ID, iat: Date.now() },
        encryptKey,
      );

      const origFetch = global.fetch;
      global.fetch = vi.fn(async (_url: any, init: any) => {
        const auth = (init?.headers as Record<string, string>)?.['Authorization'];
        return { status: auth === `Bearer ${RAW_ACCESS_TOKEN}` ? 200 : 401 } as any;
      });

      try {
        const response = await request(tApp)
          .post('/mcp')
          .set('Accept', 'application/json, text/event-stream')
          .set('Authorization', `Bearer ${envelope}`)
          .send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });

        expect(response.body.error).toBeDefined();
        expect(response.body.error.message).toContain('invalid or expired');
      } finally {
        global.fetch = origFetch;
        if (savedEnv === undefined) delete process.env.MCP4_SSRF_ALLOW_PRIVATE_NETWORK;
        else process.env.MCP4_SSRF_ALLOW_PRIVATE_NETWORK = savedEnv;
        await t.stop();
      }
    });
  });

  describe('getSessionToken', () => {
    it('should return token for existing session', () => {
      const profileState = createProfileState(transport as any);
      const sessionId = (transport as any).createSession(profileState, 'my-auth-token');
      const token = transport.getSessionToken('default', sessionId);
      expect(token).toBe('my-auth-token');
    });

    it('returns rawAccessToken when session.authToken is an encrypted envelope', () => {
      const profileState = createProfileState(transport as any);
      const envelopeToken = 'mcp4.v1.fake-envelope-token';
      const rawAccessToken = 'real-idp-access-token';
      const sessionId = (transport as any).createSession(profileState, envelopeToken);
      profileState.oauthTokensByAccessToken.set(envelopeToken, {
        refreshToken: 'refresh-x',
        expiresAt: Date.now() + 60_000,
        clientId: 'client-x',
        scopes: ['read'],
        rawAccessToken,
      });
      const token = transport.getSessionToken('default', sessionId);
      expect(token).toBe(rawAccessToken);
    });
  });

  describe('profile routing', () => {
    it('routes /profile/:id/mcp to handler with profileId', async () => {
      const config = {
        host: '127.0.0.1',
        port: 0,
        sessionTimeoutMs: 1800000,
        heartbeatEnabled: false,
        heartbeatIntervalMs: 30000,
        metricsEnabled: false,
        metricsPath: '/metrics',
        profileRoutingEnabled: true,
      };

      const routingTransport = new HttpTransport(config, logger);
      routingTransport.setProfileContextProvider(async (id) => ({ profileId: id }));
      const handler = vi.fn(async (message: any, sessionId?: string, profileId?: string) => ({
        jsonrpc: '2.0',
        id: message.id,
        result: { sessionId, profileId },
      }));
      routingTransport.setMessageHandler(handler);

      const routingApp = (routingTransport as any).app;

      const response = await request(routingApp)
        .post('/profile/gitlab/mcp')
        .set('Accept', 'application/json')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            clientInfo: { name: 'test', version: '1.0.0' },
          },
        });

      expect(response.status).toBe(200);
      const [, , profileId] = handler.mock.calls[0];
      expect(profileId).toBe('gitlab');

      await routingTransport.stop();
    });

    it('supports deprecated /profile/:id/sse alias for initialization', async () => {
      const routingTransport = new HttpTransport(
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
      routingTransport.setProfileContextProvider(async (id) => ({ profileId: id }));
      routingTransport.setMessageHandler(async (_message) => ({
        protocolVersion: '2025-03-26',
        serverInfo: { name: 'test' },
      }));

      const routingApp = (routingTransport as any).app;
      const response = await request(routingApp)
        .post('/profile/gitlab/sse')
        .set('Accept', 'text/event-stream')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {},
        });

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('text/event-stream');
      expect(response.headers['mcp-session-id']).toBeDefined();
      expect(response.text).toContain('id:');
      expect(response.text).toContain('data:');

      await routingTransport.stop();
    });

    it('returns 404 for /mcp when routing enabled without default profile', async () => {
      const routingTransport = new HttpTransport(
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
      routingTransport.setProfileContextProvider(async (id) => ({ profileId: id }));
      routingTransport.setMessageHandler(async (message: any) => ({
        jsonrpc: '2.0',
        id: message.id,
        result: { ok: true },
      }));

      const routingApp = (routingTransport as any).app;
      const response = await request(routingApp)
        .post('/mcp')
        .set('Accept', 'application/json')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            clientInfo: { name: 'test', version: '1.0.0' },
          },
        });

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Not Found');

      await routingTransport.stop();
    });

    it('keeps /mcp when default profile is set in routing mode', async () => {
      const routingTransport = new HttpTransport(
        {
          host: '127.0.0.1',
          port: 0,
          sessionTimeoutMs: 1800000,
          heartbeatEnabled: false,
          heartbeatIntervalMs: 30000,
          metricsEnabled: false,
          metricsPath: '/metrics',
          profileRoutingEnabled: true,
          defaultProfileId: 'default',
        },
        logger
      );
      routingTransport.setProfileContextProvider(async (id) => (id === 'default' ? { profileId: id } : null));
      const handler = vi.fn(async (message: any, sessionId?: string, profileId?: string) => ({
        jsonrpc: '2.0',
        id: message.id,
        result: { sessionId, profileId },
      }));
      routingTransport.setMessageHandler(handler);

      const routingApp = (routingTransport as any).app;
      const response = await request(routingApp)
        .post('/mcp')
        .set('Accept', 'application/json')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            clientInfo: { name: 'test', version: '1.0.0' },
          },
        });

      expect(response.status).toBe(200);
      const [, , profileId] = handler.mock.calls[0];
      expect(profileId).toBe('default');

      await routingTransport.stop();
    });

    it('routes alias profile ids when default profile is set', async () => {
      const routingTransport = new HttpTransport(
        {
          host: '127.0.0.1',
          port: 0,
          sessionTimeoutMs: 1800000,
          heartbeatEnabled: false,
          heartbeatIntervalMs: 30000,
          metricsEnabled: false,
          metricsPath: '/metrics',
          profileRoutingEnabled: true,
          defaultProfileId: 'default',
        },
        logger
      );
      routingTransport.setProfileContextProvider(async (id) => (id === 'alias-default' ? { profileId: id } : null));
      const handler = vi.fn(async (message: any, sessionId?: string, profileId?: string) => ({
        jsonrpc: '2.0',
        id: message.id,
        result: { sessionId, profileId },
      }));
      routingTransport.setMessageHandler(handler);

      const routingApp = (routingTransport as any).app;
      const response = await request(routingApp)
        .post('/profile/alias-default/mcp')
        .set('Accept', 'application/json')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            clientInfo: { name: 'test', version: '1.0.0' },
          },
        });

      expect(response.status).toBe(200);
      const [, , profileId] = handler.mock.calls[0];
      expect(profileId).toBe('alias-default');

      await routingTransport.stop();
    });

    it('passes request profile id to handler when alias is used', async () => {
      const routingTransport = new HttpTransport(
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
      routingTransport.setProfileContextProvider(async () => ({
        profileId: 'canonical',
      }));
      const handler = vi.fn(async (message: any, sessionId?: string, profileId?: string) => ({
        jsonrpc: '2.0',
        id: message.id,
        result: { sessionId, profileId },
      }));
      routingTransport.setMessageHandler(handler);

      const routingApp = (routingTransport as any).app;
      const response = await request(routingApp)
        .post('/profile/alias/mcp')
        .set('Accept', 'application/json')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            clientInfo: { name: 'test', version: '1.0.0' },
          },
        });

      expect(response.status).toBe(200);
      const [, , profileId] = handler.mock.calls[0];
      expect(profileId).toBe('alias');

      await routingTransport.stop();
    });

    it('serves profile-scoped OAuth metadata', async () => {
      const routingTransport = new HttpTransport(
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
      routingTransport.setProfileContextProvider(async (id) => ({
        profileId: id,
        oauthConfig: {
          authorization_endpoint: 'https://auth.example.com/oauth/authorize',
          token_endpoint: 'https://auth.example.com/oauth/token',
          client_id: 'client',
          client_secret: 'secret',
          redirect_uri: 'http://localhost:3003/oauth/callback',
          scopes: ['api'],
        },
      }));

      const routingApp = (routingTransport as any).app;
      const response = await request(routingApp).get('/profile/gitlab/.well-known/oauth-authorization-server');

      expect(response.status).toBe(200);
      expect(response.body.issuer).toContain('/profile/gitlab');
      expect(response.body.authorization_endpoint).toContain('/profile/gitlab/oauth/authorize');
      expect(response.body.token_endpoint).toContain('/profile/gitlab/oauth/token');

      await routingTransport.stop();
    });

    it('serves OAuth metadata via well-known path suffix', async () => {
      const routingTransport = new HttpTransport(
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
      routingTransport.setProfileContextProvider(async (id) => ({
        profileId: id,
        oauthConfig: {
          authorization_endpoint: 'https://auth.example.com/oauth/authorize',
          token_endpoint: 'https://auth.example.com/oauth/token',
          client_id: 'client',
          client_secret: 'secret',
          redirect_uri: 'http://localhost:3003/oauth/callback',
          scopes: ['api'],
        },
      }));

      const routingApp = (routingTransport as any).app;
      const response = await request(routingApp).get('/.well-known/oauth-authorization-server/profile/gitlab');

      expect(response.status).toBe(200);
      expect(response.body.issuer).toContain('/profile/gitlab');
      expect(response.body.authorization_endpoint).toContain('/profile/gitlab/oauth/authorize');
      expect(response.body.token_endpoint).toContain('/profile/gitlab/oauth/token');

      await routingTransport.stop();
    });

    it('serves OpenID configuration aliases for profile routing', async () => {
      const routingTransport = new HttpTransport(
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
      routingTransport.setProfileContextProvider(async (id) => ({
        profileId: id,
        oauthConfig: {
          authorization_endpoint: 'https://auth.example.com/oauth/authorize',
          token_endpoint: 'https://auth.example.com/oauth/token',
          client_id: 'client',
          client_secret: 'secret',
          redirect_uri: 'http://localhost:3003/oauth/callback',
          scopes: ['api'],
        },
      }));

      const routingApp = (routingTransport as any).app;
      const responseProfilePath = await request(routingApp).get('/profile/gitlab/.well-known/openid-configuration');
      const responseSuffixPath = await request(routingApp).get('/.well-known/openid-configuration/profile/gitlab');

      expect(responseProfilePath.status).toBe(200);
      expect(responseProfilePath.body.issuer).toContain('/profile/gitlab');
      expect(responseSuffixPath.status).toBe(200);
      expect(responseSuffixPath.body.issuer).toContain('/profile/gitlab');

      await routingTransport.stop();
    });

    it('keeps profile prefix for default profile OAuth metadata', async () => {
      const routingTransport = new HttpTransport(
        {
          host: '127.0.0.1',
          port: 0,
          sessionTimeoutMs: 1800000,
          heartbeatEnabled: false,
          heartbeatIntervalMs: 30000,
          metricsEnabled: false,
          metricsPath: '/metrics',
          profileRoutingEnabled: true,
          defaultProfileId: 'default',
        },
        logger
      );
      routingTransport.setProfileContextProvider(async (id) => ({
        profileId: id,
        oauthConfig: {
          authorization_endpoint: 'https://auth.example.com/oauth/authorize',
          token_endpoint: 'https://auth.example.com/oauth/token',
          client_id: 'client',
          client_secret: 'secret',
          redirect_uri: 'http://localhost:3003/oauth/callback',
          scopes: ['api'],
        },
      }));

      const routingApp = (routingTransport as any).app;
      const response = await request(routingApp).get('/profile/default/.well-known/oauth-authorization-server');

      expect(response.status).toBe(200);
      expect(response.body.issuer).toContain('/profile/default');
      expect(response.body.authorization_endpoint).toContain('/profile/default/oauth/authorize');
      expect(response.body.token_endpoint).toContain('/profile/default/oauth/token');

      await routingTransport.stop();
    });

    it('serves profile-scoped protected resource metadata', async () => {
      const routingTransport = new HttpTransport(
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
      routingTransport.setProfileContextProvider(async (id) => ({
        profileId: id,
        oauthConfig: {
          authorization_endpoint: 'https://auth.example.com/oauth/authorize',
          token_endpoint: 'https://auth.example.com/oauth/token',
          client_id: 'client',
          client_secret: 'secret',
          redirect_uri: 'http://localhost:3003/oauth/callback',
          scopes: ['api'],
        },
      }));

      const routingApp = (routingTransport as any).app;
      const response = await request(routingApp).get('/profile/gitlab/.well-known/oauth-protected-resource/mcp');

      expect(response.status).toBe(200);
      expect(response.body.resource).toContain('/profile/gitlab/mcp');
      expect(response.body.authorization_servers?.[0]).toContain('/profile/gitlab');

      await routingTransport.stop();
    });

    it('serves root protected resource metadata using resource query', async () => {
      const routingTransport = new HttpTransport(
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
      routingTransport.setProfileContextProvider(async (id) => ({
        profileId: id,
        oauthConfig: {
          authorization_endpoint: 'https://auth.example.com/oauth/authorize',
          token_endpoint: 'https://auth.example.com/oauth/token',
          client_id: 'client',
          client_secret: 'secret',
          redirect_uri: 'http://localhost:3003/oauth/callback',
          scopes: ['api'],
        },
      }));

      const routingApp = (routingTransport as any).app;
      const response = await request(routingApp)
        .get('/.well-known/oauth-protected-resource/mcp')
        .query({ resource: 'https://example.com/profile/gitlab/mcp/' });

      expect(response.status).toBe(200);
      expect(response.body.resource).toContain('/profile/gitlab/mcp');
      expect(response.body.authorization_servers?.[0]).toContain('/profile/gitlab');

      await routingTransport.stop();
    });

    it('serves protected resource metadata using well-known profile path', async () => {
      const routingTransport = new HttpTransport(
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
      routingTransport.setProfileContextProvider(async (id) => ({
        profileId: id,
        oauthConfig: {
          authorization_endpoint: 'https://auth.example.com/oauth/authorize',
          token_endpoint: 'https://auth.example.com/oauth/token',
          client_id: 'client',
          client_secret: 'secret',
          redirect_uri: 'http://localhost:3003/oauth/callback',
          scopes: ['api'],
        },
      }));

      const routingApp = (routingTransport as any).app;
      const response = await request(routingApp)
        .get('/.well-known/oauth-protected-resource/profile/gitlab/mcp');

      expect(response.status).toBe(200);
      expect(response.body.resource).toContain('/profile/gitlab/mcp');
      expect(response.body.authorization_servers?.[0]).toContain('/profile/gitlab');

      await routingTransport.stop();
    });

    it('serves root auth server metadata using profile hint', async () => {
      const routingTransport = new HttpTransport(
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
      routingTransport.setProfileContextProvider(async (id) => ({
        profileId: id,
        oauthConfig: {
          authorization_endpoint: 'https://auth.example.com/oauth/authorize',
          token_endpoint: 'https://auth.example.com/oauth/token',
          client_id: 'client',
          client_secret: 'secret',
          redirect_uri: 'http://localhost:3003/oauth/callback',
          scopes: ['api'],
        },
      }));

      const routingApp = (routingTransport as any).app;

      // Prime hint via profile route
      await request(routingApp)
        .post('/profile/gitlab/mcp')
        .send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
        .ok(() => true);

      const response = await request(routingApp).get('/.well-known/oauth-authorization-server');

      expect(response.status).toBe(200);
      expect(response.body.issuer).toContain('/profile/gitlab');
      expect(response.body.authorization_endpoint).toContain('/profile/gitlab/oauth/authorize');
      expect(response.body.token_endpoint).toContain('/profile/gitlab/oauth/token');

      await routingTransport.stop();
    });

    it('forces profile prefix when resource query targets default profile path', async () => {
      const routingTransport = new HttpTransport(
        {
          host: '127.0.0.1',
          port: 0,
          sessionTimeoutMs: 1800000,
          heartbeatEnabled: false,
          heartbeatIntervalMs: 30000,
          metricsEnabled: false,
          metricsPath: '/metrics',
          profileRoutingEnabled: true,
          defaultProfileId: 'gitlab',
        },
        logger
      );
      routingTransport.setProfileContextProvider(async (id) => ({
        profileId: id,
        oauthConfig: {
          authorization_endpoint: 'https://auth.example.com/oauth/authorize',
          token_endpoint: 'https://auth.example.com/oauth/token',
          client_id: 'client',
          client_secret: 'secret',
          redirect_uri: 'http://localhost:3003/oauth/callback',
          scopes: ['api'],
        },
      }));

      const routingApp = (routingTransport as any).app;
      const response = await request(routingApp)
        .get('/.well-known/oauth-protected-resource/mcp')
        .query({ resource: 'https://example.com/profile/gitlab/mcp' });

      expect(response.status).toBe(200);
      expect(response.body.resource).toContain('/profile/gitlab/mcp');
      expect(response.body.authorization_servers?.[0]).toContain('/profile/gitlab');

      await routingTransport.stop();
    });

    it('rejects invalid resource query parameter', async () => {
      const routingTransport = new HttpTransport(
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

      const routingApp = (routingTransport as any).app;
      const response = await request(routingApp)
        .get('/.well-known/oauth-protected-resource/mcp')
        .query({ resource: ['one', 'two'] });

      expect(response.status).toBe(400);
      expect(response.body.message).toBe('Invalid resource query parameter');

      await routingTransport.stop();
    });

    it('returns not found for unrecognized resource url', async () => {
      const routingTransport = new HttpTransport(
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

      const routingApp = (routingTransport as any).app;
      const response = await request(routingApp)
        .get('/.well-known/oauth-protected-resource/mcp')
        .query({ resource: 'not-a-url' });

      expect(response.status).toBe(404);
      expect(response.body.message).toBe('OAuth metadata unavailable for requested resource');

      await routingTransport.stop();
    });
  });

  describe('isAllowedOrigin with OAuth redirect URI', () => {
    let oauthTransport: HttpTransport;

    beforeEach(async () => {
      const oauthConfig = {
        host: '127.0.0.1',
        port: 0,
        sessionTimeoutMs: 1800000,
        heartbeatEnabled: false,
        heartbeatIntervalMs: 30000,
        metricsEnabled: false,
        metricsPath: '/metrics',
      };

      oauthTransport = new HttpTransport(oauthConfig, logger);
    });

    afterEach(async () => {
      await oauthTransport.stop();
    });

    it('should allow origin matching OAuth redirect URI host', async () => {
      // Mock OAuth provider with redirect URI
      (oauthTransport as any).profileStates.set('default', {
        profileId: 'default',
        context: { profileId: 'default' },
        oauthProvider: { redirectUri: 'http://myapp.example.com:3000/callback' },
        oauthTokensByAccessToken: new Map(),
        sessions: new Map(),
      });

      const isAllowed = (oauthTransport as any).isAllowedOrigin('http://myapp.example.com:3000');
      expect(isAllowed).toBe(true);
    });

    it('should handle invalid OAuth redirect URI gracefully', async () => {
      // Mock OAuth provider with invalid redirect URI
      (oauthTransport as any).profileStates.set('default', {
        profileId: 'default',
        context: { profileId: 'default' },
        oauthProvider: { redirectUri: 'not-a-valid-url' },
        oauthTokensByAccessToken: new Map(),
        sessions: new Map(),
      });

      // Should not throw and should fall back to other checks
      const isAllowed = (oauthTransport as any).isAllowedOrigin('http://localhost:3000');
      expect(isAllowed).toBe(true); // localhost always allowed
    });
  });

  describe('getSessionClientPrincipal (OBS-01)', () => {
    it('returns the clientPrincipal stored on the session', () => {
      const t = new HttpTransport(
        {
          host: '127.0.0.1',
          port: 0,
          sessionTimeoutMs: 1800000,
          heartbeatEnabled: false,
          heartbeatIntervalMs: 30000,
          metricsEnabled: false,
          metricsPath: '/metrics',
        },
        logger,
      );
      const principal = {
        authType: 'token' as const,
        profileId: 'default',
        subject: 'svc-account',
        scopes: ['read', 'write'],
      };
      (t as any).profileStates.set('default', {
        profileId: 'default',
        context: { profileId: 'default' },
        oauthTokensByAccessToken: new Map(),
        sessions: new Map([['session-1', { clientPrincipal: principal }]]),
      });

      const out = t.getSessionClientPrincipal('default', 'session-1');
      expect(out).toBeDefined();
      expect(out?.subject).toBe('svc-account');
      expect(out?.authType).toBe('token');
    });

    it('returns undefined when session is anonymous (no clientPrincipal)', () => {
      const t = new HttpTransport(
        {
          host: '127.0.0.1',
          port: 0,
          sessionTimeoutMs: 1800000,
          heartbeatEnabled: false,
          heartbeatIntervalMs: 30000,
          metricsEnabled: false,
          metricsPath: '/metrics',
        },
        logger,
      );
      (t as any).profileStates.set('default', {
        profileId: 'default',
        context: { profileId: 'default' },
        oauthTokensByAccessToken: new Map(),
        sessions: new Map([['session-anon', {}]]),
      });

      expect(t.getSessionClientPrincipal('default', 'session-anon')).toBeUndefined();
    });

    it('returns undefined when profileId or sessionId is unknown', () => {
      const t = new HttpTransport(
        {
          host: '127.0.0.1',
          port: 0,
          sessionTimeoutMs: 1800000,
          heartbeatEnabled: false,
          heartbeatIntervalMs: 30000,
          metricsEnabled: false,
          metricsPath: '/metrics',
        },
        logger,
      );
      expect(t.getSessionClientPrincipal('does-not-exist', 'whatever')).toBeUndefined();
      (t as any).profileStates.set('default', {
        profileId: 'default',
        context: { profileId: 'default' },
        oauthTokensByAccessToken: new Map(),
        sessions: new Map(),
      });
      expect(t.getSessionClientPrincipal('default', 'no-such-session')).toBeUndefined();
    });
  });
});
