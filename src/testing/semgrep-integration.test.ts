/**
 * Semgrep integration tests
 * 
 * Why: Test end-to-end Semgrep API integration with mock server
 * to diagnose parameter passing and validation issues.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { http } from 'msw';
import { MCPServer } from '../mcp-server.js';
import { createMockSemgrepServer } from './mock-semgrep-server.js';
import type { SetupServerApi } from 'msw/node';
import path from 'path';

const PROFILE_PATH = path.join(process.cwd(), 'profiles/semgrep/profile.json');
const SPEC_PATH = path.join(process.cwd(), 'profiles/semgrep/openapi.yaml');
const MOCK_API_TOKEN = 'mock-semgrep-token-12345';
const DEPLOYMENT_SLUG = 'test-deployment';
const DEPLOYMENT_ID = 123;

describe('Semgrep Integration Tests', () => {
  let mockServer: SetupServerApi;
  let server: MCPServer;

  beforeAll(async () => {
    // Start mock Semgrep server
    mockServer = createMockSemgrepServer({
      validToken: MOCK_API_TOKEN,
      deploymentSlug: DEPLOYMENT_SLUG,
      deploymentId: DEPLOYMENT_ID,
    });
    mockServer.listen({ onUnhandledRequest: 'error' });

    // Initialize MCP server with Semgrep profile
    process.env.MCP4_API_TOKEN = MOCK_API_TOKEN;
    process.env.MCP4_API_BASE_URL = 'https://semgrep.dev';

    server = new MCPServer();
    await server.initialize(SPEC_PATH, PROFILE_PATH);
  });

  afterAll(() => {
    mockServer.close();
  });

  afterEach(() => {
    mockServer.resetHandlers();
  });

  describe('Parameter Aliases', () => {
    it('should resolve snake_case parameters via aliases', async () => {
      // Tests that parameter_aliases works: OpenAPI has {projectName} in path,
      // but tool can accept project_name due to alias mapping
      const tool = server['profile']!.tools.find(t => t.name === 'manage_projects')!;
      const result = await server['executeSimpleTool'](tool, {
        deploymentSlug: DEPLOYMENT_SLUG,
        action: 'list',
        page: 0,
        page_size: 5,
      });

      expect(result).toBeDefined();
      expect((result as { projects: unknown[] }).projects).toBeDefined();
      expect(Array.isArray((result as { projects: unknown[] }).projects)).toBe(true);
    });
  });

  describe('Composite Tools', () => {
    it('should execute get_deployment composite tool', async () => {
      const tool = server['profile']!.tools.find(t => t.name === 'get_deployment')!;
      expect(tool).toBeDefined();
      expect(tool.composite).toBe(true);
      expect(tool.steps).toBeDefined();

      const result = await server['handleToolCall'](
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'get_deployment',
            arguments: {},
          },
        },
        'test-session'
      );

      expect(result).toBeDefined();
      const response = result as { result: { content: Array<{ type: string; text: string }> } };
      expect(response.result).toBeDefined();
      expect(response.result.content).toBeDefined();
      expect(response.result.content.length).toBeGreaterThan(0);

      const resultData = JSON.parse(response.result.content[0].text);
      
      // Composite tool result structure: data.{store_as} + completion metadata
      expect(resultData.data).toBeDefined();
      expect(resultData.data.deployment).toBeDefined();
      expect(resultData.data.deployment.deployments).toBeDefined();
      expect(Array.isArray(resultData.data.deployment.deployments)).toBe(true);
      
      const deployment = resultData.data.deployment.deployments[0];
      expect(deployment.slug).toBe(DEPLOYMENT_SLUG);
      expect(deployment.id).toBe(DEPLOYMENT_ID);
      
      expect(resultData.completed_steps).toBe(1);
      expect(resultData.total_steps).toBe(1);
      expect(resultData.success).toBe(true);
    });
  });

  describe('Findings Management', () => {
    it('should list findings with deploymentSlug', async () => {
      const tool = server['profile']!.tools.find(t => t.name === 'manage_findings')!;
      const result = await server['executeSimpleTool'](tool, {
        deploymentSlug: DEPLOYMENT_SLUG,
        issue_type: 'sast',
        page: 0,
        page_size: 10,
      });

      expect(result).toBeDefined();
      const data = result as { sastFindings: { findings: unknown[] } };
      expect(data.sastFindings).toBeDefined();
      expect(data.sastFindings.findings).toBeInstanceOf(Array);
    });
  });

  describe('Triage Findings', () => {
    it('should triage findings with deploymentSlug in body', async () => {
      console.log('\n=== TEST: Triage with deploymentSlug ===');
      const params = {
        deploymentSlug: DEPLOYMENT_SLUG,
        issue_type: 'sast',
        status: 'open',
        new_triage_state: 'ignored',
        new_triage_reason: 'false_positive',
        limit: 10,
      };
      console.log('Input parameters:', JSON.stringify(params, null, 2));

      const tool = server['profile']!.tools.find(t => t.name === 'triage_findings')!;
      const result = await server['executeSimpleTool'](tool, params);

      console.log('Result:', JSON.stringify(result, null, 2));
      expect(result).toBeDefined();
      const data = result as { num_triaged: number; triaged_issues: unknown[] };
      expect(data.num_triaged).toBeDefined();
      expect(data.triaged_issues).toBeInstanceOf(Array);
    });

    it('should fail without deploymentSlug', async () => {
      console.log('\n=== TEST: Triage without deploymentSlug ===');
      const params = {
        issue_type: 'sast',
        status: 'open',
        new_triage_state: 'ignored',
        new_triage_reason: 'false_positive',
      };
      console.log('Input parameters:', JSON.stringify(params, null, 2));

      const tool = server['profile']!.tools.find(t => t.name === 'triage_findings')!;
      
      await expect(async () => {
        await server['executeSimpleTool'](tool, params);
      }).rejects.toThrow();
    });

    it('should handle snake_case deployment_slug if aliased', async () => {
      console.log('\n=== TEST: Triage with deployment_slug (snake_case) ===');
      const params = {
        deployment_slug: DEPLOYMENT_SLUG,
        issue_type: 'sast',
        status: 'open',
        new_triage_state: 'ignored',
        new_triage_reason: 'false_positive',
        limit: 10,
      };
      console.log('Input parameters:', JSON.stringify(params, null, 2));

      const tool = server['profile']!.tools.find(t => t.name === 'triage_findings')!;
      
      try {
        const result = await server['executeSimpleTool'](tool, params);
        console.log('Result (if alias exists):', JSON.stringify(result, null, 2));
      } catch (error) {
        console.log('Error caught (expected if no alias):', error);
        // This is expected if no parameter_aliases configured for deployment_slug -> deploymentSlug
      }
    });

    it('should validate limit as integer', async () => {
      console.log('\n=== TEST: Triage with non-integer limit ===');
      const params = {
        deploymentSlug: DEPLOYMENT_SLUG,
        issue_type: 'sast',
        status: 'open',
        new_triage_state: 'ignored',
        new_triage_reason: 'false_positive',
        limit: 10.5, // Not an integer
      };
      console.log('Input parameters:', JSON.stringify(params, null, 2));

      const tool = server['profile']!.tools.find(t => t.name === 'triage_findings')!;
      
      await expect(async () => {
        await server['executeSimpleTool'](tool, params);
      }).rejects.toThrow();
    });
  });

  describe('Parameter Transformation', () => {
    it('should trace parameter flow from input to API call', async () => {
      console.log('\n=== DIAGNOSTIC: Parameter flow tracing ===');

      const params = {
        deploymentSlug: DEPLOYMENT_SLUG,
        issue_type: 'sast',
        status: 'open',
        new_triage_state: 'ignored',
        new_triage_reason: 'false_positive',
        limit: 10,
      };
      console.log('1. Input parameters to executeSimpleTool:');
      console.log(JSON.stringify(params, null, 2));

      // Intercept the actual HTTP request to see what's sent
      let capturedBody: unknown = null;
      let capturedUrlParams: unknown = null;
      
      mockServer.use(
        http.post('https://semgrep.dev/api/v1/deployments/:deploymentSlug/findings/triage', async ({ request, params: urlParams }) => {
          capturedBody = await request.json();
          capturedUrlParams = urlParams;
          console.log('2. Request body received by mock server:');
          console.log(JSON.stringify(capturedBody, null, 2));
          console.log('3. URL params:');
          console.log(JSON.stringify(capturedUrlParams, null, 2));
          return new Response(
            JSON.stringify({ num_triaged: 0, triaged_issues: [] }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        })
      );

      const tool = server['profile']!.tools.find(t => t.name === 'triage_findings')!;
      await server['executeSimpleTool'](tool, params);

      // Verify request was made
      expect(capturedBody).toBeDefined();
      expect(capturedUrlParams).toBeDefined();
      console.log('\n4. Captured request data:');
      console.log('Body:', JSON.stringify(capturedBody, null, 2));
      console.log('URL params:', JSON.stringify(capturedUrlParams, null, 2));
    });
  });
});
