/**
 * Unit tests for MCPServer
 *
 * Why: Test server initialization, tool listing, and behavior without profile.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import path from 'path';
import { MCPServer } from './mcp-server.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { 
  AuthenticationError, 
  AuthorizationError, 
  RateLimitError, 
  NetworkError,
  ValidationError 
} from './errors.js';

describe('MCPServer', () => {
  let server: MCPServer;
  const originalApiToken = process.env.API_TOKEN;

  beforeEach(() => {
    server = new MCPServer();
  });

  afterEach(() => {
    if (originalApiToken === undefined) {
      delete process.env.API_TOKEN;
    } else {
      process.env.API_TOKEN = originalApiToken;
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

      process.env.API_TOKEN = 'test-token';

      await server.initialize(specPath, profilePath);

      const hasGlobalClient = (server as any).httpClientFactory.hasGlobalClient();
      expect(hasGlobalClient).toBe(true);
    });

    it('should report missing env token when OAuth is primary and env auth has no token', async () => {
      const specPath = path.join(process.cwd(), 'profiles/gitlab/openapi.yaml');
      const profilePath = path.join(process.cwd(), 'profiles/gitlab/developer-profile.json');

      delete process.env.API_TOKEN;

      await server.initialize(specPath, profilePath);

      const hasGlobalClient = (server as any).httpClientFactory.hasGlobalClient();
      expect(hasGlobalClient).toBe(false);

      expect(() => (server as any).getHttpClientForSession()).toThrowError(
        /HasEnvToken\(API_TOKEN\): false/
      );
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
  });

  describe('security warnings', () => {
    it('should warn when binding non-localhost with empty ALLOWED_ORIGINS', async () => {
      const messages: string[] = [];
      const testLogger: any = {
        debug: () => {},
        info: () => {},
        warn: (msg: string) => { messages.push(msg); },
        error: () => {},
      };

      const serverWithLogger = new MCPServer(testLogger);

      const prev = process.env.ALLOWED_ORIGINS;
      delete process.env.ALLOWED_ORIGINS;
      try {
        await serverWithLogger.runHttp('0.0.0.0', 0);
        expect(messages.find(m => m.includes('ALLOWED_ORIGINS'))).toBeDefined();
      } finally {
        await serverWithLogger.stop();
        process.env.ALLOWED_ORIGINS = prev;
      }
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
});
