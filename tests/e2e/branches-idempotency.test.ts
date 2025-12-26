import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { resolve } from 'path';
import { McpProcess, JsonRpcResponse } from './utils/mcp-process.js';
import { startStandaloneMockServer, getAvailablePort, MockServerInstance } from './utils/mock-server.js';
import { describeIfListen } from './utils/listen-support.js';

const PROFILE_PATH = resolve(process.cwd(), 'profiles/gitlab/developer-profile-oauth.json');
const OPENAPI_PATH = resolve(process.cwd(), 'profiles/gitlab/openapi.yaml');

interface ToolResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

function extractData(response: JsonRpcResponse) {
  expect(response.error).toBeUndefined();
  const result = response.result as ToolResult;
  expect(result.content?.[0]?.text).toBeDefined();
  return JSON.parse(result.content[0].text!);
}

describeIfListen('Branch Protect/Unprotect Idempotency E2E', () => {
  let mockServer: MockServerInstance;
  let mcp: McpProcess;
  let httpPort: number;
  const oauthEnv = {
    MCP4_OAUTH_ISSUER: 'https://gitlab.example.com',
    MCP4_OAUTH_CLIENT_ID: 'test-client-id',
    MCP4_OAUTH_CLIENT_SECRET: 'test-client-secret',
    MCP4_OAUTH_REDIRECT_URI: 'http://127.0.0.1/oauth/callback',
  };

  beforeAll(async () => {
    const port = await getAvailablePort();
    mockServer = await startStandaloneMockServer({ port });
    httpPort = await getAvailablePort();
    mcp = new McpProcess({
      transport: 'http',
      openapiSpecPath: OPENAPI_PATH,
      profilePath: PROFILE_PATH,
      apiBaseUrl: mockServer.gitlabApiUrl,
      apiToken: 'test-token-12345',
      httpPort,
      logLevel: 'ERROR',
      env: {
        // Prevent rate limit noise across repeated calls in one session
        MCP4_HTTP_RATE_LIMIT_ENABLED: 'false',
        ...oauthEnv,
      },
    });
    await mcp.start();
  });

  afterAll(async () => {
    await mcp.stop();
    await mockServer.stop();
  });

  beforeEach(async () => {
    await mcp.initialize();
  });

  it('protect / unprotect actions are idempotent', async () => {
    // Branch starts unprotected in the mock server state (feature/new-feature)
    const protectFirst = await mcp.callTool('manage_branches', {
      action: 'protect',
      project_id: '12345',
      branch: 'feature/new-feature'
    });
    const dataProtectFirst = extractData(protectFirst);
    expect(dataProtectFirst.protected).toBe(true);

    const protectSecond = await mcp.callTool('manage_branches', {
      action: 'protect',
      project_id: '12345',
      branch: 'feature/new-feature'
    });
    const dataProtectSecond = extractData(protectSecond);
    expect(dataProtectSecond.protected).toBe(true);

    const unprotectFirst = await mcp.callTool('manage_branches', {
      action: 'unprotect',
      project_id: '12345',
      branch: 'feature/new-feature'
    });
    const dataUnprotectFirst = extractData(unprotectFirst);
    expect(dataUnprotectFirst.protected).toBe(false);

    const unprotectSecond = await mcp.callTool('manage_branches', {
      action: 'unprotect',
      project_id: '12345',
      branch: 'feature/new-feature'
    });
    const dataUnprotectSecond = extractData(unprotectSecond);
    expect(dataUnprotectSecond.protected).toBe(false);
  }, 15000);
});
