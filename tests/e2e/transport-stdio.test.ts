/**
 * E2E tests for stdio transport
 * 
 * Why: Verifies MCP server works correctly with stdio transport,
 * which is the primary mode for local development and IDE integration.
 */

import { it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import * as path from 'path';
import { McpProcess } from './utils/mcp-process.js';
import { startStandaloneMockServer, MockServerInstance } from './utils/mock-server.js';
import { describeIfListen } from './utils/listen-support.js';

describeIfListen('E2E: stdio transport', () => {
  let mockServer: MockServerInstance;
  let mcp: McpProcess;

  const openapiSpecPath = path.resolve(process.cwd(), 'profiles/gitlab/openapi.yaml');
  const profilePath = path.resolve(process.cwd(), 'profiles/gitlab/developer-profile.json');

  beforeAll(async () => {
    // Start mock GitLab API server
    mockServer = await startStandaloneMockServer({
      apiBasePath: '/api/v4',
    });
  }, 30000);

  afterAll(async () => {
    await mockServer?.stop();
  });

  afterEach(async () => {
    await mcp?.stop();
  });

  it('should initialize MCP session via stdio', async () => {
    mcp = new McpProcess({
      transport: 'stdio',
      openapiSpecPath,
      profilePath,
      apiBaseUrl: mockServer.gitlabApiUrl,
      apiToken: 'test-token',
    });

    await mcp.start();
    const response = await mcp.initialize();

    expect(response.jsonrpc).toBe('2.0');
    expect(response.error).toBeUndefined();
    expect(response.result).toBeDefined();
    expect((response.result as Record<string, unknown>).protocolVersion).toBeDefined();
  }, 15000);

  it('should list available tools', async () => {
    mcp = new McpProcess({
      transport: 'stdio',
      openapiSpecPath,
      profilePath,
      apiBaseUrl: mockServer.gitlabApiUrl,
      apiToken: 'test-token',
    });

    await mcp.start();
    await mcp.initialize();
    
    const response = await mcp.listTools();

    expect(response.error).toBeUndefined();
    expect(response.result).toBeDefined();
    
    const result = response.result as { tools: Array<{ name: string }> };
    expect(result.tools).toBeInstanceOf(Array);
    expect(result.tools.length).toBeGreaterThan(0);
  }, 15000);

  it('should call a tool and get response from mock API', async () => {
    mcp = new McpProcess({
      transport: 'stdio',
      openapiSpecPath,
      profilePath,
      apiBaseUrl: mockServer.gitlabApiUrl,
      apiToken: 'test-token',
    });

    await mcp.start();
    await mcp.initialize();

    const callResponse = await mcp.callTool('manage_branches', {
      action: 'list',
      project_id: '12345',
    });

    expect(callResponse.jsonrpc).toBe('2.0');
    expect(callResponse.error).toBeUndefined();

    const content = (callResponse.result as { content: Array<{ text?: string }> }).content?.[0]?.text;
    expect(content).toBeDefined();

    const data = JSON.parse(content || '{}') as Array<{ name: string }>;
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThan(0);
  }, 20000);

  it('should handle invalid tool call gracefully', async () => {
    mcp = new McpProcess({
      transport: 'stdio',
      openapiSpecPath,
      profilePath,
      apiBaseUrl: mockServer.gitlabApiUrl,
      apiToken: 'test-token',
    });

    await mcp.start();
    await mcp.initialize();

    const response = await mcp.callTool('nonexistent_tool', {});

    // Should return an error response, not crash
    expect(response.jsonrpc).toBe('2.0');
    expect(response.error).toBeDefined();
  }, 15000);

  it('should work without profile (auto-generate tools)', async () => {
    mcp = new McpProcess({
      transport: 'stdio',
      openapiSpecPath,
      // No profilePath - should auto-generate tools
      apiBaseUrl: mockServer.gitlabApiUrl,
      apiToken: 'test-token',
    });

    await mcp.start();
    await mcp.initialize();
    
    const response = await mcp.listTools();

    expect(response.error).toBeUndefined();
    const result = response.result as { tools: Array<{ name: string }> };
    expect(result.tools.length).toBeGreaterThan(0);
  }, 15000);
});
