
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { HttpTransport } from './http-transport.js';
import { ConsoleLogger } from './logger.js';
import { describeIfListen } from './testing/listen-support.js';

describeIfListen('HttpTransport Security Headers', () => {
  let transport: HttpTransport;
  let app: Express;
  const logger = new ConsoleLogger();

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
    transport.setMessageHandler(async () => ({ result: 'ok' }));
  });

  afterEach(async () => {
    await transport.stop();
  });

  it('should set X-Content-Type-Options header', async () => {
    const response = await request(app).get('/health');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
  });

  it('should set X-Frame-Options header', async () => {
    const response = await request(app).get('/health');
    expect(response.headers['x-frame-options']).toBe('DENY');
  });

  it('should set Content-Security-Policy header', async () => {
    const response = await request(app).get('/health');
    expect(response.headers['content-security-policy']).toBe("default-src 'self'");
  });

  it('should set HSTS header on non-localhost requests', async () => {
      // Mocking a non-localhost request via Host header and potentially modifying transport config if needed
      // However, supertest requests are local. We might need to mock req.hostname or check logic.
      // Let's create a new transport with a non-localhost host config to simulate production-like env
       const prodTransport = new HttpTransport({
        host: '0.0.0.0', // Bind to all interfaces, simulates prod
        port: 0,
        sessionTimeoutMs: 1800000,
        heartbeatEnabled: false,
        heartbeatIntervalMs: 30000,
        metricsEnabled: false,
        metricsPath: '/metrics',
      }, logger);
      const prodApp = (prodTransport as any).app;

      // We need to trick the middleware into thinking it's not localhost.
      // Express req.hostname depends on Host header.
      const response = await request(prodApp)
        .get('/health')
        .set('Host', 'example.com');

      expect(response.headers['strict-transport-security']).toBe('max-age=31536000; includeSubDomains');

      await prodTransport.stop();
  });

  it('should NOT set HSTS header on localhost requests', async () => {
      const response = await request(app)
        .get('/health')
        .set('Host', 'localhost');

      expect(response.headers['strict-transport-security']).toBeUndefined();
  });
});
