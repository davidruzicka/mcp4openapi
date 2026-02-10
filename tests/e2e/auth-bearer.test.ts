/**
 * E2E tests for Bearer token authentication
 */

import { it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import * as path from 'path';
import { McpProcess } from './utils/mcp-process.js';
import { startStandaloneMockServer, MockServerInstance } from './utils/mock-server.js';
import { describeIfListen } from './utils/listen-support.js';

describeIfListen('E2E: Bearer token authentication', () => {
  let mockServer: MockServerInstance;
  let mcp: McpProcess;

  const openapiSpecPath = path.resolve(process.cwd(), 'profiles/gitlab/openapi.yaml');
  const profilePath = path.resolve(process.cwd(), 'profiles/gitlab/developer-profile-oauth.json');

  beforeAll(async () => {
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

  it('should authenticate with bearer token', async () => {
    mcp = new McpProcess({
      transport: 'stdio',
      openapiSpecPath,
      profilePath,
      apiBaseUrl: mockServer.gitlabApiUrl,
      apiToken: 'valid-bearer-token',
      env: { MCP4_SSRF_ALLOW_PRIVATE_NETWORK: 'true' },
    });

    await mcp.start();
    await mcp.initialize();

    const response = await mcp.listTools();
    expect(response.error).toBeUndefined();
    expect((response.result as { tools: unknown[] }).tools.length).toBeGreaterThan(0);
  }, 15000);

  it('should reject missing token when auth is configured', async () => {
    mcp = new McpProcess({
      transport: 'stdio',
      openapiSpecPath,
      profilePath,
      apiBaseUrl: mockServer.gitlabApiUrl,
      // No apiToken
      env: { MCP4_SSRF_ALLOW_PRIVATE_NETWORK: 'true' },
    });

    await mcp.start();
    await mcp.initialize();

    const response = await mcp.callTool('manage_groups', {
      action: 'list'
    });
    expect(response.error).toBeDefined();
  }, 15000);

  it('should use custom token env var', async () => {
    mcp = new McpProcess({
      transport: 'stdio',
      openapiSpecPath,
      profilePath,
      apiBaseUrl: mockServer.gitlabApiUrl,
      env: {
        CUSTOM_TOKEN: 'my-custom-token',
        MCP4_AUTH_ENV_VAR: 'CUSTOM_TOKEN',
        MCP4_SSRF_ALLOW_PRIVATE_NETWORK: 'true',
      },
    });

    await mcp.start();
    await mcp.initialize();

    const response = await mcp.listTools();
    expect(response.error).toBeUndefined();
  }, 15000);
});
