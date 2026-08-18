import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { HttpTransport } from './http-transport.js';
import { ConsoleLogger } from '../core/logger.js';
import type { AuthInterceptor, OAuthConfig } from '../types/profile.js';

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

  it('should reject initialization without token when auth has no env fallback', async () => {
    const authConfig: AuthInterceptor = {
      type: 'custom-header',
      header_name: 'X-API-Key',
    };

    const profileContext = {
      profileId: 'default',
      authConfigs: [authConfig],
      baseUrl: 'http://example.com'
    };

    transport.setProfileContextProvider(async () => profileContext);

    const req = {
      method: 'POST',
      url: '/mcp',
      path: '/mcp',
      headers: {
        'content-type': 'application/json',
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

    transport.setMessageHandler(async () => {
      return { result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'server', version: '1.0' } } };
    });

    await (transport as any).handlePost(req, res);

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual(expect.objectContaining({ error: 'invalid_request' }));
  });

  it('should allow initialization without client token when env fallback token exists', async () => {
    const authEnvVarName = 'HTTP_TRANSPORT_AUTH_FALLBACK_TOKEN';
    const previousEnvValue = process.env[authEnvVarName];
    process.env[authEnvVarName] = 'server-side-token';

    try {
      const authConfig: AuthInterceptor = {
        type: 'custom-header',
        header_name: 'X-API-Key',
        value_from_env: authEnvVarName,
      };

      const profileContext = {
        profileId: 'default',
        authConfigs: [authConfig],
        baseUrl: 'http://example.com'
      };

      transport.setProfileContextProvider(async () => profileContext);

      const req = {
        method: 'POST',
        url: '/mcp',
        path: '/mcp',
        headers: {
          'content-type': 'application/json',
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

      transport.setMessageHandler(async () => {
        return { result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'server', version: '1.0' } } };
      });

      await (transport as any).handlePost(req, res);

      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual(expect.objectContaining({
        result: expect.objectContaining({
          serverInfo: expect.objectContaining({ name: 'server' })
        })
      }));
    } finally {
      if (previousEnvValue === undefined) {
        delete process.env[authEnvVarName];
      } else {
        process.env[authEnvVarName] = previousEnvValue;
      }
    }
  });

  it('should allow initialization without client token when session-cookie credentials exist on server', async () => {
    const usernameEnvVarName = 'HTTP_TRANSPORT_SESSION_COOKIE_USER';
    const passwordEnvVarName = 'HTTP_TRANSPORT_SESSION_COOKIE_PASSWORD';
    const previousUsername = process.env[usernameEnvVarName];
    const previousPassword = process.env[passwordEnvVarName];
    process.env[usernameEnvVarName] = 'user@example.com';
    process.env[passwordEnvVarName] = 'secret';

    try {
      const authConfig: AuthInterceptor = {
        type: 'session-cookie',
        session_cookie_config: {
          login_endpoint: '/rest/login',
          username_field: 'email',
          username_from_env: usernameEnvVarName,
          password_field: 'password',
          password_from_env: passwordEnvVarName,
          cookie_names: ['n8n-auth'],
        },
      };

      const profileContext = {
        profileId: 'default',
        authConfigs: [authConfig],
        baseUrl: 'http://example.com'
      };

      transport.setProfileContextProvider(async () => profileContext);

      const req = {
        method: 'POST',
        url: '/mcp',
        path: '/mcp',
        headers: {
          'content-type': 'application/json',
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

      transport.setMessageHandler(async () => {
        return { result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'server', version: '1.0' } } };
      });

      await (transport as any).handlePost(req, res);

      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual(expect.objectContaining({
        result: expect.objectContaining({
          serverInfo: expect.objectContaining({ name: 'server' })
        })
      }));
    } finally {
      if (previousUsername === undefined) {
        delete process.env[usernameEnvVarName];
      } else {
        process.env[usernameEnvVarName] = previousUsername;
      }

      if (previousPassword === undefined) {
        delete process.env[passwordEnvVarName];
      } else {
        process.env[passwordEnvVarName] = previousPassword;
      }
    }
  });

  it('should reject initialization when session-cookie server credentials are incomplete', async () => {
    const usernameEnvVarName = 'HTTP_TRANSPORT_SESSION_COOKIE_USER_ONLY';
    const passwordEnvVarName = 'HTTP_TRANSPORT_SESSION_COOKIE_PASSWORD_ONLY';
    const previousUsername = process.env[usernameEnvVarName];
    const previousPassword = process.env[passwordEnvVarName];
    process.env[usernameEnvVarName] = 'user@example.com';
    delete process.env[passwordEnvVarName];

    try {
      const authConfig: AuthInterceptor = {
        type: 'session-cookie',
        session_cookie_config: {
          login_endpoint: '/rest/login',
          username_field: 'email',
          username_from_env: usernameEnvVarName,
          password_field: 'password',
          password_from_env: passwordEnvVarName,
          cookie_names: ['n8n-auth'],
        },
      };

      const profileContext = {
        profileId: 'default',
        authConfigs: [authConfig],
        baseUrl: 'http://example.com'
      };

      transport.setProfileContextProvider(async () => profileContext);

      const req = {
        method: 'POST',
        url: '/mcp',
        path: '/mcp',
        headers: {
          'content-type': 'application/json',
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

      transport.setMessageHandler(async () => {
        return { result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'server', version: '1.0' } } };
      });

      await (transport as any).handlePost(req, res);

      expect(res.statusCode).toBe(401);
      expect(res.body).toEqual(expect.objectContaining({ error: 'invalid_request' }));
    } finally {
      if (previousUsername === undefined) {
        delete process.env[usernameEnvVarName];
      } else {
        process.env[usernameEnvVarName] = previousUsername;
      }

      if (previousPassword === undefined) {
        delete process.env[passwordEnvVarName];
      } else {
        process.env[passwordEnvVarName] = previousPassword;
      }
    }
  });
});

