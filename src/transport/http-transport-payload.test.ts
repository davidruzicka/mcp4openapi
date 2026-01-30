
import { it, expect, beforeAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { HttpTransport } from './http-transport.js';
import { ConsoleLogger } from '../core/logger.js';
import { describeIfListen } from '../testing/listen-support.js';

describeIfListen('Payload Size Limits', () => {
  let transport: HttpTransport;
  let app: express.Application;

  beforeAll(async () => {
    const logger = new ConsoleLogger();
    transport = new HttpTransport({
      port: 0, // Random port
      host: 'localhost',
      metricsEnabled: false,
      rateLimitEnabled: false, // Disable rate limit for this test
      oauthConfig: {
        client_id: 'test-client',
        client_secret: 'test-secret',
        redirect_uri: 'http://localhost/callback',
        authorization_endpoint: 'http://localhost/auth',
        token_endpoint: 'http://localhost/token',
        scopes: ['api']
      }
    }, logger);

    // We need to access the app instance to use supertest
    // Since app is private, we can cast to any
    app = (transport as any).app;
  });

  it('should accept 1MB JSON payloads (now allowed)', async () => {
    const largeData = 'x'.repeat(1024 * 1024); // 1MB
    const response = await request(app)
      .post('/mcp')
      .send({
        jsonrpc: '2.0',
        method: 'ping',
        id: 1,
        params: { data: largeData }
      })
      .set('Accept', 'application/json');

    // Should PASS (not 413) because limit is 10mb
    expect(response.status).not.toBe(413);
  });

  it('should reject extremely large JSON payloads (>10MB)', async () => {
    const largeData = 'x'.repeat(11 * 1024 * 1024); // 11MB

    const response = await request(app)
      .post('/mcp')
      .send({
        jsonrpc: '2.0',
        method: 'ping',
        id: 1,
        params: { data: largeData }
      })
      .set('Accept', 'application/json');

    expect(response.status).toBe(413);
  });

  it('should reject large URL-encoded payloads (>50kb) for OAuth', async () => {
    // 60kb payload
    const largeData = 'x'.repeat(60 * 1024);

    const response = await request(app)
      .post('/oauth/token')
      .send(`grant_type=client_credentials&data=${largeData}`)
      .set('Content-Type', 'application/x-www-form-urlencoded');

    // Should FAIL (413) because limit is 50kb
    expect(response.status).toBe(413);
  });
});
