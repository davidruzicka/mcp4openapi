/**
 * Unit tests for MCPServer
 *
 * Why: Test server initialization, tool listing, and behavior without profile.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'path';
import { MCPServer } from './mcp-server.js';
import { HttpTransport } from './http-transport.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { JsonLogger } from './logger.js';
import { Server as MCPProtocolServer } from '@modelcontextprotocol/sdk/server/index.js';
import { 
  AuthenticationError, 
  AuthorizationError, 
  RateLimitError, 
  NetworkError,
  ValidationError,
  OperationNotFoundError,
  ConfigurationError
} from './errors.js';

describe('MCPServer', () => {
  let server: MCPServer;
  const originalApiToken = process.env.MCP4_API_TOKEN;

  beforeEach(() => {
    server = new MCPServer();
  });

  afterEach(() => {
    if (originalApiToken === undefined) {
      delete process.env.MCP4_API_TOKEN;
    } else {
      process.env.MCP4_API_TOKEN = originalApiToken;
    }
  });

  describe('initialize without profile', () => {
    it('should initialize successfully without profile path', async () => {
      const specPath = path.join(process.cwd(), 'profiles/gitlab/openapi.yaml');

      await expect(server.initialize(specPath)).resolves.toBeUndefined();
    });

    it('should have auto-generated tools when no profile is provided', async () => {
      const specPath = path.join(process.cwd(), 'profiles/gitlab/openapi.yaml');
      await server.initialize(specPath);

      expect(server['profile']!.tools.length).toBeGreaterThan(0);
      // Check that tools have proper structure
      const firstTool = server['profile']!.tools[0];
      expect(firstTool.name).toBeDefined();
      expect(firstTool.description).toBeDefined();
      expect(firstTool.operations).toBeDefined();
      expect(firstTool.parameters).toBeDefined();
    });

    it('should use default profile with auto-generated tools', async () => {
      const specPath = path.join(process.cwd(), 'profiles/gitlab/openapi.yaml');
      await server.initialize(specPath);

      expect(server['profile']!.profile_name).toBe('default');
      expect(server['profile']!.tools.length).toBeGreaterThan(0);
      expect(server['profile']!.description).toContain('Auto-generated default profile');
    });
  });

  describe('initialize with profile', () => {
    it('should load profile and provide tools', async () => {
      const specPath = path.join(process.cwd(), 'profiles/gitlab/openapi.yaml');
      const profilePath = path.join(process.cwd(), 'profiles/gitlab/developer-profile.json');

      await server.initialize(specPath, profilePath);

      expect(server['profile']!.tools.length).toBeGreaterThan(0);
    });

    it('should create global client when OAuth is higher priority than env auth', async () => {
      const specPath = path.join(process.cwd(), 'profiles/gitlab/openapi.yaml');
      const profilePath = path.join(process.cwd(), 'profiles/gitlab/developer-profile.json');

      process.env.MCP4_API_TOKEN = 'test-token';

      await server.initialize(specPath, profilePath);

      const hasGlobalClient = (server as any).httpClientFactory.hasGlobalClient();
      expect(hasGlobalClient).toBe(true);
    });

    it('should report missing env token when OAuth is primary and env auth has no token', async () => {
      const specPath = path.join(process.cwd(), 'profiles/gitlab/openapi.yaml');
      const profilePath = path.join(process.cwd(), 'profiles/gitlab/developer-profile.json');

      delete process.env.MCP4_API_TOKEN;

      await server.initialize(specPath, profilePath);

      const hasGlobalClient = (server as any).httpClientFactory.hasGlobalClient();
      expect(hasGlobalClient).toBe(false);

      await expect((server as any).getHttpClientForSession()).rejects.toThrow(
        /HasEnvToken\(MCP4_API_TOKEN\): false/
      );
    });
  });

  describe('runStdio', () => {
    it('should connect MCP server via StdioServerTransport', async () => {
      const logger = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };

      const server = new MCPServer(logger as any);
      const connectSpy = vi.spyOn((server as any).server, 'connect').mockResolvedValue(undefined);

      try {
        await server.runStdio();
        expect(connectSpy).toHaveBeenCalledTimes(1);
        expect(logger.info).toHaveBeenCalledWith('MCP server running on stdio');
      } finally {
        connectSpy.mockRestore();
      }
    });
  });

  describe('auto-generated tools from OpenAPI spec', () => {
    beforeEach(async () => {
      const specPath = path.join(process.cwd(), 'profiles/gitlab/openapi.yaml');
      await server.initialize(specPath);
    });

    it('should generate tools with operationId as name', () => {
      const tools = server['profile']!.tools;
      expect(tools.length).toBeGreaterThan(0);

      // All tools should have operationId as name
      tools.forEach(tool => {
        expect(tool.name).toBeDefined();
        expect(typeof tool.name).toBe('string');
        expect(tool.name.length).toBeGreaterThan(0);
      });
    });

    it('should generate tools with meaningful descriptions', () => {
      const tools = server['profile']!.tools;

      tools.forEach(tool => {
        expect(tool.description).toBeDefined();
        expect(typeof tool.description).toBe('string');
        expect(tool.description.length).toBeGreaterThan(0);
      });
    });

    it('should generate tools with operations mapping', () => {
      const tools = server['profile']!.tools;

      tools.forEach(tool => {
        expect(tool.operations).toBeDefined();
        expect(typeof tool.operations).toBe('object');
        expect(tool.operations).toHaveProperty('execute');
        expect(typeof (tool.operations as any).execute).toBe('string');
      });
    });

    it('should generate tools with parameters from OpenAPI spec', () => {
      const tools = server['profile']!.tools;

      // Find a tool that should have parameters
      const toolWithParams = tools.find(t => Object.keys(t.parameters).length > 0);
      expect(toolWithParams).toBeDefined();

      if (toolWithParams) {
        Object.values(toolWithParams.parameters).forEach(param => {
          expect(param.type).toBeDefined();
          expect(param.description).toBeDefined();
          expect(typeof param.required).toBe('boolean');
        });
      }
    });

    it('should generate reasonable number of tools from GitLab spec', () => {
      const tools = server['profile']!.tools;
      // GitLab spec has around 87 operations, should generate similar number
      expect(tools.length).toBeGreaterThan(50);
      expect(tools.length).toBeLessThan(200);
    });
  });

  describe('error sanitization', () => {
    it('should successfully execute simple tool and return result', async () => {
      const server = new MCPServer();
      const specPath = path.join(process.cwd(), 'profiles/gitlab/openapi.yaml');
      await server.initialize(specPath);

      // Find any simple (non-composite) tool
      const simpleTool = (server as any).profile.tools.find((t: any) => !t.composite);
      if (!simpleTool) return;

      // Mock executeSimpleTool to return success
      (server as any).executeSimpleTool = async () => {
        return { id: 1, name: 'test' };
      };

      const message = {
        jsonrpc: '2.0',
        id: '1',
        method: 'tools/call',
        params: {
          name: simpleTool.name,
          arguments: {}
        }
      };

      const response = await (server as any)['handleToolCall'](message, 'test-session');
      expect(response.result).toBeDefined();
      expect(response.result.content).toBeDefined();
      expect(response.result.content[0].type).toBe('text');
      const parsed = JSON.parse(response.result.content[0].text);
      expect(parsed).toEqual({ id: 1, name: 'test' });
    });

    it('should return user-friendly error message with correlation ID from HTTP handleToolCall', async () => {
      const specPath = path.join(process.cwd(), 'profiles/gitlab/openapi.yaml');
      await server.initialize(specPath);

      const message = {
        jsonrpc: '2.0',
        id: '1',
        method: 'tools/call',
        params: {
          name: 'non_existing_tool',
          arguments: {}
        }
      };

      const response = await (server as any)['handleToolCall'](message, 'test-session');
      expect(response).toHaveProperty('error');
      expect(response.error).toHaveProperty('message');
      // OperationNotFoundError is safe to show with correlation ID
      expect(response.error.message).toContain('Operation not found');
      expect(response.error.message).toContain('correlation ID');
    });

    it('should map AuthorizationError to error code -32002', async () => {
      const server = new MCPServer();
      const specPath = path.join(process.cwd(), 'profiles/gitlab/openapi.yaml');
      await server.initialize(specPath);

      // Mock the composite executor to throw AuthorizationError
      (server as any).compositeExecutor = {
        execute: async () => {
          throw new AuthorizationError('Forbidden');
        }
      };
      
      // Find a composite tool
      const compositeTool = (server as any).profile.tools.find((t: any) => t.composite);
      if (!compositeTool) return; // Skip if no composite tools
      
      const message = {
        jsonrpc: '2.0',
        id: '1',
        method: 'tools/call',
        params: {
          name: compositeTool.name,
          arguments: {}
        }
      };

      const response = await (server as any)['handleToolCall'](message, 'test-session');
      expect(response.error.code).toBe(-32002);
    });

    it('should map ValidationError to error code -32602', async () => {
      const server = new MCPServer();
      const specPath = path.join(process.cwd(), 'profiles/gitlab/openapi.yaml');
      await server.initialize(specPath);

      // Find any simple (non-composite) tool
      const simpleTool = (server as any).profile.tools.find((t: any) => !t.composite);
      if (!simpleTool) return; // Skip if no simple tools

      // Mock executeSimpleTool to throw ValidationError
      (server as any).executeSimpleTool = async () => {
        throw new ValidationError('Invalid input');
      };

      const message = {
        jsonrpc: '2.0',
        id: '1',
        method: 'tools/call',
        params: {
          name: simpleTool.name,
          arguments: {}
        }
      };

      const response = await (server as any)['handleToolCall'](message, 'test-session');
      expect(response.error.code).toBe(-32602);
    });

    it('should map RateLimitError to error code -32003', async () => {
      const server = new MCPServer();
      const specPath = path.join(process.cwd(), 'profiles/gitlab/openapi.yaml');
      await server.initialize(specPath);

      // Find any simple (non-composite) tool
      const simpleTool = (server as any).profile.tools.find((t: any) => !t.composite);
      if (!simpleTool) return; // Skip if no simple tools

      // Mock executeSimpleTool to throw RateLimitError
      (server as any).executeSimpleTool = async () => {
        throw new RateLimitError('Too many requests', 60);
      };

      const message = {
        jsonrpc: '2.0',
        id: '1',
        method: 'tools/call',
        params: {
          name: simpleTool.name,
          arguments: {}
        }
      };

      const response = await (server as any)['handleToolCall'](message, 'test-session');
      expect(response.error.code).toBe(-32003);
    });

    it('should map AuthenticationError to error code -32001', async () => {
      const server = new MCPServer();
      const specPath = path.join(process.cwd(), 'profiles/gitlab/openapi.yaml');
      await server.initialize(specPath);

      // Find any simple (non-composite) tool
      const simpleTool = (server as any).profile.tools.find((t: any) => !t.composite);
      if (!simpleTool) return;

      // Mock executeSimpleTool to throw AuthenticationError
      (server as any).executeSimpleTool = async () => {
        throw new AuthenticationError('Token expired');
      };

      const message = {
        jsonrpc: '2.0',
        id: '1',
        method: 'tools/call',
        params: {
          name: simpleTool.name,
          arguments: {}
        }
      };

      const response = await (server as any)['handleToolCall'](message, 'test-session');
      expect(response.error.code).toBe(-32001);
    });

    it('should return OAuth required error when httpTransport has OAuth provider but no auth token', async () => {
      const server = new MCPServer();
      const specPath = path.join(process.cwd(), 'profiles/gitlab/openapi.yaml');
      await server.initialize(specPath);

      const simpleTool = (server as any).profile.tools.find((t: any) => !t.composite);
      if (!simpleTool) return;

      // Mock httpTransport with OAuth provider
      (server as any).httpTransport = {
        hasOAuthProvider: () => true,
        getServerUrl: () => 'http://localhost:3000',
      };

      // Mock getAuthTokenFromSession to return null (no token)
      (server as any).getAuthTokenFromSession = async () => null;

      const message = {
        jsonrpc: '2.0',
        id: '1',
        method: 'tools/call',
        params: {
          name: simpleTool.name,
          arguments: {}
        }
      };

      const response = await (server as any)['handleToolCall'](message, 'test-session');
      expect(response.error).toBeDefined();
      expect(response.error.code).toBe(-32001);
      expect(response.error.message).toContain('Authentication required');
      expect(response.error.data.oauth_required).toBe(true);
    });

    it('should map generic Error to -32603 internal error code', async () => {
      const server = new MCPServer();
      const specPath = path.join(process.cwd(), 'profiles/gitlab/openapi.yaml');
      await server.initialize(specPath);

      const simpleTool = (server as any).profile.tools.find((t: any) => !t.composite);
      if (!simpleTool) return;

      (server as any).executeSimpleTool = async () => {
        throw new Error('Generic internal error');
      };

      const message = {
        jsonrpc: '2.0',
        id: '1',
        method: 'tools/call',
        params: {
          name: simpleTool.name,
          arguments: {}
        }
      };

      const response = await (server as any)['handleToolCall'](message, 'test-session');
      expect(response.error.code).toBe(-32603);
    });
  });

  describe('handleToolCall error mapping (HTTP JSON-RPC)', () => {
    it('maps AuthorizationError to -32002', async () => {
      const server = new MCPServer();
      const specPath = path.join(process.cwd(), 'profiles/gitlab/openapi.yaml');
      await server.initialize(specPath);

      (server as any).profile = {
        profile_name: 'test',
        description: 'test',
        tools: [
          {
            name: 'simple_test',
            description: 'test',
            parameters: {},
            operations: { execute: 'op' },
          },
        ],
        interceptors: {},
      };
      (server as any).compositeExecutor = { execute: async () => ({}) };
      (server as any).toolGenerator = { validateArguments: () => {} };
      (server as any).executeSimpleTool = async () => {
        throw new AuthorizationError('Forbidden');
      };

      const message = {
        jsonrpc: '2.0',
        id: '1',
        method: 'tools/call',
        params: { name: 'simple_test', arguments: {} },
      };

      const response = await (server as any).handleToolCall(message, 'test-session');
      expect(response.error.code).toBe(-32002);
    });
  });

  describe('security warnings', () => {
    it('should warn when binding non-localhost with empty MCP4_ALLOWED_ORIGINS', async () => {
      const messages: string[] = [];
      const testLogger: any = {
        debug: () => {},
        info: () => {},
        warn: (msg: string) => { messages.push(msg); },
        error: () => {},
      };

      const serverWithLogger = new MCPServer(testLogger);

      const prev = process.env.MCP4_ALLOWED_ORIGINS;
      delete process.env.MCP4_ALLOWED_ORIGINS;
      const startSpy = vi.spyOn(HttpTransport.prototype, 'start').mockResolvedValue(undefined as any);
      const stopSpy = vi.spyOn(HttpTransport.prototype, 'stop').mockResolvedValue(undefined as any);
      try {
        await serverWithLogger.runHttp('0.0.0.0', 0);
        expect(messages.find(m => m.includes('MCP4_ALLOWED_ORIGINS'))).toBeDefined();
      } finally {
        await serverWithLogger.stop();
        startSpy.mockRestore();
        stopSpy.mockRestore();
        process.env.MCP4_ALLOWED_ORIGINS = prev;
      }
    });
  });

  describe('runHttp configuration', () => {
    const originalEnv = { ...process.env };

    afterEach(() => {
      process.env = { ...originalEnv };
      vi.resetModules();
      vi.clearAllMocks();
    });

    it('should derive OAuth redirect hosts and token limits from environment', async () => {
      const capturedConfigs: any[] = [];

      vi.doMock('./http-transport.js', () => {
        return {
          HttpTransport: class {
            constructor(config: any) {
              capturedConfigs.push(config);
            }
            setMessageHandler() {}
            onSessionDestroyed() {}
            async start() {}
            async stop() {}
            hasOAuthProvider() { return false; }
            getSessionToken() { return undefined; }
            ensureValidSessionToken() { return Promise.resolve(true); }
          }
        };
      });

      const { MCPServer: MockedMCPServer } = await import('./mcp-server.js');
      const serverWithMock = new MockedMCPServer({
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
      } as any);

      (serverWithMock as any).parser = {
        getBaseUrl: () => 'https://api.test',
        getResourceMetadata: () => ({ name: 'Test', documentation: 'Docs' })
      };

      (serverWithMock as any).profile = {
        profile_name: 'test',
        description: 'test profile',
        tools: [],
        interceptors: {
          auth: [{
            type: 'oauth',
            priority: 1,
            oauth_config: {
              issuer: 'https://issuer.test',
              client_id: 'client-id',
              redirect_uri: 'https://app.test/callback'
            }
          }]
        }
      };

      process.env.MCP4_ALLOWED_ORIGINS = 'https://*.allowed.test';
      process.env.MCP4_TOKEN_MAX_LENGTH = '2048';

      await serverWithMock.runHttp('127.0.0.1', 0);
      await serverWithMock.stop();

      expect(capturedConfigs).toHaveLength(1);
      const config = capturedConfigs[0];
      expect(config.maxTokenLength).toBe(2048);
      expect(config.oauthConfig?.allowed_redirect_hosts).toEqual(['*.allowed.test']);
    });
  });

  describe('executeProxyDownload wiring', () => {
    const originalEnv = { ...process.env };

    afterEach(() => {
      process.env = { ...originalEnv };
      vi.resetModules();
      vi.clearAllMocks();
    });

    it('should pass logger into ProxyDownloadExecutor', async () => {
      const capturedCtorArgs: any[] = [];

      vi.doMock('./proxy-executor.js', () => {
        return {
          ProxyDownloadExecutor: class {
            constructor(httpClient: any, logger: any) {
              capturedCtorArgs.push({ httpClient, logger });
            }
            async execute() {
              return { fileName: 'x', mimeType: 'text/plain', size: 1, content: 'a' };
            }
          },
        };
      });

      const { MCPServer: MockedMCPServer } = await import('./mcp-server.js');

      const logger = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };

      const server = new MockedMCPServer(logger as any);

      (server as any).parser = {
        getOperation: (opId: string) => {
          if (opId === 'metadata') return { path: '/meta/{id}', method: 'GET' };
          return undefined;
        },
      };

      (server as any).profile = {
        profile_name: 'test',
        description: 'test profile',
        tools: [],
        interceptors: { auth: [] },
      };

      (server as any).getHttpClientForSession = vi.fn(async () => {
        return {
          getAuthCredentials: () => ({ type: 'none' }),
        };
      });

      await (server as any).executeProxyDownload(
        {
          metadata_endpoint: 'metadata',
          url_field: 'url',
        },
        { id: '123' }
      );

      expect(capturedCtorArgs.length).toBe(1);
      expect(capturedCtorArgs[0].logger).toBe(logger);
    });
  });

  describe('error handling with correlation ID', () => {
    it('should format AuthenticationError with correlation ID for client', () => {
      const server = new MCPServer();
      const error = new AuthenticationError('Token is expired');
      const correlationId = 'test-correlation-id';
      
      const formatted = (server as any).formatErrorForClient(error, correlationId);
      
      expect(formatted).toContain('Authentication failed');
      expect(formatted).toContain('Token is expired');
      expect(formatted).toContain(correlationId);
    });

    it('should format AuthorizationError with correlation ID for client', () => {
      const server = new MCPServer();
      const error = new AuthorizationError('Insufficient permissions');
      const correlationId = 'test-correlation-id';
      
      const formatted = (server as any).formatErrorForClient(error, correlationId);
      
      expect(formatted).toContain('Authorization failed');
      expect(formatted).toContain('Insufficient permissions');
      expect(formatted).toContain(correlationId);
    });

    it('should format RateLimitError with retry info and correlation ID', () => {
      const server = new MCPServer();
      const error = new RateLimitError('Too many requests', 60);
      const correlationId = 'test-correlation-id';
      
      const formatted = (server as any).formatErrorForClient(error, correlationId);
      
      expect(formatted).toContain('Rate limit exceeded');
      expect(formatted).toContain('Retry after 60 seconds');
      expect(formatted).toContain(correlationId);
    });

    it('should format NetworkError (4xx) with correlation ID for client', () => {
      const server = new MCPServer();
      const error = new NetworkError('Not found', 404);
      const correlationId = 'test-correlation-id';
      
      const formatted = (server as any).formatErrorForClient(error, correlationId);
      
      expect(formatted).toContain('Request failed');
      expect(formatted).toContain('Not found');
      expect(formatted).toContain(correlationId);
    });

    it('should hide details for NetworkError (5xx) and show only correlation ID', () => {
      const server = new MCPServer();
      const error = new NetworkError('Internal server error', 500, {
        body: { sensitiveData: 'should not be exposed' }
      });
      const correlationId = 'test-correlation-id';
      
      const formatted = (server as any).formatErrorForClient(error, correlationId);
      
      expect(formatted).toContain('Internal error');
      expect(formatted).toContain(correlationId);
      expect(formatted).not.toContain('sensitiveData');
      expect(formatted).not.toContain('Internal server error');
    });

    it('should format ValidationError with correlation ID for client', () => {
      const server = new MCPServer();
      const error = new ValidationError('Invalid parameter format');
      const correlationId = 'test-correlation-id';
      
      const formatted = (server as any).formatErrorForClient(error, correlationId);
      
      expect(formatted).toContain('Validation error');
      expect(formatted).toContain('Invalid parameter format');
      expect(formatted).toContain(correlationId);
    });

    it('should format generic errors with only correlation ID', () => {
      const server = new MCPServer();
      const error = new Error('Some internal error');
      const correlationId = 'test-correlation-id';
      
      const formatted = (server as any).formatErrorForClient(error, correlationId);
      
      expect(formatted).toBe(`Internal error (correlation ID: ${correlationId})`);
      expect(formatted).not.toContain('Some internal error');
    });
  });

  describe('session token validation with empty sessionId', () => {
    it('should not log warning when sessionId is empty', async () => {
      const warns: string[] = [];
      const testLogger: any = {
        debug: () => {},
        info: () => {},
        warn: (msg: string) => { warns.push(msg); },
        error: () => {},
      };

      const serverWithLogger = new MCPServer(testLogger);
      await serverWithLogger.runHttp('127.0.0.1', 0);
      try {
        const token = await (serverWithLogger as any).getAuthTokenFromSession('');
        expect(token).toBeUndefined();
        expect(warns.find(m => m.includes('Session token validation/refresh failed'))).toBeUndefined();
      } finally {
        await serverWithLogger.stop();
      }
    });
  });

  describe('getAuthTokenFromSession', () => {
    it('should return undefined when httpTransport is missing', async () => {
      const server = new MCPServer();
      const token = await (server as any).getAuthTokenFromSession('session-1');
      expect(token).toBeUndefined();
    });

    it('should warn when token refresh fails but still return token if available', async () => {
      const warns: any[] = [];
      const testLogger: any = {
        debug: () => {},
        info: () => {},
        warn: (msg: string, ctx?: any) => { warns.push({ msg, ctx }); },
        error: () => {},
      };

      const server = new MCPServer(testLogger);
      (server as any).httpTransport = {
        ensureValidSessionToken: async () => false,
        getSessionToken: () => 'still-returned-token',
      };

      const token = await (server as any).getAuthTokenFromSession('session-1');
      expect(token).toBe('still-returned-token');
      expect(warns.some(w => String(w.msg).includes('Session token validation/refresh failed'))).toBe(true);
    });
  });

  describe('createLoggerWithAuth', () => {
    it('should create JsonLogger when MCP4_LOG_FORMAT=json', () => {
      const original = process.env.MCP4_LOG_FORMAT;
      process.env.MCP4_LOG_FORMAT = 'json';
      try {
        const server = new MCPServer();
        const logger = (server as any).createLoggerWithAuth({
          type: 'bearer',
          value_from_env: 'MCP4_API_TOKEN',
        });
        expect(logger).toBeInstanceOf(JsonLogger);
      } finally {
        if (original === undefined) delete process.env.MCP4_LOG_FORMAT;
        else process.env.MCP4_LOG_FORMAT = original;
      }
    });
  });

  describe('filterFields', () => {
    it('should filter object fields', () => {
      const server = new MCPServer();
      const data = { id: 1, name: 'test', secret: 'hidden', extra: 'data' };
      const result = (server as any).filterFields(data, ['id', 'name']);
      expect(result).toEqual({ id: 1, name: 'test' });
    });

    it('should filter array of objects', () => {
      const server = new MCPServer();
      const data = [
        { id: 1, name: 'a', secret: 'x' },
        { id: 2, name: 'b', secret: 'y' }
      ];
      const result = (server as any).filterFields(data, ['id', 'name']);
      expect(result).toEqual([{ id: 1, name: 'a' }, { id: 2, name: 'b' }]);
    });

    it('should recurse into nested objects and arrays when subfields are specified', () => {
      const server = new MCPServer();
      const data = {
        id: 'PROJ',
        customFields: [
          {
            id: 'pcf-1',
            ignored: 'ignored',
            field: {
              id: 'cf-1',
              name: 'Priority',
              ignored: 'ignored',
            },
          },
        ],
        ignored: 'ignored',
      };

      const result = (server as any).filterFields(data, ['id', 'customFields(id,field(id,name))']);
      expect(result).toEqual({
        id: 'PROJ',
        customFields: [
          {
            id: 'pcf-1',
            field: {
              id: 'cf-1',
              name: 'Priority',
            },
          },
        ],
      });
    });

    it('should merge repeated selectors for the same base field', () => {
      const server = new MCPServer();
      const data = {
        customFields: [
          {
            id: 'pcf-1',
            ignored: 'ignored',
            field: {
              id: 'cf-1',
              name: 'Priority',
              ignored: 'ignored',
            },
          },
        ],
      };

      const result = (server as any).filterFields(data, ['customFields(id)', 'customFields(field(id))']);
      expect(result).toEqual({
        customFields: [
          {
            id: 'pcf-1',
            field: {
              id: 'cf-1',
            },
          },
        ],
      });
    });

    it('should handle conflicts by promoting to full field selection', () => {
      const server = new MCPServer();
      const data = {
        customFields: [
          {
            id: 'pcf-1',
            ignored: 'ignored',
            field: {
              id: 'cf-1',
              name: 'Priority',
              ignored: 'ignored',
            },
          },
        ],
      };

      const result = (server as any).filterFields(data, ['customFields(field)', 'customFields(field(id))']);
      expect(result).toEqual({
        customFields: [
          {
            field: {
              id: 'cf-1',
              name: 'Priority',
              ignored: 'ignored',
            },
          },
        ],
      });
    });

    it('should split nested selectors correctly', () => {
      const server = new MCPServer();
      const data = {
        id: 'ISSUE-1',
        comments: [
          {
            id: 'c-1',
            text: 'hello',
            secret: 'ignored',
            author: {
              id: 'u-1',
              login: 'user',
              secret: 'ignored',
            },
          },
        ],
      };

      const result = (server as any).filterFields(data, ['id', 'comments(id,text,author(id,login))']);
      expect(result).toEqual({
        id: 'ISSUE-1',
        comments: [
          {
            id: 'c-1',
            text: 'hello',
            author: {
              id: 'u-1',
              login: 'user',
            },
          },
        ],
      });
    });

    it('should not allow prototype pollution via field selectors', () => {
      const server = new MCPServer();

      const data = {
        safe: 'ok',
        __proto__: { polluted: true },
      };

      const before = ({} as any).polluted;
      expect(before).toBeUndefined();

      const result = (server as any).filterFields(data, ['safe', '__proto__(polluted)', 'constructor(prototype)', 'prototype(x)']);
      expect(result).toEqual({ safe: 'ok' });

      const after = ({} as any).polluted;
      expect(after).toBeUndefined();
    });

    it('should return primitive values as-is', () => {
      const server = new MCPServer();
      expect((server as any).filterFields('string', ['id'])).toBe('string');
      expect((server as any).filterFields(123, ['id'])).toBe(123);
      expect((server as any).filterFields(null, ['id'])).toBe(null);
    });

    it('should handle missing fields gracefully', () => {
      const server = new MCPServer();
      const data = { id: 1, name: 'test' };
      const result = (server as any).filterFields(data, ['id', 'nonexistent']);
      expect(result).toEqual({ id: 1 });
    });
  });

  describe('executeProxyDownload', () => {
    let localServer: MCPServer;

    beforeEach(() => {
      localServer = new MCPServer();
    });

    it('should throw OperationNotFoundError when metadata endpoint is missing', async () => {
      (localServer as any).parser = {
        getOperation: vi.fn(() => undefined),
      };

      await expect(
        (localServer as any).executeProxyDownload(
          { type: 'proxy_download', metadata_endpoint: 'missing-meta' },
          {},
          undefined
        )
      ).rejects.toBeInstanceOf(OperationNotFoundError);
    });

    it('should throw OperationNotFoundError when download endpoint is missing', async () => {
      const metadataOp = {
        operationId: 'meta-op',
        method: 'GET',
        path: '/projects/{id}/jobs/{job_id}',
        parameters: [],
      };

      (localServer as any).parser = {
        getOperation: vi.fn((operationId: string) => {
          if (operationId === 'meta-op') {
            return metadataOp;
          }
          return undefined;
        }),
      };
      (localServer as any).resolvePath = vi.fn(() => '/projects/1/jobs/2');

      await expect(
        (localServer as any).executeProxyDownload(
          {
            type: 'proxy_download',
            metadata_endpoint: 'meta-op',
            download_endpoint: 'missing-download',
          },
          { project_id: 'my-org/my-project', job_id: 2 },
          undefined
        )
      ).rejects.toBeInstanceOf(OperationNotFoundError);
    });
  });

  describe('handleOtherRequest', () => {
    let server: MCPServer;

    beforeEach(async () => {
      server = new MCPServer();
      const specPath = path.join(process.cwd(), 'profiles/gitlab/openapi.yaml');
      await server.initialize(specPath);
    });

    it('should return tools list for tools/list method', async () => {
      const message = {
        jsonrpc: '2.0',
        id: '1',
        method: 'tools/list',
        params: {}
      };

      const response = await (server as any).handleOtherRequest(message, 'test-session');
      
      expect(response.jsonrpc).toBe('2.0');
      expect(response.id).toBe('1');
      expect(response.result).toBeDefined();
      expect(response.result.tools).toBeDefined();
      expect(Array.isArray(response.result.tools)).toBe(true);
    });

    it('should return error for unknown method', async () => {
      const message = {
        jsonrpc: '2.0',
        id: '2',
        method: 'unknown/method',
        params: {}
      };

      const response = await (server as any).handleOtherRequest(message, 'test-session');
      
      expect(response.jsonrpc).toBe('2.0');
      expect(response.id).toBe('2');
      expect(response.error).toBeDefined();
      expect(response.error.code).toBe(-32601);
      expect(response.error.message).toContain('Method not found');
    });
  });

  describe('handleInitialize', () => {
    it('should return server info and capabilities', () => {
      const server = new MCPServer();
      const message = {
        jsonrpc: '2.0',
        id: '1',
        method: 'initialize',
        params: {}
      };

      const response = (server as any).handleInitialize(message, 'test-session');
      
      expect(response.jsonrpc).toBe('2.0');
      expect(response.id).toBe('1');
      expect(response.result.protocolVersion).toBe('2025-03-26');
      expect(response.result.serverInfo.name).toBe('mcp4openapi');
      expect(response.result.capabilities.tools).toBeDefined();
      expect(response.result.sessionId).toBe('test-session');
    });

    it('should not include sessionId when not provided', () => {
      const server = new MCPServer();
      const message = {
        jsonrpc: '2.0',
        id: '1',
        method: 'initialize',
        params: {}
      };

      const response = (server as any).handleInitialize(message, undefined);
      
      expect(response.result.sessionId).toBeUndefined();
    });
  });

  describe('OperationNotFoundError formatting', () => {
    it('should format OperationNotFoundError with correlation ID', () => {
      const server = new MCPServer();
      const error = new OperationNotFoundError('unknown_operation');
      const correlationId = 'test-correlation-id';
      
      const formatted = (server as any).formatErrorForClient(error, correlationId);
      
      expect(formatted).toContain('Operation not found');
      expect(formatted).toContain(correlationId);
    });
  });

  describe('ConfigurationError formatting', () => {
    it('should format ConfigurationError with correlation ID', () => {
      const server = new MCPServer();
      const error = new ConfigurationError('Missing API key');
      const correlationId = 'test-correlation-id';
      
      const formatted = (server as any).formatErrorForClient(error, correlationId);
      
      expect(formatted).toContain('Configuration error');
      expect(formatted).toContain('Missing API key');
      expect(formatted).toContain(correlationId);
    });
  });

  describe('RateLimitError without retryAfter', () => {
    it('should format RateLimitError without retry info when retryAfter is missing', () => {
      const server = new MCPServer();
      const error = new RateLimitError('Too many requests');
      const correlationId = 'test-correlation-id';
      
      const formatted = (server as any).formatErrorForClient(error, correlationId);
      
      expect(formatted).toContain('Rate limit exceeded');
      expect(formatted).not.toContain('Retry after');
      expect(formatted).toContain(correlationId);
    });
  });

  describe('getAuthConfigs', () => {
    it('should return empty array when no auth configured', async () => {
      const server = new MCPServer();
      const specPath = path.join(process.cwd(), 'profiles/gitlab/openapi.yaml');
      await server.initialize(specPath);
      
      // Modify profile to remove auth
      (server as any).profile.interceptors = undefined;
      
      const configs = (server as any).getAuthConfigs();
      expect(configs).toEqual([]);
    });

    it('should handle single auth config', async () => {
      const server = new MCPServer();
      const specPath = path.join(process.cwd(), 'profiles/gitlab/openapi.yaml');
      await server.initialize(specPath);
      
      (server as any).profile.interceptors = {
        auth: { type: 'bearer', value_from_env: 'TEST_TOKEN' }
      };
      
      const configs = (server as any).getAuthConfigs();
      expect(configs).toHaveLength(1);
      expect(configs[0].type).toBe('bearer');
    });
  });

  describe('AuthorizationError formatting', () => {
    it('should format AuthorizationError with correlation ID', () => {
      const server = new MCPServer();
      const error = new AuthorizationError('Insufficient permissions');
      const correlationId = 'test-correlation-id';
      
      const formatted = (server as any).formatErrorForClient(error, correlationId);
      
      expect(formatted).toContain('Authorization failed');
      expect(formatted).toContain(correlationId);
    });
  });

  describe('ValidationError formatting', () => {
    it('should format ValidationError with correlation ID', () => {
      const server = new MCPServer();
      const error = new ValidationError('Invalid input');
      const correlationId = 'test-correlation-id';
      
      const formatted = (server as any).formatErrorForClient(error, correlationId);
      
      expect(formatted).toContain('Invalid input');
      expect(formatted).toContain(correlationId);
    });
  });

  describe('getEnvBackedAuthConfig', () => {
    it('should return undefined when no auth with value_from_env', async () => {
      const server = new MCPServer();
      const specPath = path.join(process.cwd(), 'profiles/gitlab/openapi.yaml');
      await server.initialize(specPath);
      
      (server as any).profile.interceptors = {
        auth: [{ type: 'oauth', oauth: { issuer: 'https://example.com' } }]
      };
      
      const config = (server as any).getEnvBackedAuthConfig();
      expect(config).toBeUndefined();
    });
  });

  describe('getHttpClientForSession', () => {
    it('should throw ConfigurationError when no global client and no sessionId', async () => {
      const server = new MCPServer();
      const specPath = path.join(process.cwd(), 'profiles/gitlab/openapi.yaml');
      
      // Don't set MCP4_API_TOKEN to prevent global client creation
      delete process.env.MCP4_API_TOKEN;
      
      await server.initialize(specPath);
      
      // Ensure no global client
      (server as any).httpClientFactory = { 
        hasGlobalClient: () => false,
        getGlobalClient: () => { throw new Error('No client'); }
      };
      
      await expect((server as any).getHttpClientForSession()).rejects.toThrow('HTTP client not initialized');
    });

    it('should suggest Authorization header when http transport is active', async () => {
      const server = new MCPServer();
      const specPath = path.join(process.cwd(), 'profiles/gitlab/openapi.yaml');

      delete process.env.MCP4_API_TOKEN;
      await server.initialize(specPath);

      (server as any).httpTransport = {}; // Treat as http transport
      (server as any).httpClientFactory = {
        hasGlobalClient: () => false,
        getGlobalClient: () => {
          throw new Error('No client');
        },
      };

      await expect((server as any).getHttpClientForSession()).rejects.toThrow(
        /Send token in Authorization header during initialization/
      );
    });

    it('should throw ConfigurationError when profile not initialized', async () => {
      const server = new MCPServer();
      
      // Call without initializing profile
      (server as any).profile = undefined;
      (server as any).httpClientFactory = { 
        hasGlobalClient: () => false,
        getGlobalClient: () => { throw new Error('No client'); },
        getOrCreateSessionClient: () => ({})
      };
      
      await expect((server as any).getHttpClientForSession('some-session-id')).rejects.toThrow('Profile not initialized');
    });
  });

  describe('setupHandlers (MCP SDK)', () => {
    it('ListTools handler should wrap errors with correlation ID when uninitialized', async () => {
      const setHandlerSpy = vi.spyOn(MCPProtocolServer.prototype as any, 'setRequestHandler');
      const server = new MCPServer();

      const listCall = setHandlerSpy.mock.calls.find(call => {
        const schema: any = call[0];
        return schema?.shape?.method?.value === 'tools/list';
      });
      expect(listCall).toBeDefined();

      const listHandler = listCall![1] as () => Promise<unknown>;
      await expect(listHandler()).rejects.toThrow(/correlation ID/);
    });

    it('ListTools handler should return tools when initialized', async () => {
      const setHandlerSpy = vi.spyOn(MCPProtocolServer.prototype as any, 'setRequestHandler');
      const server = new MCPServer();
      const specPath = path.join(process.cwd(), 'profiles/gitlab/openapi.yaml');
      await server.initialize(specPath);

      const listCall = setHandlerSpy.mock.calls.find(call => {
        const schema: any = call[0];
        return schema?.shape?.method?.value === 'tools/list';
      });
      const listHandler = listCall![1] as () => Promise<any>;
      const result = await listHandler();
      expect(result).toHaveProperty('tools');
      expect(Array.isArray(result.tools)).toBe(true);
      expect(result.tools.length).toBeGreaterThan(0);
    });

    it('CallTool handler should return composite result with _metadata', async () => {
      const setHandlerSpy = vi.spyOn(MCPProtocolServer.prototype as any, 'setRequestHandler');
      const server = new MCPServer();
      const specPath = path.join(process.cwd(), 'profiles/gitlab/openapi.yaml');
      await server.initialize(specPath);

      const toolDef: any = {
        name: 'composite_test',
        description: 'test',
        composite: true,
        steps: [{ operation: 'x', store_as: '$.x' }],
        parameters: {},
        operations: { execute: 'x' },
      };
      (server as any).profile.tools = [toolDef];
      (server as any).compositeExecutor = {
        execute: async () => ({
          data: { ok: true },
          completed_steps: 1,
          total_steps: 1,
          errors: [],
        }),
      };
      (server as any).toolGenerator.validateArguments = () => {};

      const callToolCall = setHandlerSpy.mock.calls.find(call => {
        const schema: any = call[0];
        return schema?.shape?.method?.value === 'tools/call';
      });
      expect(callToolCall).toBeDefined();
      const callToolHandler = callToolCall![1] as (req: any) => Promise<any>;
      const response = await callToolHandler({ params: { name: 'composite_test', arguments: {} } });
      const parsed = JSON.parse(response.content[0].text);
      expect(parsed).toHaveProperty('_metadata');
      expect(parsed._metadata).toHaveProperty('success', true);
    });

    it('CallTool handler should map errors to client-safe message', async () => {
      const setHandlerSpy = vi.spyOn(MCPProtocolServer.prototype as any, 'setRequestHandler');
      const server = new MCPServer();
      const specPath = path.join(process.cwd(), 'profiles/gitlab/openapi.yaml');
      await server.initialize(specPath);

      const toolDef: any = {
        name: 'simple_test',
        description: 'test',
        composite: false,
        parameters: {},
        operations: { execute: 'x' },
      };
      (server as any).profile.tools = [toolDef];
      (server as any).toolGenerator.validateArguments = () => {};
      (server as any).executeSimpleTool = async () => {
        throw new AuthorizationError('Forbidden');
      };

      const callToolCall = setHandlerSpy.mock.calls.find(call => {
        const schema: any = call[0];
        return schema?.shape?.method?.value === 'tools/call';
      });
      const callToolHandler = callToolCall![1] as (req: any) => Promise<any>;
      await expect(
        callToolHandler({ params: { name: 'simple_test', arguments: {} } })
      ).rejects.toThrow(/Authorization failed: Forbidden/);
    });
  });

  describe('checkToolNameLengths', () => {
    it('should return early when names are already shortened', () => {
      const originalStrategy = process.env.MCP4_TOOLNAME_STRATEGY;
      const originalWarnOnly = process.env.MCP4_TOOLNAME_WARN_ONLY;

      process.env.MCP4_TOOLNAME_STRATEGY = 'balanced';
      process.env.MCP4_TOOLNAME_WARN_ONLY = 'false';

      try {
        const server = new MCPServer();
        // Set parser to throw if getAllOperations is called - should not be called on early return
        (server as any).parser = {
          getAllOperations: () => {
            throw new Error('should not be called');
          },
        };
        expect(() => (server as any).checkToolNameLengths()).not.toThrow();
      } finally {
        if (originalStrategy === undefined) delete process.env.MCP4_TOOLNAME_STRATEGY;
        else process.env.MCP4_TOOLNAME_STRATEGY = originalStrategy;
        if (originalWarnOnly === undefined) delete process.env.MCP4_TOOLNAME_WARN_ONLY;
        else process.env.MCP4_TOOLNAME_WARN_ONLY = originalWarnOnly;
      }
    });
  });

  describe('executeSimpleTool', () => {
    it('should throw ValidationError when operation mapping is missing', async () => {
      const server = new MCPServer();
      (server as any).toolGenerator = {
        getOperationDefinition: () => undefined,
      };
      await expect(
        (server as any).executeSimpleTool(
          { name: 't', operations: {}, parameters: {} },
          { action: 'x' }
        )
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it('should throw OperationNotFoundError when operationId is not in spec', async () => {
      const server = new MCPServer();
      (server as any).toolGenerator = {
        getOperationDefinition: () => 'missingOp',
      };
      (server as any).parser = {
        getOperation: () => undefined,
      };
      await expect(
        (server as any).executeSimpleTool(
          { name: 't', operations: { execute: 'missingOp' }, parameters: {} },
          {}
        )
      ).rejects.toBeInstanceOf(OperationNotFoundError);
    });

    it('should send response_fields as query param when enabled', async () => {
      const server = new MCPServer();
      (server as any).toolGenerator = {
        getOperationDefinition: () => 'op',
      };
      (server as any).parser = {
        getOperation: () => ({
          operationId: 'op',
          method: 'GET',
          path: '/items/{id}',
          parameters: [],
        }),
      };
      (server as any).resolvePath = () => '/items/1';
      (server as any).extractQueryParams = () => ({});
      (server as any).extractBody = () => undefined;
      (server as any).schemaValidator = { validateRequestBody: () => ({ valid: true }) };

      let capturedParams: any = undefined;
      (server as any).getHttpClientForSession = async () => ({
        request: async (_m: any, _p: any, opts: any) => {
          capturedParams = opts.params;
          return { body: { ok: true } };
        },
        getAuthCredentials: () => ({ headers: {} }),
      });

      const toolDef: any = {
        name: 't',
        operations: { execute: 'op' },
        parameters: {},
        send_response_fields_as_param: true,
        response_fields: { list: ['id', 'name'] },
      };

      await (server as any).executeSimpleTool(toolDef, { action: 'list' });
      expect(capturedParams).toHaveProperty('fields', 'id,name');
    });
  });

  describe('runHttp config parsing', () => {
    it('should throw ConfigurationError for invalid MCP4_OAUTH_SESSION_TIMEOUT_MS', async () => {
      const server = new MCPServer();
      const original = process.env.MCP4_OAUTH_SESSION_TIMEOUT_MS;
      process.env.MCP4_OAUTH_SESSION_TIMEOUT_MS = 'nope';
      try {
        await expect(server.runHttp('127.0.0.1', 0)).rejects.toBeInstanceOf(ConfigurationError);
      } finally {
        if (original === undefined) delete process.env.MCP4_OAUTH_SESSION_TIMEOUT_MS;
        else process.env.MCP4_OAUTH_SESSION_TIMEOUT_MS = original;
      }
    });

    it('should throw ConfigurationError for invalid MCP4_OAUTH_REFRESH_THRESHOLD_MS', async () => {
      const server = new MCPServer();
      const original = process.env.MCP4_OAUTH_REFRESH_THRESHOLD_MS;
      process.env.MCP4_OAUTH_REFRESH_THRESHOLD_MS = 'nope';
      try {
        await expect(server.runHttp('127.0.0.1', 0)).rejects.toBeInstanceOf(ConfigurationError);
      } finally {
        if (original === undefined) delete process.env.MCP4_OAUTH_REFRESH_THRESHOLD_MS;
        else process.env.MCP4_OAUTH_REFRESH_THRESHOLD_MS = original;
      }
    });
  });

  describe('handleOtherRequest with OAuth', () => {
    it('should return OAuth required error when no auth token and OAuth is enabled', async () => {
      const server = new MCPServer();
      const specPath = path.join(process.cwd(), 'profiles/gitlab/openapi.yaml');
      await server.initialize(specPath);
      
      // Mock httpTransport with OAuth
      (server as any).httpTransport = {
        hasOAuthProvider: () => true,
        getServerUrl: () => 'https://example.com',
      };
      
      // Mock getAuthTokenFromSession to return undefined
      (server as any).getAuthTokenFromSession = async () => undefined;
      
      const response = await (server as any).handleOtherRequest(
        { jsonrpc: '2.0', id: 1, method: 'tools/list' },
        'test-session'
      );
      
      expect(response.error.code).toBe(-32001);
      expect(response.error.data.oauth_required).toBe(true);
    });
  });

  describe('extractHostsFromOrigins', () => {
    it('should extract hostname from simple URL', () => {
      const server = new MCPServer();
      const hosts = (server as any).extractHostsFromOrigins('http://localhost:3000');
      expect(hosts).toContain('localhost');
    });

    it('should handle wildcard port', () => {
      const server = new MCPServer();
      const hosts = (server as any).extractHostsFromOrigins('http://localhost:*');
      expect(hosts).toContain('localhost');
    });

    it('should handle wildcard subdomain', () => {
      const server = new MCPServer();
      const hosts = (server as any).extractHostsFromOrigins('https://*.example.com');
      expect(hosts).toContain('*.example.com');
    });

    it('should handle multiple origins', () => {
      const server = new MCPServer();
      const hosts = (server as any).extractHostsFromOrigins('http://localhost:3000,https://app.example.com');
      expect(hosts).toContain('localhost');
      expect(hosts).toContain('app.example.com');
    });

    it('should deduplicate hosts', () => {
      const server = new MCPServer();
      const hosts = (server as any).extractHostsFromOrigins('http://localhost:3000,http://localhost:8080');
      expect(hosts.filter((h: string) => h === 'localhost')).toHaveLength(1);
    });

    it('should handle invalid URLs by treating as hostname', () => {
      const server = new MCPServer();
      const hosts = (server as any).extractHostsFromOrigins('not-a-url');
      expect(hosts).toContain('not-a-url');
    });

    it('should skip CIDR blocks', () => {
      const server = new MCPServer();
      const hosts = (server as any).extractHostsFromOrigins('localhost,127.0.0.1/8,10.0.0.0/8,2a06:2140::/29');
      expect(hosts).toContain('localhost');
      expect(hosts).not.toContain('127.0.0.1/8');
      expect(hosts).not.toContain('10.0.0.0/8');
      expect(hosts).not.toContain('2a06:2140::/29');
    });

    it('should skip entries with spaces', () => {
      const server = new MCPServer();
      const hosts = (server as any).extractHostsFromOrigins('http://localhost, invalid entry');
      expect(hosts).toContain('localhost');
      expect(hosts).not.toContain('invalid entry');
    });
  });

  describe('handleToolCall with OAuth', () => {
    it('should return OAuth required error when no auth token and OAuth is enabled', async () => {
      const server = new MCPServer();
      const specPath = path.join(process.cwd(), 'profiles/gitlab/openapi.yaml');
      await server.initialize(specPath);
      
      // Mock httpTransport with OAuth
      (server as any).httpTransport = {
        hasOAuthProvider: () => true,
        getServerUrl: () => 'https://example.com',
      };
      
      // Mock getAuthTokenFromSession to return undefined
      (server as any).getAuthTokenFromSession = async () => undefined;
      
      const response = await (server as any).handleToolCall(
        { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'some_tool', arguments: {} } },
        'test-session'
      );
      
      expect(response.error.code).toBe(-32001);
      expect(response.error.data.oauth_required).toBe(true);
    });
  });
});
