/**
 * Unit tests for MCPServer
 *
 * Why: Test server initialization, tool listing, and behavior without profile.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'path';
import fs from 'fs/promises';
import os from 'os';
import { MCPServer } from './mcp-server.js';
import { HttpTransport } from '../transport/http-transport.js';
import { JsonLogger } from '../core/logger.js';
import { Server as MCPProtocolServer } from '@modelcontextprotocol/sdk/server/index.js';
import { parseSessionToolFilterHeader } from '../tool-filter/index.js';
import {
  MCPError,
  AuthenticationError,
  AuthorizationError,
  RateLimitError,
  NetworkError,
  ValidationError,
  OperationNotFoundError,
  ConfigurationError,
  ResourceNotFoundError
} from '../core/errors.js';
import {
  UpstreamConnectionError,
  UpstreamTimeoutError,
  UpstreamAuthError,
  UpstreamMalformedResponseError,
} from '../upstream/upstream-errors.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { INPUT_LIMITS } from '../core/constants.js';

type ToolCallResponse = {
  result?: {
    content?: Array<{ type: string; text?: string }>;
  };
  error?: {
    code?: number;
    message?: string;
    data?: any;
  };
};

type RequestHandler = (request: unknown) => Promise<unknown>;

const asToolCallResponse = (value: unknown): ToolCallResponse => value as ToolCallResponse;

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
      const profilePath = path.join(process.cwd(), 'profiles/gitlab/developer-profile-oauth.json');

      await server.initialize(specPath, profilePath);

      expect(server['profile']!.tools.length).toBeGreaterThan(0);
    });

    it('should create global client when profile has no auth', async () => {
      const specPath = path.join(os.tmpdir(), `spec-no-auth-${Date.now()}-${Math.random()}.yaml`);
      const profilePath = path.join(os.tmpdir(), `profile-no-auth-${Date.now()}-${Math.random()}.json`);
      delete process.env.MCP4_API_TOKEN;

      const spec = `openapi: 3.0.0
info:
  title: Test API
  version: 1.0.0
paths:
  /items:
    get:
      operationId: listItems
      responses:
        '200':
          description: OK
`;

      const profile = {
        profile_name: 'no-auth-profile',
        description: 'No auth profile',
        tools: [
          {
            name: 'items',
            description: 'List items',
            metadata_params: ['action'],
            operations: { list: 'listItems' },
            parameters: {
              action: { type: 'string', enum: ['list'], description: 'Action', required: true },
            },
          },
        ],
      };

      try {
        await fs.writeFile(specPath, spec, 'utf-8');
        await fs.writeFile(profilePath, JSON.stringify(profile), 'utf-8');
        await server.initialize(specPath, profilePath);
        const hasGlobalClient = (server as any).httpClientFactory.hasGlobalClient();
        expect(hasGlobalClient).toBe(true);
      } finally {
        await Promise.allSettled([fs.unlink(profilePath), fs.unlink(specPath)]);
      }
    });

    it('should create global client when OAuth is higher priority than env auth', async () => {
      const specPath = path.join(process.cwd(), 'profiles/gitlab/openapi.yaml');
      const profilePath = path.join(process.cwd(), 'profiles/gitlab/developer-profile-oauth.json');

      process.env.GITLAB_TOKEN = 'test-token';

      await server.initialize(specPath, profilePath);

      const hasGlobalClient = (server as any).httpClientFactory.hasGlobalClient();
      expect(hasGlobalClient).toBe(true);
    });

    it('should report missing env token when OAuth is primary and env auth has no token', async () => {
      const specPath = path.join(process.cwd(), 'profiles/gitlab/openapi.yaml');
      const profilePath = path.join(process.cwd(), 'profiles/gitlab/developer-profile-oauth.json');

      delete process.env.GITLAB_TOKEN;

      await server.initialize(specPath, profilePath);

      const hasGlobalClient = (server as any).httpClientFactory.hasGlobalClient();
      expect(hasGlobalClient).toBe(false);

      await expect((server as any).getHttpClientForSession()).rejects.toThrow(
        /HasEnvToken\(GITLAB_TOKEN\): false/
      );
    });
  });

  describe('extractBody', () => {
    it('uses root array body from body/items/single array param', () => {
      const operation: any = {
        operationId: 'test',
        method: 'POST',
        path: '/test',
        parameters: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'array',
                items: { type: 'object' },
              },
            },
          },
        },
      };

      const toolDef: any = { metadata_params: ['action'] };

      const fromBody = (server as any).extractBody(operation, { action: 'create', body: [{ a: 1 }] }, toolDef);
      expect(fromBody).toEqual([{ a: 1 }]);

      const fromItems = (server as any).extractBody(operation, { action: 'create', items: [{ b: 2 }] }, toolDef);
      expect(fromItems).toEqual([{ b: 2 }]);

      const fromSingleArray = (server as any).extractBody(operation, { action: 'create', users: [{ c: 3 }] }, toolDef);
      expect(fromSingleArray).toEqual([{ c: 3 }]);
    });

    it('returns undefined when root array body has multiple array candidates', () => {
      const operation: any = {
        operationId: 'test',
        method: 'POST',
        path: '/test',
        parameters: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'array',
                items: { type: 'object' },
              },
            },
          },
        },
      };

      const toolDef: any = { metadata_params: ['action'] };
      const result = (server as any).extractBody(
        operation,
        { action: 'create', itemsA: [{ a: 1 }], itemsB: [{ b: 2 }] },
        toolDef
      );

      expect(result).toBeUndefined();
    });
  });

  describe('global tool filtering', () => {
    const specPath = path.join(process.cwd(), 'profiles/gitlab/openapi.yaml');
    let profilePath: string;

    const buildProfile = () => ({
      profile_name: 'test',
      description: 'test profile',
      tools: [
        {
          name: 'keep_tool',
          description: 'Keep tool',
          parameters: {},
          operations: { execute: 'getApiV4ProjectsIdBadges' },
        },
        {
          name: 'drop_tool',
          description: 'Drop tool',
          parameters: {},
          operations: { execute: 'getApiV4ProjectsIdAccessRequests' },
        },
      ],
      interceptors: {},
    });

    beforeEach(async () => {
      profilePath = path.join(os.tmpdir(), `profile-${Date.now()}-${Math.random()}.json`);
      await fs.writeFile(profilePath, JSON.stringify(buildProfile()), 'utf-8');
    });

    afterEach(async () => {
      delete process.env.MCP4_TOOL_FILTER_ALLOW_NAMES;
      delete process.env.MCP4_TOOL_FILTER_ALLOW_NAME_REGEX;
      delete process.env.MCP4_TOOL_FILTER_DENY_NAMES;
      delete process.env.MCP4_TOOL_FILTER_DENY_NAME_REGEX;
      delete process.env.MCP4_TOOL_FILTER_ALLOW_CATEGORIES;
      await fs.unlink(profilePath);
    });

    it('applies allow list filtering from environment', async () => {
      process.env.MCP4_TOOL_FILTER_ALLOW_NAMES = 'keep_tool';
      await server.initialize(specPath, profilePath);
      expect((server as any).profile.tools).toHaveLength(1);
      expect((server as any).profile.tools[0].name).toBe('keep_tool');
    });

    it('applies allow regex filtering from environment', async () => {
      process.env.MCP4_TOOL_FILTER_ALLOW_NAME_REGEX = 'keep_.*';
      await server.initialize(specPath, profilePath);
      expect((server as any).profile.tools).toHaveLength(1);
      expect((server as any).profile.tools[0].name).toBe('keep_tool');
    });

    it('rejects no-op tool filter configuration', async () => {
      process.env.MCP4_TOOL_FILTER_ALLOW_NAMES = 'keep_tool,drop_tool';
      await expect(server.initialize(specPath, profilePath)).rejects.toBeInstanceOf(ConfigurationError);
    });

    it('rejects configurations that filter out all tools', async () => {
      process.env.MCP4_TOOL_FILTER_DENY_NAMES = 'keep_tool,drop_tool';
      await expect(server.initialize(specPath, profilePath)).rejects.toBeInstanceOf(ConfigurationError);
    });

    it('rejects composite tools that reference filtered operations', async () => {
      process.env.MCP4_TOOL_FILTER_ALLOW_NAMES = 'composite_tool';
      const localServer = new MCPServer();
      (localServer as any).profile = {
        profile_name: 'test',
        description: 'test',
        tools: [
          {
            name: 'composite_tool',
            description: 'Composite',
            composite: true,
            steps: [{ call: 'GET /project', store_as: 'project' }],
            parameters: {},
          },
          {
            name: 'get_project',
            description: 'Get project',
            parameters: {},
            operations: { read: 'getProject' },
          },
        ],
        interceptors: {},
      };

      (localServer as any).buildToolFilterResolver = () => ({
        getOperationForCall: () => ({
          operationId: 'getProject',
          method: 'get',
          path: '/project',
          parameters: [],
        }),
      });

      expect(() => (localServer as any).applyGlobalToolFiltering()).toThrow(ConfigurationError);
    });
  });

  describe('initializeWithoutSpec', () => {
    it('initializes successfully with upstream_mcp proxy profile', async () => {
      const profilePath = path.join(os.tmpdir(), `proxy-profile-${Date.now()}-${Math.random()}.json`);

      const profile = {
        profile_name: 'proxy-profile',
        description: 'Pure upstream proxy',
        tools: [],
        upstream_mcp: {
          name: 'example',
          transport: { type: 'http-streamable', url: 'https://example.com/mcp' },
        },
      };

      await fs.writeFile(profilePath, JSON.stringify(profile));
      try {
        await expect(server.initializeWithoutSpec(profilePath)).resolves.toBeUndefined();
        expect(server['profile']!.tools).toHaveLength(0);
      } finally {
        await fs.unlink(profilePath);
      }
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
      expect(tools.length).toBeLessThanOrEqual(230);
    });
  });


  describe('session tenant client overrides', () => {
    it('uses tenant base URL and tenant auth configs for session HTTP client', async () => {
      const specPath = path.join(process.cwd(), 'profiles/gitlab/openapi.yaml');
      await server.initialize(specPath);

      const getOrCreateSessionClient = vi.fn().mockReturnValue({});
      (server as any).httpClientFactory = {
        hasGlobalClient: () => true,
        getGlobalClient: () => ({}),
        getOrCreateSessionClient,
      };
      (server as any).httpTransport = {
        ensureValidSessionToken: vi.fn().mockResolvedValue(true),
        getSessionToken: vi.fn().mockReturnValue('session-token'),
        getSessionTenantContext: vi.fn().mockReturnValue({
          tenantId: 'team-a',
          tenantBaseUrl: 'https://team-a.example.com/api',
          tenantAuthConfigs: [{ type: 'bearer', value_from_env: 'TEAM_A_TOKEN' }],
        }),
      };

      await (server as any).getHttpClientForSession('session-1', 'default');

      expect(getOrCreateSessionClient).toHaveBeenCalledWith(
        'session-1',
        expect.objectContaining({
          baseUrl: 'https://team-a.example.com/api',
          authConfigs: [{ type: 'bearer', value_from_env: 'TEAM_A_TOKEN' }],
          sessionToken: 'session-token',
          // OBS-01: clientIdentity is always populated on the metrics context now;
          // anonymous sessions report 'anonymous' so audit + metric dimensions are
          // never undefined at the label boundary.
          metricsContext: {
            profileId: 'default',
            tenantId: 'team-a',
            clientIdentity: 'anonymous',
          },
        })
      );
    });

    it('falls back to profile base URL when tenant context is missing', async () => {
      const specPath = path.join(process.cwd(), 'profiles/gitlab/openapi.yaml');
      await server.initialize(specPath);

      const getOrCreateSessionClient = vi.fn().mockReturnValue({});
      (server as any).httpClientFactory = {
        hasGlobalClient: () => true,
        getGlobalClient: () => ({}),
        getOrCreateSessionClient,
      };
      (server as any).httpTransport = {
        ensureValidSessionToken: vi.fn().mockResolvedValue(true),
        getSessionToken: vi.fn().mockReturnValue('session-token'),
        getSessionTenantContext: vi.fn().mockReturnValue(undefined),
      };

      await (server as any).getHttpClientForSession('session-2', 'default');

      expect(getOrCreateSessionClient).toHaveBeenCalledWith(
        'session-2',
        expect.objectContaining({
          baseUrl: (server as any).getBaseUrl(),
          authConfigs: undefined,
          // OBS-01: anonymous fallback present on metricsContext
          metricsContext: {
            profileId: 'default',
            tenantId: 'none',
            clientIdentity: 'anonymous',
          },
        })
      );
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

      (server as any).toolGenerator.validateArguments = () => {};

      // Mock executeSimpleTool to return success
      (server as any).executeSimpleTool = async () => {
        return { id: 1, name: 'test' };
      };

      const response = asToolCallResponse(await server.callToolRpc(simpleTool.name, {}, 'test-session', '1'));
      expect(response.result).toBeDefined();
      const result = response.result as { content: Array<{ type: string; text?: string }> };
      expect(result.content).toBeDefined();
      expect(result.content[0].type).toBe('text');
      const parsed = JSON.parse(result.content[0].text as string);
      expect(parsed).toEqual({ id: 1, name: 'test' });
    });

    it('should return user-friendly error message with correlation ID from HTTP handleToolCall', async () => {
      const specPath = path.join(process.cwd(), 'profiles/gitlab/openapi.yaml');
      await server.initialize(specPath);

      const response = asToolCallResponse(await server.callToolRpc('non_existing_tool', {}, 'test-session', '1'));
      expect(response).toHaveProperty('error');
      expect(response.error).toHaveProperty('message');
      const error = response.error as { message?: string };
      // OperationNotFoundError is safe to show with correlation ID
      expect(error.message).toContain('Tool not found');
      expect(error.message).toContain('correlation ID');
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
      
      const response = asToolCallResponse(await server.callToolRpc(compositeTool.name, {}, 'test-session', '1'));
      const error = response.error as { code?: number };
      expect(error.code).toBe(-32002);
    });

    it('should map ValidationError to error code -32602', async () => {
      const server = new MCPServer();
      const specPath = path.join(process.cwd(), 'profiles/gitlab/openapi.yaml');
      await server.initialize(specPath);

      // Find any simple (non-composite) tool
      const simpleTool = (server as any).profile.tools.find((t: any) => !t.composite);
      if (!simpleTool) return; // Skip if no simple tools

      (server as any).toolGenerator.validateArguments = () => {};

      // Mock executeSimpleTool to throw ValidationError
      (server as any).executeSimpleTool = async () => {
        throw new ValidationError('Invalid input');
      };

      const response = asToolCallResponse(await server.callToolRpc(simpleTool.name, {}, 'test-session', '1'));
      const error = response.error as { code?: number };
      expect(error.code).toBe(-32602);
    });

    it('should map RateLimitError to error code -32003', async () => {
      const server = new MCPServer();
      const specPath = path.join(process.cwd(), 'profiles/gitlab/openapi.yaml');
      await server.initialize(specPath);

      // Find any simple (non-composite) tool
      const simpleTool = (server as any).profile.tools.find((t: any) => !t.composite);
      if (!simpleTool) return; // Skip if no simple tools

      (server as any).toolGenerator.validateArguments = () => {};

      // Mock executeSimpleTool to throw RateLimitError
      (server as any).executeSimpleTool = async () => {
        throw new RateLimitError('Too many requests', 60);
      };

      const response = asToolCallResponse(await server.callToolRpc(simpleTool.name, {}, 'test-session', '1'));
      const error = response.error as { code?: number };
      expect(error.code).toBe(-32003);
    });

    it('should map AuthenticationError to InvalidRequest error code (-32600)', async () => {
      const server = new MCPServer();
      const specPath = path.join(process.cwd(), 'profiles/gitlab/openapi.yaml');
      await server.initialize(specPath);

      // Find any simple (non-composite) tool
      const simpleTool = (server as any).profile.tools.find((t: any) => !t.composite);
      if (!simpleTool) return;

      (server as any).toolGenerator.validateArguments = () => {};

      // Mock executeSimpleTool to throw AuthenticationError
      (server as any).executeSimpleTool = async () => {
        throw new AuthenticationError('Token expired');
      };

      const response = asToolCallResponse(await server.callToolRpc(simpleTool.name, {}, 'test-session', '1'));
      const error = response.error as { code?: number };
      expect(error.code).toBe(-32600);
    });

    it('should return OAuth required error when httpTransport has OAuth provider but no auth token', async () => {
      const server = new MCPServer();
      const specPath = path.join(process.cwd(), 'profiles/gitlab/openapi.yaml');
      await server.initialize(specPath);

      const simpleTool = (server as any).profile.tools.find((t: any) => !t.composite);
      if (!simpleTool) return;

      (server as any).toolGenerator.validateArguments = () => {};

      // Mock httpTransport with OAuth provider
      (server as any).httpTransport = {
        hasOAuthProvider: (_profileId?: string) => true,
        getOAuthProtectedResourceUrl: (_profileId?: string) => 'http://localhost:3000/.well-known/oauth-protected-resource/mcp',
      };

      // Mock getAuthTokenFromSession to return null (no token)
      (server as any).getAuthTokenFromSession = async () => null;

      const response = asToolCallResponse(await server.callToolRpc(simpleTool.name, {}, 'test-session', '1'));
      expect(response.error).toBeDefined();
      const error = response.error as { code?: number; message?: string; data?: { oauth_required?: boolean } };
      expect(error.code).toBe(-32600);
      expect(error.message).toContain('Authentication required');
      expect(error.data?.oauth_required).toBe(true);
    });

    it('should map generic Error to -32603 internal error code', async () => {
      const server = new MCPServer();
      const specPath = path.join(process.cwd(), 'profiles/gitlab/openapi.yaml');
      await server.initialize(specPath);

      const simpleTool = (server as any).profile.tools.find((t: any) => !t.composite);
      if (!simpleTool) return;

      (server as any).toolGenerator.validateArguments = () => {};

      (server as any).executeSimpleTool = async () => {
        throw new Error('Generic internal error');
      };

      const response = asToolCallResponse(await server.callToolRpc(simpleTool.name, {}, 'test-session', '1'));
      const error = response.error as { code?: number };
      expect(error.code).toBe(-32603);
    });

    it('records tool metrics with profile and tenant context on success', async () => {
      const server = new MCPServer();
      const specPath = path.join(process.cwd(), 'profiles/gitlab/openapi.yaml');
      await server.initialize(specPath);

      const simpleTool = (server as any).profile.tools.find((t: any) => !t.composite);
      if (!simpleTool) return;

      (server as any).toolGenerator.validateArguments = () => {};

      (server as any).executeSimpleTool = async () => ({ ok: true });
      const metrics = {
        recordToolCall: vi.fn(),
        recordToolCallError: vi.fn(),
      };
      (server as any).httpTransport = {
        hasOAuthProvider: () => false,
        getMetricsCollector: () => metrics,
        getSessionTenantContext: vi.fn().mockReturnValue({ tenantId: 'team-a' }),
        getSessionFiltering: vi.fn().mockReturnValue(undefined),
      };

      await server.callToolRpc(simpleTool.name, {}, 'session-1', '1');

      expect(metrics.recordToolCall).toHaveBeenCalledWith(
        simpleTool.name,
        'success',
        expect.any(Number),
        expect.objectContaining({
          profileId: expect.any(String),
          tenantId: 'team-a',
        })
      );
      expect(metrics.recordToolCallError).not.toHaveBeenCalled();
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

      const response = asToolCallResponse(await server.callToolRpc('simple_test', {}, 'test-session', '1'));
      const error = response.error as { code?: number };
      expect(error.code).toBe(-32002);
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
      const specPath = path.join(process.cwd(), 'profiles/gitlab/openapi.yaml');
      await serverWithLogger.initialize(specPath);
      (serverWithLogger as any).logger = testLogger;

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

    it('getHttpProfileContext merges allowed_redirect_hosts from MCP4_ALLOWED_ORIGINS', async () => {
      const serverWithMock = new MCPServer({
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

      process.env.MCP4_ALLOWED_ORIGINS = 'https://*.allowed.test,https://app.example.com';

      const context = serverWithMock.getHttpProfileContext();
      expect(context.oauthConfig?.allowed_redirect_hosts).toEqual(['*.allowed.test', 'app.example.com']);
    });

    it('getHttpProfileContext merges unregistered OAuth client env config', async () => {
      const serverWithMock = new MCPServer({
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

      process.env.MCP4_ALLOW_UNREGISTERED_CLIENTS = 'true';
      process.env.MCP4_ALLOWED_UNREGISTERED_REDIRECT_URIS = 'http://localhost, cursor://';

      const context = serverWithMock.getHttpProfileContext();
      expect(context.oauthConfig?.allow_unregistered_clients).toBe(true);
      expect(context.oauthConfig?.allowed_unregistered_redirect_uris).toEqual(['http://localhost', 'cursor://']);
    });

    it('MCP4_ALLOW_UNREGISTERED_CLIENTS=true overrides profile allow_unregistered_clients=false', () => {
      const serverWithMock = new MCPServer({
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
              redirect_uri: 'https://app.test/callback',
              allow_unregistered_clients: false,
            }
          }]
        }
      };

      process.env.MCP4_ALLOW_UNREGISTERED_CLIENTS = 'true';
      process.env.MCP4_ALLOWED_UNREGISTERED_REDIRECT_URIS = 'http://localhost';

      const context = serverWithMock.getHttpProfileContext();
      expect(context.oauthConfig?.allow_unregistered_clients).toBe(true);
    });

    it('MCP4_ALLOWED_UNREGISTERED_REDIRECT_URIS overrides profile allowed_unregistered_redirect_uris', () => {
      const serverWithMock = new MCPServer({
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
              redirect_uri: 'https://app.test/callback',
              allow_unregistered_clients: true,
              allowed_unregistered_redirect_uris: ['http://profile-only.example.com'],
            }
          }]
        }
      };

      process.env.MCP4_ALLOWED_UNREGISTERED_REDIRECT_URIS = 'http://localhost,http://127.0.0.1';

      const context = serverWithMock.getHttpProfileContext();
      expect(context.oauthConfig?.allowed_unregistered_redirect_uris).toEqual(['http://localhost', 'http://127.0.0.1']);
    });

    it('MCP4_ALLOWED_ORIGINS overrides profile allowed_redirect_hosts', () => {
      const serverWithMock = new MCPServer({
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
              redirect_uri: 'https://app.test/callback',
              allowed_redirect_hosts: ['profile-host.example.com'],
            }
          }]
        }
      };

      process.env.MCP4_ALLOWED_ORIGINS = 'https://env-host.example.com';

      const context = serverWithMock.getHttpProfileContext();
      expect(context.oauthConfig?.allowed_redirect_hosts).toEqual(['env-host.example.com']);
    });

    it('should derive OAuth redirect hosts and token limits from environment', async () => {
      const capturedConfigs: any[] = [];

      vi.doMock('../transport/http-transport.js', () => {
        return {
          HttpTransport: class {
            constructor(config: any) {
              capturedConfigs.push(config);
            }
            setMessageHandler() {}
            onSessionDestroyed() {}
            async start() {}
            async stop() {}
            hasOAuthProvider(_profileId?: string) { return false; }
            getSessionToken(_profileId: string, _sessionId: string) { return undefined; }
            ensureValidSessionToken(_profileId: string, _sessionId: string) { return Promise.resolve(true); }
            setUpstreamConnectionManager(_manager: any) {}
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

  describe('resolvePath encoding', () => {
    it('encodes slashes and percent escapes when path contains slash', () => {
      const localServer = new MCPServer();
      (localServer as any).profile = {
        profile_name: 'test',
        description: 'test profile',
        tools: [],
        interceptors: { auth: [] },
        parameter_aliases: { id: ['project_id'] },
      };

      const result = (localServer as any).resolvePath(
        '/projects/{id}',
        { project_id: 'group/mcp%2Fapp' }
      );

      expect(result).toBe('/projects/group%2Fmcp%252Fapp');
    });

    it('encodes raw slashes in path parameters', () => {
      const localServer = new MCPServer();
      (localServer as any).profile = {
        profile_name: 'test',
        description: 'test profile',
        tools: [],
        interceptors: { auth: [] },
        parameter_aliases: { id: ['project_id'] },
      };

      const result = (localServer as any).resolvePath(
        '/projects/{id}',
        { project_id: 'group/mcp/app' }
      );

      expect(result).toBe('/projects/group%2Fmcp%2Fapp');
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

      vi.doMock('../tooling/proxy-executor.js', () => {
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
      const specPath = path.join(process.cwd(), 'profiles/gitlab/openapi.yaml');
      await serverWithLogger.initialize(specPath);
      const startSpy = vi.spyOn(HttpTransport.prototype, 'start').mockResolvedValue(undefined as any);
      const stopSpy = vi.spyOn(HttpTransport.prototype, 'stop').mockResolvedValue(undefined as any);
      await serverWithLogger.runHttp('127.0.0.1', 0);
      try {
        const token = await (serverWithLogger as any).getAuthTokenFromSession('');
        expect(token).toBeUndefined();
        expect(warns.find(m => m.includes('Session token validation/refresh failed'))).toBeUndefined();
      } finally {
        await serverWithLogger.stop();
        startSpy.mockRestore();
        stopSpy.mockRestore();
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
      (server as any).profile = {
        profile_name: 'test',
        tools: [],
        interceptors: {},
      };
      (server as any).httpTransport = {
        ensureValidSessionToken: async (_profileId: string, _sessionId: string) => false,
        getSessionToken: (_profileId: string, _sessionId: string) => 'still-returned-token',
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

    it('should support quoted field names with spaces', () => {
      const server = new MCPServer();
      const data = {
        'Credentials Risk Report': {
          sections: [
            { title: 'Section 1', risk: 'credentials', extra: 'ignore' }
          ],
          ignored: 'ignore'
        },
        other: 'ignore'
      };

      const result = (server as any).filterFields(data, ['\"Credentials Risk Report\"(sections(title))']);
      expect(result).toEqual({
        'Credentials Risk Report': {
          sections: [
            { title: 'Section 1' }
          ]
        }
      });
    });

    it('should handle quoted bases with trailing junk', () => {
      const server = new MCPServer();
      const parsed = (server as any).parseFieldSelector('"some field" trailing');
      expect(parsed).toEqual({ baseName: 'some field' });
    });

    it('should handle escaped quotes in quoted bases', () => {
      const server = new MCPServer();
      const parsed = (server as any).parseFieldSelector('"a \\"b\\""');
      expect(parsed).toEqual({ baseName: 'a "b"' });
    });

    it('returns undefined for unterminated quoted base', () => {
      const server = new MCPServer();
      const parsed = (server as any).parseQuotedBase('"unterminated');
      expect(parsed).toBeUndefined();
    });

    it('splits top-level selectors while respecting quoted commas and escapes', () => {
      const server = new MCPServer();
      const parts = (server as any).splitTopLevel('"a, b",c,"d \\"e\\"",f(g,h),"i(j,k)"');
      expect(parts).toEqual(['"a, b"', 'c', '"d \\"e\\""', 'f(g,h)', '"i(j,k)"']);
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

    it('should return prompts list for prompts/list method', async () => {
      (server as any).profile.prompts = [
        {
          name: 'summarize_issue',
          description: 'Summarize issue context',
          arguments: [{ name: 'issue_title', required: true }],
          messages: [{ role: 'user', content: { type: 'text', text: 'Summarize: {{issue_title}}' } }],
        },
      ];

      const response = await (server as any).handleOtherRequest({
        jsonrpc: '2.0',
        id: '3',
        method: 'prompts/list',
        params: {},
      }, 'test-session');

      expect(response.result.prompts).toHaveLength(1);
      expect(response.result.prompts[0].name).toBe('summarize_issue');
      expect(response.result.prompts[0].arguments[0].name).toBe('issue_title');
    });

    it('should return rendered prompt for prompts/get method', async () => {
      (server as any).profile.prompts = [
        {
          name: 'summarize_issue',
          description: 'Summarize issue context',
          arguments: [{ name: 'issue_title', required: true }],
          messages: [{ role: 'user', content: { type: 'text', text: 'Summarize: {{issue_title}}' } }],
        },
      ];

      const response = await (server as any).handleOtherRequest({
        jsonrpc: '2.0',
        id: '4',
        method: 'prompts/get',
        params: { name: 'summarize_issue', arguments: { issue_title: 'Bug report' } },
      }, 'test-session');

      expect(response.result.messages).toHaveLength(1);
      expect(response.result.messages[0].content.text).toContain('Bug report');
    });

    it('should return -32602 for prompts/get without valid name', async () => {
      const response = await (server as any).handleOtherRequest({
        jsonrpc: '2.0',
        id: '5',
        method: 'prompts/get',
        params: {},
      }, 'test-session');

      expect(response.error.code).toBe(-32602);
      expect(response.error.message).toContain('requires string parameter "name"');
    });

    it('should return -32602 for prompts/get when name is whitespace-only', async () => {
      const response = await (server as any).handleOtherRequest({
        jsonrpc: '2.0',
        id: '5b',
        method: 'prompts/get',
        params: { name: '   ' },
      }, 'test-session');

      expect(response.error.code).toBe(-32602);
      expect(response.error.message).toContain('requires string parameter "name"');
    });

    it('should return -32602 for prompts/get when name is empty string', async () => {
      const response = await (server as any).handleOtherRequest({
        jsonrpc: '2.0',
        id: '5c',
        method: 'prompts/get',
        params: { name: '' },
      }, 'test-session');

      expect(response.error.code).toBe(-32602);
      expect(response.error.message).toContain('requires string parameter "name"');
    });

    it('should return -32602 for prompts/get when arguments is not an object', async () => {
      const response = await (server as any).handleOtherRequest({
        jsonrpc: '2.0',
        id: '7',
        method: 'prompts/get',
        params: { name: 'summarize_issue', arguments: 'bad-args' },
      }, 'test-session');

      expect(response.error.code).toBe(-32602);
      expect(response.error.message).toContain('parameter "arguments" must be an object');
    });

    it('should return -32602 for prompts/get when arguments is null', async () => {
      const response = await (server as any).handleOtherRequest({
        jsonrpc: '2.0',
        id: '7b',
        method: 'prompts/get',
        params: { name: 'summarize_issue', arguments: null },
      }, 'test-session');

      expect(response.error.code).toBe(-32602);
      expect(response.error.message).toContain('parameter "arguments" must be an object');
    });

    it('should return -32602 for prompts/get when arguments is an array', async () => {
      const response = await (server as any).handleOtherRequest({
        jsonrpc: '2.0',
        id: '7c',
        method: 'prompts/get',
        params: { name: 'summarize_issue', arguments: [] },
      }, 'test-session');

      expect(response.error.code).toBe(-32602);
      expect(response.error.message).toContain('parameter "arguments" must be an object');
    });

    it('should return -32001 for prompts/get when prompt is missing', async () => {
      const response = await (server as any).handleOtherRequest({
        jsonrpc: '2.0',
        id: '6',
        method: 'prompts/get',
        params: { name: 'missing_prompt' },
      }, 'test-session');

      expect(response.error.code).toBe(-32001);
      expect(response.error.message).toContain('Prompt not found');
    });

    it('should respond to ping with empty result', async () => {
      const response = await (server as any).handleOtherRequest({
        jsonrpc: '2.0',
        id: 'p1',
        method: 'ping',
      }, 'test-session');

      expect(response.jsonrpc).toBe('2.0');
      expect(response.id).toBe('p1');
      expect(response.result).toEqual({});
      expect(response.error).toBeUndefined();
    });

    it('should return -32600 when method is null', async () => {
      const response = await (server as any).handleOtherRequest({
        jsonrpc: '2.0',
        id: 'inv1',
        method: null,
      }, 'test-session');

      expect(response.error.code).toBe(-32600);
      expect(response.error.message).toContain('missing method');
    });

    it('should return -32600 when method is undefined', async () => {
      const response = await (server as any).handleOtherRequest({
        jsonrpc: '2.0',
        id: 'inv2',
      }, 'test-session');

      expect(response.error.code).toBe(-32600);
      expect(response.error.message).toContain('missing method');
    });

    it('should return -32600 when method is empty string', async () => {
      const response = await (server as any).handleOtherRequest({
        jsonrpc: '2.0',
        id: 'inv3',
        method: '',
      }, 'test-session');

      expect(response.error.code).toBe(-32600);
      expect(response.error.message).toContain('missing method');
    });

    it('should return -32600 when method is whitespace-only', async () => {
      const response = await (server as any).handleOtherRequest({
        jsonrpc: '2.0',
        id: 'inv4',
        method: '   ',
      }, 'test-session');

      expect(response.error.code).toBe(-32600);
      expect(response.error.message).toContain('missing method');
    });

    it('should return empty resources/list when no appsModel', async () => {
      const response = await (server as any).handleOtherRequest({
        jsonrpc: '2.0',
        id: 'rl1',
        method: 'resources/list',
      }, 'test-session');

      expect(response.result.resources).toEqual([]);
    });

    it('should return empty resources/templates/list when no appsModel', async () => {
      const response = await (server as any).handleOtherRequest({
        jsonrpc: '2.0',
        id: 'rtl1',
        method: 'resources/templates/list',
      }, 'test-session');

      expect(response.result.resourceTemplates).toEqual([]);
    });

    it('should return -32602 for resources/read without uri param', async () => {
      const response = await (server as any).handleOtherRequest({
        jsonrpc: '2.0',
        id: 'rr1',
        method: 'resources/read',
        params: {},
      }, 'test-session');

      expect(response.error.code).toBe(-32602);
      expect(response.error.message).toContain('"uri"');
    });

    it('should return -32602 for resources/read when uri is not a string', async () => {
      const response = await (server as any).handleOtherRequest({
        jsonrpc: '2.0',
        id: 'rr2',
        method: 'resources/read',
        params: { uri: 42 },
      }, 'test-session');

      expect(response.error.code).toBe(-32602);
      expect(response.error.message).toContain('"uri"');
    });

    it('should return -32602 for resources/read when uri is whitespace-only', async () => {
      const response = await (server as any).handleOtherRequest({
        jsonrpc: '2.0',
        id: 'rr2b',
        method: 'resources/read',
        params: { uri: '   ' },
      }, 'test-session');

      expect(response.error.code).toBe(-32602);
      expect(response.error.message).toContain('"uri"');
    });

    it('should return -32001 for resources/read when resource not found', async () => {
      vi.spyOn(server as any, 'readResource').mockRejectedValueOnce(new ResourceNotFoundError('unknown://missing', 'Resource'));
      const response = await (server as any).handleOtherRequest({
        jsonrpc: '2.0',
        id: 'rr3',
        method: 'resources/read',
        params: { uri: 'unknown://missing' },
      }, 'test-session');

      expect(response.error.code).toBe(-32001);
      expect(response.error.message).toContain('not found');
    });

    it('should return -32603 for resources/read on unexpected error', async () => {
      vi.spyOn(server as any, 'readResource').mockRejectedValueOnce(new Error('unexpected'));
      const response = await (server as any).handleOtherRequest({
        jsonrpc: '2.0',
        id: 'rr4',
        method: 'resources/read',
        params: { uri: 'test://uri' },
      }, 'test-session');

      expect(response.error.code).toBe(-32603);
      expect(response.error.message).toContain('Internal error');
    });

    it('should return result for resources/read when resource exists', async () => {
      const mockContents = [{ uri: 'test://uri', mimeType: 'text/plain', text: 'hello' }];
      vi.spyOn(server as any, 'readResource').mockResolvedValueOnce({ contents: mockContents });
      const response = await (server as any).handleOtherRequest({
        jsonrpc: '2.0',
        id: 'rr5',
        method: 'resources/read',
        params: { uri: 'test://uri' },
      }, 'test-session');

      expect(response.result.contents).toEqual(mockContents);
    });

    it('should return -32602 for completion/complete with invalid ref', async () => {
      const response = await (server as any).handleOtherRequest({
        jsonrpc: '2.0',
        id: 'cc1',
        method: 'completion/complete',
        params: { ref: { type: 'ref/prompt' }, argument: { name: 'x', value: '' } },
      }, 'test-session');

      expect(response.error.code).toBe(-32602);
      expect(response.error.message).toContain('resource ref');
    });

    it('should return -32603 for completion/complete on unexpected error', async () => {
      vi.spyOn(server as any, 'completeResourceArgument').mockRejectedValueOnce(new Error('db down'));
      const response = await (server as any).handleOtherRequest({
        jsonrpc: '2.0',
        id: 'cc2',
        method: 'completion/complete',
        params: {},
      }, 'test-session');

      expect(response.error.code).toBe(-32603);
      expect(response.error.message).toContain('Internal error');
    });

    it('should return result for completion/complete on success', async () => {
      const mockResult = { completion: { values: ['foo', 'bar'], hasMore: false, total: 2 } };
      vi.spyOn(server as any, 'completeResourceArgument').mockResolvedValueOnce(mockResult);
      const response = await (server as any).handleOtherRequest({
        jsonrpc: '2.0',
        id: 'cc3',
        method: 'completion/complete',
        params: {},
      }, 'test-session');

      expect(response.result).toEqual(mockResult);
    });

    it('should return -32602 for completion/complete with valid ref but missing argument', async () => {
      vi.spyOn(server as any, 'completeResourceArgument').mockRejectedValueOnce(new ValidationError('argument name is required'));
      const response = await (server as any).handleOtherRequest({
        jsonrpc: '2.0',
        id: 'cc4',
        method: 'completion/complete',
        params: { ref: { type: 'ref/resource', uri: 'test://uri' }, argument: {} },
      }, 'test-session');

      expect(response.error.code).toBe(-32602);
      expect(response.error.message).toContain('argument');
    });

    it('should return -32001 for completion/complete when resource template is not found', async () => {
      vi.spyOn(server as any, 'completeResourceArgument').mockRejectedValueOnce(new ResourceNotFoundError('test://missing', 'Resource template'));
      const response = await (server as any).handleOtherRequest({
        jsonrpc: '2.0',
        id: 'cc5',
        method: 'completion/complete',
        params: { ref: { type: 'ref/resource', uri: 'test://missing' }, argument: { name: 'x', value: '' } },
      }, 'test-session');

      expect(response.error.code).toBe(-32001);
      expect(response.error.message).toContain('not found');
    });

    it('should return -32602 for resources/read when uri exceeds 2048 characters', async () => {
      const response = await (server as any).handleOtherRequest({
        jsonrpc: '2.0',
        id: 'rr6',
        method: 'resources/read',
        params: { uri: 'test://' + 'a'.repeat(INPUT_LIMITS.RESOURCE_URI + 1) },
      }, 'test-session');

      expect(response.error.code).toBe(-32602);
      expect(response.error.message).toContain('2048');
    });

    it('should return -32602 for resources/read when readResource throws ValidationError (ambiguous template)', async () => {
      vi.spyOn(server as any, 'readResource').mockRejectedValueOnce(new ValidationError('Ambiguous resource uri: matches multiple templates'));
      const response = await (server as any).handleOtherRequest({
        jsonrpc: '2.0',
        id: 'rr7',
        method: 'resources/read',
        params: { uri: 'test://ambiguous' },
      }, 'test-session');

      expect(response.error.code).toBe(-32602);
      expect(response.error.message).toContain('Ambiguous');
    });

    it('should return -32602 for prompts/get when name exceeds 256 characters', async () => {
      const response = await (server as any).handleOtherRequest({
        jsonrpc: '2.0',
        id: 'pg6',
        method: 'prompts/get',
        params: { name: 'a'.repeat(INPUT_LIMITS.PROMPT_NAME + 1) },
      }, 'test-session');

      expect(response.error.code).toBe(-32602);
      expect(response.error.message).toContain('256');
    });

    it('should return -32601 for prototype-inherited property __proto__', async () => {
      const response = await (server as any).handleOtherRequest({
        jsonrpc: '2.0',
        id: 'proto1',
        method: '__proto__',
      }, 'test-session');

      expect(response.error.code).toBe(-32601);
      expect(response.error.message).toContain('Method not found');
    });

    it('should return -32601 for prototype-inherited property constructor', async () => {
      const response = await (server as any).handleOtherRequest({
        jsonrpc: '2.0',
        id: 'proto2',
        method: 'constructor',
      }, 'test-session');

      expect(response.error.code).toBe(-32601);
      expect(response.error.message).toContain('Method not found');
    });

    it('should return -32601 for prototype-inherited property toString', async () => {
      const response = await (server as any).handleOtherRequest({
        jsonrpc: '2.0',
        id: 'proto3',
        method: 'toString',
      }, 'test-session');

      expect(response.error.code).toBe(-32601);
      expect(response.error.message).toContain('Method not found');
    });
  });

  describe('session tool filtering', () => {
    it('filters tools list based on session allow list', async () => {
      const localServer = new MCPServer();
      (localServer as any).profile = {
        profile_name: 'test',
        description: 'test',
        tools: [
          { name: 'allowed', description: 'allowed', parameters: {}, operations: { execute: 'op1' } },
          { name: 'blocked', description: 'blocked', parameters: {}, operations: { execute: 'op2' } },
        ],
        interceptors: {},
      };
      (localServer as any).toolGenerator = {
        generateTool: (toolDef: any) => ({ name: toolDef.name }),
      };
      (localServer as any).httpTransport = {
        hasOAuthProvider: (_profileId?: string) => false,
        getSessionToolFilter: (_profileId: string, _sessionId: string) => ({
          allowedToolNames: new Set(['allowed']),
          reasons: new Map(),
          patterns: { allow: [] },
          normalizedHeader: 'allowed',
        }),
      };

      const response = await (localServer as any).handleOtherRequest({
        jsonrpc: '2.0',
        id: '1',
        method: 'tools/list',
        params: {},
      }, 'session-1');

      expect(response.result.tools).toHaveLength(1);
      expect(response.result.tools[0].name).toBe('allowed');
    });

    it('filters tools list based on session allow regex', async () => {
      const localServer = new MCPServer();
      (localServer as any).profile = {
        profile_name: 'test',
        description: 'test',
        tools: [
          { name: 'read_item', description: 'read', parameters: {}, operations: { execute: 'op1' } },
          { name: 'write_item', description: 'write', parameters: {}, operations: { execute: 'op2' } },
        ],
        interceptors: {},
      };
      (localServer as any).toolGenerator = {
        generateTool: (toolDef: any) => ({ name: toolDef.name }),
      };

      const sessionFilters = new Map<string, any>();
      const request = parseSessionToolFilterHeader('regex:read_.*');
      (localServer as any).httpTransport = {
        hasOAuthProvider: (_profileId?: string) => false,
        getSessionToolFilterRequest: (_profileId: string, _sessionId: string) => request,
        setSessionToolFilter: (_profileId: string, sessionId: string, filter: any) => {
          sessionFilters.set(sessionId, filter);
        },
        getSessionToolFilter: (_profileId: string, sessionId: string) => sessionFilters.get(sessionId),
      };

      (localServer as any).handleInitialize(
        { jsonrpc: '2.0', id: '1', method: 'initialize', params: {} },
        'session-1'
      );

      const response = await (localServer as any).handleOtherRequest(
        { jsonrpc: '2.0', id: '2', method: 'tools/list', params: {} },
        'session-1'
      );

      expect(response.result.tools).toHaveLength(1);
      expect(response.result.tools[0].name).toBe('read_item');
    });

    it('blocks tool calls not allowed by session filter', async () => {
      const localServer = new MCPServer();
      (localServer as any).profile = {
        profile_name: 'test',
        description: 'test',
        tools: [
          { name: 'blocked', description: 'blocked', parameters: {}, operations: { execute: 'op2' } },
        ],
        interceptors: {},
      };
      (localServer as any).executeSimpleTool = vi.fn().mockResolvedValue({ ok: true });
      (localServer as any).httpTransport = {
        hasOAuthProvider: (_profileId?: string) => false,
        getSessionToolFilter: (_profileId: string, _sessionId: string) => ({
          allowedToolNames: new Set(['allowed']),
          reasons: new Map([['blocked', ['session_allow_list:allowed']]]),
          patterns: { allow: [] },
          normalizedHeader: 'allowed',
        }),
        getSessionFiltering: (_profileId: string, _sessionId: string) => undefined,
      };

      const response = await localServer.callToolRpc('blocked', {}, 'session-1', '1') as any;
      expect(response.error).toBeDefined();
      expect(response.error.code).toBe(-32002);
      expect(response.error.message).toContain('X-Mcp4-Tools');
    });

    it('allows tool calls permitted by session filter', async () => {
      const localServer = new MCPServer();
      (localServer as any).profile = {
        profile_name: 'test',
        description: 'test',
        tools: [
          { name: 'allowed', description: 'allowed', parameters: {}, operations: { execute: 'op1' } },
        ],
        interceptors: {},
      };
      (localServer as any).executeSimpleTool = vi.fn().mockResolvedValue({ ok: true });
      (localServer as any).httpTransport = {
        hasOAuthProvider: (_profileId?: string) => false,
        getSessionToolFilter: (_profileId: string, _sessionId: string) => ({
          allowedToolNames: new Set(['allowed']),
          reasons: new Map(),
          patterns: { allow: [] },
          normalizedHeader: 'allowed',
        }),
        getSessionFiltering: (_profileId: string, _sessionId: string) => undefined,
      };

      const response = await localServer.callToolRpc('allowed', {}, 'session-1', '1') as any;
      expect(response.result).toBeDefined();
      const payload = JSON.parse(response.result.content[0].text);
      expect(payload).toEqual({ ok: true });
    });

    it('filters tools list based on enterprise authorization categories', async () => {
      const localServer = new MCPServer();
      (localServer as any).profile = {
        profile_name: 'test',
        description: 'test',
        tools: [
          { name: 'list_groups', description: 'list', parameters: {}, operations: { list: 'op1' } },
          { name: 'update_group', description: 'modify', parameters: {}, operations: { update: 'op2' } },
        ],
        enterprise_authorization: {
          enabled: true,
          access_policy: {
            allowed_tool_categories: ['list'],
          },
        },
        interceptors: {},
      };
      (localServer as any).toolGenerator = {
        generateTool: (toolDef: any) => ({ name: toolDef.name }),
      };
      (localServer as any).httpTransport = {
        hasOAuthProvider: (_profileId?: string) => false,
        getSessionEnterpriseAllowedToolCategories: (_profileId: string, _sessionId: string) => new Set(['list']),
      };

      const response = await (localServer as any).handleOtherRequest({
        jsonrpc: '2.0',
        id: '1',
        method: 'tools/list',
        params: {},
      }, 'session-1');

      expect(response.result.tools).toHaveLength(1);
      expect(response.result.tools[0].name).toBe('list_groups');
    });

    it('blocks tool calls not allowed by enterprise authorization policy', async () => {
      const localServer = new MCPServer();
      (localServer as any).profile = {
        profile_name: 'test',
        description: 'test',
        tools: [
          { name: 'update_group', description: 'modify', parameters: {}, operations: { update: 'op2' } },
        ],
        enterprise_authorization: {
          enabled: true,
          access_policy: {
            allowed_tool_categories: ['list'],
          },
        },
        interceptors: {},
      };
      (localServer as any).executeSimpleTool = vi.fn().mockResolvedValue({ ok: true });
      (localServer as any).httpTransport = {
        hasOAuthProvider: (_profileId?: string) => false,
        getSessionFiltering: (_profileId: string, _sessionId: string) => undefined,
        getSessionEnterpriseAllowedToolCategories: (_profileId: string, _sessionId: string) => new Set(['list']),
      };

      const response = await localServer.callToolRpc('update_group', {}, 'session-1', '1') as any;
      expect(response.error).toBeDefined();
      expect(response.error.code).toBe(-32002);
      expect(response.error.message).toContain('enterprise authorization policy');
    });

    it('allows enterprise policy lookup to fall back to undefined without session transport support', () => {
      const localServer = new MCPServer();
      (localServer as any).profile = {
        profile_name: 'test',
        description: 'test',
        tools: [],
        interceptors: {},
      };

      expect((localServer as any).getEnterpriseAllowedToolCategoriesForSession('session-1', 'profile-a')).toBeUndefined();

      (localServer as any).httpTransport = {};
      expect((localServer as any).getEnterpriseAllowedToolCategoriesForSession('session-1', 'profile-a')).toBeUndefined();
    });

    it('classifies composite tool categories conservatively', () => {
      const localServer = new MCPServer();
      (localServer as any).parser = {
        getPath: (path: string) => {
          if (path === '/groups') {
            return { operations: { get: { method: 'get', path, parameters: [] } } };
          }
          if (path === '/groups/{id}') {
            return { operations: { get: { method: 'get', path, parameters: [{ in: 'path', name: 'id' }] } } };
          }
          if (path === '/groups/mutate') {
            return { operations: { post: { method: 'post', path, parameters: [] } } };
          }
          return undefined;
        },
      };

      expect((localServer as any).getToolCategory({
        name: 'list_groups',
        description: 'list',
        composite: true,
        steps: [{ call: 'GET /groups' }],
      })).toBe('list');

      expect((localServer as any).getToolCategory({
        name: 'get_group',
        description: 'read',
        composite: true,
        steps: [{ call: 'GET /groups/{id}' }],
      })).toBe('read');

      expect((localServer as any).getToolCategory({
        name: 'mixed_group',
        description: 'mixed',
        composite: true,
        steps: [{ call: 'GET /groups' }, { call: 'GET /groups/{id}' }],
      })).toBe('modify');

      expect((localServer as any).getToolCategory({
        name: 'modify_group',
        description: 'modify',
        composite: true,
        steps: [{ call: 'POST /groups/mutate' }],
      })).toBe('modify');

      expect((localServer as any).getToolCategory({
        name: 'missing_step',
        description: 'missing',
        composite: true,
        steps: [{ call: 'GET /missing' }],
      })).toBe('modify');
    });

    it('applies enterprise tool policy consistently to tool listing and execution for ambiguously categorized composite tools', async () => {
      const localServer = new MCPServer();
      (localServer as any).profile = {
        profile_name: 'test',
        description: 'test',
        tools: [
          {
            name: 'mixed_group',
            description: 'mixed',
            composite: true,
            steps: [{ call: 'GET /groups' }, { call: 'GET /groups/{id}' }],
            parameters: {},
          },
        ],
        enterprise_authorization: {
          enabled: true,
          access_policy: {
            allowed_tool_categories: ['list'],
          },
        },
        interceptors: {},
      };
      (localServer as any).parser = {
        getPath: (path: string) => {
          if (path === '/groups') {
            return { operations: { get: { method: 'get', path, parameters: [] } } };
          }
          if (path === '/groups/{id}') {
            return { operations: { get: { method: 'get', path, parameters: [{ in: 'path', name: 'id' }] } } };
          }
          return undefined;
        },
      };
      (localServer as any).toolGenerator = {
        generateTool: (toolDef: any) => ({ name: toolDef.name }),
        validateArguments: vi.fn(),
      };
      (localServer as any).executeCompositeTool = vi.fn().mockResolvedValue({ ok: true });
      (localServer as any).httpTransport = {
        hasOAuthProvider: (_profileId?: string) => false,
        getSessionFiltering: (_profileId: string, _sessionId: string) => undefined,
        getSessionEnterpriseAllowedToolCategories: (_profileId: string, _sessionId: string) => new Set(['list']),
      };

      const listResponse = await (localServer as any).handleOtherRequest({
        jsonrpc: '2.0',
        id: '1',
        method: 'tools/list',
        params: {},
      }, 'session-1');

      expect(listResponse.result.tools).toHaveLength(0);

      const callResponse = await localServer.callToolRpc('mixed_group', {}, 'session-1', '2') as any;
      expect(callResponse.error).toBeDefined();
      expect(callResponse.error.code).toBe(-32002);
      expect(callResponse.error.message).toContain('enterprise authorization policy');
    });

    it('classifies simple tools using operations and fallback actions', () => {
      const localServer = new MCPServer();
      (localServer as any).parser = {
        getOperation: (operationId: string) => {
          if (operationId === 'op-list') {
            return { method: 'get', path: '/groups', parameters: [] };
          }
          if (operationId === 'op-read') {
            return { method: 'get', path: '/groups/{id}', parameters: [{ in: 'path', name: 'id' }] };
          }
          if (operationId === 'op-modify') {
            return { method: 'post', path: '/groups', parameters: [] };
          }
          return undefined;
        },
      };

      expect((localServer as any).getToolCategory({
        name: 'list_groups',
        description: 'list',
        operations: { list: 'op-list' },
      })).toBe('list');

      expect((localServer as any).getToolCategory({
        name: 'get_group',
        description: 'read',
        operations: { get: 'op-read' },
      })).toBe('read');

      expect((localServer as any).getToolCategory({
        name: 'mutate_group',
        description: 'modify',
        operations: { update: 'op-modify' },
      })).toBe('modify');

      expect((localServer as any).getToolCategory({
        name: 'fallback_search',
        description: 'search',
        operations: { search: 'missing-op' },
      })).toBe('list');

      expect((localServer as any).getToolCategory({
        name: 'fallback_get',
        description: 'get',
        operations: { get: 'missing-op' },
      })).toBe('read');

      expect((localServer as any).getToolCategory({
        name: 'fallback_custom',
        description: 'custom',
        operations: { custom: 'missing-op' },
      })).toBe('modify');

      expect((localServer as any).getToolCategory({
        name: 'missing_ops',
        description: 'missing',
      })).toBe('modify');

      expect((localServer as any).getToolCategory({
        name: 'non_string_op',
        description: 'bad',
        operations: { download: { url_source: '$.url' } },
      })).toBe('modify');
    });

    it('allows tools when enterprise categories are unset and blocks mismatched categories otherwise', () => {
      const localServer = new MCPServer();
      (localServer as any).parser = {
        getOperation: (operationId: string) => {
          if (operationId === 'op-list') {
            return { method: 'get', path: '/groups', parameters: [] };
          }
          return { method: 'post', path: '/groups', parameters: [] };
        },
      };

      const toolDef = {
        name: 'list_groups',
        description: 'list',
        operations: { list: 'op-list' },
      };

      expect((localServer as any).isToolAllowedByEnterprisePolicy(toolDef, undefined, 'profile-a')).toBe(true);

      (localServer as any).httpTransport = {
        getSessionEnterpriseAllowedToolCategories: () => new Set(['modify']),
      };

      expect((localServer as any).isToolAllowedByEnterprisePolicy(toolDef, 'session-1', 'profile-a')).toBe(false);

      (localServer as any).httpTransport = {
        getSessionEnterpriseAllowedToolCategories: () => new Set(),
      };

      expect((localServer as any).isToolAllowedByEnterprisePolicy(toolDef, 'session-1', 'profile-a')).toBe(true);
    });

    it('rejects session tool filters that match all tools', () => {
      const localServer = new MCPServer();
      (localServer as any).profile = {
        profile_name: 'test',
        description: 'test',
        tools: [
          { name: 'alpha', description: 'alpha', parameters: {}, operations: { execute: 'op1' } },
          { name: 'beta', description: 'beta', parameters: {}, operations: { execute: 'op2' } },
        ],
        interceptors: {},
      };

      const request = parseSessionToolFilterHeader('alpha, beta');
      (localServer as any).httpTransport = {
        hasOAuthProvider: (_profileId?: string) => false,
        getSessionToolFilterRequest: (_profileId: string, _sessionId: string) => request,
        setSessionToolFilter: vi.fn(),
      };

      expect(() =>
        (localServer as any).handleInitialize(
          { jsonrpc: '2.0', id: '1', method: 'initialize', params: {} },
          'session-1'
        )
      ).toThrow(ValidationError);
    });

    it('rejects empty session tool filter headers', () => {
      const localServer = new MCPServer();
      (localServer as any).profile = {
        profile_name: 'test',
        description: 'test',
        tools: [
          { name: 'alpha', description: 'alpha', parameters: {}, operations: { execute: 'op1' } },
        ],
        interceptors: {},
      };

      const request = parseSessionToolFilterHeader('');
      (localServer as any).httpTransport = {
        hasOAuthProvider: (_profileId?: string) => false,
        getSessionToolFilterRequest: (_profileId: string, _sessionId: string) => request,
        setSessionToolFilter: vi.fn(),
      };

      expect(() =>
        (localServer as any).handleInitialize(
          { jsonrpc: '2.0', id: '1', method: 'initialize', params: {} },
          'session-1'
        )
      ).toThrow(ValidationError);
    });

    it('rejects session tool filters that remove all tools', () => {
      const localServer = new MCPServer();
      (localServer as any).profile = {
        profile_name: 'test',
        description: 'test',
        tools: [
          { name: 'alpha', description: 'alpha', parameters: {}, operations: { execute: 'op1' } },
          { name: 'beta', description: 'beta', parameters: {}, operations: { execute: 'op2' } },
        ],
        interceptors: {},
      };

      const request = parseSessionToolFilterHeader('regex:does_not_exist');
      (localServer as any).httpTransport = {
        hasOAuthProvider: (_profileId?: string) => false,
        getSessionToolFilterRequest: (_profileId: string, _sessionId: string) => request,
        setSessionToolFilter: vi.fn(),
      };

      expect(() =>
        (localServer as any).handleInitialize(
          { jsonrpc: '2.0', id: '1', method: 'initialize', params: {} },
          'session-1'
        )
      ).toThrow(ValidationError);
    });
  });

  describe('tool call validation', () => {
    it('returns not found when tool is missing', async () => {
      const localServer = new MCPServer();
      (localServer as any).profile = {
        profile_name: 'test',
        description: 'test',
        tools: [
          { name: 'allowed', description: 'allowed', parameters: {}, operations: { execute: 'op1' } },
        ],
        interceptors: {},
      };
      (localServer as any).httpTransport = {
        hasOAuthProvider: (_profileId?: string) => false,
        getSessionFiltering: (_profileId: string, _sessionId: string) => undefined,
      };

      const response = await localServer.callToolRpc('missing', {}, 'session-1', '1') as any;
      expect(response.error).toBeDefined();
      expect(response.error.code).toBe(-32601);
      expect(response.error.message).toContain('Tool not found');
    });
  });

  describe('tool filter intersection', () => {
    it('keeps intersection of global and session filters', () => {
      const localServer = new MCPServer();
      process.env.MCP4_TOOL_FILTER_ALLOW_NAMES = 'tool_a,tool_b,tool_c';
      try {
        (localServer as any).profile = {
          profile_name: 'test',
          description: 'test',
          tools: [
            { name: 'tool_a', description: 'a', parameters: {}, operations: { execute: 'op1' } },
            { name: 'tool_b', description: 'b', parameters: {}, operations: { execute: 'op2' } },
            { name: 'tool_c', description: 'c', parameters: {}, operations: { execute: 'op3' } },
            { name: 'tool_d', description: 'd', parameters: {}, operations: { execute: 'op4' } },
          ],
          interceptors: {},
        };

        const sessionFilters = new Map<string, any>();
        const request = parseSessionToolFilterHeader('tool_b, tool_c, tool_d');
        (localServer as any).httpTransport = {
          getSessionToolFilterRequest: (_profileId: string, _sessionId: string) => request,
          setSessionToolFilter: (_profileId: string, sessionId: string, filter: any) => {
            sessionFilters.set(sessionId, filter);
          },
        };

        (localServer as any).applyGlobalToolFiltering();
        (localServer as any).applySessionToolFiltering('session-1');

        const sessionFilter = sessionFilters.get('session-1');
        expect(sessionFilter.allowedToolNames.size).toBe(2);
        expect(sessionFilter.allowedToolNames.has('tool_b')).toBe(true);
        expect(sessionFilter.allowedToolNames.has('tool_c')).toBe(true);
      } finally {
        delete process.env.MCP4_TOOL_FILTER_ALLOW_NAMES;
      }
    });
  });

  describe('field selection', () => {
    it('filters nested fields and arrays with sub-selections', () => {
      const server = new MCPServer();
      const data = {
        id: 1,
        title: 'x',
        author: { id: 'u1', login: 'alice', email: 'secret@example.com' },
        comments: [
          { id: 'c1', text: 'hi', author: { id: 'u2', login: 'bob', token: 'secret' } },
        ],
      };

      const filtered = (server as any).filterFields(data, [
        'id',
        'author(id,login)',
        'comments(id,text,author(id,login))',
      ]);

      expect(filtered).toEqual({
        id: 1,
        author: { id: 'u1', login: 'alice' },
        comments: [{ id: 'c1', text: 'hi', author: { id: 'u2', login: 'bob' } }],
      });
    });

    it('treats invalid selector parentheses as selecting the whole field', () => {
      const server = new MCPServer();
      const data = { id: 1, author: { id: 'u1', login: 'alice' } };
      const filtered = (server as any).filterFields(data, ['author(id']);
      expect(filtered).toEqual({ author: { id: 'u1', login: 'alice' } });
    });

    it('ignores unsafe property names in selector', () => {
      const server = new MCPServer();
      const data = { ok: 1, __proto__: { polluted: true } } as any;
      const filtered = (server as any).filterFields(data, ['__proto__(polluted)', 'ok']);
      expect(filtered).toEqual({ ok: 1 });
    });

    it('merges repeated selectors for the same field', () => {
      const server = new MCPServer();
      const data = { a: { b: 1, c: 2, d: 3 } };
      const filtered = (server as any).filterFields(data, ['a(b)', 'a(c)']);
      expect(filtered).toEqual({ a: { b: 1, c: 2 } });
    });

    it('merges nested selectors recursively', () => {
      const server = new MCPServer();
      const data = { a: { b: { x: 1, y: 2, z: 3 } } };
      const filtered = (server as any).filterFields(data, ['a(b(x))', 'a(b(y))']);
      expect(filtered).toEqual({ a: { b: { x: 1, y: 2 } } });
    });
  });

  describe('tool filter / auth helpers coverage', () => {
    it('selects primary and env-backed auth configs', () => {
      const server = new MCPServer();
      (server as any).profile = {
        profile_name: 'test',
        description: 'test',
        tools: [],
        interceptors: {
          auth: [
            { type: 'oauth', oauth_config: { issuer: 'https://example.com' }, priority: 10 },
            { type: 'bearer', value_from_env: 'TOKEN', priority: 0 },
          ],
        },
      };

      const primary = (server as any).getPrimaryAuthConfig();
      expect(primary.type).toBe('bearer');

      const envBacked = (server as any).getEnvBackedAuthConfig();
      expect(envBacked.type).toBe('bearer');

      const oauth = (server as any).getOAuthConfig();
      expect(oauth.issuer).toBe('https://example.com');
    });

    it('applyGlobalToolFiltering returns without profile', () => {
      const server = new MCPServer();
      (server as any).applyGlobalToolFiltering();
    });

    it('applyGlobalToolFiltering returns when no env config is set', () => {
      const server = new MCPServer();
      (server as any).profile = {
        profile_name: 'test',
        description: 'test',
        tools: [{ name: 'a', description: 'a', parameters: {}, operations: { execute: 'op' } }],
        interceptors: {},
      };
      (server as any).applyGlobalToolFiltering();
      expect((server as any).profile.tools).toHaveLength(1);
    });

    it('warns when tool filter removes a high percentage of tools', () => {
      const logger = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };
      const server = new MCPServer(logger as any);
      (server as any).profile = {
        profile_name: 'test',
        description: 'test',
        tools: [
          { name: 'tool_a', description: 'a', parameters: {}, operations: { execute: 'op1' } },
          { name: 'tool_b', description: 'b', parameters: {}, operations: { execute: 'op2' } },
          { name: 'tool_c', description: 'c', parameters: {}, operations: { execute: 'op3' } },
          { name: 'tool_d', description: 'd', parameters: {}, operations: { execute: 'op4' } },
        ],
        interceptors: {},
      };
      process.env.MCP4_TOOL_FILTER_ALLOW_NAMES = 'tool_a';
      process.env.MCP4_TOOL_FILTER_WARN_THRESHOLD_PCT = '1';
      try {
        (server as any).applyGlobalToolFiltering();
        expect(logger.warn).toHaveBeenCalled();
      } finally {
        delete process.env.MCP4_TOOL_FILTER_ALLOW_NAMES;
        delete process.env.MCP4_TOOL_FILTER_WARN_THRESHOLD_PCT;
      }
    });

    it('returns OAuth-required error for tools/list when OAuth is enabled and session has no token', async () => {
      const server = new MCPServer();
      (server as any).httpTransport = {
        hasOAuthProvider: (_profileId?: string) => true,
        getOAuthProtectedResourceUrl: (_profileId?: string) => 'http://127.0.0.1:9999/.well-known/oauth-protected-resource/mcp',
      };
      (server as any).getAuthTokenFromSession = async () => undefined;

      const res = await (server as any).handleOtherRequest({ jsonrpc: '2.0', id: '1', method: 'tools/list' }, 's1');
      expect((res as any).error?.data?.oauth_required).toBe(true);
    });

    it('maps OperationNotFoundError to -32601', async () => {
      const server = new MCPServer();
      (server as any).profile = {
        profile_name: 'test',
        description: 'test',
        tools: [{ name: 't', description: 't', parameters: {}, operations: { execute: 'op1' } }],
        interceptors: {},
      };
      (server as any).executeSimpleTool = async () => {
        throw new OperationNotFoundError('missing-operation');
      };
      const resp = await server.callToolRpc('t', {}, 's1', '1');
      expect((resp as any).error?.code).toBe(-32601);
    });

    it('creates a session HTTP client via factory when sessionId is provided', async () => {
      const server = new MCPServer();
      (server as any).profile = {
        profile_name: 'test',
        description: 'test',
        tools: [],
        interceptors: {},
      };
      (server as any).getAuthTokenFromSession = async () => 'token';
      const client = { request: async () => ({}) };
      const getOrCreateSessionClient = vi.fn().mockReturnValue(client);
      (server as any).httpClientFactory = {
        getOrCreateSessionClient,
        hasGlobalClient: () => true,
        getGlobalClient: () => client,
        cleanupSessionClient: () => false,
      };
      (server as any).parser = { getBaseUrl: () => 'https://example.com' };

      const out = await (server as any).getHttpClientForSession('session-1');
      expect(out).toBe(client);
      expect(getOrCreateSessionClient).toHaveBeenCalled();
    });

    it('logs cleanup when session client is removed', () => {
      const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const server = new MCPServer(logger as any);
      (server as any).httpClientFactory = { cleanupSessionClient: () => true };
      (server as any).cleanupSessionClient('default', 'session-1');
      expect(logger.info).toHaveBeenCalledWith('Cleaned up session HTTP client', { profileId: 'default', sessionId: 'session-1' });
    });

    it('CallTool request handler returns a user-friendly error when server is not initialized', async () => {
      const server = new MCPServer();

      const handlers: Array<{ schema: unknown; handler: RequestHandler }> = [];
      const originalSet = (server as any).server.setRequestHandler.bind((server as any).server);
      (server as any).server.setRequestHandler = (schema: unknown, handler: RequestHandler) => {
        handlers.push({ schema, handler });
        return originalSet(schema, handler);
      };

      // Install handlers and call the CallTool handler without initializing profile/compositeExecutor.
      (server as any).setupHandlers();
      const callToolHandler = handlers.find(entry => {
        const schema: any = entry.schema;
        return schema?.shape?.method?.value === 'tools/call';
      })?.handler;
      expect(callToolHandler).toBeDefined();

      await expect(
        callToolHandler!({ params: { name: 'any', arguments: {} } })
      ).rejects.toThrow('Server not initialized');
    });

    it('covers session tool filtering error branches (no-op and all-filtered)', () => {
      const localServer = new MCPServer();
      const resolver = {
        getOperationById: () => undefined,
        getOperationForCall: () => undefined,
      };
      (localServer as any).buildToolFilterResolver = () => resolver;

      (localServer as any).profile = {
        profile_name: 'test',
        description: 'test',
        tools: [{ name: 'tool_a', description: 'a', parameters: {}, operations: { execute: 'op1' } }],
        interceptors: {},
      };

      const noRulesRequest = parseSessionToolFilterHeader('');
      const allFilteredRequest = parseSessionToolFilterHeader('tool_b');

      const sessionFilters = new Map<string, any>();
      (localServer as any).httpTransport = {
        getSessionToolFilterRequest: (_profileId: string, sessionId: string) =>
          sessionId === 'no-rules' ? noRulesRequest : allFilteredRequest,
        setSessionToolFilter: (_profileId: string, sessionId: string, filter: any) => {
          sessionFilters.set(sessionId, filter);
        },
      };

      expect(() => (localServer as any).applySessionToolFiltering('no-rules')).toThrow(ValidationError);
      expect(() => (localServer as any).applySessionToolFiltering('all-filtered')).toThrow(ValidationError);
    });

    it('does not throw for upstream profiles with empty tools[] when X-Mcp4-Tools header is present', () => {
      // upstream_mcp profiles have tools: [] by design - a 0-vs-0 no-op check must not block init
      const s = new MCPServer();
      const resolver = {
        getOperationById: () => undefined,
        getOperationForCall: () => undefined,
      };
      (s as any).buildToolFilterResolver = () => resolver;
      (s as any).profile = {
        profile_name: 'upstream-test',
        description: 'upstream',
        tools: [],
        interceptors: {},
      };
      const filterRequest = parseSessionToolFilterHeader('some_tool');
      (s as any).httpTransport = {
        getSessionToolFilterRequest: () => filterRequest,
        setSessionToolFilter: vi.fn(),
      };
      // Must not throw - upstream profiles skip the no-effect guard
      expect(() => (s as any).applySessionToolFiltering('session-1')).not.toThrow();
    });

    it('throws ValidationError for _allow_list with upstream proxy profiles at session init', () => {
      const s = new MCPServer();
      (s as any).profile = {
        profile_name: 'upstream-test',
        tools: [],
        upstream_mcp: { name: 'test', transport: { type: 'http', url: 'https://example.com/mcp' } },
      };
      const filterRequest = parseSessionToolFilterHeader('_allow_list');
      (s as any).httpTransport = {
        getSessionToolFilterRequest: () => filterRequest,
        getUpstreamMcpConfig: (_pid: string) =>
          ({ name: 'test', transport: { type: 'http', url: 'https://example.com/mcp' } }),
      };
      expect(() => (s as any).applySessionToolFiltering('session-1'))
        .toThrow('_allow_list/_allow_read not supported for upstream proxy profiles');
    });

    it('does not throw for exact/regex X-Mcp4-Tools rules with upstream proxy profiles at session init', () => {
      const s = new MCPServer();
      (s as any).profile = {
        profile_name: 'upstream-test',
        tools: [],
        upstream_mcp: { name: 'test', transport: { type: 'http', url: 'https://example.com/mcp' } },
      };
      const filterRequest = parseSessionToolFilterHeader('tool_a, regex:read_.*');
      (s as any).httpTransport = {
        getSessionToolFilterRequest: () => filterRequest,
        getUpstreamMcpConfig: (_pid: string) =>
          ({ name: 'test', transport: { type: 'http', url: 'https://example.com/mcp' } }),
      };
      // Must not throw - exact/regex rules are deferred predicates for upstream
      expect(() => (s as any).applySessionToolFiltering('session-1')).not.toThrow();
    });

    it('covers tool filter metrics helpers and threshold parsing', () => {
      const localServer = new MCPServer();

      // invalid threshold
      process.env.MCP4_TOOL_FILTER_WARN_THRESHOLD_PCT = '0';
      try {
        expect(() => (localServer as any).getToolFilterWarnThresholdPct()).toThrow(ConfigurationError);
      } finally {
        delete process.env.MCP4_TOOL_FILTER_WARN_THRESHOLD_PCT;
      }

      const recordGlobalToolFilterMetrics = vi.fn();
      const recordSessionToolFilterMetrics = vi.fn();
      const recordToolFilterRejection = vi.fn();
      (localServer as any).httpTransport = {
        recordGlobalToolFilterMetrics,
        recordSessionToolFilterMetrics,
        recordToolFilterRejection,
      };
      (localServer as any).globalToolFilterSummary = {
        originalCount: 2,
        allowedCount: 1,
        removedCount: 1,
        patternCounts: { allow_names: 1 },
      };

      (localServer as any).recordGlobalToolFilterMetrics();
      expect(recordGlobalToolFilterMetrics).toHaveBeenCalled();

      const req = parseSessionToolFilterHeader('tool_a');
      (localServer as any).recordSessionToolFilterMetrics('s1', 1, req);
      expect(recordSessionToolFilterMetrics).toHaveBeenCalled();

      (localServer as any).recordToolFilterRejection('tool_a', 'session');
      expect(recordToolFilterRejection).toHaveBeenCalled();
    });

    it('covers buildToolFilterResolver call parsing', () => {
      const localServer = new MCPServer();
      (localServer as any).parser = {
        getOperation: () => undefined,
        getPath: (p: string) => {
          if (p === '/items') {
            return {
              operations: {
                get: { operationId: 'listItems', method: 'get', path: '/items', parameters: [] },
              },
            };
          }
          return undefined;
        },
      };

      const resolver = (localServer as any).buildToolFilterResolver();
      expect(resolver.getOperationForCall('GET /items')?.operationId).toBe('listItems');
      expect(resolver.getOperationForCall('GET')).toBeUndefined();
    });

    it('covers applySessionToolFiltering early return paths', () => {
      const s = new MCPServer();
      // No httpTransport/profile => return
      (s as any).applySessionToolFiltering('s1');
      // httpTransport present but no profile => return
      (s as any).httpTransport = {};
      (s as any).applySessionToolFiltering('s1');
    });

    it('throws ConfigurationError when all tools are filtered out', () => {
      const s = new MCPServer();
      (s as any).profile = {
        profile_name: 'test',
        description: 'test',
        tools: [
          { name: 'a', description: 'a', parameters: {}, operations: { execute: 'op1' } },
          { name: 'b', description: 'b', parameters: {}, operations: { execute: 'op2' } },
        ],
        interceptors: {},
      };
      process.env.MCP4_TOOL_FILTER_DENY_NAMES = 'a,b';
      try {
        expect(() => (s as any).applyGlobalToolFiltering()).toThrow(ConfigurationError);
      } finally {
        delete process.env.MCP4_TOOL_FILTER_DENY_NAMES;
      }
    });

    it('covers CallTool handler tool-not-found and simple tool execution branches', async () => {
      const s = new MCPServer();

      const handlers: Array<{ schema: unknown; handler: RequestHandler }> = [];
      const originalSet = (s as any).server.setRequestHandler.bind((s as any).server);
      (s as any).server.setRequestHandler = (schema: unknown, handler: RequestHandler) => {
        handlers.push({ schema, handler });
        return originalSet(schema, handler);
      };
      (s as any).setupHandlers();
      const callToolHandler = handlers.find(entry => {
        const schema: any = entry.schema;
        return schema?.shape?.method?.value === 'tools/call';
      })?.handler;
      expect(callToolHandler).toBeDefined();

      // Setup minimal initialized state
      (s as any).profile = {
        profile_name: 'test',
        description: 'test',
        tools: [{ name: 't', description: 't', parameters: {}, operations: { execute: 'op' } }],
        interceptors: {},
      };
      (s as any).compositeExecutor = {};
      (s as any).toolGenerator = { validateArguments: () => {} };

      // Unknown tool => OperationNotFoundError path
      await expect(callToolHandler!({ params: { name: 'missing', arguments: {} } })).rejects.toThrow();

      // Existing tool => executeSimpleTool branch
      (s as any).executeSimpleTool = async () => ({ ok: true });
      const res = await callToolHandler!({ params: { name: 't', arguments: {} } });
      expect(res.content[0].text).toContain('"ok": true');
    });

    it('covers recordSessionToolFilterMetrics and recordToolFilterRejection early return branches', () => {
      const s = new MCPServer();
      const req = parseSessionToolFilterHeader('tool_a');
      (s as any).recordSessionToolFilterMetrics('s1', 1, req);
      (s as any).recordToolFilterRejection('tool_a', 'session');
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
      expect(response.result.capabilities.prompts).toBeDefined();
      expect(response.result.capabilities.prompts.listChanged).toBe(false);
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

    it('should store stdio filtering when provided', () => {
      const server = new MCPServer();
      const message = {
        jsonrpc: '2.0',
        id: '1',
        method: 'initialize',
        params: { filtering: 'project_id=1' }
      };

      (server as any).handleInitialize(message, undefined);
      expect((server as any).stdioFiltering).toEqual({ project_id: ['1'] });
    });

    it('merges stdio filtering with global filtering', () => {
      const server = new MCPServer();
      server.setGlobalFiltering({ project_id: ['1', '2'], _allow_read: [] });
      const message = {
        jsonrpc: '2.0',
        id: '1',
        method: 'initialize',
        params: { filtering: 'project_id=2,_allow_read' }
      };

      (server as any).handleInitialize(message, undefined);

      expect((server as any).stdioFiltering).toEqual({
        project_id: ['2'],
        _allow_read: [],
      });
    });

    it('rejects conflicting stdio filtering against global filtering', () => {
      const server = new MCPServer();
      server.setGlobalFiltering({ project_id: ['1'] });
      const message = {
        jsonrpc: '2.0',
        id: '1',
        method: 'initialize',
        params: { filtering: 'project_id=2' }
      };

      expect(() => (server as any).handleInitialize(message, undefined)).toThrow(ValidationError);
    });

    it('uses global filtering when no stdio filtering is provided', () => {
      const server = new MCPServer();
      server.setGlobalFiltering({ project_id: ['1'] });

      (server as any).handleInitialize({
        jsonrpc: '2.0',
        id: '1',
        method: 'initialize',
        params: {}
      }, undefined);

      expect((server as any).getFilteringForSession()).toEqual({ project_id: ['1'] });
    });

    it('should reject non-string stdio filtering', () => {
      const server = new MCPServer();
      const message = {
        jsonrpc: '2.0',
        id: '1',
        method: 'initialize',
        params: { filtering: 123 }
      };

      expect(() => (server as any).handleInitialize(message, undefined)).toThrow(ValidationError);
    });
  });

  describe('filtering enforcement in tool calls', () => {
    it('applies filtering with resolved operation info', async () => {
      const server = new MCPServer();
      (server as any).profile = {
        profile_name: 'test',
        description: 'test',
        tools: [
          {
            name: 'projects',
            description: 'Project tool',
            parameters: {
              project_id: { type: 'string', description: 'Project ID' },
            },
            operations: { get: 'getProject' },
          },
        ],
        interceptors: {},
      };

      (server as any).toolGenerator = {
        mapActionToOperation: () => 'getProject',
        validateArguments: () => {},
      };
      (server as any).parser = {
        getOperation: () => ({
          operationId: 'getProject',
          method: 'get',
          path: '/projects',
          parameters: [],
        }),
      };
      (server as any).executeSimpleTool = async () => ({ ok: true });

      (server as any).handleInitialize({
        jsonrpc: '2.0',
        id: '1',
        method: 'initialize',
        params: { filtering: 'project_id=1' }
      }, undefined);

      const response = asToolCallResponse(await server.callToolRpc('projects', { project_id: '1' }, undefined, '1'));
      expect(response.result).toBeDefined();
    });

    it('returns undefined operation info for composite tools and missing operations', () => {
      const server = new MCPServer();
      const compositeTool = {
        name: 'composite',
        description: 'Composite tool',
        composite: true,
        steps: [],
        parameters: {},
      };

      expect((server as any).getFilteringOperationInfo(compositeTool, {})).toBeUndefined();

      const simpleTool = {
        name: 'simple',
        description: 'Simple tool',
        parameters: {},
        operations: {},
      };
      (server as any).toolGenerator = { mapActionToOperation: () => undefined };

      expect((server as any).getFilteringOperationInfo(simpleTool, {})).toBeUndefined();
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

  describe('ResourceNotFoundError formatting', () => {
    it('should format ResourceNotFoundError with correlation ID', () => {
      const server = new MCPServer();
      const error = new ResourceNotFoundError('missing_tool', 'Tool');
      const correlationId = 'test-correlation-id';

      const formatted = (server as any).formatErrorForClient(error, correlationId);

      expect(formatted).toContain('Tool not found');
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
    const findHandlerCall = (setHandlerSpy: ReturnType<typeof vi.spyOn>, method: string) => {
      return [...setHandlerSpy.mock.calls].reverse().find((call) => {
        const schema: any = call[0];
        return schema?.shape?.method?.value === method;
      });
    };

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('ListTools handler should wrap errors with correlation ID when uninitialized', async () => {
      const setHandlerSpy = vi.spyOn(MCPProtocolServer.prototype as any, 'setRequestHandler');
      new MCPServer();

      const listCall = findHandlerCall(setHandlerSpy, 'tools/list');
      expect(listCall).toBeDefined();

      const listHandler = listCall![1] as () => Promise<unknown>;
      await expect(listHandler()).rejects.toThrow(/correlation ID/);
    });

    it('ListTools handler should return tools when initialized', async () => {
      const setHandlerSpy = vi.spyOn(MCPProtocolServer.prototype as any, 'setRequestHandler');
      const server = new MCPServer();
      const specPath = path.join(process.cwd(), 'profiles/gitlab/openapi.yaml');
      await server.initialize(specPath);

      const listCall = findHandlerCall(setHandlerSpy, 'tools/list');
      const listHandler = listCall![1] as () => Promise<any>;
      const result = await listHandler();
      expect(result).toHaveProperty('tools');
      expect(Array.isArray(result.tools)).toBe(true);
      expect(result.tools.length).toBeGreaterThan(0);
    });

    it('ListPrompts handler should return configured prompts when initialized', async () => {
      const setHandlerSpy = vi.spyOn(MCPProtocolServer.prototype as any, 'setRequestHandler');
      const server = new MCPServer();
      const specPath = path.join(process.cwd(), 'profiles/gitlab/openapi.yaml');
      await server.initialize(specPath);
      (server as any).profile.prompts = [
        {
          name: 'summarize_issue',
          description: 'Summarize issue context',
          arguments: [{ name: 'issue_title', required: true }],
          messages: [{ role: 'user', content: { type: 'text', text: 'Summarize: {{issue_title}}' } }],
        },
      ];

      const listCall = findHandlerCall(setHandlerSpy, 'prompts/list');
      expect(listCall).toBeDefined();

      const listHandler = listCall![1] as () => Promise<any>;
      const result = await listHandler();
      expect(result.prompts).toHaveLength(1);
      expect(result.prompts[0].name).toBe('summarize_issue');
    });

    it('ListPrompts handler should wrap unexpected errors with correlation ID', async () => {
      const setHandlerSpy = vi.spyOn(MCPProtocolServer.prototype as any, 'setRequestHandler');
      const server = new MCPServer();
      (server as any).listPrompts = () => {
        throw new Error('boom');
      };

      const listCall = findHandlerCall(setHandlerSpy, 'prompts/list');
      const listHandler = listCall![1] as () => Promise<any>;
      await expect(listHandler()).rejects.toThrow(/correlation ID/);
    });

    it('GetPrompt handler should render prompt text from arguments', async () => {
      const setHandlerSpy = vi.spyOn(MCPProtocolServer.prototype as any, 'setRequestHandler');
      const server = new MCPServer();
      const specPath = path.join(process.cwd(), 'profiles/gitlab/openapi.yaml');
      await server.initialize(specPath);
      (server as any).profile.prompts = [
        {
          name: 'summarize_issue',
          description: 'Summarize issue context',
          arguments: [{ name: 'issue_title', required: true }],
          messages: [{ role: 'user', content: { type: 'text', text: 'Summarize: {{issue_title}}' } }],
        },
      ];

      const getCall = findHandlerCall(setHandlerSpy, 'prompts/get');
      expect(getCall).toBeDefined();

      const getHandler = getCall![1] as (req: any) => Promise<any>;
      const result = await getHandler({ params: { name: 'summarize_issue', arguments: { issue_title: 'Fix login' } } });
      expect(result.messages[0].content.text).toContain('Fix login');
    });

    it('GetPrompt handler should wrap configuration errors with correlation ID when uninitialized', async () => {
      const setHandlerSpy = vi.spyOn(MCPProtocolServer.prototype as any, 'setRequestHandler');
      new MCPServer();

      const getCall = findHandlerCall(setHandlerSpy, 'prompts/get');
      const getHandler = getCall![1] as (req: any) => Promise<any>;

      await expect(getHandler({ params: { name: 'summarize_issue', arguments: {} } }))
        .rejects.toThrow(/correlation ID/);
    });

    it('GetPrompt handler should preserve ValidationError for missing required args', async () => {
      const setHandlerSpy = vi.spyOn(MCPProtocolServer.prototype as any, 'setRequestHandler');
      const server = new MCPServer();
      const specPath = path.join(process.cwd(), 'profiles/gitlab/openapi.yaml');
      await server.initialize(specPath);
      (server as any).profile.prompts = [
        {
          name: 'summarize_issue',
          description: 'Summarize issue context',
          arguments: [{ name: 'issue_title', required: true }],
          messages: [{ role: 'user', content: { type: 'text', text: 'Summarize: {{issue_title}}' } }],
        },
      ];

      const getCall = findHandlerCall(setHandlerSpy, 'prompts/get');
      const getHandler = getCall![1] as (req: any) => Promise<any>;

      await expect(getHandler({ params: { name: 'summarize_issue', arguments: {} } }))
        .rejects.toBeInstanceOf(ValidationError);
    });

    it('GetPrompt handler should preserve ResourceNotFoundError for missing prompt', async () => {
      const setHandlerSpy = vi.spyOn(MCPProtocolServer.prototype as any, 'setRequestHandler');
      const server = new MCPServer();
      const specPath = path.join(process.cwd(), 'profiles/gitlab/openapi.yaml');
      await server.initialize(specPath);
      (server as any).profile.prompts = [];

      const getCall = findHandlerCall(setHandlerSpy, 'prompts/get');
      const getHandler = getCall![1] as (req: any) => Promise<any>;

      await expect(getHandler({ params: { name: 'missing_prompt', arguments: {} } }))
        .rejects.toBeInstanceOf(ResourceNotFoundError);
    });

    it('GetPrompt handler should wrap unexpected runtime errors with correlation ID', async () => {
      const setHandlerSpy = vi.spyOn(MCPProtocolServer.prototype as any, 'setRequestHandler');
      const server = new MCPServer();
      const specPath = path.join(process.cwd(), 'profiles/gitlab/openapi.yaml');
      await server.initialize(specPath);
      (server as any).profile.prompts = [
        {
          name: 'summarize_issue',
          description: 'Summarize issue context',
          arguments: [{ name: 'issue_title', required: true }],
          messages: [{ role: 'user', content: { type: 'text', text: 'Summarize: {{issue_title}}' } }],
        },
      ];
      (server as any).renderPromptByName = () => {
        throw new Error('boom');
      };

      const getCall = findHandlerCall(setHandlerSpy, 'prompts/get');
      const getHandler = getCall![1] as (req: any) => Promise<any>;

      await expect(getHandler({ params: { name: 'summarize_issue', arguments: { issue_title: 'X' } } }))
        .rejects.toThrow(/correlation ID/);
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

      const callToolCall = findHandlerCall(setHandlerSpy, 'tools/call');
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

      const callToolCall = findHandlerCall(setHandlerSpy, 'tools/call');
      const callToolHandler = callToolCall![1] as (req: any) => Promise<any>;
      await expect(
        callToolHandler({ params: { name: 'simple_test', arguments: {} } })
      ).rejects.toThrow(/Authorization failed: Forbidden/);
    });
  });

  describe('profile id resolution', () => {
    it('throws when profile is not initialized', () => {
      const server = new MCPServer();
      (server as any).profile = undefined;
      expect(() => (server as any).getProfileIdValue()).toThrow('Profile not initialized. Call initialize() first.');
    });

    it('throws when profile has no id or name', () => {
      const server = new MCPServer();
      (server as any).profile = {
        profile_name: '',
        profile_id: '   ',
        tools: [],
        interceptors: {},
      };
      expect(() => (server as any).getProfileIdValue()).toThrow('Profile is missing profile_id and profile_name.');
    });
  });

  describe('session cleanup', () => {
    it('handleSessionDestroyed forwards to cleanupSessionClient', () => {
      const server = new MCPServer();
      const cleanupSpy = vi.spyOn(server as any, 'cleanupSessionClient');
      server.handleSessionDestroyed('default', 'session-1');
      expect(cleanupSpy).toHaveBeenCalledWith('default', 'session-1');
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
        hasOAuthProvider: (_profileId?: string) => true,
        getOAuthProtectedResourceUrl: (_profileId?: string) => 'https://example.com/.well-known/oauth-protected-resource/mcp',
      };
      
      // Mock getAuthTokenFromSession to return undefined
      (server as any).getAuthTokenFromSession = async () => undefined;
      
      const response = await (server as any).handleOtherRequest(
        { jsonrpc: '2.0', id: 1, method: 'tools/list' },
        'test-session'
      );
      
      expect(response.error.code).toBe(-32600);
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
        hasOAuthProvider: (_profileId?: string) => true,
        getOAuthProtectedResourceUrl: (_profileId?: string) => 'https://example.com/.well-known/oauth-protected-resource/mcp',
      };
      
      // Mock getAuthTokenFromSession to return undefined
      (server as any).getAuthTokenFromSession = async () => undefined;
      
      const response = asToolCallResponse(await server.callToolRpc('some_tool', {}, 'test-session', 1));
      
      const error = response.error as { code?: number; data?: { oauth_required?: boolean } };
      expect(error.code).toBe(-32600);
      expect(error.data?.oauth_required).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Upstream proxy behavior tests
  // ---------------------------------------------------------------------------
  describe('upstream proxy', () => {
    const upstreamProvider = {
      name: 'test-upstream',
      transport: { type: 'http-streamable', url: 'https://upstream.example.com/mcp' },
    };

    const safeTool = {
      name: 'safe_tool',
      description: 'A safe tool',
      inputSchema: { type: 'object', properties: {} },
    };

    const unsafeTool = {
      name: 'has <script> injection',
      description: 'Bad',
      inputSchema: { type: 'object', properties: {} },
    };

    // Shared mock upstream client
    let mockListTools: ReturnType<typeof vi.fn>;
    let mockCallTool: ReturnType<typeof vi.fn>;
    let mockGetUpstreamClient: ReturnType<typeof vi.fn>;
    let upstreamServer: MCPServer;

    beforeEach(async () => {
      mockListTools = vi.fn().mockResolvedValue({ tools: [safeTool] });
      mockCallTool = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
      mockGetUpstreamClient = vi.fn().mockResolvedValue({ listTools: mockListTools, callTool: mockCallTool });

      upstreamServer = new MCPServer();
      // Set a minimal profile with upstream_mcp (no tools - upstream is the source)
      (upstreamServer as any).profile = {
        profile_name: 'upstream-profile',
        description: 'Upstream profile',
        tools: [],
        upstream_mcp: upstreamProvider,
      };
      // Wire a mock httpTransport that returns upstreamMcp config
      (upstreamServer as any).httpTransport = {
        hasOAuthProvider: () => false,
        getUpstreamMcpConfig: (_profileId: string) => upstreamProvider,
        getSessionToken: (_profileId: string, _sessionId: string) => 'downstream-token',
        getSessionTenantContext: () => undefined,
        getMetricsCollector: () => null,
        getSessionFiltering: () => undefined,
        getSessionToolFilter: () => undefined,
        getSessionToolFilterHeader: () => undefined,
        getSessionToolFilterRequest: () => undefined,
        getSessionEnterpriseTiers: () => undefined,
        getSessionEnterpriseAllowedToolCategories: () => undefined,
        recordToolFilterRejection: () => {},
      };
      // Wire the upstream client callback
      upstreamServer.setGetUpstreamClient(mockGetUpstreamClient);
    });

    // -------------------------------------------------------------------------
    describe('tools/list upstream forwarding', () => {
      it('returns sanitized upstream tools when upstream_mcp configured', async () => {
        const response = await (upstreamServer as any).handleOtherRequest(
          { jsonrpc: '2.0', id: '1', method: 'tools/list', params: {} },
          'session-123',
          'upstream-profile',
        ) as any;

        expect(response.result.tools).toHaveLength(1);
        expect(response.result.tools[0].name).toBe('safe_tool');
        expect(mockGetUpstreamClient).toHaveBeenCalledWith('session-123', upstreamProvider, 'downstream-token');
        expect(mockListTools).toHaveBeenCalled();
      });

      it('drops unsafe tools from upstream response', async () => {
        mockListTools.mockResolvedValueOnce({ tools: [safeTool, unsafeTool] });

        const response = await (upstreamServer as any).handleOtherRequest(
          { jsonrpc: '2.0', id: '2', method: 'tools/list', params: {} },
          'session-123',
          'upstream-profile',
        ) as any;

        // Only safe_tool survives - unsafeTool name has invalid chars
        expect(response.result.tools).toHaveLength(1);
        expect(response.result.tools[0].name).toBe('safe_tool');
      });

      it('returns local tools when no upstream_mcp configured', async () => {
        // Create a non-upstream server
        const localServer = new MCPServer();
        (localServer as any).profile = {
          profile_name: 'local-profile',
          description: 'Local profile',
          tools: [
            {
              name: 'local_tool',
              description: 'A local tool',
              parameters: {},
              operations: { execute: 'someOp' },
            },
          ],
        };
        (localServer as any).httpTransport = null;

        const response = await (localServer as any).handleOtherRequest(
          { jsonrpc: '2.0', id: '3', method: 'tools/list', params: {} },
          'session-123',
        ) as any;

        expect(response.result.tools).toHaveLength(1);
        expect(response.result.tools[0].name).toBe('local_tool');
      });

      it('returns MCP error when getOrConnect throws UpstreamConnectionError', async () => {
        mockGetUpstreamClient.mockRejectedValueOnce(
          new UpstreamConnectionError('connection refused', 'test-upstream'),
        );

        const response = await (upstreamServer as any).handleOtherRequest(
          { jsonrpc: '2.0', id: '4', method: 'tools/list', params: {} },
          'session-123',
          'upstream-profile',
        ) as any;

        expect(response.error).toBeDefined();
        expect(response.error.code).toBe(-32603);
        expect(response.result).toBeUndefined();
      });

      it('returns UpstreamMalformedResponseError when listTools returns null result', async () => {
        mockListTools.mockResolvedValueOnce(null);

        const response = await (upstreamServer as any).handleOtherRequest(
          { jsonrpc: '2.0', id: '5', method: 'tools/list', params: {} },
          'session-123',
          'upstream-profile',
        ) as any;

        expect(response.error).toBeDefined();
        expect(response.error.code).toBe(-32603);
        expect(response.result).toBeUndefined();
      });

      it('returns UpstreamMalformedResponseError when listTools returns non-array tools field', async () => {
        mockListTools.mockResolvedValueOnce({ tools: { unexpected: true } });

        const response = await (upstreamServer as any).handleOtherRequest(
          { jsonrpc: '2.0', id: '5', method: 'tools/list', params: {} },
          'session-123',
          'upstream-profile',
        ) as any;

        expect(response.error).toBeDefined();
        expect(response.error.code).toBe(-32603);
        expect(response.result).toBeUndefined();
      });

      it('returns UpstreamMalformedResponseError when listTools returns null tools field', async () => {
        // null was previously silently coerced to [] via ??, now correctly detected
        mockListTools.mockResolvedValueOnce({ tools: null });

        const response = await (upstreamServer as any).handleOtherRequest(
          { jsonrpc: '2.0', id: '5', method: 'tools/list', params: {} },
          'session-123',
          'upstream-profile',
        ) as any;

        expect(response.error).toBeDefined();
        expect(response.error.code).toBe(-32603);
        expect(response.result).toBeUndefined();
      });

      it('X-Mcp4-Tools session filter removes blocked tools from upstream tools/list', async () => {
        const toolA = { name: 'tool_a', description: 'Tool A', inputSchema: { type: 'object', properties: {} } };
        const toolB = { name: 'tool_b', description: 'Tool B', inputSchema: { type: 'object', properties: {} } };
        mockListTools.mockResolvedValueOnce({ tools: [toolA, toolB] });
        const filterRequest = parseSessionToolFilterHeader('tool_a');
        (upstreamServer as any).httpTransport.getSessionToolFilterRequest = () => filterRequest;

        const response = await (upstreamServer as any).handleOtherRequest(
          { jsonrpc: '2.0', id: '1', method: 'tools/list', params: {} },
          'session-123',
          'upstream-profile',
        ) as any;

        expect(response.result.tools).toHaveLength(1);
        expect(response.result.tools[0].name).toBe('tool_a');
      });

      it('applies regex predicate X-Mcp4-Tools filter to upstream tools/list', async () => {
        const toolRead = { name: 'read_users', description: 'Read', inputSchema: { type: 'object', properties: {} } };
        const toolWrite = { name: 'write_users', description: 'Write', inputSchema: { type: 'object', properties: {} } };
        mockListTools.mockResolvedValueOnce({ tools: [toolRead, toolWrite] });
        const filterRequest = parseSessionToolFilterHeader('regex:read_.*');
        (upstreamServer as any).httpTransport.getSessionToolFilterRequest = () => filterRequest;

        const response = await (upstreamServer as any).handleOtherRequest(
          { jsonrpc: '2.0', id: '1', method: 'tools/list', params: {} },
          'session-123',
          'upstream-profile',
        ) as any;

        expect(response.result.tools).toHaveLength(1);
        expect(response.result.tools[0].name).toBe('read_users');
      });

      it('enterprise policy hides all upstream tools when modify category is not permitted', async () => {
        const toolA = { name: 'tool_a', description: 'Tool A', inputSchema: { type: 'object', properties: {} } };
        mockListTools.mockResolvedValueOnce({ tools: [toolA] });
        (upstreamServer as any).httpTransport.getSessionEnterpriseAllowedToolCategories = () =>
          new Set(['read', 'list']); // 'modify' not in set

        const response = await (upstreamServer as any).handleOtherRequest(
          { jsonrpc: '2.0', id: '1', method: 'tools/list', params: {} },
          'session-123',
          'upstream-profile',
        ) as any;

        expect(response.result.tools).toHaveLength(0);
      });

      it('emits a warn log when enterprise policy blocks all upstream tools', async () => {
        const mockLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
        const server = new MCPServer(mockLogger as never);
        (server as any).profile = (upstreamServer as any).profile;
        (server as any).httpTransport = {
          ...(upstreamServer as any).httpTransport,
          getSessionEnterpriseAllowedToolCategories: () => new Set(['read', 'list']),
        };
        server.setGetUpstreamClient(mockGetUpstreamClient);

        const toolA = { name: 'tool_a', description: 'Tool A', inputSchema: { type: 'object', properties: {} } };
        mockListTools.mockResolvedValueOnce({ tools: [toolA] });

        await (server as any).handleOtherRequest(
          { jsonrpc: '2.0', id: '1', method: 'tools/list', params: {} },
          'session-123',
          'upstream-profile',
        );

        expect(mockLogger.warn).toHaveBeenCalledWith(
          expect.stringContaining("upstream tools require the 'modify' permission"),
          expect.objectContaining({ blockedCount: 1 }),
        );
      });

      it('enterprise policy passes upstream tools when modify category is permitted', async () => {
        const toolA = { name: 'tool_a', description: 'Tool A', inputSchema: { type: 'object', properties: {} } };
        mockListTools.mockResolvedValueOnce({ tools: [toolA] });
        (upstreamServer as any).httpTransport.getSessionEnterpriseAllowedToolCategories = () =>
          new Set(['read', 'list', 'modify']);

        const response = await (upstreamServer as any).handleOtherRequest(
          { jsonrpc: '2.0', id: '1', method: 'tools/list', params: {} },
          'session-123',
          'upstream-profile',
        ) as any;

        expect(response.result.tools).toHaveLength(1);
        expect(response.result.tools[0].name).toBe('tool_a');
      });
    });

    // -------------------------------------------------------------------------
    describe('tools/call upstream forwarding', () => {
      it('forwards call to upstream client with correct name and arguments', async () => {
        const response = await (upstreamServer as any).handleToolCall(
          {
            jsonrpc: '2.0',
            id: '1',
            method: 'tools/call',
            params: { name: 'safe_tool', arguments: { key: 'value' } },
          },
          'session-123',
          'upstream-profile',
        ) as any;

        expect(mockCallTool).toHaveBeenCalledWith({ name: 'safe_tool', arguments: { key: 'value' } });
        expect(response.result).toBeDefined();
        expect(response.error).toBeUndefined();
      });

      it('passes timeout_ms as RequestOptions.timeout to callTool when configured', async () => {
        const providerWithTimeout = { ...upstreamProvider, timeout_ms: 7500 };
        (upstreamServer as any).profile = {
          ...(upstreamServer as any).profile,
          upstream_mcp: providerWithTimeout,
        };
        (upstreamServer as any).httpTransport.getUpstreamMcpConfig = () => providerWithTimeout;

        await (upstreamServer as any).handleToolCall(
          {
            jsonrpc: '2.0',
            id: '1t',
            method: 'tools/call',
            params: { name: 'safe_tool', arguments: {} },
          },
          'session-123',
          'upstream-profile',
        );

        expect(mockCallTool).toHaveBeenCalledWith(
          { name: 'safe_tool', arguments: {} },
          undefined,
          { timeout: 7500 },
        );
      });

      it('forwards isError:true results as-is without converting to JSON-RPC error', async () => {
        mockCallTool.mockResolvedValueOnce({
          isError: true,
          content: [{ type: 'text', text: 'Tool-level error message' }],
        });

        const response = await (upstreamServer as any).handleToolCall(
          {
            jsonrpc: '2.0',
            id: '2',
            method: 'tools/call',
            params: { name: 'safe_tool', arguments: {} },
          },
          'session-123',
          'upstream-profile',
        ) as any;

        // isError:true is a valid tool result, must appear in result not error field
        expect(response.result).toBeDefined();
        expect(response.result.isError).toBe(true);
        expect(response.error).toBeUndefined();
      });

      it('maps UpstreamConnectionError to InternalError (-32603)', async () => {
        mockCallTool.mockRejectedValueOnce(
          new UpstreamConnectionError('ECONNREFUSED', 'test-upstream'),
        );

        const response = await (upstreamServer as any).handleToolCall(
          {
            jsonrpc: '2.0',
            id: '3',
            method: 'tools/call',
            params: { name: 'safe_tool', arguments: {} },
          },
          'session-123',
          'upstream-profile',
        ) as any;

        expect(response.error).toBeDefined();
        expect(response.error.code).toBe(-32603);
        expect(response.error.message).toMatch(/Upstream connection failed/);
      });

      it('maps UpstreamTimeoutError to code -32001', async () => {
        mockCallTool.mockRejectedValueOnce(
          new UpstreamTimeoutError('test-upstream', 5000),
        );

        const response = await (upstreamServer as any).handleToolCall(
          {
            jsonrpc: '2.0',
            id: '4',
            method: 'tools/call',
            params: { name: 'safe_tool', arguments: {} },
          },
          'session-123',
          'upstream-profile',
        ) as any;

        expect(response.error).toBeDefined();
        expect(response.error.code).toBe(-32001);
        expect(response.error.message).toMatch(/Upstream request timed out/);
      });

      it('maps UpstreamAuthError to InvalidRequest (-32600)', async () => {
        mockCallTool.mockRejectedValueOnce(
          new UpstreamAuthError('test-upstream'),
        );

        const response = await (upstreamServer as any).handleToolCall(
          {
            jsonrpc: '2.0',
            id: '5',
            method: 'tools/call',
            params: { name: 'safe_tool', arguments: {} },
          },
          'session-123',
          'upstream-profile',
        ) as any;

        expect(response.error).toBeDefined();
        expect(response.error.code).toBe(-32600);
      });

      it('maps unknown error type to InternalError with generic message (fallback case)', async () => {
        // A plain Error that is not one of the 4 typed upstream errors
        mockCallTool.mockRejectedValueOnce(new Error('unexpected internal failure'));

        const response = await (upstreamServer as any).handleToolCall(
          {
            jsonrpc: '2.0',
            id: '6',
            method: 'tools/call',
            params: { name: 'safe_tool', arguments: {} },
          },
          'session-123',
          'upstream-profile',
        ) as any;

        expect(response.error).toBeDefined();
        expect(response.error.code).toBe(-32603);
        expect(response.error.message).toBe('Upstream error');
      });

      it('preserves SDK McpError code instead of collapsing to InternalError', async () => {
        // SDK throws McpError (e.g. RequestTimeout) from client.callTool — the mapper must
        // forward the original code so callers can apply correct retry/re-auth logic.
        mockCallTool.mockRejectedValueOnce(
          new McpError(ErrorCode.RequestTimeout, 'upstream call timed out'),
        );

        const response = await (upstreamServer as any).handleToolCall(
          {
            jsonrpc: '2.0',
            id: '7',
            method: 'tools/call',
            params: { name: 'safe_tool', arguments: {} },
          },
          'session-123',
          'upstream-profile',
        ) as any;

        expect(response.error).toBeDefined();
        expect(response.error.code).toBe(ErrorCode.RequestTimeout);
        expect(response.error.message).toBe('Upstream error');
      });

      it('error data includes correlationId and providerName but message does not contain provider name', async () => {
        mockCallTool.mockRejectedValueOnce(
          new UpstreamConnectionError('ECONNREFUSED', 'test-upstream'),
        );

        const response = await (upstreamServer as any).handleToolCall(
          {
            jsonrpc: '2.0',
            id: '6',
            method: 'tools/call',
            params: { name: 'safe_tool', arguments: {} },
          },
          'session-123',
          'upstream-profile',
        ) as any;

        expect(response.error.data.providerName).toBe('test-upstream');
        expect(response.error.data.correlationId).toBeDefined();
        // Provider name must NOT appear in the client-facing message string
        expect(response.error.message).not.toContain('test-upstream');
      });
    });

    // -------------------------------------------------------------------------
    describe('upstream error logging', () => {
      let fakeLogger: { debug: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };

      beforeEach(() => {
        fakeLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
        (upstreamServer as any).logger = fakeLogger;
      });

      it('tools/list: UpstreamConnectionError → logger.error with correlationId, response -32603', async () => {
        const err = new UpstreamConnectionError('ECONNREFUSED', 'test-upstream');
        mockGetUpstreamClient.mockRejectedValueOnce(err);

        const response = await (upstreamServer as any).handleUpstreamToolsList(
          { jsonrpc: '2.0', id: '1', method: 'tools/list', params: {} },
          'session-123',
          'upstream-profile',
          upstreamProvider,
        ) as any;

        expect(response.error.code).toBe(-32603);
        expect(fakeLogger.error).toHaveBeenCalledWith(
          'Upstream tools/list failed',
          expect.any(Error),
          expect.objectContaining({
            provider: 'test-upstream',
            sessionId: 'session-123',
            upstreamErrorType: 'UpstreamConnectionError',
            correlationId: expect.any(String),
          }),
        );
      });

      it('tools/call: UpstreamTimeoutError → logger.error with correlationId, response -32001', async () => {
        const err = new UpstreamTimeoutError('test-upstream', 5000);
        mockCallTool.mockRejectedValueOnce(err);

        const response = await (upstreamServer as any).handleUpstreamToolCall(
          { jsonrpc: '2.0', id: '2', method: 'tools/call', params: { name: 'safe_tool', arguments: {} } },
          'session-123',
          'upstream-profile',
          upstreamProvider,
          Date.now(),
        ) as any;

        expect(response.error.code).toBe(-32001);
        expect(fakeLogger.error).toHaveBeenCalledWith(
          'Upstream tools/call failed',
          expect.any(Error),
          expect.objectContaining({
            provider: 'test-upstream',
            toolName: 'safe_tool',
            upstreamErrorType: 'UpstreamTimeoutError',
            correlationId: expect.any(String),
          }),
        );
      });

      it('tools/call: UpstreamMalformedResponseError → logger.error, response -32603', async () => {
        mockCallTool.mockRejectedValueOnce(
          new UpstreamMalformedResponseError('test-upstream', 'bad json'),
        );

        const response = await (upstreamServer as any).handleUpstreamToolCall(
          { jsonrpc: '2.0', id: '3', method: 'tools/call', params: { name: 'safe_tool', arguments: {} } },
          'session-123',
          'upstream-profile',
          upstreamProvider,
          Date.now(),
        ) as any;

        expect(response.error.code).toBe(-32603);
        expect(fakeLogger.error).toHaveBeenCalledWith(
          'Upstream tools/call failed',
          expect.any(Error),
          expect.objectContaining({ upstreamErrorType: 'UpstreamMalformedResponseError' }),
        );
      });

      it('tools/list: internal UpstreamMalformedResponseError (null listTools result) → logger.error', async () => {
        mockListTools.mockResolvedValueOnce(null);

        const response = await (upstreamServer as any).handleUpstreamToolsList(
          { jsonrpc: '2.0', id: '4', method: 'tools/list', params: {} },
          'session-123',
          'upstream-profile',
          upstreamProvider,
        ) as any;

        expect(response.error.code).toBe(-32603);
        expect(fakeLogger.error).toHaveBeenCalledWith(
          'Upstream tools/list failed',
          expect.any(Error),
          expect.objectContaining({ upstreamErrorType: 'UpstreamMalformedResponseError' }),
        );
      });

      it('tools/call: UpstreamAuthError → logger.warn (not error), response -32600', async () => {
        mockCallTool.mockRejectedValueOnce(new UpstreamAuthError('test-upstream'));

        const response = await (upstreamServer as any).handleUpstreamToolCall(
          { jsonrpc: '2.0', id: '5', method: 'tools/call', params: { name: 'safe_tool', arguments: {} } },
          'session-123',
          'upstream-profile',
          upstreamProvider,
          Date.now(),
        ) as any;

        expect(response.error.code).toBe(-32600);
        expect(fakeLogger.error).not.toHaveBeenCalled();
        expect(fakeLogger.warn).toHaveBeenCalledWith(
          'Upstream tools/call failed',
          expect.objectContaining({ upstreamErrorType: 'UpstreamAuthError' }),
        );
      });

      it('tools/list: UpstreamAuthError → logger.warn (not error), response -32600', async () => {
        mockGetUpstreamClient.mockRejectedValueOnce(new UpstreamAuthError('test-upstream'));

        const response = await (upstreamServer as any).handleUpstreamToolsList(
          { jsonrpc: '2.0', id: '6', method: 'tools/list', params: {} },
          'session-123',
          'upstream-profile',
          upstreamProvider,
        ) as any;

        expect(response.error.code).toBe(-32600);
        expect(fakeLogger.error).not.toHaveBeenCalled();
        expect(fakeLogger.warn).toHaveBeenCalledWith(
          'Upstream tools/list failed',
          expect.objectContaining({ upstreamErrorType: 'UpstreamAuthError' }),
        );
      });

      it('tools/call: unexpected error type → logger.warn (not error)', async () => {
        mockCallTool.mockRejectedValueOnce(new Error('unexpected proxy failure'));

        const response = await (upstreamServer as any).handleUpstreamToolCall(
          { jsonrpc: '2.0', id: '7', method: 'tools/call', params: { name: 'safe_tool', arguments: {} } },
          'session-123',
          'upstream-profile',
          upstreamProvider,
          Date.now(),
        ) as any;

        expect(response.error.code).toBe(-32603);
        expect(fakeLogger.error).not.toHaveBeenCalled();
        expect(fakeLogger.warn).toHaveBeenCalledWith(
          'Upstream tools/call failed',
          expect.objectContaining({ upstreamErrorType: 'Error' }),
        );
      });

      it('tools/list: unexpected error type → logger.warn (not error)', async () => {
        mockGetUpstreamClient.mockRejectedValueOnce(new Error('unexpected'));

        const response = await (upstreamServer as any).handleUpstreamToolsList(
          { jsonrpc: '2.0', id: '8', method: 'tools/list', params: {} },
          'session-123',
          'upstream-profile',
          upstreamProvider,
        ) as any;

        expect(response.error.code).toBe(-32603);
        expect(fakeLogger.error).not.toHaveBeenCalled();
        expect(fakeLogger.warn).toHaveBeenCalledWith(
          'Upstream tools/list failed',
          expect.objectContaining({ upstreamErrorType: 'Error' }),
        );
      });
    });

    // -------------------------------------------------------------------------
    describe('sessionId guard', () => {
      it('handleUpstreamToolsList throws UpstreamConnectionError when sessionId is undefined', async () => {
        await expect(
          (upstreamServer as any).handleUpstreamToolsList(
            { jsonrpc: '2.0', id: '1', method: 'tools/list', params: {} },
            undefined, // no sessionId
            'upstream-profile',
            upstreamProvider,
          ),
        ).rejects.toBeInstanceOf(UpstreamConnectionError);
      });

      it('handleUpstreamToolCall throws UpstreamConnectionError when sessionId is undefined', async () => {
        await expect(
          (upstreamServer as any).handleUpstreamToolCall(
            {
              jsonrpc: '2.0',
              id: '1',
              method: 'tools/call',
              params: { name: 'safe_tool', arguments: {} },
            },
            undefined, // no sessionId
            'upstream-profile',
            upstreamProvider,
          ),
        ).rejects.toBeInstanceOf(UpstreamConnectionError);
      });
    });

    // -------------------------------------------------------------------------
    describe('capabilities', () => {
      it('advertises tools.listChanged:true when upstream_mcp configured', async () => {
        const response = await (upstreamServer as any).handleInitialize(
          { jsonrpc: '2.0', id: '1', method: 'initialize', params: {} },
          'session-123',
          'upstream-profile',
        ) as any;

        expect(response.result.capabilities.tools.listChanged).toBe(true);
      });

      it('logs warn when upstream_mcp configured but no upstream client wired (stdio path)', async () => {
        const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
        const stdioServer = new MCPServer(logger as any);
        (stdioServer as any).profile = {
          profile_name: 'stdio-profile',
          description: 'Stdio with upstream_mcp',
          tools: [],
          upstream_mcp: { name: 'my-upstream', transport: { type: 'http-streamable', url: 'https://upstream.example.com/mcp' } },
        };
        // No httpTransport, no getUpstreamClientFn - stdio mode

        // Trigger tools/list which calls getUpstreamMcpConfig
        await (stdioServer as any).handleOtherRequest(
          { jsonrpc: '2.0', id: '1', method: 'tools/list', params: {} },
          undefined,
          'stdio-profile',
        );

        expect(logger.warn).toHaveBeenCalledWith(
          'upstream_mcp configured but no upstream client wired - upstream_mcp requires HTTP transport',
          expect.objectContaining({ profileId: expect.anything() }),
        );
      });

      it('getUpstreamToken returns undefined when no httpTransport (stdio path with client fn)', async () => {
        const stdioProvider = { name: 'stdio-upstream', transport: { type: 'http-streamable', url: 'https://upstream.example.com/mcp' } };
        const mockListFn = vi.fn().mockResolvedValue({ tools: [] });
        const mockClientFn = vi.fn().mockResolvedValue({ listTools: mockListFn, callTool: vi.fn() });

        const stdioServer = new MCPServer();
        (stdioServer as any).profile = {
          profile_name: 'no-transport-profile',
          description: 'No transport',
          tools: [],
          upstream_mcp: stdioProvider,
        };
        // No httpTransport - token will come back undefined from getUpstreamToken
        stdioServer.setGetUpstreamClient(mockClientFn);

        const response = await (stdioServer as any).handleOtherRequest(
          { jsonrpc: '2.0', id: '1', method: 'tools/list', params: {} },
          'session-abc',
          'no-transport-profile',
        ) as any;

        // Should still succeed and call mockClientFn with undefined token
        expect(mockClientFn).toHaveBeenCalledWith('session-abc', stdioProvider, undefined);
        expect(response.result).toBeDefined();
      });

      it('does not advertise tools.listChanged for non-upstream profiles', async () => {
        const localServer = new MCPServer();
        (localServer as any).profile = {
          profile_name: 'local-profile',
          description: 'Local',
          tools: [],
        };
        (localServer as any).httpTransport = null;

        const response = await (localServer as any).handleInitialize(
          { jsonrpc: '2.0', id: '1', method: 'initialize', params: {} },
          undefined,
          undefined,
        ) as any;

        expect(response.result.capabilities.tools.listChanged).toBeUndefined();
      });
    });

    // -------------------------------------------------------------------------
    describe('getUpstreamMcpConfig HTTP fallback (fix: issue #1)', () => {
      it('does not fall back to profile.upstream_mcp when httpTransport.getUpstreamMcpConfig returns undefined', async () => {
        const server = new MCPServer();
        const provider = { name: 'fallback-provider', transport: { type: 'http-streamable', url: 'https://upstream.example.com/mcp' } };
        (server as any).profile = {
          profile_name: 'fallback-profile',
          description: 'Profile with upstream_mcp not reflected in httpTransport context',
          tools: [],
          upstream_mcp: provider,
        };
        // httpTransport returns undefined for getUpstreamMcpConfig (single-profile HTTP startup case)
        (server as any).httpTransport = {
          hasOAuthProvider: () => false,
          getUpstreamMcpConfig: (_profileId: string) => undefined,
          getSessionToken: () => undefined,
          getSessionTenantContext: () => undefined,
          getMetricsCollector: () => null,
          getSessionFiltering: () => undefined,
          getSessionToolFilter: () => undefined,
          getSessionEnterpriseAllowedToolCategories: () => undefined,
        };

        const mockClientFn = vi.fn().mockResolvedValue({ listTools: vi.fn().mockResolvedValue({ tools: [] }), callTool: vi.fn() });
        server.setGetUpstreamClient(mockClientFn);

        const response = await (server as any).handleOtherRequest(
          { jsonrpc: '2.0', id: '1', method: 'tools/list', params: {} },
          'session-1',
          'fallback-profile',
        ) as any;

        // Fail closed: no upstream routing when the transport context does not own the profile.
        expect(mockClientFn).not.toHaveBeenCalled();
        expect(response.result).toBeDefined();
        expect(response.result.tools).toEqual([]);
      });

      it('logs warn when upstream config lookup misses for profileId not in transport context', async () => {
        const logger = new JsonLogger();
        const warnSpy = vi.spyOn(logger, 'warn');

        const server = new MCPServer(logger);
        const provider = { name: 'profile-a-provider', transport: { type: 'http-streamable', url: 'https://a.example.com/mcp' } };
        (server as any).profile = { profile_name: 'profile-a', tools: [], upstream_mcp: provider };
        (server as any).httpTransport = {
          hasOAuthProvider: () => false,
          getUpstreamMcpConfig: (_profileId: string) => undefined,
          getSessionToken: () => undefined,
          getSessionTenantContext: () => undefined,
          getMetricsCollector: () => null,
          getSessionFiltering: () => undefined,
          getSessionToolFilter: () => undefined,
          getSessionEnterpriseAllowedToolCategories: () => undefined,
        };

        const mockClientFn = vi.fn().mockResolvedValue({ listTools: vi.fn().mockResolvedValue({ tools: [] }), callTool: vi.fn() });
        server.setGetUpstreamClient(mockClientFn);

        await (server as any).handleOtherRequest(
          { jsonrpc: '2.0', id: '1', method: 'tools/list', params: {} },
          'session-1',
          'profile-b',
        );

        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('refusing to fall back to this.profile.upstream_mcp'),
          expect.objectContaining({ profileId: 'profile-b' }),
        );
        expect(mockClientFn).not.toHaveBeenCalled();
      });
    });

    // -------------------------------------------------------------------------
    describe('policy enforcement before upstream forwarding (fix: issue #4 + #5)', () => {
      it('tool filter blocks upstream tool call', async () => {
        const filterRequest = parseSessionToolFilterHeader('allowed_tool');
        (upstreamServer as any).httpTransport.getSessionToolFilterRequest = () => filterRequest;

        const response = await (upstreamServer as any).handleToolCall(
          { jsonrpc: '2.0', id: '1', method: 'tools/call', params: { name: 'safe_tool', arguments: {} } },
          'session-123',
          'upstream-profile',
        ) as any;

        expect(response.error).toBeDefined();
        expect(response.error.code).toBe(-32002);
        expect(response.error.message).toMatch(/X-Mcp4-Tools filter/);
        expect(mockCallTool).not.toHaveBeenCalled();
      });

      it('allows upstream tools/call when tool name matches X-Mcp4-Tools exact filter', async () => {
        const filterRequest = parseSessionToolFilterHeader('safe_tool');
        (upstreamServer as any).httpTransport.getSessionToolFilterRequest = () => filterRequest;

        const response = await (upstreamServer as any).handleToolCall(
          { jsonrpc: '2.0', id: '1', method: 'tools/call', params: { name: 'safe_tool', arguments: {} } },
          'session-123',
          'upstream-profile',
        ) as any;

        expect(response.result).toBeDefined();
        expect(mockCallTool).toHaveBeenCalled();
      });

      it('blocks upstream tools/call when tool name does not match X-Mcp4-Tools regex filter', async () => {
        const filterRequest = parseSessionToolFilterHeader('regex:read_.*');
        (upstreamServer as any).httpTransport.getSessionToolFilterRequest = () => filterRequest;

        const response = await (upstreamServer as any).handleToolCall(
          { jsonrpc: '2.0', id: '1', method: 'tools/call', params: { name: 'safe_tool', arguments: {} } },
          'session-123',
          'upstream-profile',
        ) as any;

        expect(response.error).toBeDefined();
        expect(response.error.code).toBe(-32002);
        expect(response.error.message).toMatch(/X-Mcp4-Tools filter/);
        expect(mockCallTool).not.toHaveBeenCalled();
      });

      it('enterprise policy blocks upstream tool call (default modify category)', async () => {
        (upstreamServer as any).httpTransport.getSessionEnterpriseAllowedToolCategories = () =>
          new Set(['read', 'list']); // 'modify' not allowed

        const response = await (upstreamServer as any).handleToolCall(
          { jsonrpc: '2.0', id: '1', method: 'tools/call', params: { name: 'safe_tool', arguments: {} } },
          'session-123',
          'upstream-profile',
        ) as any;

        expect(response.error).toBeDefined();
        expect(response.error.code).toBe(-32002);
        expect(response.error.message).toMatch(/enterprise authorization policy/);
        expect(mockCallTool).not.toHaveBeenCalled();
      });

      it('enterprise policy allows upstream tool call when modify is permitted', async () => {
        (upstreamServer as any).httpTransport.getSessionEnterpriseAllowedToolCategories = () =>
          new Set(['read', 'list', 'modify']);

        const response = await (upstreamServer as any).handleToolCall(
          { jsonrpc: '2.0', id: '1', method: 'tools/call', params: { name: 'safe_tool', arguments: {} } },
          'session-123',
          'upstream-profile',
        ) as any;

        expect(response.result).toBeDefined();
        expect(mockCallTool).toHaveBeenCalled();
      });

      it('rejects upstream tool call with non-string tool name without throwing (P2)', async () => {
        // A malformed request sends name: 123 (number). The handler must return -32002
        // rather than throwing TypeError from toolName.slice() on a non-string value.
        const response = await (upstreamServer as any).handleToolCall(
          { jsonrpc: '2.0', id: '1', method: 'tools/call', params: { name: 123, arguments: {} } },
          'session-123',
          'upstream-profile',
        ) as any;

        expect(response.error).toBeDefined();
        expect(response.error.code).toBe(-32002);
        expect(response.error.message).toContain('must be a string');
        expect(mockCallTool).not.toHaveBeenCalled();
      });

      it('rejects upstream tool call with invalid tool name (prevents sanitizer bypass)', async () => {
        const response = await (upstreamServer as any).handleToolCall(
          { jsonrpc: '2.0', id: '1', method: 'tools/call', params: { name: 'has <script> injection', arguments: {} } },
          'session-123',
          'upstream-profile',
        ) as any;

        expect(response.error).toBeDefined();
        expect(response.error.code).toBe(-32002);
        expect(response.error.message).toMatch(/not allowed/);
        expect(mockCallTool).not.toHaveBeenCalled();
      });

      it('rejects upstream tool call with tool name exceeding max length', async () => {
        const longName = 'a'.repeat(256);
        const response = await (upstreamServer as any).handleToolCall(
          { jsonrpc: '2.0', id: '1', method: 'tools/call', params: { name: longName, arguments: {} } },
          'session-123',
          'upstream-profile',
        ) as any;

        expect(response.error).toBeDefined();
        expect(response.error.code).toBe(-32002);
        expect(mockCallTool).not.toHaveBeenCalled();
      });
    });

    // -------------------------------------------------------------------------
    describe('sanitized tool set enforcement (fix: sanitization bypass via tools/call)', () => {
      it('blocks tool call for tool dropped by sanitization (bad description) after tools/list was called', async () => {
        // tools/list returns a tool with a forbidden description - sanitizeToolList drops it
        const toolWithBadDesc = {
          name: 'dangerous_tool',
          description: 'This has <script>injection</script>',
          inputSchema: { type: 'object', properties: {} },
        };
        mockListTools.mockResolvedValueOnce({ tools: [toolWithBadDesc] });

        // Call tools/list to populate the sanitized cache (dangerous_tool is dropped)
        await (upstreamServer as any).handleOtherRequest(
          { jsonrpc: '2.0', id: '1', method: 'tools/list', params: {} },
          'session-sanitize',
          'upstream-profile',
        );

        // Attempt to call the dropped tool directly via tools/call
        const response = await (upstreamServer as any).handleToolCall(
          { jsonrpc: '2.0', id: '2', method: 'tools/call', params: { name: 'dangerous_tool', arguments: {} } },
          'session-sanitize',
          'upstream-profile',
        ) as any;

        expect(response.error).toBeDefined();
        expect(response.error.code).toBe(-32002);
        expect(response.error.message).toMatch(/sanitized tool set/);
        expect(mockCallTool).not.toHaveBeenCalled();
      });

      it('blocks tool call for tool dropped by sanitization (bad inputSchema) after tools/list was called', async () => {
        const toolWithBadSchema = {
          name: 'schema_tool',
          description: 'Fine description',
          inputSchema: { type: 'object', properties: { field: { description: 'contains <injection>' } } },
        };
        mockListTools.mockResolvedValueOnce({ tools: [toolWithBadSchema] });

        await (upstreamServer as any).handleOtherRequest(
          { jsonrpc: '2.0', id: '1', method: 'tools/list', params: {} },
          'session-schema',
          'upstream-profile',
        );

        const response = await (upstreamServer as any).handleToolCall(
          { jsonrpc: '2.0', id: '2', method: 'tools/call', params: { name: 'schema_tool', arguments: {} } },
          'session-schema',
          'upstream-profile',
        ) as any;

        expect(response.error).toBeDefined();
        expect(response.error.code).toBe(-32002);
        expect(mockCallTool).not.toHaveBeenCalled();
      });

      it('allows tool call for tool that passed sanitization after tools/list was called', async () => {
        // tools/list returns safe_tool which passes sanitization
        await (upstreamServer as any).handleOtherRequest(
          { jsonrpc: '2.0', id: '1', method: 'tools/list', params: {} },
          'session-allow',
          'upstream-profile',
        );

        const response = await (upstreamServer as any).handleToolCall(
          { jsonrpc: '2.0', id: '2', method: 'tools/call', params: { name: 'safe_tool', arguments: {} } },
          'session-allow',
          'upstream-profile',
        ) as any;

        expect(response.result).toBeDefined();
        expect(mockCallTool).toHaveBeenCalledWith({ name: 'safe_tool', arguments: {} });
      });

      it('skips sanitized set check when tools/list was never called for the session', async () => {
        // No tools/list call - cache is empty - should fall through to upstream call
        const response = await (upstreamServer as any).handleToolCall(
          { jsonrpc: '2.0', id: '1', method: 'tools/call', params: { name: 'safe_tool', arguments: {} } },
          'session-no-list',
          'upstream-profile',
        ) as any;

        // No error from sanitized set check - normal upstream call proceeds
        expect(response.result).toBeDefined();
        expect(mockCallTool).toHaveBeenCalledWith({ name: 'safe_tool', arguments: {} });
      });

      it('tools/call before tools/list does not leak tool description or schema in response (cold-cache is not an injection vector)', async () => {
        // A tool with a bad description that would be dropped by sanitizeToolList.
        // The client calls tools/call directly, bypassing tools/list entirely.
        // Security model: tools/call never returns description/inputSchema back to the
        // caller - injection risk exists only on the tools/list display path.
        const toolResult = { content: [{ type: 'text', text: 'result' }] };
        mockCallTool.mockResolvedValueOnce(toolResult);

        const response = await (upstreamServer as any).handleToolCall(
          { jsonrpc: '2.0', id: '1', method: 'tools/call', params: { name: 'dangerous_tool', arguments: {} } },
          'session-cold-cache',
          'upstream-profile',
        ) as any;

        // Call succeeds - cold cache skip is intentional, not a security gap
        expect(response.result).toBeDefined();
        expect(mockCallTool).toHaveBeenCalledWith({ name: 'dangerous_tool', arguments: {} });

        // Response contains only call result - no description, no inputSchema
        const responseText = JSON.stringify(response);
        expect(responseText).not.toContain('description');
        expect(responseText).not.toContain('inputSchema');
        expect(responseText).not.toContain('<script>');
      });

      it('cleans up sanitized cache on session destruction so gate no longer blocks', async () => {
        const toolWithBadDesc = {
          name: 'dangerous_tool',
          description: 'This has <script>injection</script>',
          inputSchema: { type: 'object', properties: {} },
        };
        mockListTools.mockResolvedValueOnce({ tools: [toolWithBadDesc] });

        // Populate cache (dangerous_tool dropped by sanitization)
        await (upstreamServer as any).handleOtherRequest(
          { jsonrpc: '2.0', id: '1', method: 'tools/list', params: {} },
          'session-cleanup',
          'upstream-profile',
        );

        // Gate is active - dangerous_tool is blocked
        const blocked = await (upstreamServer as any).handleToolCall(
          { jsonrpc: '2.0', id: '2', method: 'tools/call', params: { name: 'dangerous_tool', arguments: {} } },
          'session-cleanup',
          'upstream-profile',
        ) as any;
        expect(blocked.error?.code).toBe(-32002);
        expect(mockCallTool).not.toHaveBeenCalled();

        // Simulate session destruction
        (upstreamServer as any).httpClientFactory = { cleanupSessionClient: vi.fn().mockReturnValue(true) };
        (upstreamServer as any).cleanupSessionClient('upstream-profile', 'session-cleanup');

        // After cleanup, cache is cleared - gate is skipped, call proceeds
        const allowed = await (upstreamServer as any).handleToolCall(
          { jsonrpc: '2.0', id: '3', method: 'tools/call', params: { name: 'dangerous_tool', arguments: {} } },
          'session-cleanup',
          'upstream-profile',
        ) as any;
        expect(allowed.result).toBeDefined();
        expect(mockCallTool).toHaveBeenCalledWith({ name: 'dangerous_tool', arguments: {} });
      });

      it('overwrites cached tool set when tools/list is called again for the same session+provider', async () => {
        const toolA = { name: 'tool_a', description: 'First tool', inputSchema: { type: 'object', properties: {} } };
        const toolB = { name: 'tool_b', description: 'Second tool', inputSchema: { type: 'object', properties: {} } };

        // First tools/list - only tool_a
        mockListTools.mockResolvedValueOnce({ tools: [toolA] });
        await (upstreamServer as any).handleOtherRequest(
          { jsonrpc: '2.0', id: '1', method: 'tools/list', params: {} },
          'session-overwrite',
          'upstream-profile',
        );

        // tool_b is blocked (not in cached set)
        const blockToolB = await (upstreamServer as any).handleToolCall(
          { jsonrpc: '2.0', id: '2', method: 'tools/call', params: { name: 'tool_b', arguments: {} } },
          'session-overwrite',
          'upstream-profile',
        ) as any;
        expect(blockToolB.error?.code).toBe(-32002);

        // Second tools/list - only tool_b (tool_a is gone)
        mockListTools.mockResolvedValueOnce({ tools: [toolB] });
        await (upstreamServer as any).handleOtherRequest(
          { jsonrpc: '2.0', id: '3', method: 'tools/list', params: {} },
          'session-overwrite',
          'upstream-profile',
        );

        // tool_b is now allowed
        const allowToolB = await (upstreamServer as any).handleToolCall(
          { jsonrpc: '2.0', id: '4', method: 'tools/call', params: { name: 'tool_b', arguments: {} } },
          'session-overwrite',
          'upstream-profile',
        ) as any;
        expect(allowToolB.result).toBeDefined();

        // tool_a is blocked - cache was overwritten, not accumulated
        const blockToolA = await (upstreamServer as any).handleToolCall(
          { jsonrpc: '2.0', id: '5', method: 'tools/call', params: { name: 'tool_a', arguments: {} } },
          'session-overwrite',
          'upstream-profile',
        ) as any;
        expect(blockToolA.error?.code).toBe(-32002);
      });

      it('invalidateUpstreamToolCache clears provider cache so newly added tool is not blocked', async () => {
        const toolA = { name: 'tool_a', description: 'Existing tool', inputSchema: { type: 'object', properties: {} } };
        const providerName = (upstreamServer as any).profile.upstream_mcp.name as string;

        // Populate cache with only tool_a
        mockListTools.mockResolvedValueOnce({ tools: [toolA] });
        await (upstreamServer as any).handleOtherRequest(
          { jsonrpc: '2.0', id: '1', method: 'tools/list', params: {} },
          'session-invalidate',
          'upstream-profile',
        );

        // tool_b not in cache → blocked
        const blocked = await (upstreamServer as any).handleToolCall(
          { jsonrpc: '2.0', id: '2', method: 'tools/call', params: { name: 'tool_b', arguments: {} } },
          'session-invalidate',
          'upstream-profile',
        ) as any;
        expect(blocked.error?.code).toBe(-32002);

        // Invalidate cache (simulates tools/list_changed hook)
        (upstreamServer as any).invalidateUpstreamToolCache('session-invalidate', providerName);

        // After invalidation, cold-cache path: gate skipped, call proceeds
        const allowed = await (upstreamServer as any).handleToolCall(
          { jsonrpc: '2.0', id: '3', method: 'tools/call', params: { name: 'tool_b', arguments: {} } },
          'session-invalidate',
          'upstream-profile',
        ) as any;
        expect(allowed.result).toBeDefined();
        expect(mockCallTool).toHaveBeenCalledWith({ name: 'tool_b', arguments: {} });
      });

      it('invalidateUpstreamToolCache is a no-op for unknown session', () => {
        expect(() => {
          (upstreamServer as any).invalidateUpstreamToolCache('no-such-session', 'no-such-provider');
        }).not.toThrow();
      });
    });

    // -------------------------------------------------------------------------
    describe('upstream provider tool policy (allow/deny lists)', () => {
      it('blocks tool call denied by provider deny list', async () => {
        (upstreamServer as any).profile.upstream_mcp = {
          ...upstreamServer['profile'].upstream_mcp,
          tools: { deny: ['safe_tool'] },
        };
        (upstreamServer as any).httpTransport.getUpstreamMcpConfig = () =>
          (upstreamServer as any).profile.upstream_mcp;

        const response = await (upstreamServer as any).handleToolCall(
          { jsonrpc: '2.0', id: '1', method: 'tools/call', params: { name: 'safe_tool', arguments: {} } },
          'session-123',
          'upstream-profile',
        ) as any;

        expect(response.error).toBeDefined();
        expect(response.error.code).toBe(-32002);
        expect(response.error.message).toMatch(/upstream provider tool policy/);
        expect(mockCallTool).not.toHaveBeenCalled();
      });

      it('blocks tool call not in provider allow list', async () => {
        (upstreamServer as any).profile.upstream_mcp = {
          ...upstreamServer['profile'].upstream_mcp,
          tools: { allow: ['other_tool'] },
        };
        (upstreamServer as any).httpTransport.getUpstreamMcpConfig = () =>
          (upstreamServer as any).profile.upstream_mcp;

        const response = await (upstreamServer as any).handleToolCall(
          { jsonrpc: '2.0', id: '1', method: 'tools/call', params: { name: 'safe_tool', arguments: {} } },
          'session-123',
          'upstream-profile',
        ) as any;

        expect(response.error).toBeDefined();
        expect(response.error.code).toBe(-32002);
        expect(response.error.message).toMatch(/upstream provider tool policy/);
        expect(mockCallTool).not.toHaveBeenCalled();
      });

      it('allows tool call that passes provider allow list', async () => {
        (upstreamServer as any).profile.upstream_mcp = {
          ...upstreamServer['profile'].upstream_mcp,
          tools: { allow: ['safe_tool'] },
        };
        (upstreamServer as any).httpTransport.getUpstreamMcpConfig = () =>
          (upstreamServer as any).profile.upstream_mcp;

        const response = await (upstreamServer as any).handleToolCall(
          { jsonrpc: '2.0', id: '1', method: 'tools/call', params: { name: 'safe_tool', arguments: {} } },
          'session-123',
          'upstream-profile',
        ) as any;

        expect(response.result).toBeDefined();
        expect(mockCallTool).toHaveBeenCalledWith({ name: 'safe_tool', arguments: {} });
      });

      it('blocks tool call denied by wildcard deny pattern (cold cache, no prior tools/list)', async () => {
        (upstreamServer as any).profile.upstream_mcp = {
          ...upstreamServer['profile'].upstream_mcp,
          tools: { deny: ['safe_*'] },
        };
        (upstreamServer as any).httpTransport.getUpstreamMcpConfig = () =>
          (upstreamServer as any).profile.upstream_mcp;

        const response = await (upstreamServer as any).handleToolCall(
          { jsonrpc: '2.0', id: '1', method: 'tools/call', params: { name: 'safe_tool', arguments: {} } },
          'session-wildcard-deny',
          'upstream-profile',
        ) as any;

        expect(response.error).toBeDefined();
        expect(response.error.code).toBe(-32002);
        expect(response.error.message).toMatch(/upstream provider tool policy/);
        expect(mockCallTool).not.toHaveBeenCalled();
      });

      it('allows tool call matching wildcard allow pattern (cold cache, no prior tools/list)', async () => {
        (upstreamServer as any).profile.upstream_mcp = {
          ...upstreamServer['profile'].upstream_mcp,
          tools: { allow: ['safe_*'] },
        };
        (upstreamServer as any).httpTransport.getUpstreamMcpConfig = () =>
          (upstreamServer as any).profile.upstream_mcp;

        const response = await (upstreamServer as any).handleToolCall(
          { jsonrpc: '2.0', id: '1', method: 'tools/call', params: { name: 'safe_tool', arguments: {} } },
          'session-wildcard-allow',
          'upstream-profile',
        ) as any;

        expect(response.result).toBeDefined();
        expect(mockCallTool).toHaveBeenCalledWith({ name: 'safe_tool', arguments: {} });
      });

      it('blocks tool call not matching wildcard allow pattern (cold cache, no prior tools/list)', async () => {
        (upstreamServer as any).profile.upstream_mcp = {
          ...upstreamServer['profile'].upstream_mcp,
          tools: { allow: ['github_*'] },
        };
        (upstreamServer as any).httpTransport.getUpstreamMcpConfig = () =>
          (upstreamServer as any).profile.upstream_mcp;

        const response = await (upstreamServer as any).handleToolCall(
          { jsonrpc: '2.0', id: '1', method: 'tools/call', params: { name: 'safe_tool', arguments: {} } },
          'session-wildcard-allow-miss',
          'upstream-profile',
        ) as any;

        expect(response.error).toBeDefined();
        expect(response.error.code).toBe(-32002);
        expect(response.error.message).toMatch(/upstream provider tool policy/);
        expect(mockCallTool).not.toHaveBeenCalled();
      });

      it('filters tools/list by provider allow list', async () => {
        const anotherTool = { name: 'another_tool', description: 'Another', inputSchema: { type: 'object', properties: {} } };
        mockListTools.mockResolvedValue({ tools: [safeTool, anotherTool] });
        (upstreamServer as any).profile.upstream_mcp = {
          ...upstreamServer['profile'].upstream_mcp,
          tools: { allow: ['safe_tool'] },
        };
        (upstreamServer as any).httpTransport.getUpstreamMcpConfig = () =>
          (upstreamServer as any).profile.upstream_mcp;

        const response = await (upstreamServer as any).handleOtherRequest(
          { jsonrpc: '2.0', id: '1', method: 'tools/list', params: {} },
          'session-123',
          'upstream-profile',
        ) as any;

        expect(response.result.tools).toHaveLength(1);
        expect(response.result.tools[0].name).toBe('safe_tool');
      });

      it('filters tools/list by provider deny list', async () => {
        const anotherTool = { name: 'another_tool', description: 'Another', inputSchema: { type: 'object', properties: {} } };
        mockListTools.mockResolvedValue({ tools: [safeTool, anotherTool] });
        (upstreamServer as any).profile.upstream_mcp = {
          ...upstreamServer['profile'].upstream_mcp,
          tools: { deny: ['safe_tool'] },
        };
        (upstreamServer as any).httpTransport.getUpstreamMcpConfig = () =>
          (upstreamServer as any).profile.upstream_mcp;

        const response = await (upstreamServer as any).handleOtherRequest(
          { jsonrpc: '2.0', id: '1', method: 'tools/list', params: {} },
          'session-123',
          'upstream-profile',
        ) as any;

        expect(response.result.tools).toHaveLength(1);
        expect(response.result.tools[0].name).toBe('another_tool');
      });
    });

    // -------------------------------------------------------------------------
    describe('metrics recording for upstream tool calls (P2)', () => {
      function makeMetrics() {
        return { recordToolCall: vi.fn(), recordToolCallError: vi.fn() };
      }

      it('records success metric when upstream tool call succeeds', async () => {
        const metrics = makeMetrics();
        (upstreamServer as any).httpTransport.getMetricsCollector = () => metrics;

        await (upstreamServer as any).handleToolCall(
          { jsonrpc: '2.0', id: '1', method: 'tools/call', params: { name: 'safe_tool', arguments: {} } },
          'session-metrics',
          'upstream-profile',
        );

        expect(metrics.recordToolCall).toHaveBeenCalledWith(
          'safe_tool', 'success', expect.any(Number), expect.objectContaining({ upstreamHost: expect.any(String) }),
        );
        expect(metrics.recordToolCallError).not.toHaveBeenCalled();
      });

      it('records error metric when upstream tool call throws', async () => {
        const metrics = makeMetrics();
        (upstreamServer as any).httpTransport.getMetricsCollector = () => metrics;
        mockCallTool.mockRejectedValueOnce(new Error('upstream down'));

        await (upstreamServer as any).handleToolCall(
          { jsonrpc: '2.0', id: '1', method: 'tools/call', params: { name: 'safe_tool', arguments: {} } },
          'session-metrics-err',
          'upstream-profile',
        );

        expect(metrics.recordToolCall).toHaveBeenCalledWith(
          'safe_tool', 'error', expect.any(Number), expect.objectContaining({ upstreamHost: expect.any(String) }),
        );
        expect(metrics.recordToolCallError).toHaveBeenCalledWith(
          'safe_tool', expect.any(String), expect.objectContaining({ upstreamHost: expect.any(String) }),
        );
      });

      it('skips metric recording when no collector is wired but still emits audit log', async () => {
        (upstreamServer as any).httpTransport.getMetricsCollector = () => null;
        const fakeLogger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
        (upstreamServer as any).logger = fakeLogger;

        const response = await (upstreamServer as any).handleToolCall(
          { jsonrpc: '2.0', id: '1', method: 'tools/call', params: { name: 'safe_tool', arguments: {} } },
          'session-no-metrics',
          'upstream-profile',
        ) as any;

        expect(response.result).toBeDefined();
        // Audit log fires regardless of metrics being disabled (OBS-01 independence guarantee).
        const audits = fakeLogger.info.mock.calls.filter((c: unknown[]) => c[0] === 'audit:tool_call');
        expect(audits.length).toBeGreaterThanOrEqual(1);
        const payload = audits[audits.length - 1][1] as Record<string, unknown>;
        expect(payload.outcome).toBe('success');
        expect(payload.sessionId).toBe('session-no-metrics');
      });

      it('records FilterRejection error metric when X-Mcp4-Tools filter blocks tool', async () => {
        const metrics = makeMetrics();
        (upstreamServer as any).httpTransport.getMetricsCollector = () => metrics;
        (upstreamServer as any).httpTransport.getSessionToolFilterRequest = () =>
          parseSessionToolFilterHeader('other_tool');

        const response = await (upstreamServer as any).handleToolCall(
          { jsonrpc: '2.0', id: '1', method: 'tools/call', params: { name: 'safe_tool', arguments: {} } },
          'session-filter',
          'upstream-profile',
        ) as any;

        expect(response.error).toBeDefined();
        expect(metrics.recordToolCall).toHaveBeenCalledWith(
          'safe_tool', 'rejected', expect.any(Number), expect.any(Object),
        );
        expect(metrics.recordToolCallError).toHaveBeenCalledWith(
          'safe_tool', 'FilterRejection', expect.any(Object),
        );
      });

      it('records PolicyRejection error metric when enterprise policy blocks tool', async () => {
        const metrics = makeMetrics();
        (upstreamServer as any).httpTransport.getMetricsCollector = () => metrics;
        (upstreamServer as any).httpTransport.getSessionEnterpriseTiers = () => ['read'];
        (upstreamServer as any).httpTransport.getSessionEnterpriseAllowedToolCategories = () => new Set(['read']);

        const response = await (upstreamServer as any).handleToolCall(
          { jsonrpc: '2.0', id: '1', method: 'tools/call', params: { name: 'safe_tool', arguments: {} } },
          'session-enterprise',
          'upstream-profile',
        ) as any;

        expect(response.error).toBeDefined();
        expect(metrics.recordToolCall).toHaveBeenCalledWith(
          'safe_tool', 'rejected', expect.any(Number), expect.any(Object),
        );
        expect(metrics.recordToolCallError).toHaveBeenCalledWith(
          'safe_tool', 'PolicyRejection', expect.any(Object),
        );
      });

      it('records InvalidToolName error metric when tool name contains invalid chars', async () => {
        const metrics = makeMetrics();
        (upstreamServer as any).httpTransport.getMetricsCollector = () => metrics;

        const response = await (upstreamServer as any).handleToolCall(
          { jsonrpc: '2.0', id: '1', method: 'tools/call', params: { name: 'bad tool name!', arguments: {} } },
          'session-invalid-name',
          'upstream-profile',
        ) as any;

        expect(response.error).toBeDefined();
        expect(metrics.recordToolCall).toHaveBeenCalledWith(
          'bad tool name!', 'rejected', expect.any(Number), expect.any(Object),
        );
        expect(metrics.recordToolCallError).toHaveBeenCalledWith(
          'bad tool name!', 'InvalidToolName', expect.any(Object),
        );
      });

      it('records PolicyRejection error metric when provider tool policy blocks tool', async () => {
        const metrics = makeMetrics();
        (upstreamServer as any).httpTransport.getMetricsCollector = () => metrics;
        const providerWithPolicy = { ...upstreamProvider, tools: { allow: ['other_tool'] } };
        (upstreamServer as any).profile.upstream_mcp = providerWithPolicy;
        (upstreamServer as any).httpTransport.getUpstreamMcpConfig = () => providerWithPolicy;

        const response = await (upstreamServer as any).handleToolCall(
          { jsonrpc: '2.0', id: '1', method: 'tools/call', params: { name: 'safe_tool', arguments: {} } },
          'session-provider-policy',
          'upstream-profile',
        ) as any;

        expect(response.error).toBeDefined();
        expect(metrics.recordToolCall).toHaveBeenCalledWith(
          'safe_tool', 'rejected', expect.any(Number), expect.any(Object),
        );
        expect(metrics.recordToolCallError).toHaveBeenCalledWith(
          'safe_tool', 'PolicyRejection', expect.any(Object),
        );
      });

      it('records SanitizationRejection error metric when tool was dropped by sanitization', async () => {
        const metrics = makeMetrics();
        (upstreamServer as any).httpTransport.getMetricsCollector = () => metrics;
        // Warm the sanitized cache with a set that does not include safe_tool
        const sessionCache = new Map<string, Set<string>>();
        sessionCache.set(upstreamProvider.name, new Set(['other_tool']));
        (upstreamServer as any).sanitizedAndPolicyFilteredToolNames.set('session-sanitized', sessionCache);

        const response = await (upstreamServer as any).handleToolCall(
          { jsonrpc: '2.0', id: '1', method: 'tools/call', params: { name: 'safe_tool', arguments: {} } },
          'session-sanitized',
          'upstream-profile',
        ) as any;

        expect(response.error).toBeDefined();
        expect(metrics.recordToolCall).toHaveBeenCalledWith(
          'safe_tool', 'rejected', expect.any(Number), expect.any(Object),
        );
        expect(metrics.recordToolCallError).toHaveBeenCalledWith(
          'safe_tool', 'SanitizationRejection', expect.any(Object),
        );
      });

      it('passes raw tool name to MetricsCollector on reject (MetricsCollector truncates internally)', async () => {
        const metrics = makeMetrics();
        (upstreamServer as any).httpTransport.getMetricsCollector = () => metrics;
        const longName = 'a'.repeat(300);

        const response = await (upstreamServer as any).handleToolCall(
          { jsonrpc: '2.0', id: '1', method: 'tools/call', params: { name: longName, arguments: {} } },
          'session-truncate',
          'upstream-profile',
        ) as any;

        expect(response.error).toBeDefined();
        // recordUpstreamReject passes raw name with 'rejected' status; MetricsCollector truncates at 64 internally
        expect(metrics.recordToolCall).toHaveBeenCalledWith(
          longName, 'rejected', expect.any(Number), expect.any(Object),
        );
        expect(metrics.recordToolCallError).toHaveBeenCalledWith(
          longName, 'InvalidToolName', expect.any(Object),
        );
      });
    });

    // -------------------------------------------------------------------------
    describe('Audit log (OBS-01)', () => {
      function spyLogger() {
        const info = vi.fn();
        const debug = vi.fn();
        const warn = vi.fn();
        const error = vi.fn();
        return { info, debug, warn, error };
      }

      function findAuditEntries(infoSpy: ReturnType<typeof vi.fn>) {
        return infoSpy.mock.calls.filter((c: unknown[]) => c[0] === 'audit:tool_call');
      }

      it('emits audit:tool_call with structured fields on upstream success', async () => {
        const fakeLogger = spyLogger();
        (upstreamServer as any).logger = fakeLogger;

        const response: any = await (upstreamServer as any).handleToolCall(
          { jsonrpc: '2.0', id: '1', method: 'tools/call', params: { name: 'safe_tool', arguments: {} } },
          'session-audit-ok',
          'upstream-profile',
        );

        expect(response.result).toBeDefined();
        const audits = findAuditEntries(fakeLogger.info);
        expect(audits.length).toBeGreaterThanOrEqual(1);
        const payload = audits[audits.length - 1][1] as Record<string, unknown>;
        expect(payload).toMatchObject({
          sessionId: 'session-audit-ok',
          tool: 'safe_tool',
          outcome: 'success',
          upstreamHost: 'upstream.example.com',
        });
        expect(typeof payload.durationMs).toBe('number');
        // clientPrincipal must always be present (string) - 'anonymous' when no principal
        expect(typeof payload.clientPrincipal).toBe('string');
      });

      it('emits audit:tool_call with outcome=error when upstream call throws', async () => {
        const fakeLogger = spyLogger();
        (upstreamServer as any).logger = fakeLogger;
        mockCallTool.mockRejectedValueOnce(new Error('upstream down'));

        await (upstreamServer as any).handleToolCall(
          { jsonrpc: '2.0', id: '1', method: 'tools/call', params: { name: 'safe_tool', arguments: {} } },
          'session-audit-err',
          'upstream-profile',
        );

        const audits = findAuditEntries(fakeLogger.info);
        expect(audits.length).toBeGreaterThanOrEqual(1);
        const payload = audits[audits.length - 1][1] as Record<string, unknown>;
        expect(payload.outcome).toBe('error');
        expect(payload.tool).toBe('safe_tool');
        expect(payload.upstreamHost).toBe('upstream.example.com');
      });

      it('audit correlationId matches error log correlationId on upstream proxy failure', async () => {
        const fakeLogger = spyLogger();
        (upstreamServer as any).logger = fakeLogger;
        mockCallTool.mockRejectedValueOnce(new Error('upstream down'));

        await (upstreamServer as any).handleToolCall(
          { jsonrpc: '2.0', id: '1', method: 'tools/call', params: { name: 'safe_tool', arguments: {} } },
          'session-audit-corr',
          'upstream-profile',
        );

        const audits = findAuditEntries(fakeLogger.info);
        const auditPayload = audits[audits.length - 1][1] as Record<string, unknown>;
        expect(typeof auditPayload.correlationId).toBe('string');
        expect((auditPayload.correlationId as string).length).toBeGreaterThan(0);

        // Error logger must carry the same correlationId as the audit entry.
        const errorCalls = fakeLogger.error.mock.calls as unknown[][];
        const warnCalls = fakeLogger.warn.mock.calls as unknown[][];
        const allCalls = [...errorCalls, ...warnCalls];
        const logWithCorr = allCalls.find(
          (c) => typeof c[c.length - 1] === 'object' && c[c.length - 1] !== null &&
            (c[c.length - 1] as Record<string, unknown>).correlationId === auditPayload.correlationId,
        );
        expect(logWithCorr).toBeDefined();
      });

      it('uses "anonymous" clientPrincipal when session has no AuthorizedPrincipal', async () => {
        const fakeLogger = spyLogger();
        (upstreamServer as any).logger = fakeLogger;
        // httpTransport in beforeEach has no getSessionClientPrincipal -> resolveMetricsContext
        // must still produce 'anonymous' for the audit emission

        await (upstreamServer as any).handleToolCall(
          { jsonrpc: '2.0', id: '1', method: 'tools/call', params: { name: 'safe_tool', arguments: {} } },
          'session-anon',
          'upstream-profile',
        );

        const audits = findAuditEntries(fakeLogger.info);
        const payload = audits[audits.length - 1][1] as Record<string, unknown>;
        expect(payload.clientPrincipal).toBe('anonymous');
      });

      it('uses resolved AuthorizedPrincipal.subject when session has one', async () => {
        const fakeLogger = spyLogger();
        (upstreamServer as any).logger = fakeLogger;
        (upstreamServer as any).httpTransport.getSessionClientPrincipal = (_pid: string, sid: string) =>
          sid === 'session-with-principal'
            ? { authType: 'token', profileId: 'upstream-profile', subject: 'svc-bot', scopes: [] }
            : undefined;

        await (upstreamServer as any).handleToolCall(
          { jsonrpc: '2.0', id: '1', method: 'tools/call', params: { name: 'safe_tool', arguments: {} } },
          'session-with-principal',
          'upstream-profile',
        );

        const audits = findAuditEntries(fakeLogger.info);
        const payload = audits[audits.length - 1][1] as Record<string, unknown>;
        expect(payload.clientPrincipal).toBe('svc-bot');
      });

      it('emits audit:tool_call on upstream early-reject (FilterRejection)', async () => {
        const fakeLogger = spyLogger();
        (upstreamServer as any).logger = fakeLogger;
        (upstreamServer as any).httpTransport.getSessionToolFilterRequest = () =>
          parseSessionToolFilterHeader('other_tool');

        await (upstreamServer as any).handleToolCall(
          { jsonrpc: '2.0', id: '1', method: 'tools/call', params: { name: 'safe_tool', arguments: {} } },
          'session-reject',
          'upstream-profile',
        );

        const audits = findAuditEntries(fakeLogger.info);
        expect(audits.length).toBeGreaterThanOrEqual(1);
        const payload = audits[audits.length - 1][1] as Record<string, unknown>;
        expect(payload.outcome).toBe('rejected');
        expect(payload.tool).toBe('safe_tool');
        expect(payload.upstreamHost).toBe('upstream.example.com');
      });

      it('audit:tool_call on FilterRejection has a defined correlationId', async () => {
        const fakeLogger = spyLogger();
        (upstreamServer as any).logger = fakeLogger;
        (upstreamServer as any).httpTransport.getSessionToolFilterRequest = () =>
          parseSessionToolFilterHeader('other_tool');

        await (upstreamServer as any).handleToolCall(
          { jsonrpc: '2.0', id: '1', method: 'tools/call', params: { name: 'safe_tool', arguments: {} } },
          'session-reject-corr',
          'upstream-profile',
        );

        const audits = findAuditEntries(fakeLogger.info);
        const payload = audits[audits.length - 1][1] as Record<string, unknown>;
        expect(typeof payload.correlationId).toBe('string');
        expect((payload.correlationId as string).length).toBeGreaterThan(0);
      });

      it('upstreamHost in audit log is host-only (no path, no scheme)', async () => {
        const fakeLogger = spyLogger();
        (upstreamServer as any).logger = fakeLogger;

        await (upstreamServer as any).handleToolCall(
          { jsonrpc: '2.0', id: '1', method: 'tools/call', params: { name: 'safe_tool', arguments: {} } },
          'session-host-check',
          'upstream-profile',
        );

        const audits = findAuditEntries(fakeLogger.info);
        const payload = audits[audits.length - 1][1] as Record<string, unknown>;
        expect(payload.upstreamHost).toBe('upstream.example.com');
        // No scheme, no path, no credentials
        expect(payload.upstreamHost).not.toMatch(/^https?:\/\//);
        expect(payload.upstreamHost).not.toContain('/mcp');
      });

      it('emits audit:tool_call on PolicyRejection (enterprise policy blocks tool)', async () => {
        const fakeLogger = spyLogger();
        (upstreamServer as any).logger = fakeLogger;
        (upstreamServer as any).httpTransport.getSessionEnterpriseTiers = () => ['read'];
        (upstreamServer as any).httpTransport.getSessionEnterpriseAllowedToolCategories = () => new Set(['read']);

        await (upstreamServer as any).handleToolCall(
          { jsonrpc: '2.0', id: '1', method: 'tools/call', params: { name: 'safe_tool', arguments: {} } },
          'session-policy-audit',
          'upstream-profile',
        );

        const audits = findAuditEntries(fakeLogger.info);
        expect(audits.length).toBeGreaterThanOrEqual(1);
        const payload = audits[audits.length - 1][1] as Record<string, unknown>;
        expect(payload.outcome).toBe('rejected');
        expect(payload.tool).toBe('safe_tool');
        expect(typeof payload.correlationId).toBe('string');
      });

      it('emits audit:tool_call on InvalidToolName rejection', async () => {
        const fakeLogger = spyLogger();
        (upstreamServer as any).logger = fakeLogger;

        await (upstreamServer as any).handleToolCall(
          { jsonrpc: '2.0', id: '1', method: 'tools/call', params: { name: 'bad tool name!', arguments: {} } },
          'session-invalid-name-audit',
          'upstream-profile',
        );

        const audits = findAuditEntries(fakeLogger.info);
        expect(audits.length).toBeGreaterThanOrEqual(1);
        const payload = audits[audits.length - 1][1] as Record<string, unknown>;
        expect(payload.outcome).toBe('rejected');
        expect(typeof payload.correlationId).toBe('string');
      });

      it('emits audit:tool_call on SanitizationRejection', async () => {
        const fakeLogger = spyLogger();
        (upstreamServer as any).logger = fakeLogger;
        const sessionCache = new Map<string, Set<string>>();
        sessionCache.set(upstreamProvider.name, new Set(['other_tool']));
        (upstreamServer as any).sanitizedAndPolicyFilteredToolNames.set('session-sanitized-audit', sessionCache);

        await (upstreamServer as any).handleToolCall(
          { jsonrpc: '2.0', id: '1', method: 'tools/call', params: { name: 'safe_tool', arguments: {} } },
          'session-sanitized-audit',
          'upstream-profile',
        );

        const audits = findAuditEntries(fakeLogger.info);
        expect(audits.length).toBeGreaterThanOrEqual(1);
        const payload = audits[audits.length - 1][1] as Record<string, unknown>;
        expect(payload.outcome).toBe('rejected');
        expect(payload.tool).toBe('safe_tool');
        expect(typeof payload.correlationId).toBe('string');
      });

      it('emits audit:tool_call on OAuthRequired early-reject', async () => {
        const fakeLogger = spyLogger();
        (upstreamServer as any).logger = fakeLogger;
        // Make the server believe OAuth is configured so it triggers the auth check
        (upstreamServer as any).httpTransport.hasOAuthProvider = () => true;
        // Return no token so the auth check fails (getAuthTokenFromSession returns undefined)
        (upstreamServer as any).httpTransport.ensureValidSessionToken = async () => false;
        (upstreamServer as any).httpTransport.getSessionToken = () => undefined;
        (upstreamServer as any).httpTransport.getOAuthProtectedResourceUrl = () => 'https://example.com/.well-known/oauth';

        await (upstreamServer as any).handleToolCall(
          { jsonrpc: '2.0', id: '1', method: 'tools/call', params: { name: 'safe_tool', arguments: {} } },
          'session-oauth-audit',
          'upstream-profile',
        );

        const audits = findAuditEntries(fakeLogger.info);
        expect(audits.length).toBeGreaterThanOrEqual(1);
        const payload = audits[audits.length - 1][1] as Record<string, unknown>;
        expect(payload.outcome).toBe('error');
        expect(payload.tool).toBe('safe_tool');
      });

      it('upstream MCPError with embedded correlationId → audit entry reuses that ID (extractCorrelationId)', async () => {
        const fakeLogger = spyLogger();
        (upstreamServer as any).logger = fakeLogger;
        const embeddedId = 'upstream-corr-abc123';
        mockCallTool.mockRejectedValueOnce(new MCPError('upstream failed', 'UPSTREAM_ERR', { correlationId: embeddedId }));

        await (upstreamServer as any).handleToolCall(
          { jsonrpc: '2.0', id: '1', method: 'tools/call', params: { name: 'safe_tool', arguments: {} } },
          'session-corr-extract',
          'upstream-profile',
        );

        const audits = findAuditEntries(fakeLogger.info);
        const payload = audits[audits.length - 1][1] as Record<string, unknown>;
        expect(payload.correlationId).toBe(embeddedId);
        // warn log (unexpected error type) must carry the same correlationId
        const warnCalls = fakeLogger.warn.mock.calls as unknown[][];
        const logWithCorr = warnCalls.find(
          (c) => typeof c[c.length - 1] === 'object' && c[c.length - 1] !== null &&
            (c[c.length - 1] as Record<string, unknown>).correlationId === embeddedId,
        );
        expect(logWithCorr).toBeDefined();
      });

      it('emits audit:tool_call on local HTTP tool success (non-upstream path)', async () => {
        const specPath = path.join(process.cwd(), 'profiles/gitlab/openapi.yaml');
        await server.initialize(specPath);
        const fakeLogger = spyLogger();
        (server as any).logger = fakeLogger;
        const simpleTool = (server as any).profile.tools.find((t: any) => !t.composite);
        expect(simpleTool).toBeDefined();
        (server as any).toolGenerator.validateArguments = () => {};
        (server as any).executeSimpleTool = async () => ({ ok: true });

        await server.callToolRpc(simpleTool.name, {}, 'session-local-ok', '1');

        const audits = findAuditEntries(fakeLogger.info);
        expect(audits.length).toBeGreaterThanOrEqual(1);
        const payload = audits[audits.length - 1][1] as Record<string, unknown>;
        expect(payload).toMatchObject({
          sessionId: 'session-local-ok',
          tool: simpleTool.name,
          outcome: 'success',
        });
        expect(typeof payload.durationMs).toBe('number');
        expect(payload.clientPrincipal).toBe('anonymous');
        expect(typeof payload.correlationId).toBe('string');
        expect(typeof payload.upstreamHost).toBe('string');
      });

      it('emits audit:tool_call with outcome=error on local HTTP tool failure (non-upstream path)', async () => {
        const specPath = path.join(process.cwd(), 'profiles/gitlab/openapi.yaml');
        await server.initialize(specPath);
        const fakeLogger = spyLogger();
        (server as any).logger = fakeLogger;
        const simpleTool = (server as any).profile.tools.find((t: any) => !t.composite);
        expect(simpleTool).toBeDefined();
        (server as any).toolGenerator.validateArguments = () => {};
        (server as any).executeSimpleTool = async () => { throw new Error('local tool boom'); };

        await server.callToolRpc(simpleTool.name, {}, 'session-local-err', '1');

        const audits = findAuditEntries(fakeLogger.info);
        expect(audits.length).toBeGreaterThanOrEqual(1);
        const payload = audits[audits.length - 1][1] as Record<string, unknown>;
        expect(payload.outcome).toBe('error');
        expect(payload.sessionId).toBe('session-local-err');
        expect(typeof payload.correlationId).toBe('string');
        // error log must carry the same correlationId as the audit entry
        const errorCalls = fakeLogger.error.mock.calls as unknown[][];
        const logWithCorr = errorCalls.find(
          (c) => typeof c[c.length - 1] === 'object' && c[c.length - 1] !== null &&
            (c[c.length - 1] as Record<string, unknown>).correlationId === payload.correlationId,
        );
        expect(logWithCorr).toBeDefined();
      });

      it('uses sessionId="unknown" in audit log when sessionId is undefined (local tool path)', async () => {
        const specPath = path.join(process.cwd(), 'profiles/gitlab/openapi.yaml');
        await server.initialize(specPath);
        const fakeLogger = spyLogger();
        (server as any).logger = fakeLogger;
        const simpleTool = (server as any).profile.tools.find((t: any) => !t.composite);
        expect(simpleTool).toBeDefined();
        (server as any).toolGenerator.validateArguments = () => {};
        (server as any).executeSimpleTool = async () => ({ ok: true });

        // Pass undefined sessionId — emitAuditToolCall must use 'unknown' sentinel.
        await server.callToolRpc(simpleTool.name, {}, undefined, '1');

        const audits = findAuditEntries(fakeLogger.info);
        expect(audits.length).toBeGreaterThanOrEqual(1);
        const payload = audits[audits.length - 1][1] as Record<string, unknown>;
        expect(payload.sessionId).toBe('unknown');
      });
    });

    // -------------------------------------------------------------------------
    describe('getUpstreamToken token precedence (client token first, env fallback)', () => {
      it('uses downstream client token even when value_from_env is configured', async () => {
        // Client sends a token → it wins regardless of value_from_env
        const providerWithAuth = {
          ...upstreamProvider,
          auth: { type: 'bearer' as const, value_from_env: 'UPSTREAM_SECRET' },
        };
        (upstreamServer as any).profile.upstream_mcp = providerWithAuth;
        (upstreamServer as any).httpTransport.getUpstreamMcpConfig = () => providerWithAuth;

        process.env['UPSTREAM_SECRET'] = 'env-token-value';
        try {
          await (upstreamServer as any).handleOtherRequest(
            { jsonrpc: '2.0', id: '1', method: 'tools/list', params: {} },
            'session-123',
            'upstream-profile',
          );
          // getSessionToken returns 'downstream-token' - client token takes precedence
          expect(mockGetUpstreamClient).toHaveBeenCalledWith('session-123', providerWithAuth, 'downstream-token');
        } finally {
          delete process.env['UPSTREAM_SECRET'];
        }
      });

      it('blocks value_from_env for anonymous HTTP session even when inbound auth is configured', async () => {
        // hasServerEnvAuthToken on the inbound side allows anonymous sessions — those sessions
        // must still not receive server-held upstream credentials.
        const providerWithAuth = {
          ...upstreamProvider,
          auth: { type: 'bearer' as const, value_from_env: 'UPSTREAM_SECRET' },
        };
        (upstreamServer as any).profile.upstream_mcp = providerWithAuth;
        (upstreamServer as any).profile.interceptors = { auth: [{ type: 'bearer', value_from_env: 'INBOUND_TOKEN' }] };
        (upstreamServer as any).httpTransport = {
          ...(upstreamServer as any).httpTransport,
          getUpstreamMcpConfig: () => providerWithAuth,
          getSessionToken: () => undefined, // anonymous HTTP session — no verified client token
        };

        process.env['UPSTREAM_SECRET'] = 'env-token-value';
        try {
          const response = await (upstreamServer as any).handleOtherRequest(
            { jsonrpc: '2.0', id: '1', method: 'tools/list', params: {} },
            'session-123',
            'upstream-profile',
          ) as any;
          expect(mockGetUpstreamClient).not.toHaveBeenCalled();
          expect(response.error).toBeDefined();
          expect(response.error.code).toBe(-32603);
        } finally {
          delete process.env['UPSTREAM_SECRET'];
          delete (upstreamServer as any).profile.interceptors;
        }
      });

      it('blocks value_from_env for anonymous HTTP session when no inbound auth is configured', async () => {
        const providerWithAuth = {
          ...upstreamProvider,
          auth: { type: 'bearer' as const, value_from_env: 'UPSTREAM_SECRET' },
        };
        (upstreamServer as any).profile.upstream_mcp = providerWithAuth;
        delete (upstreamServer as any).profile.interceptors;
        (upstreamServer as any).httpTransport = {
          ...(upstreamServer as any).httpTransport,
          getUpstreamMcpConfig: () => providerWithAuth,
          getSessionToken: () => undefined,
        };

        process.env['UPSTREAM_SECRET'] = 'env-token-value';
        try {
          const response = await (upstreamServer as any).handleOtherRequest(
            { jsonrpc: '2.0', id: '1', method: 'tools/list', params: {} },
            'session-123',
            'upstream-profile',
          ) as any;
          expect(mockGetUpstreamClient).not.toHaveBeenCalled();
          expect(response.error).toBeDefined();
          expect(response.error.code).toBe(-32603);
        } finally {
          delete process.env['UPSTREAM_SECRET'];
        }
      });

      it('returns undefined token when provider has no auth and session has no client token', async () => {
        // No provider.auth — upstream call proceeds without a token (upstream decides how to handle)
        (upstreamServer as any).httpTransport = {
          ...(upstreamServer as any).httpTransport,
          getUpstreamMcpConfig: () => upstreamProvider,
          getSessionToken: () => undefined,
        };

        await (upstreamServer as any).handleOtherRequest(
          { jsonrpc: '2.0', id: '1', method: 'tools/list', params: {} },
          'session-123',
          'upstream-profile',
        );
        expect(mockGetUpstreamClient).toHaveBeenCalledWith('session-123', upstreamProvider, undefined);
      });

      it('uses downstream session token when no provider.auth is configured', async () => {
        // upstreamProvider has no auth - should use downstream session token
        const response = await (upstreamServer as any).handleOtherRequest(
          { jsonrpc: '2.0', id: '1', method: 'tools/list', params: {} },
          'session-123',
          'upstream-profile',
        ) as any;

        expect(mockGetUpstreamClient).toHaveBeenCalledWith('session-123', upstreamProvider, 'downstream-token');
        expect(response.result).toBeDefined();
      });
    });

    // -------------------------------------------------------------------------
    describe('getEffectiveUpstreamAuth', () => {
      it('skips oauth and returns bearer when interceptors.auth = [oauth, bearer]', async () => {
        const provider = { ...upstreamProvider }; // no provider.auth
        (upstreamServer as any).profile.interceptors = {
          auth: [
            { type: 'oauth' },
            { type: 'bearer', value_from_env: 'BEARER_TOKEN' },
          ],
        };
        (upstreamServer as any).httpTransport = {
          ...(upstreamServer as any).httpTransport,
          getUpstreamMcpConfig: () => provider,
          getSessionToken: () => 'client-token',
        };
        try {
          await (upstreamServer as any).handleOtherRequest(
            { jsonrpc: '2.0', id: '1', method: 'tools/list', params: {} },
            'session-123',
            'upstream-profile',
          );
          // effectiveAuth should be bearer; effectiveProvider passed to client should have auth.type === 'bearer'
          expect(mockGetUpstreamClient).toHaveBeenCalledWith(
            'session-123',
            expect.objectContaining({ auth: expect.objectContaining({ type: 'bearer' }) }),
            'client-token',
          );
        } finally {
          delete (upstreamServer as any).profile.interceptors;
        }
      });

      it('returns undefined when interceptors.auth = [session-cookie] only', () => {
        const server = new MCPServer();
        (server as any).profile = {
          profile_name: 'p',
          tools: [],
          interceptors: { auth: [{ type: 'session-cookie' }] },
        };
        const result = (server as any).getEffectiveUpstreamAuth({ name: 'x', transport: { type: 'http-streamable', url: 'https://example.com' } });
        expect(result).toBeUndefined();
      });

      it('priority sort: lower priority value wins — query(priority:1) before bearer(priority:5)', () => {
        const server = new MCPServer();
        (server as any).profile = {
          profile_name: 'p',
          tools: [],
          interceptors: {
            auth: [
              { type: 'bearer', value_from_env: 'T', priority: 5 },
              { type: 'query', value_from_env: 'T', query_param: 'token', priority: 1 },
            ],
          },
        };
        const result = (server as any).getEffectiveUpstreamAuth({ name: 'x', transport: { type: 'http-streamable', url: 'https://example.com' } });
        expect(result?.type).toBe('query');
      });

      it('uses provider.auth directly and ignores interceptors.auth when provider.auth set', () => {
        const server = new MCPServer();
        (server as any).profile = {
          profile_name: 'p',
          tools: [],
          interceptors: { auth: [{ type: 'bearer', value_from_env: 'INTERCEPTOR_TOKEN' }] },
        };
        const providerAuth = { type: 'bearer' as const, value_from_env: 'PROVIDER_TOKEN' };
        const result = (server as any).getEffectiveUpstreamAuth({
          name: 'x',
          transport: { type: 'http-streamable', url: 'https://example.com' },
          auth: providerAuth,
        });
        expect(result).toBe(providerAuth);
      });

      it('blocks anonymous HTTP session when interceptors.auth contains only oauth (gate bypass fix)', async () => {
        const provider = { ...upstreamProvider }; // no provider.auth
        (upstreamServer as any).profile.interceptors = {
          auth: [{ type: 'oauth' }],
        };
        (upstreamServer as any).httpTransport = {
          ...(upstreamServer as any).httpTransport,
          getUpstreamMcpConfig: () => provider,
          getSessionToken: () => undefined, // anonymous HTTP session
        };
        try {
          const response = await (upstreamServer as any).handleOtherRequest(
            { jsonrpc: '2.0', id: '1', method: 'tools/list', params: {} },
            'session-123',
            'upstream-profile',
          ) as any;
          expect(mockGetUpstreamClient).not.toHaveBeenCalled();
          expect(response.error).toBeDefined();
          expect(response.error.code).toBe(-32603);
        } finally {
          delete (upstreamServer as any).profile.interceptors;
        }
      });
    });

    // -------------------------------------------------------------------------
    describe('tool_prefix warning', () => {
      it('emits a warning when tool_prefix is configured', async () => {
        const mockLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
        const providerWithPrefix = { ...upstreamProvider, tool_prefix: 'myprefix_' };
        const prefixServer = new MCPServer(mockLogger as any);
        (prefixServer as any).profile = {
          profile_name: 'upstream-profile',
          description: 'Upstream profile',
          tools: [],
          upstream_mcp: providerWithPrefix,
        };
        (prefixServer as any).httpTransport = {
          hasOAuthProvider: () => false,
          getUpstreamMcpConfig: () => providerWithPrefix,
          getSessionToken: () => undefined,
          getSessionTenantContext: () => undefined,
          getMetricsCollector: () => null,
          getSessionFiltering: () => undefined,
          getSessionToolFilter: () => undefined,
          getSessionToolFilterHeader: () => undefined,
          getSessionToolFilterRequest: () => undefined,
          getSessionEnterpriseTiers: () => undefined,
          getSessionEnterpriseAllowedToolCategories: () => undefined,
          recordToolFilterRejection: () => {},
        };
        prefixServer.setGetUpstreamClient(vi.fn().mockResolvedValue({ listTools: vi.fn().mockResolvedValue({ tools: [] }), callTool: vi.fn() }));

        await (prefixServer as any).handleOtherRequest(
          { jsonrpc: '2.0', id: '1', method: 'tools/list', params: {} },
          'session-123',
          'upstream-profile',
        );

        expect(mockLogger.warn).toHaveBeenCalledWith(
          expect.stringContaining('tool_prefix'),
          expect.objectContaining({ tool_prefix: 'myprefix_' }),
        );
      });
    });

    // -------------------------------------------------------------------------
    describe('getUpstreamToken stdio path / boundary coverage', () => {
      it('getUpstreamToken reads value_from_env on stdio path (no httpTransport)', async () => {
        // Covers mcp-server.ts:1867 — the non-HTTP branch where value_from_env is resolved
        // from process.env because there is no session token concept in stdio mode.
        const providerWithAuth = {
          name: 'stdio-auth-upstream',
          transport: { type: 'http-streamable' as const, url: 'https://upstream.example.com/mcp' },
          auth: { type: 'bearer' as const, value_from_env: 'UPSTREAM_SECRET_TEST_VAR' },
        };
        const mockListFn = vi.fn().mockResolvedValue({ tools: [] });
        const mockClientFn = vi.fn().mockResolvedValue({ listTools: mockListFn, callTool: vi.fn() });

        const stdioServer = new MCPServer();
        (stdioServer as any).profile = {
          profile_name: 'stdio-auth-profile',
          description: 'Stdio server with value_from_env auth',
          tools: [],
          upstream_mcp: providerWithAuth,
        };
        // No httpTransport — getUpstreamToken must fall through to the stdio branch.
        stdioServer.setGetUpstreamClient(mockClientFn);

        const originalEnvValue = process.env['UPSTREAM_SECRET_TEST_VAR'];
        process.env['UPSTREAM_SECRET_TEST_VAR'] = 'stdio-env-token';
        try {
          await (stdioServer as any).handleUpstreamToolsList(
            { jsonrpc: '2.0', id: '1' },
            'session-1',
            'profile-1',
            providerWithAuth,
          );
        } finally {
          if (originalEnvValue === undefined) {
            delete process.env['UPSTREAM_SECRET_TEST_VAR'];
          } else {
            process.env['UPSTREAM_SECRET_TEST_VAR'] = originalEnvValue;
          }
        }

        expect(mockClientFn).toHaveBeenCalledWith('session-1', providerWithAuth, 'stdio-env-token');
      });

      it('handleUpstreamToolCall forwards callTool with empty args when arguments field is absent', async () => {
        // Covers mcp-server.ts:1977 branch — the `|| {}` fallback when params.arguments is missing.
        // Call handleUpstreamToolCall directly (bypassing the outer handleToolCall gate that also
        // does an || {} cast) to ensure the inner branch is actually exercised.
        mockCallTool.mockResolvedValueOnce({ content: [{ type: 'text', text: 'result' }] });

        const response = await (upstreamServer as any).handleUpstreamToolCall(
          { jsonrpc: '2.0', id: '2', params: { name: 'safe_tool' } }, // no 'arguments' field
          'session-123',
          'upstream-profile',
          upstreamProvider,
        ) as any;

        expect(response.result).toBeDefined();
        // callTool must have been called with an empty object for arguments
        expect(mockCallTool).toHaveBeenCalledWith(
          { name: 'safe_tool', arguments: {} },
        );
      });

      it('handleUpstreamToolCall with invalid tool name throws UpstreamConnectionError (covers line 1982)', async () => {
        // Covers mcp-server.ts:1981/1982 — the isValidUpstreamToolName guard inside
        // handleUpstreamToolCall. The throw is BEFORE the try block, so it propagates out
        // of the function as a rejection rather than being caught and returned as an error response.
        await expect(
          (upstreamServer as any).handleUpstreamToolCall(
            { jsonrpc: '2.0', id: '3', params: { name: 'invalid<name>' } },
            'session-123',
            'upstream-profile',
            upstreamProvider,
          ),
        ).rejects.toBeInstanceOf(UpstreamConnectionError);
      });

      it('handleUpstreamToolsList returns error when listTools returns null (covers null branch in ternary at 1901)', async () => {
        // Covers mcp-server.ts:1901[255] — the `result === null ? 'null' : typeof result` ternary.
        // Existing tests only exercise undefined/non-object; this forces the null branch.
        mockListTools.mockResolvedValueOnce(null);

        const response = await (upstreamServer as any).handleOtherRequest(
          { jsonrpc: '2.0', id: '4', method: 'tools/list', params: {} },
          'session-123',
          'upstream-profile',
        ) as any;

        expect(response.error).toBeDefined();
        expect(response.error.code).toBe(-32603);
      });

      it('handleUpstreamToolsList uses getProfileIdValue() when profileId is undefined (covers line 1925)', async () => {
        // Covers mcp-server.ts:1925[259] — `profileId || this.getProfileIdValue()`.
        // The || short-circuits when profileId is truthy; passing undefined forces the right side.
        const response = await (upstreamServer as any).handleUpstreamToolsList(
          { jsonrpc: '2.0', id: '5' },
          'session-123',
          undefined, // profileId undefined — forces getProfileIdValue() fallback
          upstreamProvider,
        ) as any;

        // Should still succeed and return a tools list
        expect(response.result).toBeDefined();
        expect(response.result.tools).toBeDefined();
      });
    });
  });

  // ---------------------------------------------------------------------------
  // extractHost helper (OBS-01)
  // ---------------------------------------------------------------------------
  describe('extractHost (OBS-01)', () => {
    let extractHostFn: (url: string) => string;

    beforeEach(async () => {
      // Import the module under test once - extractHost is a module-level helper
      const mod = await import('./mcp-server.js');
      extractHostFn = (mod as unknown as { extractHost: (u: string) => string }).extractHost;
      expect(extractHostFn).toBeTypeOf('function');
    });

    it('returns host for valid https URL with path', () => {
      expect(extractHostFn('https://api.example.com/v1/path')).toBe('api.example.com');
    });

    it('returns hostname without port', () => {
      expect(extractHostFn('http://localhost:8080/x')).toBe('localhost');
    });

    it('returns unknown when URL parsing throws', () => {
      expect(extractHostFn('not-a-url')).toBe('unknown');
    });

    it('returns unknown for URL with empty hostname (e.g. http://)', () => {
      // new URL('http://') does not throw in Node.js — hostname is empty string
      expect(extractHostFn('http://')).toBe('unknown');
    });

    it('returns unknown for empty string', () => {
      expect(extractHostFn('')).toBe('unknown');
    });

    it('strips credentials from URL (no user:pass in audit log)', () => {
      expect(extractHostFn('https://admin:secret@api.example.com/v1')).toBe('api.example.com');
    });

    it('lowercases hostname', () => {
      expect(extractHostFn('https://API.EXAMPLE.COM/v1')).toBe('api.example.com');
    });

    it('returns IPv6 address (with brackets, no port) per URL spec', () => {
      // Node.js URL.hostname for IPv6 includes brackets: '[::1]', not '::1'
      expect(extractHostFn('http://[::1]:9000/path')).toBe('[::1]');
      expect(extractHostFn('http://[2001:db8::1]/x')).toBe('[2001:db8::1]');
    });
  });

  // ---------------------------------------------------------------------------
  // truncateWithWarn (OBS-01)
  // ---------------------------------------------------------------------------
  describe('truncateWithWarn (OBS-01)', () => {
    it('emits logger.warn when value exceeds max', () => {
      const server = new MCPServer();
      const fakeLogger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
      (server as any).logger = fakeLogger;

      const result = (server as any).truncateWithWarn('a'.repeat(100), 64, 'tool');

      expect(result).toBe('a'.repeat(64));
      expect(fakeLogger.warn).toHaveBeenCalledWith(
        'audit field truncated',
        expect.objectContaining({ field: 'tool', original_length: 100, max: 64 }),
      );
    });

    it('does not warn when value is at or below max', () => {
      const server = new MCPServer();
      const fakeLogger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
      (server as any).logger = fakeLogger;

      const result = (server as any).truncateWithWarn('a'.repeat(64), 64, 'tool');

      expect(result).toBe('a'.repeat(64));
      expect(fakeLogger.warn).not.toHaveBeenCalled();
    });

    it('truncates clientPrincipal at CLIENT_PRINCIPAL_AUDIT (256) chars', () => {
      const server = new MCPServer();
      const fakeLogger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
      (server as any).logger = fakeLogger;

      const longSubject = 'x'.repeat(300);
      const result = (server as any).truncateWithWarn(longSubject, 256, 'clientPrincipal');

      expect(result).toBe('x'.repeat(256));
      expect(fakeLogger.warn).toHaveBeenCalledWith(
        'audit field truncated',
        expect.objectContaining({ field: 'clientPrincipal', original_length: 300, max: 256 }),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // safeBaseUrlHost (OBS-01)
  // ---------------------------------------------------------------------------
  describe('safeBaseUrlHost (OBS-01)', () => {
    it('returns "unknown" when getBaseUrl() throws (partial parser mock)', () => {
      const s = new MCPServer();
      (s as any).parser = { getBaseUrl: () => { throw new Error('no base url'); } };
      expect((s as any).safeBaseUrlHost()).toBe('unknown');
    });

    it('returns "unknown" when getBaseUrl() returns empty string', () => {
      const s = new MCPServer();
      (s as any).parser = { getBaseUrl: () => '' };
      expect((s as any).safeBaseUrlHost()).toBe('unknown');
    });

    it('returns hostname when getBaseUrl() returns valid URL', () => {
      const s = new MCPServer();
      (s as any).parser = { getBaseUrl: () => 'https://api.example.com/v1' };
      expect((s as any).safeBaseUrlHost()).toBe('api.example.com');
    });
  });

  // ---------------------------------------------------------------------------
  // Stdio path audit log (OBS-01)
  // ---------------------------------------------------------------------------
  describe('stdio audit log (OBS-01)', () => {
    it('emits audit:tool_call with sessionId=stdio and clientPrincipal=anonymous on stdio path', async () => {
      const localServer = new MCPServer();
      const specPath = path.join(process.cwd(), 'profiles/gitlab/openapi.yaml');
      await localServer.initialize(specPath);

      const auditInfo = vi.fn();
      const fakeLogger = {
        info: auditInfo,
        debug: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };
      (localServer as any).logger = fakeLogger;

      const simpleTool = (localServer as any).profile.tools.find((t: any) => !t.composite);
      expect(simpleTool).toBeDefined();
      (localServer as any).toolGenerator.validateArguments = () => {};
      (localServer as any).executeSimpleTool = async () => ({ ok: true });

      // Install handlers and invoke the stdio CallTool handler via the SDK registration spy
      const handlers: Array<{ schema: unknown; handler: RequestHandler }> = [];
      const originalSet = (localServer as any).server.setRequestHandler.bind((localServer as any).server);
      (localServer as any).server.setRequestHandler = (schema: unknown, handler: RequestHandler) => {
        handlers.push({ schema, handler });
        return originalSet(schema, handler);
      };
      (localServer as any).setupHandlers();
      const callToolHandler = handlers.find(entry => {
        const schema: any = entry.schema;
        return schema?.shape?.method?.value === 'tools/call';
      })?.handler;
      expect(callToolHandler).toBeDefined();

      // Wire a no-op metrics collector so the recordToolCall path is exercised
      (localServer as any).httpTransport = {
        getMetricsCollector: () => ({
          recordToolCall: () => {},
          recordToolCallError: () => {},
        }),
      };

      await callToolHandler!({ params: { name: simpleTool.name, arguments: {} } });

      const audits = auditInfo.mock.calls.filter((c: unknown[]) => c[0] === 'audit:tool_call');
      expect(audits.length).toBeGreaterThanOrEqual(1);
      const payload = audits[audits.length - 1][1] as Record<string, unknown>;
      expect(payload).toMatchObject({
        sessionId: 'stdio',
        clientPrincipal: 'anonymous',
        tool: simpleTool.name,
        outcome: 'success',
      });
      expect(typeof payload.upstreamHost).toBe('string');
      expect(typeof payload.durationMs).toBe('number');
      expect(typeof payload.correlationId).toBe('string');
    });

    it('emits audit:tool_call with outcome=error on stdio path when tool throws', async () => {
      const localServer = new MCPServer();
      const specPath = path.join(process.cwd(), 'profiles/gitlab/openapi.yaml');
      await localServer.initialize(specPath);

      const auditInfo = vi.fn();
      const fakeLogger = {
        info: auditInfo,
        debug: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };
      (localServer as any).logger = fakeLogger;

      const simpleTool = (localServer as any).profile.tools.find((t: any) => !t.composite);
      expect(simpleTool).toBeDefined();
      (localServer as any).toolGenerator.validateArguments = () => {};
      (localServer as any).executeSimpleTool = async () => {
        throw new Error('stdio boom');
      };

      const handlers: Array<{ schema: unknown; handler: RequestHandler }> = [];
      const originalSet = (localServer as any).server.setRequestHandler.bind((localServer as any).server);
      (localServer as any).server.setRequestHandler = (schema: unknown, handler: RequestHandler) => {
        handlers.push({ schema, handler });
        return originalSet(schema, handler);
      };
      (localServer as any).setupHandlers();
      const callToolHandler = handlers.find(entry => {
        const schema: any = entry.schema;
        return schema?.shape?.method?.value === 'tools/call';
      })?.handler;

      (localServer as any).httpTransport = {
        getMetricsCollector: () => ({
          recordToolCall: () => {},
          recordToolCallError: () => {},
        }),
      };

      await expect(
        callToolHandler!({ params: { name: simpleTool.name, arguments: {} } }),
      ).rejects.toThrow();

      const audits = auditInfo.mock.calls.filter((c: unknown[]) => c[0] === 'audit:tool_call');
      const payload = audits[audits.length - 1][1] as Record<string, unknown>;
      expect(payload.outcome).toBe('error');
      expect(payload.sessionId).toBe('stdio');
      expect(payload.clientPrincipal).toBe('anonymous');
    });
  });
});

