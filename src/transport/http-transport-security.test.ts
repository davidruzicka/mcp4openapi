import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import https from 'node:https';
import request from 'supertest';
import type { McpRequest } from '../types/http-transport.js';
import { HttpTransport } from './http-transport.js';
import { ConsoleLogger } from '../core/logger.js';
import {
  AuthenticationError,
  AuthorizationError,
  OAuthClientStoreCapacityError,
  OAuthInvalidGrantError,
  RateLimitError,
  ValidationError,
} from '../core/errors.js';
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

function createProfileState(transport: any, profileId: string = 'default') {
  const state = {
    profileId,
    context: { profileId },
    oauthProvider: null,
    oauthTokensByAccessToken: new Map(),
    sessions: new Map(),
  };
  transport.profileStates.set(profileId, state);
  return state;
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
    redirect: vi.fn((arg1: number | string, arg2?: string) => {
      if (typeof arg1 === 'number') {
        res.statusCode = arg1;
        res.headers['location'] = arg2 as string;
      } else {
        res.statusCode = 302;
        res.headers['location'] = arg1;
      }
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
  (CAN_LISTEN ? it : it.skip)('checks for security headers using supertest', async () => {
    const transport = createTransport();
    const app = (transport as any).app;

    const response = await request(app).get('/health');

    expect(response.headers['x-powered-by']).toBeUndefined();
    expect(response.headers['content-security-policy']).toBe("default-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'self'");
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('DENY');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['cross-origin-opener-policy']).toBe('same-origin');
    expect(response.headers['cross-origin-resource-policy']).toBe('same-origin');
    expect(response.headers['x-permitted-cross-domain-policies']).toBe('none');
    expect(response.headers['x-dns-prefetch-control']).toBe('off');
    await transport.stop();
  });

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
    // AIPP-572: catch-path 401s now emit an RFC 6750 code + Bearer challenge.
    expect(res.body).toHaveProperty('error', 'invalid_token');
    expect(res.body).toHaveProperty('correlationId');
    expect(String(res.headers['www-authenticate'])).toContain('Bearer');
    expect(String(res.headers['www-authenticate'])).toContain('resource_metadata=');
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
          redirect_uri: 'https://example.com/oauth/callback',
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
          redirect_uri: 'https://example.com/oauth/callback',
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

  it('serves profile-scoped authorization server metadata when profile routing is enabled (no network)', async () => {
    const transport = new HttpTransport(
      {
        host: '127.0.0.1',
        port: 0,
        sessionTimeoutMs: 1800000,
        heartbeatEnabled: false,
        heartbeatIntervalMs: 30000,
        metricsEnabled: false,
        metricsPath: '/metrics',
        profileRoutingEnabled: true,
        oauthConfig: {
          issuer: 'https://auth.example.com',
          client_id: 'test-client',
          client_secret: 'test-secret',
          scopes: ['read'],
        },
      } as any,
      new ConsoleLogger()
    );

    createProfileState(transport as any, 'default').oauthProvider = {
      scopes: ['read'],
    };

    const app = (transport as any).app;
    const handler = getExpressRouteHandler(app, 'get', '/profile/:profileId/.well-known/oauth-authorization-server');
    const req: any = {
      params: { profileId: 'default' },
      profileId: 'default',
      forceProfilePrefix: true,
      query: {},
      headers: {},
    };
    const res = createMockResponse();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.issuer).toContain('/profile/default');
    expect(res.body.authorization_endpoint).toContain('/profile/default/oauth/authorize');
    expect(res.body.token_endpoint).toContain('/profile/default/oauth/token');

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
          redirect_uri: 'https://example.com/oauth/callback',
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
          redirect_uri: 'https://example.com/oauth/callback',
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

    createProfileState(transport as any).oauthProvider = {
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
        code_challenge: 'challenge',
        code_challenge_method: 'S256',
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

    const authorize = vi.fn(async (..._args: any[]) => {});
    createProfileState(transport as any).oauthProvider = {
      ensureEndpointsInitialized: async () => {},
      clientsStore: { getClient: async () => ({ client_id: 'test-client', scope: 'read write' }) },
      isRedirectUriAllowedForClient: () => true,
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
    const [, authorizeParams] = authorize.mock.calls[0] as any[];
    expect(authorizeParams).toMatchObject({
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

    createProfileState(transport as any).oauthProvider = null;

    const app = (transport as any).app;
    const handler = getExpressRouteHandler(app, 'get', '/oauth/authorize');
    const req: any = { query: { response_type: 'code', client_id: 'x', redirect_uri: 'http://localhost/cb' }, headers: {} };
    const res = createMockResponse();
    await handler(req, res);

    expect(res.statusCode).toBe(404);
    expect(String(res.body)).toContain('OAuth not configured for this profile');

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

    createProfileState(transport as any).oauthProvider = {
      ensureEndpointsInitialized: async () => {},
      clientsStore: { getClient: async () => ({ client_id: 'test-client' }) },
      isRedirectUriAllowedForClient: () => true,
      authorize: async () => {
        throw new Error('boom');
      },
    };

    const app = (transport as any).app;
    const handler = getExpressRouteHandler(app, 'get', '/oauth/authorize');
    const req: any = { query: { response_type: 'code', client_id: 'test-client', redirect_uri: 'http://localhost/cb', code_challenge: 'challenge', code_challenge_method: 'S256' }, headers: {} };
    const res = createMockResponse();
    await handler(req, res);

    expect(res.statusCode).toBe(500);
    expect(String(res.body)).toContain('OAuth authorization failed');

    await transport.stop();
  });

  it('rejects /oauth/authorize without a PKCE code_challenge (invalid_request)', async () => {
    const transport = createTransport({
      oauthConfig: { issuer: 'https://auth.example.com', client_id: 'test-client', client_secret: 'test-secret', scopes: ['read'] },
    });
    const authorize = vi.fn(async () => {});
    createProfileState(transport as any).oauthProvider = {
      ensureEndpointsInitialized: async () => {},
      clientsStore: { getClient: async () => ({ client_id: 'test-client' }) },
      isRedirectUriAllowedForClient: () => true,
      authorize,
    };

    const app = (transport as any).app;
    const handler = getExpressRouteHandler(app, 'get', '/oauth/authorize');
    const req: any = { query: { response_type: 'code', client_id: 'test-client', redirect_uri: 'http://localhost/cb', state: 's1' }, headers: {} };
    const res = createMockResponse();
    await handler(req, res);

    // RFC 6749 4.1.2.1: with a valid redirect_uri, a PKCE (authorize-time) error
    // is delivered as a 302 redirect carrying error + state, not a direct 400.
    expect(res.statusCode).toBe(302);
    const location = new URL(res.headers['location']);
    expect(location.searchParams.get('error')).toBe('invalid_request');
    expect(location.searchParams.get('state')).toBe('s1');
    expect(authorize).not.toHaveBeenCalled();

    await transport.stop();
  });

  it('rejects /oauth/authorize with a non-S256 code_challenge_method (invalid_request)', async () => {
    const transport = createTransport({
      oauthConfig: { issuer: 'https://auth.example.com', client_id: 'test-client', client_secret: 'test-secret', scopes: ['read'] },
    });
    const authorize = vi.fn(async () => {});
    createProfileState(transport as any).oauthProvider = {
      ensureEndpointsInitialized: async () => {},
      clientsStore: { getClient: async () => ({ client_id: 'test-client' }) },
      isRedirectUriAllowedForClient: () => true,
      authorize,
    };

    const app = (transport as any).app;
    const handler = getExpressRouteHandler(app, 'get', '/oauth/authorize');
    const req: any = {
      query: { response_type: 'code', client_id: 'test-client', redirect_uri: 'http://localhost/cb', code_challenge: 'challenge', code_challenge_method: 'plain', state: 's2' },
      headers: {},
    };
    const res = createMockResponse();
    await handler(req, res);

    expect(res.statusCode).toBe(302);
    const location = new URL(res.headers['location']);
    expect(location.searchParams.get('error')).toBe('invalid_request');
    expect(location.searchParams.get('state')).toBe('s2');
    expect(authorize).not.toHaveBeenCalled();

    await transport.stop();
  });

  it('maps a malformed code_verifier to invalid_request at /oauth/token', async () => {
    const transport = createTransport({
      oauthConfig: { issuer: 'https://auth.example.com', client_id: 'test-client', client_secret: 'test-secret', scopes: ['read'] },
    });
    createProfileState(transport as any).oauthProvider = {
      ensureEndpointsInitialized: async () => {},
      clientsStore: { getClient: async () => ({ client_id: 'test-client', client_secret: 'server-secret', scope: 'read' }) },
      exchangeAuthorizationCode: async () => {
        throw new ValidationError('code_verifier does not meet RFC 7636 length/charset requirements');
      },
    };

    const app = (transport as any).app;
    const handler = getExpressRouteHandler(app, 'post', '/oauth/token');
    const req: any = {
      body: { grant_type: 'authorization_code', code: 'abc', client_id: 'test-client', client_secret: 'server-secret', code_verifier: 'short' },
      headers: {},
    };
    const res = createMockResponse();
    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ error: 'invalid_request' });

    await transport.stop();
  });

  it('fails closed with 401 invalid_token + WWW-Authenticate when a session token is expired and cannot refresh', async () => {
    const transport = createTransport();
    transport.setMessageHandler(async () => ({ result: 'ok' }));
    const profileState = createProfileState(transport as any);
    // Expired access token, no refresh token available -> refresh cannot succeed.
    profileState.sessions.set('expired-1', {
      id: 'expired-1',
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      sseStreams: new Map(),
      authToken: 'stale-access',
      accessTokenExpiresAt: Date.now() - 60_000,
      replayQueue: [],
      nextEventId: 0,
    });

    const app = (transport as any).app;
    const handler = getExpressRouteHandler(app, 'post', '/mcp');
    const req: any = {
      method: 'POST',
      path: '/mcp',
      url: '/mcp',
      sessionId: 'expired-1',
      headers: { accept: 'application/json', host: 'localhost' },
      body: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    };
    const res = createMockResponse();
    await handler(req, res);

    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({ error: 'invalid_token' });
    expect(String(res.headers['www-authenticate'])).toContain('error="invalid_token"');
    expect(String(res.headers['www-authenticate'])).toContain('resource_metadata=');

    await transport.stop();
  });

  it('attaches OAuth rate limiter middleware to /oauth/callback', async () => {
    const transport = new HttpTransport(
      {
        host: '127.0.0.1',
        port: 0,
        sessionTimeoutMs: 1800000,
        heartbeatEnabled: false,
        heartbeatIntervalMs: 30000,
        metricsEnabled: false,
        metricsPath: '/metrics',
        rateLimitEnabled: true,
        rateLimitOAuthMax: 1,
        rateLimitOAuthWindowMs: 10 * 60 * 1000,
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
    const stack = app?.router?.stack || app?._router?.stack;
    const findRouteHandlers = (method: string, path: string): any[] => {
      for (const layer of stack) {
        if (!layer?.route) continue;
        if (layer.route.path !== path) continue;
        if (!layer.route.methods?.[method]) continue;
        return layer.route.stack || [];
      }
      return [];
    };

    const authorizeHandlers = findRouteHandlers('get', '/oauth/authorize');
    const callbackHandlers = findRouteHandlers('get', '/oauth/callback');

    // authorize should keep at least limiter + route handler
    expect(authorizeHandlers.length).toBeGreaterThan(1);
    // callback should include limiter + route handler
    expect(callbackHandlers.length).toBeGreaterThan(1);

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
          redirect_uri: 'https://example.com/oauth/callback',
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
          redirect_uri: 'https://example.com/oauth/callback',
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
          redirect_uri: 'https://example.com/oauth/callback',
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

    createProfileState(transport as any).oauthProvider = {
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

  it('returns invalid_client for /oauth/token when confidential client_secret is missing (no network)', async () => {
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

    createProfileState(transport as any).oauthProvider = {
      ensureEndpointsInitialized: async () => {},
      clientsStore: {
        getClient: async () => ({
          client_id: 'test-client',
          client_secret: 'server-secret',
          scope: 'read',
        }),
      },
      exchangeAuthorizationCode: async () => ({}),
    };

    const app = (transport as any).app;
    const handler = getExpressRouteHandler(app, 'post', '/oauth/token');
    const req: any = {
      body: { grant_type: 'authorization_code', code: 'abc', client_id: 'test-client' },
      headers: {},
    };
    const res = createMockResponse();
    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ error: 'invalid_client' });

    await transport.stop();
  });

  it('returns invalid_client for /oauth/token when confidential client_secret is wrong (no network)', async () => {
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

    createProfileState(transport as any).oauthProvider = {
      ensureEndpointsInitialized: async () => {},
      clientsStore: {
        getClient: async () => ({
          client_id: 'test-client',
          client_secret: 'server-secret',
          scope: 'read',
        }),
      },
      exchangeAuthorizationCode: async () => ({}),
    };

    const app = (transport as any).app;
    const handler = getExpressRouteHandler(app, 'post', '/oauth/token');
    const req: any = {
      body: {
        grant_type: 'authorization_code',
        code: 'abc',
        client_id: 'test-client',
        client_secret: 'wrong-secret',
      },
      headers: {},
    };
    const res = createMockResponse();
    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ error: 'invalid_client' });

    await transport.stop();
  });

  it('allows /oauth/token without client_secret for proxy compatibility client (no network)', async () => {
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

    createProfileState(transport as any).oauthProvider = {
      ensureEndpointsInitialized: async () => {},
      clientsStore: {
        getClient: async (id: string) => {
          if (id !== 'mcp-proxy-client') return undefined;
          return {
            client_id: 'mcp-proxy-client',
            client_secret: 'proxy-secret',
            redirect_uris: ['http://localhost/cb'],
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'],
            scope: 'read',
          } as any;
        },
      },
      exchangeAuthorizationCode: async () => ({
        access_token: 'access-123',
        refresh_token: 'refresh-123',
        token_type: 'Bearer',
        expires_in: 3600,
      }),
      exchangeRefreshToken: async () => { throw new Error('not used'); },
    };

    const app = (transport as any).app;
    const handler = getExpressRouteHandler(app, 'post', '/oauth/token');
    const req: any = {
      body: {
        grant_type: 'authorization_code',
        code: 'abc',
        client_id: 'mcp-proxy-client',
        redirect_uri: 'http://localhost/cb',
      },
      headers: {},
    };
    const res = createMockResponse();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      access_token: 'access-123',
      refresh_token: 'refresh-123',
      token_type: 'Bearer',
    });

    await transport.stop();
  });

  it('exchanges /oauth/token authorization_code using Basic auth client credentials (no network)', async () => {
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
    createProfileState(transport as any).oauthProvider = {
      ensureEndpointsInitialized: async () => {},
      clientsStore: {
        getClient: async () => ({
          client_id: 'test-client',
          client_secret: 'server-secret',
          scope: 'read',
        }),
      },
      exchangeAuthorizationCode: async () => tokens,
    };

    const app = (transport as any).app;
    const handler = getExpressRouteHandler(app, 'post', '/oauth/token');
    const basicAuth = Buffer.from('test-client:server-secret', 'utf8').toString('base64');
    const req: any = {
      body: {
        grant_type: 'authorization_code',
        code: 'abc',
      },
      headers: { authorization: `Basic ${basicAuth}` },
    };
    const res = createMockResponse();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject(tokens);

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

    createProfileState(transport as any).oauthProvider = null;

    const app = (transport as any).app;
    const handler = getExpressRouteHandler(app, 'post', '/oauth/token');
    const req: any = { body: { grant_type: 'authorization_code', code: 'abc' }, headers: {} };
    const res = createMockResponse();
    await handler(req, res);

    expect(res.statusCode).toBe(404);
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
    createProfileState(transport as any).oauthProvider = {
      ensureEndpointsInitialized: async () => {},
      clientsStore: {
        getClient: async () => ({
          client_id: 'test-client',
          client_secret: 'server-secret',
          scope: 'read',
        }),
      },
      exchangeAuthorizationCode: async () => tokens,
    };

    const app = (transport as any).app;
    const handler = getExpressRouteHandler(app, 'post', '/oauth/token');
    const req: any = {
      body: {
        grant_type: 'authorization_code',
        code: 'abc',
        client_id: 'test-client',
        client_secret: 'server-secret',
      },
      headers: {},
    };
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

    createProfileState(transport as any).oauthProvider = {
      ensureEndpointsInitialized: async () => {},
      clientsStore: {
        getClient: async () => ({
          client_id: 'test-client',
          client_secret: 'server-secret',
          scope: 'read',
        }),
      },
      exchangeAuthorizationCode: async () => {
        throw new OAuthInvalidGrantError('bad code');
      },
    };

    const app = (transport as any).app;
    const handler = getExpressRouteHandler(app, 'post', '/oauth/token');
    const req: any = {
      body: {
        grant_type: 'authorization_code',
        code: 'abc',
        client_id: 'test-client',
        client_secret: 'server-secret',
      },
      headers: {},
    };
    const res = createMockResponse();
    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ error: 'invalid_grant' });
    // Error message is sanitized (RFC 6749 §5.2 grant failure)
    expect(String(res.body.error_description)).toBe('bad code');

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

    createProfileState(transport as any).oauthProvider = {
      ensureEndpointsInitialized: async () => {},
      clientsStore: {
        getClient: async () => ({
          client_id: 'test-client',
          client_secret: 'server-secret',
          scope: 'read',
        }),
      },
      exchangeRefreshToken: async () => {
        throw new OAuthInvalidGrantError('bad refresh');
      },
    };

    const app = (transport as any).app;
    const handler = getExpressRouteHandler(app, 'post', '/oauth/token');
    const req: any = {
      body: {
        grant_type: 'refresh_token',
        refresh_token: 'rt',
        client_id: 'test-client',
        client_secret: 'server-secret',
      },
      headers: {},
    };
    const res = createMockResponse();
    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ error: 'invalid_grant' });
    // Error message is sanitized (RFC 6749 §5.2 grant failure)
    expect(String(res.body.error_description)).toBe('bad refresh');

    await transport.stop();
  });

  it('keeps an invalid/unregistered redirect_uri a direct 400 at /oauth/authorize (no redirect)', async () => {
    const transport = createTransport({
      oauthConfig: { issuer: 'https://auth.example.com', client_id: 'test-client', client_secret: 'test-secret', scopes: ['read'] },
    });
    const authorize = vi.fn(async () => {});
    createProfileState(transport as any).oauthProvider = {
      ensureEndpointsInitialized: async () => {},
      clientsStore: { getClient: async () => ({ client_id: 'test-client' }) },
      isRedirectUriAllowedForClient: () => false,
      authorize,
    };

    const app = (transport as any).app;
    const handler = getExpressRouteHandler(app, 'get', '/oauth/authorize');
    const req: any = { query: { response_type: 'code', client_id: 'test-client', redirect_uri: 'http://evil.example/cb', state: 's' }, headers: {} };
    const res = createMockResponse();
    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.headers['location']).toBeUndefined();
    expect(authorize).not.toHaveBeenCalled();

    await transport.stop();
  });

  it('redirects an unsupported response_type to the validated redirect_uri with error + state', async () => {
    const transport = createTransport({
      oauthConfig: { issuer: 'https://auth.example.com', client_id: 'test-client', client_secret: 'test-secret', scopes: ['read'] },
    });
    const authorize = vi.fn(async () => {});
    createProfileState(transport as any).oauthProvider = {
      ensureEndpointsInitialized: async () => {},
      clientsStore: { getClient: async () => ({ client_id: 'test-client' }) },
      isRedirectUriAllowedForClient: () => true,
      authorize,
    };

    const app = (transport as any).app;
    const handler = getExpressRouteHandler(app, 'get', '/oauth/authorize');
    const req: any = { query: { response_type: 'token', client_id: 'test-client', redirect_uri: 'http://localhost/cb', state: 'xyz' }, headers: {} };
    const res = createMockResponse();
    await handler(req, res);

    expect(res.statusCode).toBe(302);
    const location = new URL(res.headers['location']);
    expect(location.searchParams.get('error')).toBe('unsupported_response_type');
    expect(location.searchParams.get('state')).toBe('xyz');
    expect(authorize).not.toHaveBeenCalled();

    await transport.stop();
  });

  it('sets Cache-Control: no-store on an early /oauth/authorize error', async () => {
    const transport = createTransport({
      oauthConfig: { issuer: 'https://auth.example.com', client_id: 'test-client', client_secret: 'test-secret', scopes: ['read'] },
    });
    createProfileState(transport as any).oauthProvider = {
      ensureEndpointsInitialized: async () => {},
      clientsStore: { getClient: async () => ({ client_id: 'test-client' }) },
      isRedirectUriAllowedForClient: () => true,
    };

    const app = (transport as any).app;
    const handler = getExpressRouteHandler(app, 'get', '/oauth/authorize');
    // Missing client_id -> earliest direct 400.
    const res = createMockResponse();
    await handler({ query: { response_type: 'code' }, headers: {} } as any, res);

    expect(res.statusCode).toBe(400);
    expect(res.headers['cache-control']).toBe('no-store');

    await transport.stop();
  });

  it('returns 401 invalid_client with WWW-Authenticate: Basic when Basic auth fails (RFC 6749 5.2)', async () => {
    const transport = createTransport({
      oauthConfig: { issuer: 'https://auth.example.com', client_id: 'test-client', client_secret: 'test-secret', scopes: ['read'] },
    });
    createProfileState(transport as any).oauthProvider = {
      ensureEndpointsInitialized: async () => {},
      clientsStore: { getClient: async () => undefined },
    };

    const app = (transport as any).app;
    const handler = getExpressRouteHandler(app, 'post', '/oauth/token');
    const basicAuth = Buffer.from('unknown-client:wrong-secret', 'utf8').toString('base64');
    const req: any = {
      body: { grant_type: 'authorization_code', code: 'abc' },
      headers: { authorization: `Basic ${basicAuth}` },
    };
    const res = createMockResponse();
    await handler(req, res);

    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({ error: 'invalid_client' });
    expect(String(res.headers['www-authenticate'])).toContain('Basic');

    await transport.stop();
  });

  it('keeps invalid_client a 400 without a Basic challenge for body-based client auth', async () => {
    const transport = createTransport({
      oauthConfig: { issuer: 'https://auth.example.com', client_id: 'test-client', client_secret: 'test-secret', scopes: ['read'] },
    });
    createProfileState(transport as any).oauthProvider = {
      ensureEndpointsInitialized: async () => {},
      clientsStore: { getClient: async () => undefined },
    };

    const app = (transport as any).app;
    const handler = getExpressRouteHandler(app, 'post', '/oauth/token');
    const req: any = {
      body: { grant_type: 'authorization_code', code: 'abc', client_id: 'unknown-client', client_secret: 'wrong' },
      headers: {},
    };
    const res = createMockResponse();
    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ error: 'invalid_client' });
    expect(res.headers['www-authenticate']).toBeUndefined();

    await transport.stop();
  });

  it('defaults token_type to Bearer and normalizes casing (RFC 6749 5.1)', async () => {
    const transport = createTransport({
      oauthConfig: { issuer: 'https://auth.example.com', client_id: 'test-client', client_secret: 'test-secret', scopes: ['read'] },
    });
    createProfileState(transport as any).oauthProvider = {
      ensureEndpointsInitialized: async () => {},
      clientsStore: { getClient: async () => ({ client_id: 'test-client', client_secret: 'server-secret', scope: 'read' }) },
      // Upstream omits token_type entirely.
      exchangeAuthorizationCode: async () => ({ access_token: 'access', expires_in: 3600 }),
    };

    const app = (transport as any).app;
    const handler = getExpressRouteHandler(app, 'post', '/oauth/token');
    const req: any = {
      body: { grant_type: 'authorization_code', code: 'abc', client_id: 'test-client', client_secret: 'server-secret' },
      headers: {},
    };
    const res = createMockResponse();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.token_type).toBe('Bearer');

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
          redirect_uri: 'https://example.com/oauth/callback',
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
          redirect_uri: 'https://example.com/oauth/callback',
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

    createProfileState(transport as any).oauthProvider = null;

    const app = (transport as any).app;
    const handler = getExpressRouteHandler(app, 'get', '/oauth/callback');
    const req: any = { query: { code: 'abc' }, headers: {} };
    const res = createMockResponse();
    await handler(req, res);

    expect(res.statusCode).toBe(404);
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

    createProfileState(transport as any).oauthProvider = {
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

    createProfileState(transport as any).oauthProvider = {
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
    createProfileState(transport as any).oauthProvider = {
      scopes: ['read', 'write'],
      clientsStore: { registerClient },
    };

    const app = (transport as any).app;
    const handler = getExpressRouteHandler(app, 'post', '/oauth/register');
    const req: any = { body: { redirect_uris: ['http://localhost/cb'] }, headers: {} };
    const res = createMockResponse();
    await handler(req, res);

    expect(res.statusCode).toBe(201);
    expect(typeof res.body.client_id).toBe('string');
    expect(res.body.client_id).toMatch(/^mcp-client-/);
    expect(typeof res.body.client_secret).toBe('string');
    expect(res.body.client_secret.length).toBeGreaterThan(20);
    expect(registerClient).toHaveBeenCalled();
    expect(registerClient).toHaveBeenCalledWith(
      expect.objectContaining({
        client_id: res.body.client_id,
        client_secret: res.body.client_secret,
      })
    );

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

    createProfileState(transport as any).oauthProvider = {
      scopes: ['read'],
      clientsStore: {
        registerClient: async () => {},
      },
    };

    const app = (transport as any).app;
    const handler = getExpressRouteHandler(app, 'post', '/oauth/register');
    const req: any = { body: { redirect_uris: ['http://localhost/cb'] }, headers: {} };
    const res = createMockResponse();
    await handler(req, res);

    expect(res.statusCode).toBe(201);
    expect(typeof res.body.client_id).toBe('string');
    expect(res.body.client_id).toMatch(/^mcp-client-/);
    expect(typeof res.body.client_secret).toBe('string');

    await transport.stop();
  });

  it('returns unique credentials for consecutive /oauth/register calls (no network)', async () => {
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

    createProfileState(transport as any).oauthProvider = {
      scopes: ['read'],
      clientsStore: {
        registerClient: async () => {},
      },
    };

    const app = (transport as any).app;
    const handler = getExpressRouteHandler(app, 'post', '/oauth/register');
    const req: any = { body: { redirect_uris: ['http://localhost/cb'] }, headers: {} };

    const first = createMockResponse();
    await handler(req, first);

    const second = createMockResponse();
    await handler(req, second);

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(first.body.client_id).not.toBe(second.body.client_id);
    expect(first.body.client_secret).not.toBe(second.body.client_secret);

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

    createProfileState(transport as any).oauthProvider = {
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

  it('returns 429 from /oauth/register when no safe client eviction candidate exists', async () => {
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

    createProfileState(transport as any).oauthProvider = {
      scopes: ['read'],
      clientsStore: {
        registerClient: async () => {
          throw new OAuthClientStoreCapacityError('OAuth client registration temporarily unavailable: no idle client can be evicted');
        },
      },
    };

    const app = (transport as any).app;
    const handler = getExpressRouteHandler(app, 'post', '/oauth/register');
    const req: any = { body: { redirect_uris: ['http://localhost/cb'] }, headers: {} };
    const res = createMockResponse();
    await handler(req, res);

    expect(res.statusCode).toBe(429);
    expect(res.body).toMatchObject({
      error: 'temporarily_unavailable',
      error_description: 'OAuth client registration temporarily unavailable: no idle client can be evicted',
    });
    expect(typeof res.body.correlationId).toBe('string');

    await transport.stop();
  });

  it('attaches and detaches oauth client usage on session lifecycle', async () => {
    const transport = createTransport();
    const markSessionAttached = vi.fn();
    const markSessionDetached = vi.fn();
    const profileState = createProfileState(transport as any);
    profileState.oauthProvider = {
      clientsStore: {
        markSessionAttached,
        markSessionDetached,
      },
    };

    const sessionId = (transport as any).createSession(profileState, undefined, undefined, undefined, ['read'], 'mcp-client-123');
    expect(markSessionAttached).toHaveBeenCalledWith('mcp-client-123');

    (transport as any).destroySession(profileState, sessionId);
    expect(markSessionDetached).toHaveBeenCalledWith('mcp-client-123');

    await transport.stop();
  });

  it('detaches oauth client usage when session expires in cleanup', async () => {
    const transport = createTransport({ sessionTimeoutMs: 10, oauthSessionTimeoutMs: 10 });
    const markSessionDetached = vi.fn();
    const profileState = createProfileState(transport as any);
    profileState.oauthProvider = {
      cleanup: () => {},
      clientsStore: {
        markSessionDetached,
      },
    };

    profileState.sessions.set('oauth-expired', {
      id: 'oauth-expired',
      createdAt: Date.now(),
      lastActivityAt: Date.now() - 30,
      sseStreams: new Map(),
      authToken: 'token',
      refreshToken: 'refresh',
      oauthClientId: 'mcp-client-expired',
      replayQueue: [],
      nextEventId: 0,
    });

    (transport as any).cleanupExpiredSessions();
    expect(profileState.sessions.has('oauth-expired')).toBe(false);
    expect(markSessionDetached).toHaveBeenCalledWith('mcp-client-expired');

    await transport.stop();
  });

  it('returns 500 from /oauth/register when clients store has no registerClient', async () => {
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

    createProfileState(transport as any).oauthProvider = {
      scopes: ['read'],
      clientsStore: {},
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
    // Allow private network for testing
    const originalAllowPrivateNetwork = process.env.MCP4_SSRF_ALLOW_PRIVATE_NETWORK;
    process.env.MCP4_SSRF_ALLOW_PRIVATE_NETWORK = 'true';

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
        expect(init?.redirect).toBe('error');
        return { status: 204 } as any;
      });

      await expect(
        (transport as any).validateAuthToken(
          { type: 'bearer', validation_endpoint: '/bearer' },
          'token123',
          'http://127.0.0.1'
        )
      ).resolves.toBe(true);

      await expect(
        (transport as any).validateAuthToken(
          { type: 'custom-header', header_name: 'X-API-Key', validation_endpoint: '/header' },
          'token123',
          'http://127.0.0.1'
        )
      ).resolves.toBe(true);

      await expect(
        (transport as any).validateAuthToken(
          { type: 'query', query_param: 'api_key', validation_endpoint: '/query' },
          'token123',
          'http://127.0.0.1'
        )
      ).resolves.toBe(true);

      await expect(
        (transport as any).validateAuthToken(
          { type: 'bearer', validation_endpoint: '/fail' },
          'token123',
          'http://127.0.0.1'
        )
      ).resolves.toBe(false);
    } finally {
      global.fetch = originalFetch;
      if (originalAllowPrivateNetwork === undefined) {
        delete process.env.MCP4_SSRF_ALLOW_PRIVATE_NETWORK;
      } else {
        process.env.MCP4_SSRF_ALLOW_PRIVATE_NETWORK = originalAllowPrivateNetwork;
      }
      await transport.stop();
    }
  });

  it('blocks absolute validation endpoint on untrusted host and does not call fetch', async () => {
    const transport = createTransport();
    const fetchMock = vi.fn(async () => ({ status: 204 }) as any);
    const originalFetch = global.fetch;

    try {
      global.fetch = fetchMock as any;

      await expect(
        (transport as any).validateAuthToken(
          { type: 'bearer', validation_endpoint: 'https://evil.example/validate' },
          'token123',
          'https://api.example.com'
        )
      ).resolves.toBe(false);

      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      global.fetch = originalFetch;
      await transport.stop();
    }
  });

  it('allows absolute validation endpoint on trusted host from validation_allowed_hosts', async () => {
    const transport = createTransport();
    const originalFetch = global.fetch;
    const originalAllowPrivateNetwork = process.env.MCP4_SSRF_ALLOW_PRIVATE_NETWORK;

    try {
      process.env.MCP4_SSRF_ALLOW_PRIVATE_NETWORK = 'true';
      global.fetch = vi.fn(async (_url: any, init?: any) => {
        expect(init?.redirect).toBe('error');
        return { status: 204 } as any;
      });

      await expect(
        (transport as any).validateAuthToken(
          {
            type: 'bearer',
            validation_endpoint: 'http://127.0.0.1/validate',
            validation_allowed_hosts: ['127.0.0.1'],
          },
          'token123',
          'https://api.example.com'
        )
      ).resolves.toBe(true);
    } finally {
      global.fetch = originalFetch;
      if (originalAllowPrivateNetwork === undefined) {
        delete process.env.MCP4_SSRF_ALLOW_PRIVATE_NETWORK;
      } else {
        process.env.MCP4_SSRF_ALLOW_PRIVATE_NETWORK = originalAllowPrivateNetwork;
      }
      await transport.stop();
    }
  });

  it('allows absolute validation endpoint when validation_allowed_hosts uses wildcard', async () => {
    const transport = createTransport();
    const originalFetch = global.fetch;
    const originalAllowPrivateNetwork = process.env.MCP4_SSRF_ALLOW_PRIVATE_NETWORK;

    try {
      process.env.MCP4_SSRF_ALLOW_PRIVATE_NETWORK = 'true';
      global.fetch = vi.fn(async () => ({ status: 204 }) as any);

      await expect(
        (transport as any).validateAuthToken(
          {
            type: 'bearer',
            validation_endpoint: 'http://auth.allowed.example.com/validate',
            validation_allowed_hosts: ['*.allowed.example.com'],
          },
          'token123',
          'https://api.example.com'
        )
      ).resolves.toBe(true);
    } finally {
      global.fetch = originalFetch;
      if (originalAllowPrivateNetwork === undefined) {
        delete process.env.MCP4_SSRF_ALLOW_PRIVATE_NETWORK;
      } else {
        process.env.MCP4_SSRF_ALLOW_PRIVATE_NETWORK = originalAllowPrivateNetwork;
      }
      await transport.stop();
    }
  });

  it('matches allowed validation hosts for exact and wildcard patterns', async () => {
    const transport = createTransport();
    const isAllowedValidationHost = (transport as any).isAllowedValidationHost.bind(transport);

    expect(isAllowedValidationHost('api.example.com', undefined)).toBe(false);
    expect(isAllowedValidationHost('api.example.com', [])).toBe(false);
    expect(isAllowedValidationHost('api.example.com', ['api.example.com'])).toBe(true);
    expect(isAllowedValidationHost('sub.example.com', ['*.example.com'])).toBe(true);
    expect(isAllowedValidationHost('example.com', ['*.example.com'])).toBe(false);
    expect(isAllowedValidationHost('sub.example.com', ['*.'])).toBe(false);

    await transport.stop();
  });

  it('starts SSE response without Mcp-Session-Id when session is not created', async () => {
    const transport = createTransport();
    const res = createMockSseResponse();

    (transport as any).startSSEResponse(res, { ok: true }, undefined);

    expect(res.headers['content-type']).toBe('text/event-stream');
    expect(res.headers['mcp-session-id']).toBeUndefined();
    expect(res.write).toHaveBeenCalled();
    expect(res.end).toHaveBeenCalled();

    await transport.stop();
  });

  it('queues outbound SSE messages in session replayQueue and delivers only to active streams', async () => {
    const transport = createTransport();
    const profileState = createProfileState(transport as any, 'default');
    const sessionId = 'session-1';

    const activeStream = {
      streamId: 'active',
      lastEventId: 0,
      active: true,
      response: createMockSseResponse(),
    };
    const inactiveStream = {
      streamId: 'inactive',
      lastEventId: 0,
      active: false,
      response: createMockSseResponse(),
    };

    const session: any = {
      id: sessionId,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      replayQueue: [],
      nextEventId: 0,
      sseStreams: new Map([
        ['active', activeStream as any],
        ['inactive', inactiveStream as any],
      ]),
    };
    profileState.sessions.set(sessionId, session);

    (transport as any).sendToClient('default', sessionId, { type: 'ping' });

    // Message enters the session-scoped replay queue (survives reconnects)
    expect(session.replayQueue).toHaveLength(1);
    // Only active stream receives real-time SSE write
    expect(activeStream.response.write).toHaveBeenCalled();
    expect(inactiveStream.response.write).not.toHaveBeenCalled();

    await transport.stop();
  });

  it('assigns strictly monotonic event IDs across concurrent sendToClient calls', async () => {
    const transport = createTransport();
    const profileState = createProfileState(transport as any, 'default');
    const sessionId = 'session-mono';

    const session: any = {
      id: sessionId,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      replayQueue: [],
      nextEventId: 0,
      sseStreams: new Map(),
    };
    profileState.sessions.set(sessionId, session);

    (transport as any).sendToClient('default', sessionId, { seq: 1 });
    (transport as any).sendToClient('default', sessionId, { seq: 2 });
    (transport as any).sendToClient('default', sessionId, { seq: 3 });

    expect(session.replayQueue).toHaveLength(3);
    const ids = session.replayQueue.map((m: any) => m.eventId);
    // IDs must be strictly increasing and unique regardless of clock resolution
    expect(ids[0]).toBeLessThan(ids[1]);
    expect(ids[1]).toBeLessThan(ids[2]);
    expect(new Set(ids).size).toBe(3);

    await transport.stop();
  });

  it('extracts OAuth token from session when session exists and OAuth is configured', async () => {
    const transport = createTransport();
    const profileState = createProfileState(transport as any);
    profileState.oauthProvider = {} as any;
    profileState.sessions.set('s1', {
      id: 's1',
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      sseStreams: new Map(),
      authToken: 'oauth-token',
      replayQueue: [],
      nextEventId: 0,
    });

    const req: any = { headers: { }, sessionId: 's1' };
    const info = (transport as any).extractAuthToken(req, profileState);
    expect(info).toEqual({ type: 'oauth', token: 'oauth-token', sessionId: 's1' });
    await transport.stop();
  });

  it('extracts session token as api-token when OAuth is not configured', async () => {
    const transport = createTransport();
    const profileState = createProfileState(transport as any);
    profileState.sessions.set('s1', {
      id: 's1',
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      sseStreams: new Map(),
      authToken: 'session-token',
      replayQueue: [],
      nextEventId: 0,
    });

    const req: any = { headers: { }, sessionId: 's1' };
    const info = (transport as any).extractAuthToken(req, profileState);
    expect(info).toEqual({ type: 'api-token', token: 'session-token', sessionId: 's1' });
    await transport.stop();
  });

  it('prefers header token over session token when both are present', async () => {
    const transport = createTransport();
    const profileState = createProfileState(transport as any);
    profileState.context.authConfigs = [
      {
        type: 'custom-header',
        header_name: 'X-N8N-API-KEY',
        value_from_env: 'N8N_API_TOKEN',
      },
    ];
    profileState.sessions.set('s1', {
      id: 's1',
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      sseStreams: new Map(),
      authToken: 'session-token',
      replayQueue: [],
      nextEventId: 0,
    });

    const req: any = {
      headers: {
        'x-n8n-api-key': 'header-token',
      },
      sessionId: 's1',
    };
    const info = (transport as any).extractAuthToken(req, profileState);
    expect(info).toEqual({ type: 'api-token', token: 'header-token' });
    await transport.stop();
  });

  it('rejects invalid token formats and header shapes', async () => {
    const transportHeaderLimit = createTransport({ maxTokenLength: 5 });
    const profileStateHeaderLimit = createProfileState(transportHeaderLimit as any);
    const headerTooLong: any = {
      headers: {
        authorization: `Bearer ${'x'.repeat(100)}`,
      },
    };
    expect(() => (transportHeaderLimit as any).extractAuthToken(headerTooLong, profileStateHeaderLimit)).toThrow('Authorization header too long');
    await transportHeaderLimit.stop();

    const transport = createTransport({ maxTokenLength: 100 });
    const profileState = createProfileState(transport as any);
    const invalidChars: any = {
      headers: {
        authorization: 'Bearer bad*token',
      },
    };
    expect(() => (transport as any).extractAuthToken(invalidChars, profileState)).toThrow('Invalid Authorization token format');

    expect(() => (transport as any).validateToken('', 'Authorization token')).toThrow('Authorization token is empty');

    const apiTokenNotString: any = {
      headers: {
        'x-api-token': ['a', 'b'],
      },
    };
    expect(() => (transport as any).extractAuthToken(apiTokenNotString, profileState)).toThrow('X-API-Token must be a string');

    await transport.stop();
  });

  it('accepts custom auth header based on profile auth config', async () => {
    const transport = createTransport();
    const profileState = createProfileState(transport as any);
    profileState.context.authConfigs = [
      {
        type: 'custom-header',
        header_name: 'X-N8N-API-KEY',
        value_from_env: 'N8N_API_TOKEN',
      },
    ];

    const req: any = {
      headers: {
        'x-n8n-api-key': 'n8n-test-token',
      },
    };

    const info = (transport as any).extractAuthToken(req, profileState);
    expect(info).toEqual({ type: 'api-token', token: 'n8n-test-token' });
    await transport.stop();
  });

  it('updates session auth token on non-init requests when header is present', async () => {
    const transport = createTransport();
    transport.setMessageHandler(async () => ({ result: 'ok' }));
    const profileState = createProfileState(transport as any);
    profileState.context.authConfigs = [
      {
        type: 'custom-header',
        header_name: 'X-N8N-API-KEY',
        value_from_env: 'N8N_API_TOKEN',
      },
    ];

    profileState.sessions.set('s1', {
      id: 's1',
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      sseStreams: new Map(),
      authToken: 'old-token',
      replayQueue: [],
      nextEventId: 0,
    });

    const res = createMockResponse();
    await (transport as any).handlePost(
      {
        method: 'POST',
        path: '/mcp',
        url: '/mcp',
        sessionId: 's1',
        headers: {
          accept: 'application/json',
          'x-n8n-api-key': 'n8n-test-token',
          'mcp-session-id': 's1',
        },
        body: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      } as any,
      res
    );

    const session = profileState.sessions.get('s1');
    expect(session?.authToken).toBe('n8n-test-token');
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
        redirect_uri: 'https://example.com/oauth/callback',
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

      expect(res.statusCode).toBe(200);
      expect(res.headers['www-authenticate']).toBeUndefined();
      expect(res.body).toEqual({
        jsonrpc: '2.0',
        id: 1,
        error: {
          code: -32600,
          message: 'Supplied authentication token is invalid or expired',
        },
      });
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

    const profileState = createProfileState(transport as any);
    const sessionId = (transport as any).createSession(profileState, undefined, undefined, undefined, undefined, undefined);
    const res4 = createMockSseResponse();
    await (transport as any).handleGet({ method: 'GET', path: '/mcp', url: '/mcp', sessionId, headers: { accept: 'text/event-stream', 'mcp-session-id': sessionId } } as any, res4);
    expect(profileState.sessions.get(sessionId).sseStreams.size).toBeGreaterThan(0);

    await transport.stop();
  });

  it('manages SSE replay, heartbeat, and message queues', async () => {
    vi.useFakeTimers();
    try {
      const transport = createTransport({ heartbeatEnabled: true, heartbeatIntervalMs: 10 });
      const profileState = createProfileState(transport as any);
      const sessionId = (transport as any).createSession(profileState, undefined, undefined, undefined, undefined, undefined);
      const res = createMockSseResponse();

      (transport as any).startSSEStream(res, sessionId, '1', profileState);

      const session = profileState.sessions.get(sessionId) as { sseStreams: Map<string, any>; replayQueue: any[] };
      const [streamId, streamState] = Array.from(session.sseStreams.entries())[0];

      // Replay uses session-scoped replayQueue so messages survive reconnects
      session.replayQueue.push({ eventId: 1, data: { a: 1 }, timestamp: Date.now() });
      session.replayQueue.push({ eventId: 2, data: { a: 2 }, timestamp: Date.now() });
      session.replayQueue.push({ eventId: 3, data: { a: 3 }, timestamp: Date.now() });

      (transport as any).replayMessages(res, streamState, session);
      expect(res.write).toHaveBeenCalledWith('id: 2\n');

      // Heartbeat ping
      await vi.advanceTimersByTimeAsync(11);
      expect(res.write).toHaveBeenCalledWith(':ping\n\n');

      // Replay queue trimming to last 100 (session-scoped)
      streamState.active = true;
      session.replayQueue = Array.from({ length: 100 }).map((_, i) => ({ eventId: i, data: i, timestamp: Date.now() }));
      (transport as any).sendToClient('default', sessionId, { hello: 'world' });
      expect(session.replayQueue).toHaveLength(100);

      // Close stream - stream is removed from sseStreams map, not just marked inactive
      res.emit('close');
      expect(streamState.active).toBe(false);
      expect(session.sseStreams.has(streamId)).toBe(false);

      await transport.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('replays session replayQueue messages on second reconnect', async () => {
    const transport = createTransport();
    const profileState = createProfileState(transport as any);
    const sessionId = (transport as any).createSession(profileState, undefined, undefined, undefined, undefined, undefined);
    const session = profileState.sessions.get(sessionId) as any;

    // Seed the session replayQueue directly with deterministic eventIds
    session.replayQueue.push({ eventId: 100, data: { msg: 'first' }, timestamp: Date.now() });
    session.replayQueue.push({ eventId: 200, data: { msg: 'second' }, timestamp: Date.now() });

    // First connection - then disconnect (stream removed from sseStreams map)
    const res1 = createMockSseResponse();
    (transport as any).startSSEStream(res1, sessionId, undefined, profileState);
    res1.emit('close');
    expect(session.sseStreams.size).toBe(0);
    expect(session.replayQueue).toHaveLength(2); // replayQueue persists across reconnects

    // Second reconnect with Last-Event-ID = 100 (first message's id)
    const res2 = createMockSseResponse();
    (transport as any).startSSEStream(res2, sessionId, '100', profileState);

    // Should replay only the second message (eventId 200 > lastEventId 100)
    const writeCalls = (res2.write as ReturnType<typeof vi.fn>).mock.calls.map((c: any[]) => c[0]);
    const dataLine = writeCalls.find((line: string) => line.includes('"second"'));
    expect(dataLine).toBeDefined();
    // First message (eventId 100) should not be replayed (not > 100)
    const firstDataLine = writeCalls.find((line: string) => line.includes('"first"'));
    expect(firstDataLine).toBeUndefined();

    await transport.stop();
  });

  it('destroys sessions, notifies listeners, and handles listener errors', async () => {
    const transport = createTransport();
    const destroyed: string[] = [];
    transport.onSessionDestroyed((_profileId: string, sid: string) => destroyed.push(sid));
    transport.onSessionDestroyed(() => {
      throw new Error('listener boom');
    });

    const profileState = createProfileState(transport as any);
    const sessionId = (transport as any).createSession(profileState, 'tok', undefined, undefined, undefined, undefined);
    const res = createMockSseResponse();
    (transport as any).startSSEStream(res, sessionId, undefined, profileState);

    expect(profileState.sessions.has(sessionId)).toBe(true);
    (transport as any).destroySession(profileState, sessionId);
    expect(destroyed).toContain(sessionId);
    expect(profileState.sessions.has(sessionId)).toBe(false);

    await transport.stop();
  });

  it('stores OAuth tokens and throws AuthenticationError on missing access_token', async () => {
    const transport = createTransport();
    const profileState = createProfileState(transport as any);
    expect(() => (transport as any).storeOAuthTokens(profileState, {}, 'client', ['a'])).toThrow('OAuth tokens missing access_token');
    (transport as any).storeOAuthTokens(profileState, { access_token: 'a', token_type: 'Bearer', expires_in: 1, refresh_token: 'r' }, 'client', ['a']);
    expect(profileState.oauthTokensByAccessToken.has('a')).toBe(true);
    await transport.stop();
  });

  it('cleans up expired sessions with oauthSessionTimeoutMs rules', async () => {
    const transport = createTransport({ sessionTimeoutMs: 10, oauthSessionTimeoutMs: 0 });
    const now = Date.now();

    const profileState = createProfileState(transport as any);
    profileState.sessions.set('oauth-old', {
      id: 'oauth-old',
      createdAt: now,
      lastActivityAt: now - 30,
      sseStreams: new Map(),
      authToken: 't1',
      refreshToken: 'r1',
      replayQueue: [],
      nextEventId: 0,
    });
    profileState.sessions.set('plain-old', {
      id: 'plain-old',
      createdAt: now,
      lastActivityAt: now - 30,
      sseStreams: new Map(),
      authToken: 't2',
      replayQueue: [],
      nextEventId: 0,
    });
    profileState.sessions.set('oauth-never', {
      id: 'oauth-never',
      createdAt: now,
      lastActivityAt: now - 999999,
      sseStreams: new Map(),
      authToken: 't3',
      refreshToken: 'r3',
      replayQueue: [],
      nextEventId: 0,
    });

    (transport as any).cleanupExpiredSessions();
    expect(profileState.sessions.has('plain-old')).toBe(false);
    expect(profileState.sessions.has('oauth-old')).toBe(true);
    expect(profileState.sessions.has('oauth-never')).toBe(true);

    await transport.stop();
  });

  it('refreshes OAuth tokens when expiring and updates token map', async () => {
    const transport = createTransport({
      oauthConfig: { issuer: 'https://auth.example.com', client_id: 'test-client', client_secret: 'test-secret', scopes: ['read'] },
      oauthRefreshThresholdMs: 60 * 1000,
    });

    const profileState = createProfileState(transport as any);
    const sessionId = (transport as any).createSession(profileState, 'old-access', 'old-refresh', Date.now() + 1, ['read'], 'mcp-proxy-client');
    const session = profileState.sessions.get(sessionId);
    session.accessTokenExpiresAt = Date.now() + 1;
    session.refreshToken = 'old-refresh';

    profileState.oauthProvider = {
      ensureEndpointsInitialized: async () => {},
      clientsStore: { getClient: async () => ({ client_id: 'mcp-proxy-client', scope: 'read' }) },
      exchangeRefreshToken: async () => ({ access_token: 'new-access', refresh_token: 'new-refresh', token_type: 'Bearer', expires_in: 3600 }),
    };

    const ok = await transport.ensureValidSessionToken('default', sessionId);
    expect(ok).toBe(true);
    expect(transport.getSessionToken('default', sessionId)).toBe('new-access');
    expect(profileState.oauthTokensByAccessToken.has('new-access')).toBe(true);

    await transport.stop();
  });

  it('does not refresh OAuth token when expiration is beyond threshold', async () => {
    const transport = createTransport({
      oauthConfig: { issuer: 'https://auth.example.com', client_id: 'test-client', client_secret: 'test-secret', scopes: ['read'] },
      oauthRefreshThresholdMs: 60 * 1000,
    });

    const profileState = createProfileState(transport as any);
    const sessionId = (transport as any).createSession(
      profileState,
      'stable-access',
      'stable-refresh',
      Date.now() + (5 * 60 * 1000),
      ['read'],
      'mcp-proxy-client'
    );

    const refreshSpy = vi.spyOn(transport as any, 'refreshAccessToken').mockResolvedValue(true);

    const ok = await transport.ensureValidSessionToken('default', sessionId);
    expect(ok).toBe(true);
    expect(refreshSpy).not.toHaveBeenCalled();

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
});

describe('HttpTransport RFC 6750 resource-server hardening (AIPP-572)', () => {
  const OAUTH_CONFIG = {
    authorization_endpoint: 'https://auth.example.com/oauth/authorize',
    token_endpoint: 'https://auth.example.com/oauth/token',
    redirect_uri: 'https://example.com/oauth/callback',
    scopes: ['api'],
  };

  function initReq(headers: Record<string, string> = {}) {
    return {
      method: 'POST',
      path: '/mcp',
      url: '/mcp',
      headers: { accept: 'application/json', host: 'localhost', ...headers },
      body: {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } },
      },
      get: () => undefined,
    } as any;
  }

  it('item 1: generic Authentication required 401 carries a Bearer challenge with invalid_request', async () => {
    const transport = createTransport({
      baseUrl: 'https://api.example.com',
      authConfigs: [{ type: 'custom-header', header_name: 'X-API-Key' }],
    });
    transport.setMessageHandler(async () => ({ result: 'ok' }));
    const req = initReq();
    const res = createMockResponse();
    await (transport as any).handlePost(req, res);

    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({ error: 'invalid_request' });
    expect(String(res.headers['www-authenticate'])).toContain('Bearer');
    expect(String(res.headers['www-authenticate'])).toContain('error="invalid_request"');
    expect(String(res.headers['www-authenticate'])).toContain('resource_metadata=');
    await transport.stop();
  });

  it('item 3: rejects a non-OAuth X-API-Token on an OAuth-required profile (no shadow session)', async () => {
    const transport = createTransport({
      baseUrl: 'https://api.example.com',
      oauthConfig: OAUTH_CONFIG,
      authConfigs: [{ type: 'oauth' }],
    });
    transport.setMessageHandler(async () => ({ result: { ok: true } }));
    const req = initReq({ 'x-api-token': 'garbage-token-123' });
    const res = createMockResponse();
    await (transport as any).handlePost(req, res);

    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({ error: 'invalid_token' });
    expect(String(res.headers['www-authenticate'])).toContain('Bearer');
    expect(String(res.headers['www-authenticate'])).toContain('resource_metadata=');
    // No session must be materialized for the shadow credential.
    expect(res.headers['mcp-session-id']).toBeUndefined();
    await transport.stop();
  });

  it('item 4: an expired session token is not served from cache when no Authorization header is present', async () => {
    const transport = createTransport();
    transport.setMessageHandler(async () => ({ result: 'ok' }));
    const profileState = createProfileState(transport as any);
    profileState.sessions.set('sess-exp', {
      id: 'sess-exp',
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      sseStreams: new Map(),
      authToken: 'cached-access',
      accessTokenExpiresAt: Date.now() - 60_000,
      replayQueue: [],
      nextEventId: 0,
    });
    const req = {
      method: 'POST',
      path: '/mcp',
      url: '/mcp',
      sessionId: 'sess-exp',
      headers: { accept: 'application/json', host: 'localhost' },
      body: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      get: () => undefined,
    } as any;
    const res = createMockResponse();
    await (transport as any).handlePost(req, res);

    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({ error: 'invalid_token' });
    expect(String(res.headers['www-authenticate'])).toContain('resource_metadata=');
    await transport.stop();
  });

  it('item 5: rejects a mid-session replacement token that fails validation', async () => {
    const transport = createTransport({
      baseUrl: 'https://api.example.com',
      authConfigs: [{ type: 'bearer', validation_endpoint: '/validate' }],
    });
    transport.setMessageHandler(async () => ({ result: 'ok' }));
    const profileState = createProfileState(transport as any);
    profileState.context = {
      profileId: 'default',
      authConfigs: [{ type: 'bearer', validation_endpoint: '/validate' }],
      baseUrl: 'https://api.example.com',
    };
    profileState.sessions.set('sess-swap', {
      id: 'sess-swap',
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      sseStreams: new Map(),
      authToken: 'original-token',
      replayQueue: [],
      nextEventId: 0,
    });

    const origFetch = global.fetch;
    global.fetch = vi.fn(async () => ({ status: 401 }) as any);
    try {
      const req = {
        method: 'POST',
        path: '/mcp',
        url: '/mcp',
        sessionId: 'sess-swap',
        headers: { accept: 'application/json', host: 'localhost', authorization: 'Bearer replacement-invalid-token' },
        body: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
        get: () => undefined,
      } as any;
      const res = createMockResponse();
      await (transport as any).handlePost(req, res);

      expect(res.statusCode).toBe(401);
      expect(res.body).toMatchObject({ error: 'invalid_token' });
      expect(String(res.headers['www-authenticate'])).toContain('resource_metadata=');
      // The rejected replacement must not overwrite the established session token.
      expect((profileState.sessions.get('sess-swap') as any).authToken).toBe('original-token');
    } finally {
      global.fetch = origFetch;
      await transport.stop();
    }
  });

  it('item 6: matches the Bearer scheme case-insensitively', () => {
    const transport = createTransport();
    const profileState = createProfileState(transport as any);
    const result = (transport as any).extractAuthToken(
      { headers: { authorization: 'bearer abc123def' } },
      profileState,
      [],
    );
    expect(result).toEqual({ type: 'bearer', token: 'abc123def' });
  });

  it('item 7: redacts credential-like content in buildHttpErrorResponse messages', () => {
    const transport = createTransport();
    const jwt = 'aaaaaaaa.bbbbbbbb.cccccccc';
    const out = (transport as any).buildHttpErrorResponse(new ValidationError(`bad token ${jwt}`), 'cid-1');
    expect(out.message).not.toContain(jwt);
    expect(out.message).toContain('[REDACTED_JWT]');
  });

  it('item 8: does not advertise an unenforced scope in the OAuth /mcp challenge', async () => {
    const transport = createTransport({
      baseUrl: 'https://api.example.com',
      oauthConfig: OAUTH_CONFIG,
      authConfigs: [{ type: 'oauth' }],
    });
    transport.setMessageHandler(async () => ({ result: 'ok' }));
    const req = initReq();
    const res = createMockResponse();
    await (transport as any).handlePost(req, res);

    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({ error: 'invalid_request' });
    expect(String(res.headers['www-authenticate'])).toContain('resource_metadata=');
    expect(String(res.headers['www-authenticate'])).not.toContain('scope=');
    await transport.stop();
  });
});
