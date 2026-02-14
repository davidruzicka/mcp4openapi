import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { HttpTransport } from './http-transport.js';
import { ConsoleLogger } from '../core/logger.js';
import { AuthInterceptor } from '../types/profile.js';

describe('Auth Bypass Reproduction', () => {
  let transport: HttpTransport;
  const logger = new ConsoleLogger();

  beforeEach(() => {
    const config = {
      host: '127.0.0.1',
      port: 0,
      sessionTimeoutMs: 1800000,
      heartbeatEnabled: false,
      metricsEnabled: false,
      defaultProfileId: 'default',
    };
    transport = new HttpTransport(config, logger);
  });

  afterEach(async () => {
    await transport.stop();
  });

  it('should reject initialization without token when auth is configured', async () => {
    // Setup profile with auth required
    const authConfig: AuthInterceptor = {
      type: 'custom-header',
      header_name: 'X-API-Key',
      value_from_env: 'API_KEY'
    };

    const profileContext = {
      profileId: 'default',
      authConfigs: [authConfig],
      baseUrl: 'http://example.com'
    };

    transport.setProfileContextProvider(async () => profileContext);

    // Mock request
    const req = {
      method: 'POST',
      url: '/mcp',
      path: '/mcp',
      headers: {
        'content-type': 'application/json',
        // No X-API-Key header!
      },
      body: {
        jsonrpc: '2.0',
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0' }
        },
        id: 1
      },
      get: (name: string) => {
        if (name === 'content-type') return 'application/json';
        return undefined;
      }
    };

    const res = {
      statusCode: 200,
      headers: {},
      body: null,
      setHeader(name: string, value: string) {
        this.headers[name] = value;
      },
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(body: any) {
        this.body = body;
        return this;
      },
      send(body: any) {
        this.body = body;
        return this;
      }
    };

    // Mock message handler
    transport.setMessageHandler(async (msg) => {
      return { result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'server', version: '1.0' } } };
    });

    // Execute handlePost
    await (transport as any).handlePost(req, res);

    // Expectation: Status should be 401
    console.log('Status Code:', res.statusCode);
    console.log('Body:', JSON.stringify(res.body));

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual(expect.objectContaining({ error: 'Unauthorized' }));
  });
});
