import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { HttpTransport } from './http-transport.js';
import { ConsoleLogger } from '../core/logger.js';
import { CAN_LISTEN } from '../testing/listen-support.js';

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

describe('HttpTransport HSTS Header', () => {
  (CAN_LISTEN ? it : it.skip)('sets Strict-Transport-Security header', async () => {
    const transport = createTransport();
    const app = (transport as any).app;

    const response = await request(app).get('/health');

    // This expectation should fail initially
    expect(response.headers['strict-transport-security']).toBe('max-age=63072000; includeSubDomains');

    await transport.stop();
  });
});
