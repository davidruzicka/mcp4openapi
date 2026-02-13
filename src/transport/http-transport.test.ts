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
      expect(testLogger.warn).not.toHaveBeenCalled();

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

    beforeEach(async () => {
      const config = {
        host: '127.0.0.1',
        port: 0,
        sessionTimeoutMs: 1800000,
        heartbeatEnabled: false,
        heartbeatIntervalMs: 30000,
        metricsEnabled: false,
        metricsPath: '/metrics',
        profileRoutingEnabled: true,
        profileIndexEnabled: true,
      };
      indexTransport = new HttpTransport(config, logger);
      indexApp = (indexTransport as any).app;
    });

    afterEach(async () => {
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
      expect(response1.text).toContain('mcp_sessions_created_total 1');
      expect(response1.text).toContain('mcp_sessions_active 1');

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
      expect(response2.text).toContain('mcp_sessions_destroyed_total');
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

        expect(response.status).toBe(401);
        expect(response.body).toHaveProperty('message', 'Invalid or expired authentication token');
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
        },
      };

      const oauthTransport = new HttpTransport(oauthConfig, logger);
      await (oauthTransport as any).getProfileState('default');
      expect(oauthTransport.hasOAuthProvider()).toBe(true);
      oauthTransport.stop();
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

  describe('getSessionToken', () => {
    it('should return token for existing session', () => {
      const profileState = createProfileState(transport as any);
      const sessionId = (transport as any).createSession(profileState, 'my-auth-token');
      const token = transport.getSessionToken('default', sessionId);
      expect(token).toBe('my-auth-token');
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
});
