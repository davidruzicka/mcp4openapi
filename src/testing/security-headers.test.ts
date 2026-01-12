
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { HttpTransport } from '../http-transport.js';
import { ConsoleLogger } from '../logger.js';
import type { Express } from 'express';
import { describeIfListen } from './listen-support.js';

describeIfListen('Security Headers', () => {
  let transport: HttpTransport;
  let app: Express;

  beforeAll(async () => {
    const config = {
      host: '127.0.0.1',
      port: 0,
      sessionTimeoutMs: 1800000,
      heartbeatEnabled: false,
      metricsEnabled: false,
    };

    const logger = new ConsoleLogger();
    transport = new HttpTransport(config, logger);
    app = (transport as any).app;

    // We don't need a message handler for these tests as we're testing middleware
    transport.setMessageHandler(async () => ({}));
  });

  afterAll(async () => {
    await transport.stop();
  });

  it('should have security headers on responses', async () => {
    const response = await request(app).get('/health');

    expect(response.status).toBe(200);

    // Check for standard security headers
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('DENY');
    expect(response.headers['content-security-policy']).toContain("default-src 'self'");
    expect(response.headers['referrer-policy']).toBe('no-referrer');

    // Check that X-Powered-By is removed (Express sets it by default)
    expect(response.headers['x-powered-by']).toBeUndefined();
  });

  it('should have security headers on MCP endpoints', async () => {
    const response = await request(app)
      .post('/mcp')
      .set('Accept', 'application/json')
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          clientInfo: { name: 'test', version: '1.0' }
        }
      });

    // We expect headers even on error responses or initialized responses
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('DENY');
    expect(response.headers['content-security-policy']).toContain("default-src 'self'");
  });
});
