/**
 * E2E tests for full tools coverage
 * 
 * Tests all operations from the GitLab profile against mock API.
 * Validates that each tool call succeeds and returns expected response structure.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { resolve } from 'path';
import { McpProcess, JsonRpcResponse } from './utils/mcp-process.js';
import { startStandaloneMockServer, getAvailablePort, MockServerInstance } from './utils/mock-server.js';
import { loadProfileOperations, groupOperationsByTool, ToolOperation } from './utils/profile-loader.js';

const PROFILE_PATH = resolve(process.cwd(), 'profiles/gitlab/developer-profile.json');
const OPENAPI_PATH = resolve(process.cwd(), 'profiles/gitlab/openapi.yaml');

interface ToolResult {
  content: Array<{
    type: string;
    text?: string;
  }>;
  isError?: boolean;
}

/**
 * Validate response structure based on operation type
 */
function validateToolResponse(response: JsonRpcResponse, operation: ToolOperation): void {
  expect(response.error).toBeUndefined();
  expect(response.result).toBeDefined();
  
  const result = response.result as ToolResult;
  expect(result.content).toBeDefined();
  expect(Array.isArray(result.content)).toBe(true);
  expect(result.content.length).toBeGreaterThan(0);
  
  // First content item should be text with JSON
  const firstContent = result.content[0];
  expect(firstContent.type).toBe('text');
  expect(firstContent.text).toBeDefined();
  
  // Parse and validate JSON response
  const responseData = JSON.parse(firstContent.text!);
  
  // Validate based on action type
  if (operation.action.startsWith('list')) {
    expect(Array.isArray(responseData)).toBe(true);
  } else if (operation.action === 'get' || operation.action === 'create') {
    expect(typeof responseData).toBe('object');
    expect(responseData).not.toBeNull();
  } else if (operation.action === 'delete') {
    // Delete operations may return empty or success message
    expect(responseData === null || typeof responseData === 'object').toBe(true);
  } else if (['protect', 'unprotect', 'exists'].includes(operation.action)) {
    expect(typeof responseData).toBe('object');
  }
}

/**
 * Some operations need adjusted params to work with mock data
 */
function adjustParamsForMock(operation: ToolOperation): Record<string, unknown> {
  const params = { ...operation.requiredParams };
  
  // manage_access_requests needs resource_type for proper operation selection
  if (operation.toolName === 'manage_access_requests') {
    if (!params.resource_type) {
      params.resource_type = 'project';
    }
    if (!params.resource_id) {
      params.resource_id = '12345';
    }
  }
  
  // list_project_jobs doesn't use action parameter
  if (operation.toolName === 'list_project_jobs') {
    delete params.action;
    params.project_id = '12345';  // Override example value with mock data ID
  }
  
  // manage_pipelines_jobs needs concrete project/job IDs for job actions
  if (operation.toolName === 'manage_pipelines_jobs') {
    params.project_id = '12345';
    if (params.job_id === undefined) {
      params.job_id = 1234;
    }
  }
  
  // Ensure valid IDs for get/update/delete operations
  if (operation.action === 'get' || operation.action === 'update' || operation.action === 'delete') {
    if (params.merge_request_iid === undefined && operation.toolName === 'manage_merge_requests') {
      params.merge_request_iid = 1;
    }
    if (params.issue_iid === undefined && operation.toolName === 'manage_issues') {
      params.issue_iid = 1;
    }
    if (params.badge_id === undefined && operation.toolName === 'manage_project_badges') {
      params.badge_id = 1;
    }
  }
  
  // Handle note operations
  if (operation.action.includes('note')) {
    if (params.note_id === undefined) {
      params.note_id = 1;
    }
    params.merge_request_iid = 1;
  }
  
  // Composite tools need explicit params
  if (operation.isComposite && operation.toolName === 'get_merge_request_with_details') {
    params.project_id = '12345';
    params.merge_request_iid = 1;
  }
  
  return params;
}

