import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { HttpTransport } from './http-transport.js';
import { ConsoleLogger } from './logger.js';

function createTransport(config?: Partial<any>) {
  return new HttpTransport(
    {
      host: '127.0.0.1',
      port: 0,
      sessionTimeoutMs: 1800000,
      heartbeatEnabled: false,
      metricsEnabled: false,
      ...config,
    } as any,
    new ConsoleLogger()
  );
}

describe('HttpTransport Security Headers', () => {
  it('sets standard security headers on responses', async () => {
    const transport = createTransport({ host: 'example.com' });
    const app = (transport as any).app;

    // We need to set a message handler because the route /mcp expects it
    transport.setMessageHandler(async () => ({ result: 'ok' }));

    const res = await request(app)
      .post('/mcp')
      .set('Accept', 'application/json')
      .set('Host', 'example.com') // Non-localhost
      .send({ jsonrpc: '2.0', id: 1, method: 'initialize' });

    expect(res.headers['strict-transport-security']).toBe('max-age=63072000; includeSubDomains');
    expect(res.headers['content-security-policy']).toBe("default-src 'self'; frame-ancestors 'none'");
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });

  it('skips HSTS on localhost', async () => {
    const transport = createTransport({ host: 'localhost' });
    const app = (transport as any).app;

    transport.setMessageHandler(async () => ({ result: 'ok' }));

    const res = await request(app)
      .post('/mcp')
      .set('Accept', 'application/json')
      .set('Host', 'localhost')
      .send({ jsonrpc: '2.0', id: 1, method: 'initialize' });

    expect(res.headers['strict-transport-security']).toBeUndefined();
    // Other headers should still be present
    expect(res.headers['x-frame-options']).toBe('DENY');
  });
});
