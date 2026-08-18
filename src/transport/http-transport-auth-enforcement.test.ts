import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { HttpTransport } from './http-transport.js';
import { ConsoleLogger } from '../core/logger.js';
import type { AuthInterceptor } from '../types/profile.js';

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
