import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { HttpTransport } from './http-transport.js';
import { ConsoleLogger } from '../core/logger.js';

function createTransport(config?: Partial<any>) {
  return new HttpTransport(
    {
      host: '127.0.0.1',
      port: 0,
      sessionTimeoutMs: 1800000,
      heartbeatEnabled: false,
      heartbeatIntervalMs: 30000,
      metricsEnabled: false,
      metricsPath: '/metrics',
      ...config,
    } as any,
    new ConsoleLogger()
  );
}

describe('HttpTransport security headers', () => {
  it('should include Strict-Transport-Security header', async () => {
    const transport = createTransport();
    const app = (transport as any).app;

    const response = await request(app).get('/health');

    // HSTS should be present
    expect(response.headers['strict-transport-security']).toBeDefined();
    expect(response.headers['strict-transport-security']).toBe('max-age=63072000; includeSubDomains');
    await transport.stop();
  });

  it('should include X-XSS-Protection header', async () => {
    const transport = createTransport();
    const app = (transport as any).app;

    const response = await request(app).get('/health');

    // X-XSS-Protection should be 0 to disable legacy auditors
    expect(response.headers['x-xss-protection']).toBe('0');
    await transport.stop();
  });
});
