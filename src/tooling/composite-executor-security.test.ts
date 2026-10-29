
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CompositeExecutor } from './composite-executor.js';
import { OpenAPIParser } from '../openapi/openapi-parser.js';
import type { HttpClient } from '../transport/interceptors.js';
import type { CompositeStep } from '../types/profile.js';

describe('CompositeExecutor Security', () => {
  let parser: OpenAPIParser;
  let httpClient: HttpClient;
  let executor: CompositeExecutor;
  let capturedPaths: string[] = [];

  beforeEach(() => {
    capturedPaths = [];

    // Mock OpenAPI parser
    parser = {
      getPath: vi.fn((path: string) => {
        // Strip query params/template from path for simple matching
        const normalized = path.split('{')[0];
        return {
          path: normalized,
          operations: {
            get: {
              operationId: `get${normalized.replace(/\//g, '_')}`,
              method: 'GET',
              path: normalized,
              parameters: [],
            },
          },
        };
      }),
    } as unknown as OpenAPIParser;

    // Mock HTTP client to capture requests
    httpClient = {
      request: vi.fn(async (method, path) => {
        capturedPaths.push(path);
        return {
          status: 200,
          headers: {},
          body: { success: true },
        };
      }),
    } as unknown as HttpClient;

    executor = new CompositeExecutor(parser, httpClient);
  });

  it('vulnerability: path traversal via parameter injection', async () => {
    const steps: CompositeStep[] = [
      { call: 'GET /users/{id}/profile', store_as: 'result' },
    ];

    // Normal traversal should be encoded by encodeURIComponent
    const maliciousId = '../admin/secrets';
    await executor.execute(steps, { id: maliciousId });
    const expectedFixedPath = '/users/..%2Fadmin%2Fsecrets/profile';
    expect(capturedPaths[0]).toBe(expectedFixedPath);

    // Strict match of '..' or '.' should throw
    await expect(executor.execute(steps, { id: '..' })).rejects.toThrow();
    await expect(executor.execute(steps, { id: '.' })).rejects.toThrow();
  });
});
