import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import https from 'node:https';
import type { McpRequest } from './types/http-transport.js';
import { HttpTransport } from './http-transport.js';
import { ConsoleLogger } from './logger.js';
import { AuthenticationError, AuthorizationError, RateLimitError, ValidationError } from './errors.js';

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

function getExpressRouteHandler(app: any, method: string, path: string): any {
  const stack = app?.router?.stack || app?._router?.stack;
  if (!Array.isArray(stack)) {
    throw new Error('Expected express app router stack to be available for test');
  }

  for (const layer of stack) {
    if (!layer?.route) continue;
    if (layer.route.path !== path) continue;
    if (!layer.route.methods?.[method]) continue;

    const handlers = layer.route.stack;
    if (!Array.isArray(handlers) || handlers.length === 0) {
      throw new Error(`No handlers registered for route ${method.toUpperCase()} ${path}`);
    }

    // The last handler is the route implementation (after any middleware like rate limiter)
    return handlers[handlers.length - 1].handle;
  }

  throw new Error(`Route not found: ${method.toUpperCase()} ${path}`);
}

function createMockResponse() {
  const res: any = {
    headersSent: false,
    statusCode: 200,
    headers: {} as Record<string, string>,
    setHeader: vi.fn((key: string, value: string) => {
      res.headers[key.toLowerCase()] = value;
    }),
    status: vi.fn((code: number) => {
      res.statusCode = code;
      return res;
    }),
    json: vi.fn((body: unknown) => {
      res.body = body;
      res.headersSent = true;
      return res;
    }),
    send: vi.fn((body?: unknown) => {
      res.body = body;
      res.headersSent = true;
      return res;
    }),
    end: vi.fn(() => {
      res.headersSent = true;
    }),
    get: vi.fn(() => undefined),
  };
  return res;
}

function createMockSseResponse() {
  const emitter = new EventEmitter();
  const res: any = Object.assign(emitter, {
    headersSent: false,
    writableEnded: false,
    statusCode: 200,
    headers: {} as Record<string, string>,
    setHeader: vi.fn((key: string, value: string) => {
      res.headers[key.toLowerCase()] = String(value);
    }),
    status: vi.fn((code: number) => {
      res.statusCode = code;
      return res;
    }),
    write: vi.fn(() => true),
    json: vi.fn((body: unknown) => {
      res.body = body;
      res.headersSent = true;
      return res;
    }),
    send: vi.fn((body?: unknown) => {
      res.body = body;
      res.headersSent = true;
      return res;
    }),
    end: vi.fn(() => {
      res.headersSent = true;
      res.writableEnded = true;
      emitter.emit('close');
    }),
    get: vi.fn(() => undefined),
  });
  return res;
}

