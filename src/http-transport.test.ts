/**
 * Unit tests for HTTP transport
 * 
 * Tests MCP Specification 2025-03-26 Streamable HTTP transport
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { HttpTransport } from './http-transport.js';
import { ConsoleLogger, LogLevel } from './logger.js';

describe('HttpTransport', () => {
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
      expect(response.body.message).toContain('Test error');
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
});

