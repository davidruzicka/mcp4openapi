
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import { HttpTransport } from './http-transport.js';
import { ConsoleLogger } from './logger.js';
import { TIMEOUTS } from './constants.js';

describe('Tool Filter Integration', () => {
  let app: express.Application;
  let transport: HttpTransport;

  beforeAll(async () => {
    // Setup transport
    transport = new HttpTransport({
      host: 'localhost',
      port: 0, // Ephemeral port, we won't listen
      sessionTimeoutMs: TIMEOUTS.SESSION_TIMEOUT_MS,
      heartbeatEnabled: false,
      heartbeatIntervalMs: 1000,
      metricsEnabled: false,
      metricsPath: '/metrics',
      rateLimitEnabled: false,
    }, new ConsoleLogger());

    // Access the express app via private property (for testing)
    app = (transport as any).app;

    // Mock message handler
    transport.setMessageHandler(async (msg: any) => {
      // Echo request info for verification
      if (msg.method === 'tools/list') {
        return { result: { tools: [] } }; // Mock response
      }
      return { result: 'ok' };
    });
  });

  afterAll(async () => {
    await transport.stop();
  });

  it('rejects invalid X-Mcp4-Tools header format', async () => {
    const res = await request(app)
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .set('X-Mcp4-Tools', 'tool1, regex:(') // Invalid regex
      .send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Bad Request');
    expect(res.body.message).toContain('Invalid regex');
  });

  it('accepts valid X-Mcp4-Tools header', async () => {
    const res = await request(app)
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .set('X-Mcp4-Tools', 'tool1, regex:tool.*')
      .send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });

    // Should succeed (or fail with other error if mocking isn't perfect, but status shouldn't be 400 for header)
    // Note: It might return 200 with result or error depending on handler.
    // If it reached handler, it means header passed.
    expect(res.status).not.toBe(400);
  });

  it('enforces header immutability', async () => {
    // 1. Init session with header
    const initRes = await request(app)
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .set('X-Mcp4-Tools', 'tool1')
      .send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });

    const sessionId = initRes.headers['mcp-session-id'];
    expect(sessionId).toBeDefined();

    // 2. Subsequent request with SAME header -> OK
    const sameRes = await request(app)
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .set('Mcp-Session-Id', sessionId)
      .set('X-Mcp4-Tools', 'tool1')
      .send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(sameRes.status).not.toBe(400);

    // 3. Subsequent request with DIFFERENT header -> 400
    const diffRes = await request(app)
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .set('Mcp-Session-Id', sessionId)
      .set('X-Mcp4-Tools', 'tool2')
      .send({ jsonrpc: '2.0', id: 3, method: 'tools/list' });

    expect(diffRes.status).toBe(400);
    expect(diffRes.body.message).toContain('mismatch');
  });
});