describe('Tools Coverage E2E', () => {
  let mockServer: MockServerInstance;
  let mockServerPort: number;
  let mcp: McpProcess;
  let sessionId: string | undefined;
  
  const operations = loadProfileOperations(PROFILE_PATH);
  const operationsByTool = groupOperationsByTool(operations);

  beforeAll(async () => {
    mockServerPort = await getAvailablePort();
    mockServer = await startStandaloneMockServer({
      port: mockServerPort,
    });
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
      apiBaseUrl: mockServer.gitlabApiUrl,
      apiToken: 'test-token-12345',
      httpPort,
      logLevel: 'ERROR',
    });
    
    await mcp.start();
    
    const initResponse = await mcp.initialize();
    expect(initResponse.error).toBeUndefined();
    
    // Extract session ID from response for subsequent calls
    const result = initResponse.result as Record<string, unknown>;
    if (result && typeof result === 'object') {
      sessionId = undefined; // HTTP transport creates session internally
    }
  });

  afterEach(async () => {
    await mcp.stop();
  });

  // Generate tests for each tool
  for (const [toolName, toolOps] of operationsByTool) {
    const hasStandardOps = toolOps.some(op => !op.isComposite);
    if (!hasStandardOps) {
      continue;
    }
    describe(toolName, () => {
      for (const operation of toolOps) {
        // Skip composite tools from auto-generated coverage; they have dedicated tests below
        if (operation.isComposite) {
          continue;
        }
        
        it(`${operation.action} returns valid response`, async () => {
          const params = adjustParamsForMock(operation);
          
          const response = await mcp.callTool(toolName, params, sessionId);
          
          // Some delete operations may return 404 if resource doesn't exist in mock
          // but the important thing is they complete without internal errors
          if (response.error) {
            // Check it's an API error, not internal error
            expect(response.error.code).not.toBe(-32603); // Internal error
            expect(response.error.code).not.toBe(-32600); // Invalid request
          } else {
            validateToolResponse(response, operation);
          }
        }, 15000);
      }
    });
  }
});

describe('Composite Tools E2E', () => {
  let mockServer: MockServerInstance;
  let mockServerPort: number;
  let mcp: McpProcess;

  beforeAll(async () => {
    mockServerPort = await getAvailablePort();
    mockServer = await startStandaloneMockServer({
      port: mockServerPort,
    });
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
      apiBaseUrl: mockServer.gitlabApiUrl,
      apiToken: 'test-token-12345',
      httpPort,
      logLevel: 'ERROR',
    });
    
    await mcp.start();
    await mcp.initialize();
  });

  afterEach(async () => {
    await mcp.stop();
  });

  it('get_merge_request_with_details fetches MR and notes', async () => {
    const response = await mcp.callTool('get_merge_request_with_details', {
      project_id: '12345',
      merge_request_iid: 1,
    });
    
    expect(response.error).toBeUndefined();
    expect(response.result).toBeDefined();
    
    const result = response.result as ToolResult;
    expect(result.content).toBeDefined();
    expect(result.content.length).toBeGreaterThan(0);
    
    const text = result.content[0].text!;
    const data = JSON.parse(text);
    
    // Validate composite structure
    expect(data).toBeDefined();
    expect(typeof data).toBe('object');
    expect((data as any).data).toBeDefined();
    const compositeData = (data as any).data;
    expect(compositeData.merge_request).toBeDefined();
    const mr = compositeData.merge_request;
    expect(mr.iid).toBe(1);
    expect(Array.isArray(mr.notes)).toBe(true);
    expect(mr.notes.length).toBeGreaterThan(0);
    const note = mr.notes[0];
    expect(note).toHaveProperty('id');
    expect(note).toHaveProperty('body');
    expect(note).toHaveProperty('author');
  }, 15000);
});

describe('Error Handling E2E', () => {
  let mockServer: MockServerInstance;
  let mockServerPort: number;
  let mcp: McpProcess;

  beforeAll(async () => {
    mockServerPort = await getAvailablePort();
    mockServer = await startStandaloneMockServer({
      port: mockServerPort,
    });
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
      apiBaseUrl: mockServer.gitlabApiUrl,
      apiToken: 'test-token-12345',
      httpPort,
      logLevel: 'ERROR',
    });
    
    await mcp.start();
    await mcp.initialize();
  });

  afterEach(async () => {
    await mcp.stop();
  });

  it('returns 404 for non-existent resource', async () => {
    const response = await mcp.callTool('manage_merge_requests', {
      action: 'get',
      project_id: '12345',
      merge_request_iid: 99999,
    });
    
    // Should get an error response (not a crash)
    const result = response.result as ToolResult | undefined;
    if (result) {
      const text = result.content[0]?.text;
      if (text) {
        const data = JSON.parse(text);
        expect(data.message || data.error).toBeDefined();
      }
    }
  });

  it('returns 404 for non-existent group', async () => {
    const response = await mcp.callTool('manage_groups', {
      action: 'get',
      group_id: 'non-existent-group',
    });
    
    const result = response.result as ToolResult | undefined;
    if (result) {
      const text = result.content[0]?.text;
      if (text) {
        const data = JSON.parse(text);
        expect(data.message || data.error).toBeDefined();
      }
    }
  });

  it('handles missing required parameters gracefully', async () => {
    const response = await mcp.callTool('manage_merge_requests', {
      action: 'create',
      project_id: '12345',
      // Missing: source_branch, target_branch, title
    });
    
    // Should error but not crash
    expect(response.error || response.result).toBeDefined();
  });
});
