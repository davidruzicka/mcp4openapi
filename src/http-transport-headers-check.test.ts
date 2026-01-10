
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import type { Express, Request, Response, NextFunction } from 'express';
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

  it('should have correct security headers on localhost (HSTS absent)', async () => {
    const response = await request(app).get('/health');

    // Headers that SHOULD be present
    expect(response.headers['content-security-policy']).toBe("default-src 'self'; frame-ancestors 'none'");
    expect(response.headers['x-frame-options']).toBe('DENY');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['referrer-policy']).toBe('no-referrer');

    // HSTS should be ABSENT for localhost
    expect(response.headers['strict-transport-security']).toBeUndefined();

    // X-Powered-By should be REMOVED
    expect(response.headers['x-powered-by']).toBeUndefined();
  });

  it('should have HSTS header on non-localhost production domain', async () => {
    // We need to simulate a request with a different hostname
    // Since supertest/express uses the Host header to determine hostname, we can try setting it.
    // However, the internal middleware uses req.hostname.
    // In Express, req.hostname is derived from Host header (and X-Forwarded-Host if trusted proxy set).
    // Our transport doesn't enable 'trust proxy' by default, so it relies on Host header.

    // We also need to bypass the DNS rebinding protection which checks Host header against config.host (127.0.0.1)
    // The DNS rebinding protection middleware runs BEFORE our security headers middleware.
    // If we send a "bad" host, it will return 403 Forbidden.
    // BUT, the security middleware is also global.
    // Let's check order in `setupMiddleware` in `src/http-transport.ts`.

    // 1. Request logging
    // 2. DNS rebinding protection (checks Host header) -> RETURNS 403 if bad
    // ...
    // 4. Security headers (our new middleware)

    // So if we send a "bad" Host header, we'll get a 403 from the rebinding protection,
    // AND our security middleware might NOT have run yet or the 403 response might not have headers set by it
    // (since 403 is sent and return called).

    // So we can't easily test HSTS with the current setup unless we:
    // A) Configure transport with a "production" host so rebinding protection accepts it.
    // B) Mock the request object or something deeper.

    // Let's try option A: Create a transport with a "fake" production host.

    const prodConfig = {
      host: 'api.example.com', // Fake production host
      port: 0,
      sessionTimeoutMs: 1800000,
      heartbeatEnabled: false,
      heartbeatIntervalMs: 30000,
      metricsEnabled: false,
      metricsPath: '/metrics',
    };

    const prodTransport = new HttpTransport(prodConfig, logger);
    const prodApp = (prodTransport as any).app;

    // Now we can make a request with Host: api.example.com
    const response = await request(prodApp)
      .get('/health')
      .set('Host', 'api.example.com');

    // Rebinding protection should pass (Host matches config.host)
    // Security middleware should see hostname 'api.example.com'
    // isIP('api.example.com') is 0 (false)
    // So HSTS SHOULD be present.

    expect(response.headers['strict-transport-security']).toBe('max-age=31536000; includeSubDomains');
    expect(response.headers['content-security-policy']).toBe("default-src 'self'; frame-ancestors 'none'");

    await prodTransport.stop();
  });

    it('should NOT have HSTS header on IP address host', async () => {
    const ipConfig = {
      host: '10.0.0.1', // Private IP
      port: 0,
      sessionTimeoutMs: 1800000,
      heartbeatEnabled: false,
      heartbeatIntervalMs: 30000,
      metricsEnabled: false,
      metricsPath: '/metrics',
    };

    const ipTransport = new HttpTransport(ipConfig, logger);
    const ipApp = (ipTransport as any).app;

    const response = await request(ipApp)
      .get('/health')
      .set('Host', '10.0.0.1');

    // Rebinding protection passes
    // hostname is '10.0.0.1'
    // isIP('10.0.0.1') is 4 (true)
    // HSTS should be ABSENT

    expect(response.headers['strict-transport-security']).toBeUndefined();

    await ipTransport.stop();
  });
});
