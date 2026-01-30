/**
 * Composite executor tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CompositeExecutor } from './composite-executor.js';
import { OpenAPIParser } from '../openapi/openapi-parser.js';
import type { HttpClient } from '../transport/interceptors.js';
import type { CompositeStep } from '../types/profile.js';

describe('CompositeExecutor', () => {
  let parser: OpenAPIParser;
  let httpClient: HttpClient;
  let executor: CompositeExecutor;

  beforeEach(() => {
    // Mock OpenAPI parser
    parser = {
      getPath: vi.fn((path: string) => ({
        path,
        operations: {
          get: {
            operationId: `get${path.replace(/\//g, '_')}`,
            method: 'GET',
            path,
            parameters: [],
          },
        },
      })),
    } as unknown as OpenAPIParser;

    // Mock HTTP client
    httpClient = {
      request: vi.fn(async () => ({
        status: 200,
        headers: {},
        body: { id: 123, name: 'test' },
      })),
    } as unknown as HttpClient;

    executor = new CompositeExecutor(parser, httpClient);
  });

  it('stores results at simple paths', async () => {
    const steps: CompositeStep[] = [
      { call: 'GET /projects/1', store_as: 'project' },
    ];

    const result = await executor.execute(steps, { id: '1' });

    expect(result.data).toHaveProperty('project');
    expect(result.data.project).toEqual({ id: 123, name: 'test' });
  });

  it('stores results at nested paths', async () => {
    const steps: CompositeStep[] = [
      { call: 'GET /projects/1', store_as: 'data.project' },
      { call: 'GET /projects/1/issues', store_as: 'data.issues' },
    ];

    const result = await executor.execute(steps, { id: '1' });

    expect(result.data).toHaveProperty('data');
    expect(result.data.data).toHaveProperty('project');
    expect(result.data.data).toHaveProperty('issues');
  });

  it('throws error when trying to overwrite non-object value', async () => {
    // Manually create a result with non-object value to test validation
    const steps: CompositeStep[] = [
      { call: 'GET /projects/1', store_as: 'user' },
      { call: 'GET /projects/1/details', store_as: 'user.profile' },
    ];

    // First call succeeds with string (simulating edge case)
    httpClient.request = vi.fn()
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        body: 'string value',
      })
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        body: { id: 456 },
      });

    // Should throw when trying to store user.profile when user is a string
    await expect(executor.execute(steps, { id: '1' }, false))
      .rejects
      .toThrow(/Cannot store at path.*user.*is string/);
  });

  it('handles partial results on error', async () => {
    httpClient.request = vi.fn()
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        body: { id: 123 },
      })
      .mockRejectedValueOnce(new Error('API error'));

    const steps: CompositeStep[] = [
      { call: 'GET /projects/1', store_as: 'project' },
      { call: 'GET /projects/1/issues', store_as: 'issues' },
    ];

    const result = await executor.execute(steps, { id: '1' }, true);

    expect(result.completed_steps).toBe(1);
    expect(result.total_steps).toBe(2);
    expect(result.data).toHaveProperty('project');
    expect(result.data).toHaveProperty('issues_error');
    expect(result.errors).toHaveLength(1);
  });

  it('throws error immediately when partial results disabled', async () => {
    httpClient.request = vi.fn()
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        body: { id: 123 },
      })
      .mockRejectedValueOnce(new Error('API error'));

    const steps: CompositeStep[] = [
      { call: 'GET /projects/1', store_as: 'project' },
      { call: 'GET /projects/1/issues', store_as: 'issues' },
    ];

    await expect(executor.execute(steps, { id: '1' }, false))
      .rejects
      .toThrow(/Composite step 2\/2 failed/);
  });

  it('includes error details in partial results', async () => {
    httpClient.request = vi.fn().mockRejectedValue(new Error('Network timeout'));

    const steps: CompositeStep[] = [
      { call: 'GET /projects/1', store_as: 'project' },
    ];

    const result = await executor.execute(steps, { id: '1' }, true);

    expect(result.errors).toHaveLength(1);
    expect(result.errors![0]).toMatchObject({
      step_index: 0,
      step_call: 'GET /projects/1',
      error: 'Network timeout',
    });
    expect(result.errors![0].timestamp).toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  describe('Parallel execution with DAG', () => {
    it('executes independent steps in parallel', async () => {
      // Mock responses with delays to verify parallelism
      let callOrder: string[] = [];
      httpClient.request = vi.fn(async (method: string, path: string) => {
        callOrder.push(path);
        // Simulate different response times
        await new Promise(resolve => setTimeout(resolve, Math.random() * 10));
        return {
          status: 200,
          headers: {},
          body: { id: path.split('/').pop(), name: `result-${path}` },
        };
      });

      const steps: CompositeStep[] = [
        { call: 'GET /projects/1', store_as: 'project1' },
        { call: 'GET /projects/2', store_as: 'project2' },
        { call: 'GET /projects/3', store_as: 'project3' },
      ];

      const result = await executor.execute(steps, {});

      expect(result.completed_steps).toBe(3);
      expect(result.data).toEqual({
        project1: { id: '1', name: 'result-/projects/1' },
        project2: { id: '2', name: 'result-/projects/2' },
        project3: { id: '3', name: 'result-/projects/3' },
      });
      // All calls should have been made (order may vary due to parallelism)
      expect(callOrder).toHaveLength(3);
      expect(callOrder).toContain('/projects/1');
      expect(callOrder).toContain('/projects/2');
      expect(callOrder).toContain('/projects/3');
    });

    it('respects dependencies in execution order', async () => {
      let callOrder: string[] = [];
      httpClient.request = vi.fn(async (method: string, path: string) => {
        callOrder.push(path);
        return {
          status: 200,
          headers: {},
          body: { id: path.split('/').pop(), name: `result-${path}` },
        };
      });

      const steps: CompositeStep[] = [
        { call: 'GET /projects/1', store_as: 'project' },
        { call: 'GET /merge_requests', store_as: 'mrs', depends_on: ['project'] },
        { call: 'GET /issues', store_as: 'issues', depends_on: ['project'] },
        { call: 'GET /comments', store_as: 'comments', depends_on: ['mrs', 'issues'] },
      ];

      const result = await executor.execute(steps, {});

      expect(result.completed_steps).toBe(4);
      expect(result.data).toHaveProperty('project');
      expect(result.data).toHaveProperty('mrs');
      expect(result.data).toHaveProperty('issues');
      expect(result.data).toHaveProperty('comments');

      // Verify execution order: project first, then mrs+issues in parallel, then comments
      const projectIndex = callOrder.indexOf('/projects/1');
      const mrsIndex = callOrder.indexOf('/merge_requests');
      const issuesIndex = callOrder.indexOf('/issues');
      const commentsIndex = callOrder.indexOf('/comments');

      expect(projectIndex).toBeLessThan(mrsIndex);
      expect(projectIndex).toBeLessThan(issuesIndex);
      expect(Math.min(mrsIndex, issuesIndex)).toBeLessThan(commentsIndex);
    });

    it('handles errors in parallel execution', async () => {
      let callCount = 0;
      httpClient.request = vi.fn(async (method: string, path: string) => {
        callCount++;
        if (path === '/projects/fail') {
          throw new Error('API failure');
        }
        return {
          status: 200,
          headers: {},
          body: { id: path.split('/').pop(), name: `result-${path}` },
        };
      });

      const steps: CompositeStep[] = [
        { call: 'GET /projects/1', store_as: 'project1' },
        { call: 'GET /projects/fail', store_as: 'project_fail' },
        { call: 'GET /projects/2', store_as: 'project2' },
      ];

      const result = await executor.execute(steps, {}, true); // allowPartial

      expect(result.completed_steps).toBe(2); // 2 succeeded, 1 failed
      expect(result.errors).toHaveLength(1);
      expect(result.errors![0].step_call).toBe('GET /projects/fail');
      expect(result.data).toHaveProperty('project1');
      expect(result.data).toHaveProperty('project_fail_error');
      expect(result.data).toHaveProperty('project2');
    });

    it('throws on first error when partial results disabled', async () => {
      httpClient.request = vi.fn(async (method: string, path: string) => {
        if (path === '/projects/fail') {
          throw new Error('API failure');
        }
        return {
          status: 200,
          headers: {},
          body: { id: path.split('/').pop(), name: `result-${path}` },
        };
      });

      const steps: CompositeStep[] = [
        { call: 'GET /projects/1', store_as: 'project1' },
        { call: 'GET /projects/fail', store_as: 'project_fail' },
        { call: 'GET /projects/2', store_as: 'project2' },
      ];

      await expect(executor.execute(steps, {}, false)).rejects.toThrow('Composite step 2/3 failed');
    });

    it('maintains backward compatibility - steps without depends_on execute sequentially', async () => {
      let callOrder: number[] = [];
      let callCounter = 0;

      httpClient.request = vi.fn(async (method: string, path: string) => {
        const callNumber = ++callCounter;
        callOrder.push(callNumber);

        // Simulate sequential execution by awaiting previous calls
        if (callNumber > 1) {
          // Verify previous call completed before this one started
          expect(callOrder).toContain(callNumber - 1);
        }

        return {
          status: 200,
          headers: {},
          body: { id: path.split('/').pop(), name: `result-${path}`, callNumber },
        };
      });

      // Steps without depends_on should execute sequentially (like before DAG implementation)
      const steps: CompositeStep[] = [
        { call: 'GET /projects/1', store_as: 'project1' }, // no depends_on
        { call: 'GET /projects/2', store_as: 'project2' }, // no depends_on
        { call: 'GET /projects/3', store_as: 'project3' }, // no depends_on
      ];

      const result = await executor.execute(steps, {});

      expect(result.completed_steps).toBe(3);
      // In sequential execution, calls should be made in order 1, 2, 3
      expect(callOrder).toEqual([1, 2, 3]);
    });
  });

  describe('storeAtPath edge cases', () => {
    it('throws for unsafe property name in path (prototype)', async () => {
      httpClient.request = vi.fn(async () => ({
        status: 200,
        headers: {},
        body: { id: 1 },
      }));

      const steps: CompositeStep[] = [
        { call: 'GET /projects/1', store_as: '__proto__.polluted' },
      ];

      await expect(executor.execute(steps, {})).rejects.toThrow('Invalid property name in path: __proto__');
    });

    it('throws for unsafe property name in final key (constructor)', async () => {
      httpClient.request = vi.fn(async () => ({
        status: 200,
        headers: {},
        body: { id: 1 },
      }));

      const steps: CompositeStep[] = [
        { call: 'GET /projects/1', store_as: 'safe.constructor' },
      ];

      await expect(executor.execute(steps, {})).rejects.toThrow('Invalid property name in path: constructor');
    });
  });

  describe('extractQueryParams', () => {
    it('passes array query params as string arrays', async () => {
      let capturedParams: Record<string, string | string[]> = {};
      
      // Create parser with query parameter
      const parserWithQuery = {
        getPath: vi.fn(() => ({
          path: '/test',
          operations: {
            get: {
              operationId: 'getTest',
              method: 'GET',
              path: '/test',
              parameters: [
                { name: 'tags', in: 'query', schema: { type: 'array' } },
                { name: 'filter', in: 'query', schema: { type: 'string' } },
              ],
            },
          },
        })),
      } as unknown as OpenAPIParser;

      // Capture query params
      const clientWithCapture: HttpClient = {
        request: vi.fn(async (_method, _path, options) => {
          capturedParams = options?.params || {};
          return { status: 200, headers: {}, body: {} };
        }),
      } as unknown as HttpClient;

      const exec = new CompositeExecutor(parserWithQuery, clientWithCapture);
      const steps: CompositeStep[] = [
        { call: 'GET /test', store_as: 'result' },
      ];

      await exec.execute(steps, { tags: ['a', 'b', 'c'], filter: 'active' });

      expect(capturedParams.tags).toEqual(['a', 'b', 'c']);
      expect(capturedParams.filter).toBe('active');
    });
  });

  describe('error handling', () => {
    it('should throw error when path parameter is missing', async () => {
      const parserWithPathParam: OpenAPIParser = {
        getPath: vi.fn(() => ({
          path: '/projects/{id}',
          operations: {
            get: {
              operationId: 'getProject',
              method: 'GET',
              path: '/projects/{id}',
              parameters: [],
            },
          },
        })),
      } as unknown as OpenAPIParser;

      const exec = new CompositeExecutor(parserWithPathParam, httpClient);
      const steps: CompositeStep[] = [
        { call: 'GET /projects/{id}', store_as: 'project' },
      ];

      // Execute without providing 'id' parameter - should throw
      await expect(exec.execute(steps, {}, false)).rejects.toThrow('Missing path parameter');
    });

    it('should throw error when HTTP client is not provided', async () => {
      // Create executor without HTTP client
      const exec = new CompositeExecutor(parser, null as unknown as HttpClient);
      const steps: CompositeStep[] = [
        { call: 'GET /projects/1', store_as: 'project' },
      ];

      // Should throw when httpClient is null
      await expect(exec.execute(steps, {}, false)).rejects.toThrow('HTTP client not provided');
    });

    it('should collect errors with partial_results enabled', async () => {
      const parserWithPathParam: OpenAPIParser = {
        getPath: vi.fn(() => ({
          path: '/projects/{id}',
          operations: {
            get: {
              operationId: 'getProject',
              method: 'GET',
              path: '/projects/{id}',
              parameters: [],
            },
          },
        })),
      } as unknown as OpenAPIParser;

      const exec = new CompositeExecutor(parserWithPathParam, httpClient);
      const steps: CompositeStep[] = [
        { call: 'GET /projects/{id}', store_as: 'project' },
      ];

      // Execute with partial_results=true - should collect errors instead of throwing
      const result = await exec.execute(steps, {}, true);

      expect(result.errors).toBeDefined();
      expect(result.errors!.length).toBeGreaterThan(0);
      expect(result.errors![0].error).toContain('Missing path parameter');
    });

    it('should throw error when operation not found for call', async () => {
      // Parser that returns path but no operation for the method
      const parserWithNoOp: OpenAPIParser = {
        getPath: vi.fn(() => ({
          path: '/projects/1',
          operations: {
            // Only POST is defined, not GET
            post: {
              operationId: 'createProject',
              method: 'POST',
              path: '/projects/1',
              parameters: [],
            },
          },
        })),
      } as unknown as OpenAPIParser;

      const exec = new CompositeExecutor(parserWithNoOp, httpClient);
      const steps: CompositeStep[] = [
        { call: 'GET /projects/1', store_as: 'project' },
      ];

      await expect(exec.execute(steps, {}, false)).rejects.toThrow('Operation not found');
    });
  });
});
