import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { HttpTransport } from './http-transport.js';
import { ConsoleLogger } from '../core/logger.js';

// Mock dependecies
vi.mock('../core/metrics.js', () => ({
  MetricsCollector: class {
    recordHttpRequest() {}
  }
}));

describe('HttpTransport Security Headers', () => {
  function createTransport() {
    return new HttpTransport(
      {
        host: '127.0.0.1',
        port: 0, // Random port
        metricsEnabled: false,
        heartbeatEnabled: false,
        heartbeatIntervalMs: 1000,
        sessionTimeoutMs: 60000,
      } as any,
      new ConsoleLogger()
    );
  }

  it('should include Strict-Transport-Security header', async () => {
    const transport = createTransport();
    const app = (transport as any).app;

    const response = await request(app).get('/health');

    // HSTS should be enabled with long duration and include subdomains
    expect(response.headers['strict-transport-security']).toBe('max-age=63072000; includeSubDomains');
  });

  it('should include X-XSS-Protection header', async () => {
    const transport = createTransport();
    const app = (transport as any).app;

    const response = await request(app).get('/health');

    // X-XSS-Protection should be disabled (0) in favor of CSP
    expect(response.headers['x-xss-protection']).toBe('0');
  });
});