describe('HttpTransport security behavior (no listen)', () => {
  it('returns 400 for invalid Authorization header format (no 500 leak)', async () => {
    const transport = createTransport();
    transport.setMessageHandler(async () => ({ result: 'ok' }));

    const req: McpRequest = {
      method: 'POST',
      path: '/mcp',
      url: '/mcp',
      headers: {
        accept: 'application/json',
        authorization: 'NotBearer abc',
        host: 'localhost',
      } as any,
      body: { jsonrpc: '2.0', id: 1, method: 'initialize' },
    } as any;

    const res = createMockResponse();
    await (transport as any).handlePost(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toHaveProperty('error', 'Bad Request');
    expect(res.body).toHaveProperty('correlationId');
    await transport.stop();
  });

  it('returns 500 with correlation ID and hides internal message', async () => {
    const transport = createTransport();
    transport.setMessageHandler(async () => {
      throw new Error('Sensitive internal failure');
    });

    const req: McpRequest = {
      method: 'POST',
      path: '/mcp',
      url: '/mcp',
      headers: {
        accept: 'application/json',
        host: 'localhost',
      } as any,
      body: { jsonrpc: '2.0', id: 1, method: 'initialize' },
    } as any;

    const res = createMockResponse();
    await (transport as any).handlePost(req, res);

    expect(res.statusCode).toBe(500);
    expect(res.body).toHaveProperty('error', 'Internal Server Error');
    expect(res.body).toHaveProperty('correlationId');
    expect(String(res.body.message)).toContain('correlation ID');
    expect(String(res.body.message)).not.toContain('Sensitive internal failure');
    await transport.stop();
  });

  it('maps AuthenticationError to 401 with correlation ID', async () => {
    const transport = new HttpTransport(
      {
        host: '127.0.0.1',
        port: 0,
        sessionTimeoutMs: 1800000,
        heartbeatEnabled: false,
        heartbeatIntervalMs: 30000,
        metricsEnabled: false,
        metricsPath: '/metrics',
      },
      new ConsoleLogger()
    );
    transport.setMessageHandler(async () => {
      throw new AuthenticationError('Missing token');
    });

    const req: McpRequest = {
      method: 'POST',
      path: '/mcp',
      url: '/mcp',
      headers: { accept: 'application/json', host: 'localhost' } as any,
      body: { jsonrpc: '2.0', id: 1, method: 'initialize' },
    } as any;

    const res = createMockResponse();
    await (transport as any).handlePost(req, res);

    expect(res.statusCode).toBe(401);
    expect(res.body).toHaveProperty('error', 'Unauthorized');
    expect(res.body).toHaveProperty('correlationId');
    await transport.stop();
  });

  it('maps AuthorizationError to 403 with correlation ID', async () => {
    const transport = new HttpTransport(
      {
        host: '127.0.0.1',
        port: 0,
        sessionTimeoutMs: 1800000,
        heartbeatEnabled: false,
        heartbeatIntervalMs: 30000,
        metricsEnabled: false,
        metricsPath: '/metrics',
      },
      new ConsoleLogger()
    );
    transport.setMessageHandler(async () => {
      throw new AuthorizationError('Forbidden');
    });

    const req: McpRequest = {
      method: 'POST',
      path: '/mcp',
      url: '/mcp',
      headers: { accept: 'application/json', host: 'localhost' } as any,
      body: { jsonrpc: '2.0', id: 1, method: 'initialize' },
    } as any;

    const res = createMockResponse();
    await (transport as any).handlePost(req, res);

    expect(res.statusCode).toBe(403);
    expect(res.body).toHaveProperty('error', 'Forbidden');
    expect(res.body).toHaveProperty('correlationId');
    await transport.stop();
  });

  it('maps RateLimitError to 429 with correlation ID', async () => {
    const transport = new HttpTransport(
      {
        host: '127.0.0.1',
        port: 0,
        sessionTimeoutMs: 1800000,
        heartbeatEnabled: false,
        heartbeatIntervalMs: 30000,
        metricsEnabled: false,
        metricsPath: '/metrics',
      },
      new ConsoleLogger()
    );
    transport.setMessageHandler(async () => {
      throw new RateLimitError('Too many requests', 60);
    });

    const req: McpRequest = {
      method: 'POST',
      path: '/mcp',
      url: '/mcp',
      headers: { accept: 'application/json', host: 'localhost' } as any,
      body: { jsonrpc: '2.0', id: 1, method: 'initialize' },
    } as any;

    const res = createMockResponse();
    await (transport as any).handlePost(req, res);

    expect(res.statusCode).toBe(429);
    expect(res.body).toHaveProperty('error', 'Too Many Requests');
    expect(res.body).toHaveProperty('correlationId');
    await transport.stop();
  });

  it('maps ValidationError to 400 with correlation ID', async () => {
    const transport = new HttpTransport(
      {
        host: '127.0.0.1',
        port: 0,
        sessionTimeoutMs: 1800000,
        heartbeatEnabled: false,
        heartbeatIntervalMs: 30000,
        metricsEnabled: false,
        metricsPath: '/metrics',
      },
      new ConsoleLogger()
    );
    transport.setMessageHandler(async () => {
      throw new ValidationError('Bad input');
    });

    const req: McpRequest = {
      method: 'POST',
      path: '/mcp',
      url: '/mcp',
      headers: { accept: 'application/json', host: 'localhost' } as any,
      body: { jsonrpc: '2.0', id: 1, method: 'initialize' },
    } as any;

    const res = createMockResponse();
    await (transport as any).handlePost(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toHaveProperty('error', 'Bad Request');
    expect(res.body).toHaveProperty('correlationId');
    await transport.stop();
  });

  it('serves protected resource metadata without optional fields when unset (OAuth)', async () => {
    const transport = new HttpTransport(
      {
        host: '127.0.0.1',
        port: 0,
        sessionTimeoutMs: 1800000,
        heartbeatEnabled: false,
        heartbeatIntervalMs: 30000,
        metricsEnabled: false,
        metricsPath: '/metrics',
        oauthConfig: {
          issuer: 'https://auth.example.com',
          client_id: 'test-client',
          client_secret: 'test-secret',
          scopes: [],
        },
      } as any,
      new ConsoleLogger()
    );

    const app = (transport as any).app;
    const handler = getExpressRouteHandler(app, 'get', '/.well-known/oauth-protected-resource/mcp');
    const req: any = { query: {}, headers: {} };
    const res = createMockResponse();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('resource');
    expect(res.body).toHaveProperty('authorization_servers');
    expect(res.body).toHaveProperty('bearer_methods_supported');
    expect(res.body).not.toHaveProperty('resource_name');
    expect(res.body).not.toHaveProperty('resource_documentation');
    expect(res.body).not.toHaveProperty('scopes_supported');

    await transport.stop();
  });

  it('includes optional protected resource metadata fields when configured (OAuth)', async () => {
    const transport = new HttpTransport(
      {
        host: '127.0.0.1',
        port: 0,
        sessionTimeoutMs: 1800000,
        heartbeatEnabled: false,
        heartbeatIntervalMs: 30000,
        metricsEnabled: false,
        metricsPath: '/metrics',
        oauthConfig: {
          issuer: 'https://auth.example.com',
          client_id: 'test-client',
          client_secret: 'test-secret',
          scopes: ['read'],
        },
        resourceName: 'Test MCP Server',
        resourceDocumentation: 'https://docs.example.com',
      } as any,
      new ConsoleLogger()
    );

    const app = (transport as any).app;
    const handler = getExpressRouteHandler(app, 'get', '/.well-known/oauth-protected-resource/mcp');
    const req: any = { query: {}, headers: {} };
    const res = createMockResponse();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('resource_name', 'Test MCP Server');
    expect(res.body).toHaveProperty('resource_documentation', 'https://docs.example.com');
    expect(res.body).toHaveProperty('scopes_supported');
    expect(res.body.scopes_supported).toContain('read');

    await transport.stop();
  });

  it('rejects /oauth/authorize when redirect_uri is missing (no network)', async () => {
    const transport = new HttpTransport(
      {
        host: '127.0.0.1',
        port: 0,
        sessionTimeoutMs: 1800000,
        heartbeatEnabled: false,
        heartbeatIntervalMs: 30000,
        metricsEnabled: false,
        metricsPath: '/metrics',
        oauthConfig: {
          issuer: 'https://auth.example.com',
          client_id: 'test-client',
          client_secret: 'test-secret',
          scopes: ['read'],
        },
      } as any,
      new ConsoleLogger()
    );

    const app = (transport as any).app;
    const handler = getExpressRouteHandler(app, 'get', '/oauth/authorize');
    const req: any = { query: { response_type: 'code', client_id: 'test-client' }, headers: {} };
    const res = createMockResponse();
    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(String(res.body)).toContain('Missing redirect_uri');

    await transport.stop();
  });

  it('rejects /oauth/authorize when client_id is missing (no network)', async () => {
    const transport = new HttpTransport(
      {
        host: '127.0.0.1',
        port: 0,
        sessionTimeoutMs: 1800000,
        heartbeatEnabled: false,
        heartbeatIntervalMs: 30000,
        metricsEnabled: false,
        metricsPath: '/metrics',
        oauthConfig: {
          issuer: 'https://auth.example.com',
          client_id: 'test-client',
          client_secret: 'test-secret',
          scopes: ['read'],
        },
      } as any,
      new ConsoleLogger()
    );

    const app = (transport as any).app;
    const handler = getExpressRouteHandler(app, 'get', '/oauth/authorize');
    const req: any = { query: { response_type: 'code', redirect_uri: 'http://localhost/cb' }, headers: {} };
    const res = createMockResponse();
    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(String(res.body)).toContain('Missing client_id');

    await transport.stop();
  });

  it('rejects /oauth/authorize when client_id is invalid (no network)', async () => {
    const transport = new HttpTransport(
      {
        host: '127.0.0.1',
        port: 0,
        sessionTimeoutMs: 1800000,
        heartbeatEnabled: false,
        heartbeatIntervalMs: 30000,
        metricsEnabled: false,
        metricsPath: '/metrics',
        oauthConfig: {
          issuer: 'https://auth.example.com',
          client_id: 'test-client',
          client_secret: 'test-secret',
          scopes: ['read'],
        },
      } as any,
      new ConsoleLogger()
    );

    (transport as any).oauthProvider = {
      ensureEndpointsInitialized: async () => {},
      clientsStore: { getClient: async () => undefined },
      authorize: async () => {},
    };

    const app = (transport as any).app;
    const handler = getExpressRouteHandler(app, 'get', '/oauth/authorize');
    const req: any = {
      query: {
        response_type: 'code',
        client_id: 'unknown-client',
        redirect_uri: 'http://localhost/cb',
      },
      headers: {},
    };
    const res = createMockResponse();
    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(String(res.body)).toContain('Invalid client_id');

    await transport.stop();
  });

  it('executes /oauth/authorize happy path and calls provider authorize (no network)', async () => {
    const transport = new HttpTransport(
      {
        host: '127.0.0.1',
        port: 0,
        sessionTimeoutMs: 1800000,
        heartbeatEnabled: false,
        heartbeatIntervalMs: 30000,
        metricsEnabled: false,
        metricsPath: '/metrics',
        oauthConfig: {
          issuer: 'https://auth.example.com',
          client_id: 'test-client',
          client_secret: 'test-secret',
          scopes: ['read'],
        },
      } as any,
      new ConsoleLogger()
    );

    const authorize = vi.fn(async () => {});
    (transport as any).oauthProvider = {
      ensureEndpointsInitialized: async () => {},
      clientsStore: { getClient: async () => ({ client_id: 'test-client', scope: 'read write' }) },
      authorize,
    };

    const app = (transport as any).app;
    const handler = getExpressRouteHandler(app, 'get', '/oauth/authorize');
    const req: any = {
      query: {
        response_type: 'code',
        client_id: 'test-client',
        redirect_uri: 'http://localhost/cb',
        scope: 'read write',
        state: 'abc',
        code_challenge: 'challenge',
        code_challenge_method: 'S256',
      },
      headers: {},
    };
    const res = createMockResponse();
    await handler(req, res);

    expect(authorize).toHaveBeenCalled();
    expect(authorize.mock.calls[0][1]).toMatchObject({
      responseType: 'code',
      clientId: 'test-client',
      redirectUri: 'http://localhost/cb',
      scopes: ['read', 'write'],
    });

    await transport.stop();
  });

  it('handles /oauth/authorize when provider is missing (no network)', async () => {
    const transport = new HttpTransport(
      {
        host: '127.0.0.1',
        port: 0,
        sessionTimeoutMs: 1800000,
        heartbeatEnabled: false,
        heartbeatIntervalMs: 30000,
        metricsEnabled: false,
        metricsPath: '/metrics',
        oauthConfig: {
          issuer: 'https://auth.example.com',
          client_id: 'test-client',
          client_secret: 'test-secret',
          scopes: ['read'],
        },
      } as any,
      new ConsoleLogger()
    );

    (transport as any).oauthProvider = null;

    const app = (transport as any).app;
    const handler = getExpressRouteHandler(app, 'get', '/oauth/authorize');
    const req: any = { query: { response_type: 'code', client_id: 'x', redirect_uri: 'http://localhost/cb' }, headers: {} };
    const res = createMockResponse();
    await handler(req, res);

    expect(res.statusCode).toBe(500);
    expect(String(res.body)).toContain('OAuth provider not initialized');

    await transport.stop();
  });

  it('handles /oauth/authorize provider errors (no network)', async () => {
    const transport = new HttpTransport(
      {
        host: '127.0.0.1',
        port: 0,
        sessionTimeoutMs: 1800000,
        heartbeatEnabled: false,
        heartbeatIntervalMs: 30000,
        metricsEnabled: false,
        metricsPath: '/metrics',
        oauthConfig: {
          issuer: 'https://auth.example.com',
          client_id: 'test-client',
          client_secret: 'test-secret',
          scopes: ['read'],
        },
      } as any,
      new ConsoleLogger()
    );

    (transport as any).oauthProvider = {
      ensureEndpointsInitialized: async () => {},
      clientsStore: { getClient: async () => ({ client_id: 'test-client' }) },
      authorize: async () => {
        throw new Error('boom');
      },
    };

    const app = (transport as any).app;
    const handler = getExpressRouteHandler(app, 'get', '/oauth/authorize');
    const req: any = { query: { response_type: 'code', client_id: 'test-client', redirect_uri: 'http://localhost/cb' }, headers: {} };
    const res = createMockResponse();
    await handler(req, res);

    expect(res.statusCode).toBe(500);
    expect(String(res.body)).toContain('OAuth authorization failed');

    await transport.stop();
  });

  it('rejects /oauth/token unsupported grant type (no network)', async () => {
    const transport = new HttpTransport(
      {
        host: '127.0.0.1',
        port: 0,
        sessionTimeoutMs: 1800000,
        heartbeatEnabled: false,
        heartbeatIntervalMs: 30000,
        metricsEnabled: false,
        metricsPath: '/metrics',
        oauthConfig: {
          issuer: 'https://auth.example.com',
          client_id: 'test-client',
          client_secret: 'test-secret',
          scopes: ['read'],
        },
      } as any,
      new ConsoleLogger()
    );

    const app = (transport as any).app;
    const handler = getExpressRouteHandler(app, 'post', '/oauth/token');
    const req: any = { body: { grant_type: 'client_credentials' }, headers: {} };
    const res = createMockResponse();
    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ error: 'unsupported_grant_type' });

    await transport.stop();
  });

  it('rejects /oauth/token authorization_code when code is missing (no network)', async () => {
    const transport = new HttpTransport(
      {
        host: '127.0.0.1',
        port: 0,
        sessionTimeoutMs: 1800000,
        heartbeatEnabled: false,
        heartbeatIntervalMs: 30000,
        metricsEnabled: false,
        metricsPath: '/metrics',
        oauthConfig: {
          issuer: 'https://auth.example.com',
          client_id: 'test-client',
          client_secret: 'test-secret',
          scopes: ['read'],
        },
      } as any,
      new ConsoleLogger()
    );

    const app = (transport as any).app;
    const handler = getExpressRouteHandler(app, 'post', '/oauth/token');
    const req: any = { body: { grant_type: 'authorization_code' }, headers: {} };
    const res = createMockResponse();
    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ error: 'invalid_request', error_description: 'Missing code' });

    await transport.stop();
  });

  it('rejects /oauth/token refresh_token when refresh_token is missing (no network)', async () => {
    const transport = new HttpTransport(
      {
        host: '127.0.0.1',
        port: 0,
        sessionTimeoutMs: 1800000,
        heartbeatEnabled: false,
        heartbeatIntervalMs: 30000,
        metricsEnabled: false,
        metricsPath: '/metrics',
        oauthConfig: {
          issuer: 'https://auth.example.com',
          client_id: 'test-client',
          client_secret: 'test-secret',
          scopes: ['read'],
        },
      } as any,
      new ConsoleLogger()
    );

    const app = (transport as any).app;
    const handler = getExpressRouteHandler(app, 'post', '/oauth/token');
    const req: any = { body: { grant_type: 'refresh_token' }, headers: {} };
    const res = createMockResponse();
    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ error: 'invalid_request', error_description: 'Missing refresh_token' });

    await transport.stop();
  });

  it('returns invalid_client for /oauth/token when client is unknown (no network)', async () => {
    const transport = new HttpTransport(
      {
        host: '127.0.0.1',
        port: 0,
        sessionTimeoutMs: 1800000,
        heartbeatEnabled: false,
        heartbeatIntervalMs: 30000,
        metricsEnabled: false,
        metricsPath: '/metrics',
        oauthConfig: {
          issuer: 'https://auth.example.com',
          client_id: 'test-client',
          client_secret: 'test-secret',
          scopes: ['read'],
        },
      } as any,
      new ConsoleLogger()
    );

    (transport as any).oauthProvider = {
      ensureEndpointsInitialized: async () => {},
      clientsStore: { getClient: async () => undefined },
      exchangeAuthorizationCode: async () => ({}),
    };

    const app = (transport as any).app;
    const handler = getExpressRouteHandler(app, 'post', '/oauth/token');
    const req: any = { body: { grant_type: 'authorization_code', code: 'abc', client_id: 'unknown' }, headers: {} };
    const res = createMockResponse();
    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ error: 'invalid_client' });

    await transport.stop();
  });

  it('handles /oauth/token authorization_code when provider is missing (no network)', async () => {
    const transport = new HttpTransport(
      {
        host: '127.0.0.1',
        port: 0,
        sessionTimeoutMs: 1800000,
        heartbeatEnabled: false,
        heartbeatIntervalMs: 30000,
        metricsEnabled: false,
        metricsPath: '/metrics',
        oauthConfig: {
          issuer: 'https://auth.example.com',
          client_id: 'test-client',
          client_secret: 'test-secret',
          scopes: ['read'],
        },
      } as any,
      new ConsoleLogger()
    );

    (transport as any).oauthProvider = null;

    const app = (transport as any).app;
    const handler = getExpressRouteHandler(app, 'post', '/oauth/token');
    const req: any = { body: { grant_type: 'authorization_code', code: 'abc' }, headers: {} };
    const res = createMockResponse();
    await handler(req, res);

    expect(res.statusCode).toBe(500);
    expect(res.body).toMatchObject({ error: 'server_error' });

    await transport.stop();
  });

  it('exchanges /oauth/token authorization_code and returns tokens (no network)', async () => {
    const transport = new HttpTransport(
      {
        host: '127.0.0.1',
        port: 0,
        sessionTimeoutMs: 1800000,
        heartbeatEnabled: false,
        heartbeatIntervalMs: 30000,
        metricsEnabled: false,
        metricsPath: '/metrics',
        oauthConfig: {
          issuer: 'https://auth.example.com',
          client_id: 'test-client',
          client_secret: 'test-secret',
          scopes: ['read'],
        },
      } as any,
      new ConsoleLogger()
    );

    const tokens = { access_token: 'access', token_type: 'Bearer', expires_in: 3600 };
    (transport as any).oauthProvider = {
      ensureEndpointsInitialized: async () => {},
      clientsStore: { getClient: async () => ({ client_id: 'test-client', scope: 'read' }) },
      exchangeAuthorizationCode: async () => tokens,
    };

    const app = (transport as any).app;
    const handler = getExpressRouteHandler(app, 'post', '/oauth/token');
    const req: any = { body: { grant_type: 'authorization_code', code: 'abc', client_id: 'test-client' }, headers: {} };
    const res = createMockResponse();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject(tokens);

    await transport.stop();
  });

  it('returns invalid_grant for /oauth/token when exchange throws (no network)', async () => {
    const transport = new HttpTransport(
      {
        host: '127.0.0.1',
        port: 0,
        sessionTimeoutMs: 1800000,
        heartbeatEnabled: false,
        heartbeatIntervalMs: 30000,
        metricsEnabled: false,
        metricsPath: '/metrics',
        oauthConfig: {
          issuer: 'https://auth.example.com',
          client_id: 'test-client',
          client_secret: 'test-secret',
          scopes: ['read'],
        },
      } as any,
      new ConsoleLogger()
    );

    (transport as any).oauthProvider = {
      ensureEndpointsInitialized: async () => {},
      clientsStore: { getClient: async () => ({ client_id: 'test-client', scope: 'read' }) },
      exchangeAuthorizationCode: async () => {
        throw new Error('bad code');
      },
    };

    const app = (transport as any).app;
    const handler = getExpressRouteHandler(app, 'post', '/oauth/token');
    const req: any = { body: { grant_type: 'authorization_code', code: 'abc', client_id: 'test-client' }, headers: {} };
    const res = createMockResponse();
    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ error: 'invalid_grant' });
    expect(String(res.body.error_description)).toContain('bad code');

    await transport.stop();
  });

  it('returns invalid_grant for /oauth/token refresh_token when exchange throws (no network)', async () => {
    const transport = new HttpTransport(
      {
        host: '127.0.0.1',
        port: 0,
        sessionTimeoutMs: 1800000,
        heartbeatEnabled: false,
        heartbeatIntervalMs: 30000,
        metricsEnabled: false,
        metricsPath: '/metrics',
        oauthConfig: {
          issuer: 'https://auth.example.com',
          client_id: 'test-client',
          client_secret: 'test-secret',
          scopes: ['read'],
        },
      } as any,
      new ConsoleLogger()
    );

    (transport as any).oauthProvider = {
      ensureEndpointsInitialized: async () => {},
      clientsStore: { getClient: async () => ({ client_id: 'test-client', scope: 'read' }) },
      exchangeRefreshToken: async () => {
        throw new Error('bad refresh');
      },
    };

    const app = (transport as any).app;
    const handler = getExpressRouteHandler(app, 'post', '/oauth/token');
    const req: any = { body: { grant_type: 'refresh_token', refresh_token: 'rt', client_id: 'test-client' }, headers: {} };
    const res = createMockResponse();
    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ error: 'invalid_grant' });
    expect(String(res.body.error_description)).toContain('bad refresh');

    await transport.stop();
  });

  it('rejects /oauth/callback when OAuth error is provided and sanitizes output (no network)', async () => {
    const transport = new HttpTransport(
      {
        host: '127.0.0.1',
        port: 0,
        sessionTimeoutMs: 1800000,
        heartbeatEnabled: false,
        heartbeatIntervalMs: 30000,
        metricsEnabled: false,
        metricsPath: '/metrics',
        oauthConfig: {
          issuer: 'https://auth.example.com',
          client_id: 'test-client',
          client_secret: 'test-secret',
          scopes: ['read'],
        },
      } as any,
      new ConsoleLogger()
    );

    const app = (transport as any).app;
    const handler = getExpressRouteHandler(app, 'get', '/oauth/callback');
    const req: any = {
      query: { error: '<script>alert(1)</script>', error_description: '<b>nope</b>' },
      headers: {},
    };
    const res = createMockResponse();
    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(String(res.body.error)).not.toContain('<');
    expect(String(res.body.error_description)).not.toContain('<');

    await transport.stop();
  });

  it('rejects /oauth/callback when code is missing (no network)', async () => {
    const transport = new HttpTransport(
      {
        host: '127.0.0.1',
        port: 0,
        sessionTimeoutMs: 1800000,
        heartbeatEnabled: false,
        heartbeatIntervalMs: 30000,
        metricsEnabled: false,
        metricsPath: '/metrics',
        oauthConfig: {
          issuer: 'https://auth.example.com',
          client_id: 'test-client',
          client_secret: 'test-secret',
          scopes: ['read'],
        },
      } as any,
      new ConsoleLogger()
    );

    const app = (transport as any).app;
    const handler = getExpressRouteHandler(app, 'get', '/oauth/callback');
    const req: any = { query: {}, headers: {} };
    const res = createMockResponse();
    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(String(res.body)).toContain('Missing authorization code');

    await transport.stop();
  });

  it('handles /oauth/callback when provider is missing (no network)', async () => {
    const transport = new HttpTransport(
      {
        host: '127.0.0.1',
        port: 0,
        sessionTimeoutMs: 1800000,
        heartbeatEnabled: false,
        heartbeatIntervalMs: 30000,
        metricsEnabled: false,
        metricsPath: '/metrics',
        oauthConfig: {
          issuer: 'https://auth.example.com',
          client_id: 'test-client',
          client_secret: 'test-secret',
          scopes: ['read'],
        },
      } as any,
      new ConsoleLogger()
    );

    (transport as any).oauthProvider = null;

    const app = (transport as any).app;
    const handler = getExpressRouteHandler(app, 'get', '/oauth/callback');
    const req: any = { query: { code: 'abc' }, headers: {} };
    const res = createMockResponse();
    await handler(req, res);

    expect(res.statusCode).toBe(500);
    expect(String(res.body)).toContain('OAuth provider not initialized');

    await transport.stop();
  });

  it('handles /oauth/callback provider exception and returns 500 if headers not sent (no network)', async () => {
    const transport = new HttpTransport(
      {
        host: '127.0.0.1',
        port: 0,
        sessionTimeoutMs: 1800000,
        heartbeatEnabled: false,
        heartbeatIntervalMs: 30000,
        metricsEnabled: false,
        metricsPath: '/metrics',
        oauthConfig: {
          issuer: 'https://auth.example.com',
          client_id: 'test-client',
          client_secret: 'test-secret',
          scopes: ['read'],
        },
      } as any,
      new ConsoleLogger()
    );

    (transport as any).oauthProvider = {
      handleCallback: async () => {
        throw new Error('callback boom');
      },
    };

    const app = (transport as any).app;
    const handler = getExpressRouteHandler(app, 'get', '/oauth/callback');
    const req: any = { query: { code: 'abc' }, headers: {} };
    const res = createMockResponse();
    await handler(req, res);

    expect(res.statusCode).toBe(500);
    expect(String(res.body)).toContain('OAuth callback failed');

    await transport.stop();
  });

  it('does not send for /oauth/callback provider exception when headers already sent (no network)', async () => {
    const transport = new HttpTransport(
      {
        host: '127.0.0.1',
        port: 0,
        sessionTimeoutMs: 1800000,
        heartbeatEnabled: false,
        heartbeatIntervalMs: 30000,
        metricsEnabled: false,
        metricsPath: '/metrics',
        oauthConfig: {
          issuer: 'https://auth.example.com',
          client_id: 'test-client',
          client_secret: 'test-secret',
          scopes: ['read'],
        },
      } as any,
      new ConsoleLogger()
    );

    (transport as any).oauthProvider = {
      handleCallback: async () => {
        throw new Error('callback boom');
      },
    };

    const app = (transport as any).app;
    const handler = getExpressRouteHandler(app, 'get', '/oauth/callback');
    const req: any = { query: { code: 'abc' }, headers: {} };
    const res = createMockResponse();
    res.headersSent = true;
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toBeUndefined();

    await transport.stop();
  });

  it('registers dynamic client on /oauth/register when provider exists (no network)', async () => {
    const transport = new HttpTransport(
      {
        host: '127.0.0.1',
        port: 0,
        sessionTimeoutMs: 1800000,
        heartbeatEnabled: false,
        heartbeatIntervalMs: 30000,
        metricsEnabled: false,
        metricsPath: '/metrics',
        oauthConfig: {
          issuer: 'https://auth.example.com',
          client_id: 'test-client',
          client_secret: 'test-secret',
          scopes: ['read', 'write'],
        },
      } as any,
      new ConsoleLogger()
    );

    const registerClient = vi.fn(async () => {});
    (transport as any).oauthProvider = {
      scopes: ['read', 'write'],
      clientsStore: { registerClient },
    };

    const app = (transport as any).app;
    const handler = getExpressRouteHandler(app, 'post', '/oauth/register');
    const req: any = { body: { redirect_uris: ['http://localhost/cb'] }, headers: {} };
    const res = createMockResponse();
    await handler(req, res);

    expect(res.statusCode).toBe(201);
    expect(res.body).toHaveProperty('client_id', 'mcp-proxy-client');
    expect(registerClient).toHaveBeenCalled();

    await transport.stop();
  });

  it('handles /oauth/register when provider is missing (no network)', async () => {
    const transport = new HttpTransport(
      {
        host: '127.0.0.1',
        port: 0,
        sessionTimeoutMs: 1800000,
        heartbeatEnabled: false,
        heartbeatIntervalMs: 30000,
        metricsEnabled: false,
        metricsPath: '/metrics',
        oauthConfig: {
          issuer: 'https://auth.example.com',
          client_id: 'test-client',
          client_secret: 'test-secret',
          scopes: ['read'],
        },
      } as any,
      new ConsoleLogger()
    );

    (transport as any).oauthProvider = null;

    const app = (transport as any).app;
    const handler = getExpressRouteHandler(app, 'post', '/oauth/register');
    const req: any = { body: { redirect_uris: ['http://localhost/cb'] }, headers: {} };
    const res = createMockResponse();
    await handler(req, res);

    expect(res.statusCode).toBe(201);
    expect(res.body).toHaveProperty('client_id', 'mcp-proxy-client');

    await transport.stop();
  });

  it('returns 500 from /oauth/register when registration fails (no network)', async () => {
    const transport = new HttpTransport(
      {
        host: '127.0.0.1',
        port: 0,
        sessionTimeoutMs: 1800000,
        heartbeatEnabled: false,
        heartbeatIntervalMs: 30000,
        metricsEnabled: false,
        metricsPath: '/metrics',
        oauthConfig: {
          issuer: 'https://auth.example.com',
          client_id: 'test-client',
          client_secret: 'test-secret',
          scopes: ['read'],
        },
      } as any,
      new ConsoleLogger()
    );

    (transport as any).oauthProvider = {
      scopes: ['read'],
      clientsStore: {
        registerClient: async () => {
          throw new Error('reg fail');
        },
      },
    };

    const app = (transport as any).app;
    const handler = getExpressRouteHandler(app, 'post', '/oauth/register');
    const req: any = { body: { redirect_uris: ['http://localhost/cb'] }, headers: {} };
    const res = createMockResponse();
    await handler(req, res);

    expect(res.statusCode).toBe(500);
    expect(res.body).toMatchObject({ error: 'server_error', error_description: 'Registration failed' });

    await transport.stop();
  });

  it('validates auth tokens for bearer/custom-header/query and handles fetch failures', async () => {
    const transport = createTransport();
    const originalFetch = global.fetch;

    try {
      global.fetch = vi.fn(async (url: any, init?: any) => {
        const urlString = url.toString();
        if (urlString.includes('fail')) {
          throw new Error('network down');
        }
        if (urlString.includes('query')) {
          expect(urlString).toContain('api_key=token123');
        }
        if (urlString.includes('header')) {
          expect(init?.headers?.['X-API-Key']).toBe('token123');
        }
        if (urlString.includes('bearer')) {
          expect(init?.headers?.Authorization).toBe('Bearer token123');
        }
        return { status: 204 } as any;
      });

      await expect(
        (transport as any).validateAuthToken(
          { type: 'bearer', validation_endpoint: '/bearer' },
          'token123',
          'https://api.example.com'
        )
      ).resolves.toBe(true);

      await expect(
        (transport as any).validateAuthToken(
          { type: 'custom-header', header_name: 'X-API-Key', validation_endpoint: '/header' },
          'token123',
          'https://api.example.com'
        )
      ).resolves.toBe(true);

      await expect(
        (transport as any).validateAuthToken(
          { type: 'query', query_param: 'api_key', validation_endpoint: '/query' },
          'token123',
          'https://api.example.com'
        )
      ).resolves.toBe(true);

      await expect(
        (transport as any).validateAuthToken(
          { type: 'bearer', validation_endpoint: '/fail' },
          'token123',
          'https://api.example.com'
        )
      ).resolves.toBe(false);
    } finally {
      global.fetch = originalFetch;
      await transport.stop();
    }
  });

  it('extracts OAuth token from session when session exists', async () => {
    const transport = createTransport();
    (transport as any).sessions.set('s1', {
      id: 's1',
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      sseStreams: new Map(),
      authToken: 'oauth-token',
      messageQueue: [],
    });

    const req: any = { headers: { }, sessionId: 's1' };
    const info = (transport as any).extractAuthToken(req);
    expect(info).toEqual({ type: 'oauth', token: 'oauth-token', sessionId: 's1' });
    await transport.stop();
  });

  it('rejects invalid token formats and header shapes', async () => {
    const transportHeaderLimit = createTransport({ maxTokenLength: 5 });
    const headerTooLong: any = {
      headers: {
        authorization: `Bearer ${'x'.repeat(100)}`,
      },
    };
    expect(() => (transportHeaderLimit as any).extractAuthToken(headerTooLong)).toThrow('Authorization header too long');
    await transportHeaderLimit.stop();

    const transport = createTransport({ maxTokenLength: 100 });
    const invalidChars: any = {
      headers: {
        authorization: 'Bearer bad*token',
      },
    };
    expect(() => (transport as any).extractAuthToken(invalidChars)).toThrow('Invalid Authorization token format');

    expect(() => (transport as any).validateToken('', 'Authorization token')).toThrow('Authorization token is empty');

    const apiTokenNotString: any = {
      headers: {
        'x-api-token': ['a', 'b'],
      },
    };
    expect(() => (transport as any).extractAuthToken(apiTokenNotString)).toThrow('X-API-Token must be a string');

    await transport.stop();
  });

  it('enforces Accept header rules for GET/POST in handlePost', async () => {
    const transport = createTransport();
    transport.setMessageHandler(async () => ({ result: 'ok' }));

    const res1 = createMockResponse();
    await (transport as any).handlePost(
      { method: 'GET', path: '/mcp', url: '/mcp', headers: { accept: 'application/json' }, body: {} } as any,
      res1
    );
    expect(res1.statusCode).toBe(406);

    const res2 = createMockResponse();
    await (transport as any).handlePost(
      { method: 'POST', path: '/mcp', url: '/mcp', headers: { accept: 'text/plain' }, body: {} } as any,
      res2
    );
    expect(res2.statusCode).toBe(406);

    await transport.stop();
  });

  it('triggers OAuth WWW-Authenticate on initialize when OAuth configured but token missing', async () => {
    const transport = createTransport({
      oauthConfig: {
        issuer: 'https://auth.example.com',
        client_id: 'test-client',
        client_secret: 'test-secret',
        scopes: ['api'],
      },
    });
    transport.setMessageHandler(async () => ({ result: 'ok' }));

    const req: McpRequest = {
      method: 'POST',
      path: '/mcp',
      url: '/mcp',
      headers: {
        accept: 'application/json',
        host: 'localhost',
      } as any,
      body: { jsonrpc: '2.0', id: 1, method: 'initialize' },
    } as any;

    const res = createMockResponse();
    await (transport as any).handlePost(req, res);

    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toContain('resource_metadata=');
    await transport.stop();
  });

  it('validates token during initialization and blocks when invalid', async () => {
    const transport = createTransport({
      baseUrl: 'https://api.example.com',
      authConfigs: [
        {
          type: 'bearer',
          value_from_env: 'MCP4_API_TOKEN',
          validation_endpoint: '/validate',
        },
      ],
    });
    transport.setMessageHandler(async () => ({ result: 'ok' }));

    const originalFetch = global.fetch;
    try {
      global.fetch = vi.fn(async () => ({ status: 401 }) as any);

      const req: any = {
        method: 'POST',
        path: '/mcp',
        url: '/mcp',
        headers: { accept: 'application/json', authorization: 'Bearer tok', host: 'localhost' },
        body: { jsonrpc: '2.0', id: 1, method: 'initialize' },
      };
      const res = createMockResponse();
      await (transport as any).handlePost(req, res);

      expect(res.statusCode).toBe(401);
      expect(res.body).toHaveProperty('message', 'Invalid or expired authentication token');
    } finally {
      global.fetch = originalFetch;
      await transport.stop();
    }
  });

  it('returns SSE response when Accept is text/event-stream exactly', async () => {
    const transport = createTransport();
    transport.setMessageHandler(async () => ({ result: 'ok' }));

    const req: any = {
      method: 'POST',
      path: '/mcp',
      url: '/mcp',
      headers: { accept: 'text/event-stream', host: 'localhost' },
      body: { jsonrpc: '2.0', id: 1, method: 'initialize' },
    };
    const res = createMockSseResponse();
    await (transport as any).handlePost(req, res);

    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.write).toHaveBeenCalled();
    await transport.stop();
  });

  it('validates handleGet errors and starts SSE stream on success', async () => {
    const transport = createTransport();

    const res1 = createMockResponse();
    await (transport as any).handleGet({ method: 'GET', path: '/mcp', url: '/mcp', headers: { accept: 'application/json' } } as any, res1);
    expect(res1.statusCode).toBe(405);

    const res2 = createMockResponse();
    await (transport as any).handleGet({ method: 'GET', path: '/mcp', url: '/mcp', headers: { accept: 'text/event-stream' } } as any, res2);
    expect(res2.statusCode).toBe(400);

    const res3 = createMockResponse();
    await (transport as any).handleGet({ method: 'GET', path: '/mcp', url: '/mcp', sessionId: 'missing', headers: { accept: 'text/event-stream', 'mcp-session-id': 'missing' } } as any, res3);
    expect(res3.statusCode).toBe(404);

    const sessionId = (transport as any).createSession(undefined, undefined, undefined, undefined, undefined);
    const res4 = createMockSseResponse();
    await (transport as any).handleGet({ method: 'GET', path: '/mcp', url: '/mcp', sessionId, headers: { accept: 'text/event-stream', 'mcp-session-id': sessionId } } as any, res4);
    expect((transport as any).sessions.get(sessionId).sseStreams.size).toBeGreaterThan(0);

    await transport.stop();
  });

  it('manages SSE replay, heartbeat, and message queues', async () => {
    vi.useFakeTimers();
    try {
      const transport = createTransport({ heartbeatEnabled: true, heartbeatIntervalMs: 10 });
      const sessionId = (transport as any).createSession(undefined, undefined, undefined, undefined, undefined);
      const res = createMockSseResponse();

      (transport as any).startSSEStream(res, sessionId, '1');

      const session = (transport as any).sessions.get(sessionId);
      const [streamId, streamState] = Array.from(session.sseStreams.entries())[0];
      streamState.messageQueue.push({ eventId: 1, data: { a: 1 }, timestamp: Date.now() });
      streamState.messageQueue.push({ eventId: 2, data: { a: 2 }, timestamp: Date.now() });
      streamState.messageQueue.push({ eventId: 3, data: { a: 3 }, timestamp: Date.now() });

      (transport as any).replayMessages(res, streamState);
      expect(res.write).toHaveBeenCalledWith('id: 2\n');

      // Heartbeat ping
      await vi.advanceTimersByTimeAsync(11);
      expect(res.write).toHaveBeenCalledWith(':ping\n\n');

      // Message queue trimming to last 100
      streamState.active = true;
      streamState.messageQueue = Array.from({ length: 100 }).map((_, i) => ({ eventId: i, data: i, timestamp: Date.now() }));
      (transport as any).sendToClient(sessionId, { hello: 'world' });
      expect(streamState.messageQueue).toHaveLength(100);

      // Close stream
      res.emit('close');
      expect(streamState.active).toBe(false);
      expect(session.sseStreams.get(streamId).active).toBe(false);

      await transport.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('destroys sessions, notifies listeners, and handles listener errors', async () => {
    const transport = createTransport();
    const destroyed: string[] = [];
    transport.onSessionDestroyed((sid: string) => destroyed.push(sid));
    transport.onSessionDestroyed(() => {
      throw new Error('listener boom');
    });

    const sessionId = (transport as any).createSession('tok', undefined, undefined, undefined, undefined);
    const res = createMockSseResponse();
    (transport as any).startSSEStream(res, sessionId);

    expect((transport as any).sessions.has(sessionId)).toBe(true);
    (transport as any).destroySession(sessionId);
    expect(destroyed).toContain(sessionId);
    expect((transport as any).sessions.has(sessionId)).toBe(false);

    await transport.stop();
  });

  it('stores OAuth tokens and handles missing access_token', async () => {
    const transport = createTransport();
    (transport as any).storeOAuthTokens({}, 'client', ['a']);
    (transport as any).storeOAuthTokens({ access_token: 'a', token_type: 'Bearer', expires_in: 1, refresh_token: 'r' }, 'client', ['a']);
    expect((transport as any).oauthTokensByAccessToken.has('a')).toBe(true);
    await transport.stop();
  });

  it('cleans up expired sessions with oauthSessionTimeoutMs rules', async () => {
    const transport = createTransport({ sessionTimeoutMs: 10, oauthSessionTimeoutMs: 0 });
    const now = Date.now();

    (transport as any).sessions.set('oauth-old', {
      id: 'oauth-old',
      createdAt: now,
      lastActivityAt: now - 30,
      sseStreams: new Map(),
      authToken: 't1',
      refreshToken: 'r1',
      messageQueue: [],
    });
    (transport as any).sessions.set('plain-old', {
      id: 'plain-old',
      createdAt: now,
      lastActivityAt: now - 30,
      sseStreams: new Map(),
      authToken: 't2',
      messageQueue: [],
    });
    (transport as any).sessions.set('oauth-never', {
      id: 'oauth-never',
      createdAt: now,
      lastActivityAt: now - 999999,
      sseStreams: new Map(),
      authToken: 't3',
      refreshToken: 'r3',
      messageQueue: [],
    });

    (transport as any).cleanupExpiredSessions();
    expect((transport as any).sessions.has('plain-old')).toBe(false);
    expect((transport as any).sessions.has('oauth-old')).toBe(true);
    expect((transport as any).sessions.has('oauth-never')).toBe(true);

    await transport.stop();
  });

  it('refreshes OAuth tokens when expiring and updates token map', async () => {
    const transport = createTransport({
      oauthConfig: { issuer: 'https://auth.example.com', client_id: 'test-client', client_secret: 'test-secret', scopes: ['read'] },
      oauthRefreshThresholdMs: 60 * 1000,
    });

    const sessionId = (transport as any).createSession('old-access', 'old-refresh', Date.now() + 1, ['read'], 'mcp-proxy-client');
    const session = (transport as any).sessions.get(sessionId);
    session.accessTokenExpiresAt = Date.now() + 1;
    session.refreshToken = 'old-refresh';

    (transport as any).oauthProvider = {
      ensureEndpointsInitialized: async () => {},
      clientsStore: { getClient: async () => ({ client_id: 'mcp-proxy-client', scope: 'read' }) },
      exchangeRefreshToken: async () => ({ access_token: 'new-access', refresh_token: 'new-refresh', token_type: 'Bearer', expires_in: 3600 }),
    };

    const ok = await transport.ensureValidSessionToken(sessionId);
    expect(ok).toBe(true);
    expect(transport.getSessionToken(sessionId)).toBe('new-access');
    expect((transport as any).oauthTokensByAccessToken.has('new-access')).toBe(true);

    await transport.stop();
  });

  it('starts/stops without binding by mocking server implementations', async () => {
    const transport = createTransport();
    const app = (transport as any).app;

    const fakeServer: any = {
      listen: vi.fn((_port: number, _host: string, cb: () => void) => cb()),
      on: vi.fn(),
      close: vi.fn((cb: (err?: any) => void) => cb()),
    };
    vi.spyOn(app, 'listen').mockImplementation((_port: any, _host: any, cb: any) => {
      cb();
      return fakeServer;
    });

    await transport.start();
    expect(fakeServer.on).toHaveBeenCalledWith('error', expect.any(Function));
    await transport.stop();

    // HTTPS branch with mocked fs/https
    const originalCert = process.env.MCP4_SSL_CERT_FILE;
    const originalKey = process.env.MCP4_SSL_KEY_FILE;
    process.env.MCP4_SSL_CERT_FILE = '/tmp/cert.pem';
    process.env.MCP4_SSL_KEY_FILE = '/tmp/key.pem';

    const transportHttps = createTransport();
    const fakeHttpsServer: any = {
      listen: vi.fn((_port: number, _host: string, cb: () => void) => cb()),
      on: vi.fn(),
      close: vi.fn((cb: (err?: any) => void) => cb()),
    };
    const readSpy = vi.spyOn(fs, 'readFileSync').mockReturnValue('x' as any);
    const httpsSpy = vi.spyOn(https, 'createServer').mockReturnValue(fakeHttpsServer);

    try {
      await transportHttps.start();
      expect(httpsSpy).toHaveBeenCalled();
      await transportHttps.stop();
    } finally {
      readSpy.mockRestore();
      httpsSpy.mockRestore();
      if (originalCert === undefined) delete process.env.MCP4_SSL_CERT_FILE;
      else process.env.MCP4_SSL_CERT_FILE = originalCert;
      if (originalKey === undefined) delete process.env.MCP4_SSL_KEY_FILE;
      else process.env.MCP4_SSL_KEY_FILE = originalKey;
    }
  });

  it('sets security headers (X-Content-Type-Options, X-Frame-Options, CSP)', async () => {
    const transport = createTransport();
    const app = (transport as any).app;

    const res = await request(app).get('/health');

    expect(res.statusCode).toBe(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['content-security-policy']).toBe("default-src 'none'; frame-ancestors 'none'");

    await transport.stop();
  });
});
