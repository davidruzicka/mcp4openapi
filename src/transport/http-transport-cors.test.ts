
import request from 'supertest';
import { HttpTransport } from './http-transport.js';
import { ConsoleLogger } from '../core/logger.js';
import { describe, it, expect } from 'vitest';

describe('CORS Headers', () => {
  it('should return Access-Control-Allow-Origin on POST request', async () => {
    const transport = new HttpTransport(
      {
        host: '127.0.0.1',
        port: 0,
        sessionTimeoutMs: 1800000,
        heartbeatEnabled: false,
        metricsEnabled: false,
        metricsPath: '/metrics',
      } as any,
      new ConsoleLogger()
    );

    // Mock message handler
    transport.setMessageHandler(async () => ({ result: 'ok' }));

    const app = (transport as any).app;

    const response = await request(app)
      .post('/mcp')
      .set('Origin', 'http://localhost')
      .set('Accept', 'application/json')
      .send({ jsonrpc: '2.0', id: 1, method: 'initialize' });

    expect(response.headers['access-control-allow-origin']).toBe('http://localhost');
    expect(response.headers['access-control-allow-credentials']).toBeUndefined();
    expect(response.headers['vary']).toBe('Origin');
  });

  it('should expose Mcp-Session-Id via Access-Control-Expose-Headers', async () => {
    const transport = new HttpTransport(
      {
        host: '127.0.0.1',
        port: 0,
        sessionTimeoutMs: 1800000,
        heartbeatEnabled: false,
        metricsEnabled: false,
        metricsPath: '/metrics',
      } as any,
      new ConsoleLogger()
    );

    // Mock message handler
    transport.setMessageHandler(async () => ({ result: 'ok' }));

    const app = (transport as any).app;

    const response = await request(app)
      .post('/mcp')
      .set('Origin', 'http://localhost')
      .set('Accept', 'application/json')
      .send({ jsonrpc: '2.0', id: 1, method: 'initialize' });

    expect(response.headers['access-control-expose-headers']).toBeDefined();
    expect(response.headers['access-control-expose-headers']).toContain('Mcp-Session-Id');
  });
});
