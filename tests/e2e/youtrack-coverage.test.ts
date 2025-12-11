import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { resolve } from 'path';
import { readFileSync } from 'fs';
import { McpProcess, JsonRpcResponse } from './utils/mcp-process.js';
import {
  startStandaloneYoutrackMockServer,
  getAvailablePort,
  YoutrackMockServerInstance,
} from './utils/mock-youtrack-server.js';
import { loadProfileOperations, groupOperationsByTool } from './utils/profile-loader.js';

const PROFILE_PATH = resolve(process.cwd(), 'profiles/youtrack/profile.json');
const OPENAPI_PATH = resolve(process.cwd(), 'profiles/youtrack/openapi.json');

type ToolResult = {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
};

const profile = JSON.parse(readFileSync(PROFILE_PATH, 'utf-8')) as {
  tools: Array<{
    name: string;
    response_fields?: Record<string, string[]>;
    send_response_fields_as_param?: boolean;
  }>;
};

function hasResponseFields(toolName: string, action: string): boolean {
  const tool = profile.tools.find((t) => t.name === toolName);
  return Boolean(tool?.send_response_fields_as_param && tool.response_fields?.[action]);
}

function parseResult(response: JsonRpcResponse): any {
  if (response.error) {
    // Surface server-side validation details when a call fails
    // eslint-disable-next-line no-console
    console.error('YouTrack tool call error', response.error);
  }
  expect(response.error).toBeUndefined();
  const result = response.result as ToolResult;
  expect(result.content?.length).toBeGreaterThan(0);
  const payloadText = result.content[0].text;
  expect(payloadText).toBeDefined();
  return JSON.parse(payloadText!);
}

describe('YouTrack Tools Coverage E2E', () => {
  let mockServer: YoutrackMockServerInstance;
  let mockServerPort: number;
  let mcp: McpProcess;
  let sessionId: string | undefined;

  const operations = loadProfileOperations(PROFILE_PATH);
  const operationsByTool = groupOperationsByTool(operations);

  beforeAll(async () => {
    mockServerPort = await getAvailablePort();
    mockServer = await startStandaloneYoutrackMockServer({ port: mockServerPort });
  });

  afterAll(async () => {
    await mockServer.stop();
  });

  beforeEach(async () => {
    const httpPort = await getAvailablePort();
    mcp = new McpProcess({
      transport: 'http',
      openapiSpecPath: OPENAPI_PATH,
      profilePath: PROFILE_PATH,
      apiBaseUrl: mockServer.youtrackApiUrl,
      apiToken: 'yt-test-token',
      httpPort,
      logLevel: 'ERROR',
    });

    mcp.on('stderr', (data) => {
      // eslint-disable-next-line no-console
      console.error(data);
    });

    await mcp.start();

    const initResponse = await mcp.initialize();
    expect(initResponse.error).toBeUndefined();
    sessionId = undefined;
  });

  afterEach(async () => {
    await mcp.stop();
  });

  for (const [toolName, toolOps] of operationsByTool) {
    describe(toolName, () => {
      for (const operation of toolOps) {
        it(`${operation.action} completes with structured payload`, async () => {
          const requestCount = mockServer.requests.length;
          const params = { ...operation.requiredParams };
          if (operation.action && !operation.isComposite) {
            params.action = operation.action;
          }

          const response = await mcp.callTool(toolName, params, sessionId);
          const newRequests = mockServer.requests.slice(requestCount);
          let payload: any;
          try {
            payload = parseResult(response);
          } catch (err) {
            // eslint-disable-next-line no-console
            console.error('Captured requests for failed call', newRequests);
            throw err;
          }

          if (hasResponseFields(toolName, operation.action)) {
            const requestWithFields = newRequests.find(r => r.query.fields !== undefined);
            if (!requestWithFields) {
              // eslint-disable-next-line no-console
              console.error('Missing fields parameter in requests', { action: operation.action, requests: newRequests });
            }
            expect(requestWithFields?.query.fields).toBeDefined();
          }

          if (operation.isProxyDownload) {
            expect(payload.content).toBeDefined();
            expect(payload.mimeType).toBeDefined();
            expect(payload.metadata?.url || payload.metadata?.data?.url).toBeDefined();
          } else if (Array.isArray(payload)) {
            expect(payload.length).toBeGreaterThan(0);
          } else {
            expect(newRequests.length).toBeGreaterThan(0);
            expect(payload).not.toBeUndefined();
          }
        }, 20000);
      }
    });
  }
});