/**
 * AIPP-572 wave E: OAuth precedence at the transport boundary.
 *
 * On an OAuth-required (oauthActive) profile only an OAuth bearer may establish a
 * session; a weaker method (X-API-Token / DRF `Authorization: Token` / custom-header)
 * must not shadow OAuth by creating an unvalidated session. The profile below is
 * multi-auth: OAuth (priority 0) plus a DRF token and a custom-header fallback, so
 * the weaker methods are genuinely configured yet still rejected while OAuth wins.
 */
describe('OAuth precedence at transport boundary (AIPP-572 wave E)', () => {
  let transport: HttpTransport;
  const logger = new ConsoleLogger();

  const oauthConfig: OAuthConfig = {
    authorization_endpoint: 'https://oauth.example.com/oauth/authorize',
    token_endpoint: 'https://oauth.example.com/oauth/token',
    redirect_uri: 'http://localhost:3003/oauth/callback',
    scopes: ['api'],
  };

  // Multi-auth: OAuth primary + weaker fallbacks. None of the fallbacks declare a
  // validation_endpoint, so a bearer that reaches validation is skipped (accepted),
  // isolating the enforcement decision (weaker methods rejected before validation).
  const authConfigs: AuthInterceptor[] = [
    { type: 'oauth', priority: 0, oauth_config: oauthConfig },
    { type: 'token', priority: 1, value_from_env: 'ENFORCE_DRF_TOKEN' },
    { type: 'custom-header', priority: 2, header_name: 'X-API-Key', value_from_env: 'ENFORCE_API_KEY' },
  ];

  beforeEach(() => {
    transport = new HttpTransport(
      {
        host: '127.0.0.1',
        port: 0,
        sessionTimeoutMs: 1800000,
        heartbeatEnabled: false,
        metricsEnabled: false,
        defaultProfileId: 'default',
      },
      logger,
    );

    transport.setProfileContextProvider(async () => ({
      profileId: 'default',
      oauthConfig,
      authConfigs,
      baseUrl: 'http://example.com',
    }));

    transport.setMessageHandler(async () => ({
      result: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        serverInfo: { name: 'server', version: '1.0' },
      },
    }));
  });

  afterEach(async () => {
    await transport.stop();
  });

  const makeReq = (headers: Record<string, string>) => ({
    method: 'POST',
    url: '/mcp',
    path: '/mcp',
    headers: { 'content-type': 'application/json', ...headers },
    body: {
      jsonrpc: '2.0',
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0' },
      },
      id: 1,
    },
    get: (name: string) => (name === 'content-type' ? 'application/json' : undefined),
  });

  const makeRes = () => ({
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: null as any,
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
    },
  });

  it('allows initialization with an OAuth bearer', async () => {
    const req = makeReq({ authorization: 'Bearer oauth-access-token' });
    const res = makeRes();

    await (transport as any).handlePost(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({
      result: expect.objectContaining({
        serverInfo: expect.objectContaining({ name: 'server' }),
      }),
    }));
  });

  it('rejects an X-API-Token credential (does not bypass OAuth)', async () => {
    const req = makeReq({ 'x-api-token': 'weak-api-token' });
    const res = makeRes();

    await (transport as any).handlePost(req, res);

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual(expect.objectContaining({ error: 'invalid_token' }));
  });

  it('rejects a DRF Token Authorization credential (does not bypass OAuth)', async () => {
    const req = makeReq({ authorization: 'Token drf-token' });
    const res = makeRes();

    await (transport as any).handlePost(req, res);

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual(expect.objectContaining({ error: 'invalid_token' }));
  });

  it('rejects a custom-header credential (does not bypass OAuth)', async () => {
    const req = makeReq({ 'x-api-key': 'weak-header-key' });
    const res = makeRes();

    await (transport as any).handlePost(req, res);

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual(expect.objectContaining({ error: 'invalid_token' }));
  });
});
