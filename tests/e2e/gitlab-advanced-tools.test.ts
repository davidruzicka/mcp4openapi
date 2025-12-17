/**
 * Focused e2e coverage for high-risk GitLab flows that rely on proxy downloads
 * and multi-step merge request workflows.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { resolve } from 'path';
import { McpProcess, JsonRpcResponse } from './utils/mcp-process.js';
import { startStandaloneMockServer, getAvailablePort, MockServerInstance } from './utils/mock-server.js';

const PROFILE_PATH = resolve(process.cwd(), 'profiles/gitlab/developer-profile.json');
const OPENAPI_PATH = resolve(process.cwd(), 'profiles/gitlab/openapi.yaml');

interface ToolResultEnvelope {
  content: Array<{ type: string; text?: string }>;
}

async function parseToolResponse(responsePromise: Promise<JsonRpcResponse>) {
  const response = await responsePromise;
  expect(response.error).toBeUndefined();

  const envelope = response.result as ToolResultEnvelope;
  expect(envelope?.content?.length).toBeGreaterThan(0);
  const first = envelope.content[0];
  expect(first.type).toBe('text');
  expect(first.text).toBeDefined();

  return JSON.parse(first.text!);
}

describe('GitLab advanced flows E2E', () => {
  let mockServer: MockServerInstance;
  let mcp: McpProcess;
  let httpPort: number;

  beforeAll(async () => {
    mockServer = await startStandaloneMockServer();
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
        // Disable rate limiting for shared-session E2E run
        MCP4_HTTP_RATE_LIMIT_ENABLED: 'false',
      },
    });

    await mcp.start();
  });

  beforeEach(async () => {
    const initResponse = await mcp.initialize();
    expect(initResponse.error).toBeUndefined();
  });

  afterAll(async () => {
    if (mcp) {
      await mcp.stop();
    }
    if (mockServer) {
      await mockServer.stop();
    }
  });

  describe('Pipelines and jobs', () => {
    it('runs pipeline and retries job successfully', async () => {
      const pipeline = await parseToolResponse(
        mcp.callTool('manage_pipelines_jobs', {
          action: 'run_pipeline',
          project_id: 'my-org/my-project',
          ref: 'main',
        })
      );

      expect(pipeline).toMatchObject({
        id: 501,
        status: expect.any(String),
        ref: 'main',
      });

      const retriedJob = await parseToolResponse(
        mcp.callTool('manage_pipelines_jobs', {
          action: 'retry_job',
          project_id: 'my-org/my-project',
          job_id: 1234,
        })
      );

      expect(retriedJob).toMatchObject({
        id: 1234,
        status: 'pending',
      });
    });

    it('downloads job artifacts via proxy download', async () => {
      const download = await parseToolResponse(
        mcp.callTool('manage_pipelines_jobs', {
          action: 'download_job_artifacts',
          project_id: 'my-org/my-project',
          job_id: 1234,
        })
      );

      expect(download.mimeType).toBe('application/octet-stream');
      expect(download.size).toBeGreaterThan(0);
      expect(typeof download.content).toBe('string');
      expect(download.content).toBe('YXJ0aWZhY3QgZGF0YQo=');
    });
  });

  describe('Snippets proxy download', () => {
    it('downloads snippet raw content via proxy download', async () => {
      const snippet = await parseToolResponse(
        mcp.callTool('manage_snippets', {
          action: 'download_snippet',
          project_id: 'my-org/my-project',
          snippet_id: 1,
        })
      );

      expect(snippet.mimeType).toBe('text/plain');
      expect(snippet.size).toBeGreaterThan(0);
      expect(snippet.content).toBe('c25pcHBldCBjb250ZW50Cg==');
    });
  });

  describe('Merge request discussions and approvals', () => {
    it('resolves discussion and returns resolved state', async () => {
      const discussion = await parseToolResponse(
        mcp.callTool('manage_merge_requests', {
          action: 'resolve_discussion',
          project_id: 'my-org/my-project',
          merge_request_iid: 1,
          discussion_id: 'disc-1',
        })
      );

      expect(discussion.id).toBe('disc-1');
      expect(discussion.resolved).toBe(true);
    });

    it('fetches approvals and approves merge request', async () => {
      const approvalsBefore = await parseToolResponse(
        mcp.callTool('manage_merge_requests', {
          action: 'get_approvals',
          project_id: 'my-org/my-project',
          merge_request_iid: 1,
        })
      );

      expect(approvalsBefore.approvals_left).toBeGreaterThan(0);

      const approvalsAfter = await parseToolResponse(
        mcp.callTool('manage_merge_requests', {
          action: 'approve',
          project_id: 'my-org/my-project',
          merge_request_iid: 1,
        })
      );

      expect(approvalsAfter.approvals_left).toBe(0);
      expect(Array.isArray(approvalsAfter.approved_by)).toBe(true);
    });
  });
});
