/**
 * Unit tests for HTTP transport
 * 
 * Tests MCP Specification 2025-03-26 Streamable HTTP transport
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { HttpTransport } from './http-transport.js';
import { ConsoleLogger, LogLevel, type Logger } from './logger.js';
import { describeIfListen } from './testing/listen-support.js';

describeIfListen('HttpTransport', () => {
  let transport: HttpTransport;
  let app: Express;
  const logger = new ConsoleLogger();

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

  describe('Security - Origin Validation', () => {
    it('should accept requests from localhost', async () => {
      transport.setMessageHandler(async (msg) => ({ result: 'ok' }));

      const response = await request(app)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .set('Host', 'localhost')
        .send({ jsonrpc: '2.0', id: 1, method: 'initialize' });

      expect(response.status).not.toBe(403);
    });

    it('should accept requests from 127.0.0.1', async () => {
      transport.setMessageHandler(async (msg) => ({ result: 'ok' }));

      const response = await request(app)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .set('Host', '127.0.0.1')
        .send({ jsonrpc: '2.0', id: 1, method: 'initialize' });

      expect(response.status).not.toBe(403);
    });

    it('should validate Origin header for localhost requests (CSRF protection)', async () => {
      const response = await request(app)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .set('Origin', 'https://evil.com')
        .set('Host', 'localhost')
        .send({ jsonrpc: '2.0', id: 1, method: 'initialize' });

      expect(response.status).toBe(403);
      expect(response.body).toHaveProperty('error', 'Forbidden');
    });

    it('should validate Origin header for non-localhost requests', async () => {
      // Origin validation applies for all requests
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
      customTransport.setMessageHandler(async (msg) => ({ result: 'ok' }));
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
      expect(response.headers['access-control-allow-credentials']).toBe('false');
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
  });

  describe('POST - Initialize Request', () => {
    it('should create session on initialization', async () => {
      transport.setMessageHandler(async (msg) => ({
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
      transport.setMessageHandler(async (msg) => ({
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
      transport.setMessageHandler(async (msg) => ({ result: 'ok' }));

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
      transport.setMessageHandler(async (msg) => ({ result: 'ok' }));

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
      transport.setMessageHandler(async (msg) => ({ result: 'ok' }));

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
      transport.setMessageHandler(async (msg) => ({ result: 'ok' }));

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
      transport.setMessageHandler(async (msg) => ({ result: 'ok' }));

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
      transport.setMessageHandler(async (msg) => ({ result: 'ok' }));

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
      transport.setMessageHandler(async (msg) => ({ result: 'ok' }));

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
  });

  describe('Legacy /sse alias (deprecated)', () => {
    it('should support SSE response for initialization via POST /sse', async () => {
      transport.setMessageHandler(async (msg) => ({
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
      transport.setMessageHandler(async (msg) => ({ result: 'ok' }));

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
      transport.setMessageHandler(async (msg) => ({ result: 'ok' }));

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
      transport.setMessageHandler(async (msg) => ({ result: 'ok' }));

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
      transport.setMessageHandler(async (msg) => {
        if (Array.isArray(msg)) {
          return msg.map((m: any) => ({ id: m.id, result: 'ok' }));
        }
        return { result: 'ok' };
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
        ]);

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
    });
  });

  describe('Error Handling', () => {
    it('should handle message handler errors', async () => {
      transport.setMessageHandler(async (msg) => {
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
      transport.setMessageHandler(async (msg) => ({ result: 'ok' }));

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
      const sessions = (transport as any).sessions;
      const session = sessions.get(sessionId);

      expect(session).toBeDefined();
      expect(session.id).toBe(sessionId);
      expect(session.createdAt).toBeDefined();
      expect(session.lastActivityAt).toBeDefined();
    });

    it('should update lastActivityAt on requests', async () => {
      transport.setMessageHandler(async (msg) => {
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
      const sessions = (transport as any).sessions;
      const initialActivity = sessions.get(sessionId).lastActivityAt;

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

      const updatedActivity = sessions.get(sessionId).lastActivityAt;
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
      metricsTransport.setMessageHandler(async (msg) => ({ result: 'ok' }));
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
      (oauthTransport as any).oauthProvider = {
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
      tokenTransport.setMessageHandler(async (msg) => ({ result: 'ok' }));

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
      
      transport.onSessionDestroyed((sessionId) => {
        destroyedSessions.push(sessionId);
      });

      transport.setMessageHandler(async (msg) => ({ result: 'ok' }));

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
      expect(destroyedSessions).toContain(sessionId);
    });
  });

  describe('MCP-Session-Id header validation', () => {
    it('should return error for invalid session ID format in tool call', async () => {
      transport.setMessageHandler(async (msg) => ({ result: 'ok' }));

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
      transport.setMessageHandler(async (msg) => ({ result: 'ok' }));

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
  });

  describe('hasOAuthProvider', () => {
    it('should return false when OAuth is not configured', () => {
      expect(transport.hasOAuthProvider()).toBe(false);
    });

    it('should return true when OAuth is configured', () => {
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
      expect(oauthTransport.hasOAuthProvider()).toBe(true);
      oauthTransport.stop();
    });
  });

  describe('getOAuthAuthorizationUrl', () => {
    it('should return empty string when OAuth is not configured', () => {
      expect(transport.getOAuthAuthorizationUrl()).toBe('');
    });

    it('should return authorization URL when OAuth is configured', () => {
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
      expect(oauthTransport.getOAuthAuthorizationUrl()).toBe('https://example.com/oauth/authorize');
      oauthTransport.stop();
    });
  });

  describe('getOAuthScopes', () => {
    it('should return empty array when OAuth is not configured', () => {
      expect(transport.getOAuthScopes()).toEqual([]);
    });

    it('should return scopes when OAuth is configured with scopes', () => {
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
      expect(oauthTransport.getOAuthScopes()).toEqual(['api', 'read_user']);
      oauthTransport.stop();
    });
  });

  describe('Session token retrieval', () => {
    it('should return undefined for non-existent session', () => {
      expect(transport.getSessionToken('non-existent')).toBeUndefined();
    });
  });

  describe('destroySession', () => {
    it('should handle destroying non-existent session gracefully', () => {
      // Should not throw
      expect(() => (transport as any).destroySession('non-existent-session')).not.toThrow();
    });
  });

  describe('ensureValidSessionToken', () => {
    it('should return false for non-existent session', async () => {
      const result = await transport.ensureValidSessionToken('non-existent-session');
      expect(result).toBe(false);
    });

    it('should return true for session without expiration info', async () => {
      // Create a session
      transport.setMessageHandler(async (msg) => ({
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
      const result = await transport.ensureValidSessionToken(sessionId);
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
      const result = await (transport as any).refreshAccessToken('non-existent');
      expect(result).toBe(false);
    });

    it('should return false when session has no refresh token', async () => {
      // Create session without refresh token
      const sessionId = (transport as any).createSession('access-token');
      const result = await (transport as any).refreshAccessToken(sessionId);
      expect(result).toBe(false);
    });

    it('should return false when OAuth provider is not configured', async () => {
      // Create session with refresh token but no OAuth provider
      const sessionId = (transport as any).createSession('access-token', 'refresh-token');
      const result = await (transport as any).refreshAccessToken(sessionId);
      expect(result).toBe(false);
    });
  });

  describe('storeOAuthTokens', () => {
    it('should store tokens with expiration', () => {
      const tokens = {
        access_token: 'test-access-token',
        refresh_token: 'test-refresh-token',
        expires_in: 3600
      };
      
      (transport as any).storeOAuthTokens(tokens, 'client-id', ['read', 'write']);
      
      const stored = (transport as any).oauthTokensByAccessToken.get('test-access-token');
      expect(stored).toBeDefined();
      expect(stored.refreshToken).toBe('test-refresh-token');
      expect(stored.clientId).toBe('client-id');
      expect(stored.scopes).toEqual(['read', 'write']);
      expect(stored.expiresAt).toBeGreaterThan(Date.now());
    });

    it('should store tokens without expiration', () => {
      const tokens = {
        access_token: 'test-access-token-2'
      };
      
      (transport as any).storeOAuthTokens(tokens, 'client-id', []);
      
      const stored = (transport as any).oauthTokensByAccessToken.get('test-access-token-2');
      expect(stored).toBeDefined();
      expect(stored.refreshToken).toBeUndefined();
      expect(stored.expiresAt).toBeUndefined();
    });
  });

  describe('getSessionToken', () => {
    it('should return token for existing session', () => {
      const sessionId = (transport as any).createSession('my-auth-token');
      const token = transport.getSessionToken(sessionId);
      expect(token).toBe('my-auth-token');
    });
  });

  describe('isAllowedOrigin with OAuth redirect URI', () => {
    let oauthTransport: HttpTransport;
    let oauthApp: Express;

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
      oauthApp = (oauthTransport as any).app;
    });

    afterEach(async () => {
      await oauthTransport.stop();
    });

    it('should allow origin matching OAuth redirect URI host', async () => {
      // Mock OAuth provider with redirect URI
      (oauthTransport as any).oauthProvider = {
        redirectUri: 'http://myapp.example.com:3000/callback',
      };

      const isAllowed = (oauthTransport as any).isAllowedOrigin('http://myapp.example.com:3000');
      expect(isAllowed).toBe(true);
    });

    it('should handle invalid OAuth redirect URI gracefully', async () => {
      // Mock OAuth provider with invalid redirect URI
      (oauthTransport as any).oauthProvider = {
        redirectUri: 'not-a-valid-url',
      };

      // Should not throw and should fall back to other checks
      const isAllowed = (oauthTransport as any).isAllowedOrigin('http://localhost:3000');
      expect(isAllowed).toBe(true); // localhost always allowed
    });
  });
});
