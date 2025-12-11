
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MCPServer } from '../mcp-server.js';
import { HttpClient } from '../interceptors.js';
import { OpenAPIParser } from '../openapi-parser.js';
import { ProfileLoader } from '../profile-loader.js';
import { ToolGenerator } from '../tool-generator.js';
import path from 'path';
import type { Profile } from '../types/profile.js';

// Mock HttpClient
vi.mock('../interceptors.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../interceptors.js')>();
  return {
    ...actual,
    HttpClient: class MockHttpClient {
      async request(method: string, url: string, options: any) {
        return {
          data: { id: 'test' },
          status: 200,
          headers: {},
        };
      }
    }
  };
});

describe('Parameter Mapping Integration', () => {
  let server: MCPServer;
  let mockLogger: any;
  let requestSpy: any;

  beforeEach(async () => {
    // Setup spy on HttpClient.prototype.request
    // We need to access the prototype of the mocked class
    const { HttpClient } = await import('../interceptors.js');
    requestSpy = vi.spyOn(HttpClient.prototype, 'request');
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should map aliased parameters to OpenAPI query parameters', async () => {
    // 1. Setup minimal profile with aliases
    const profile: Profile = {
      profile_name: 'test-profile',
      parameter_aliases: {
        '$skip': ['skip'],
        '$top': ['top']
      },
      tools: [
        {
          name: 'list_items',
          description: 'List items',
          operations: {
            'list': 'listItems'
          },
          parameters: {
            'action': { type: 'string', description: 'Action' },
            'skip': { type: 'integer', description: 'Skip' },
            'top': { type: 'integer', description: 'Top' }
          }
        }
      ]
    };

    // 2. Setup minimal OpenAPI spec
    const openApiSpec = {
      openapi: '3.0.0',
      info: { title: 'Test API', version: '1.0.0' },
      paths: {
        '/items': {
          get: {
            operationId: 'listItems',
            parameters: [
              {
                name: '$skip',
                in: 'query',
                schema: { type: 'integer' }
              },
              {
                name: '$top',
                in: 'query',
                schema: { type: 'integer' }
              }
            ],
            responses: {
              '200': { description: 'OK' }
            }
          }
        }
      }
    };

    // 3. Initialize server components
    const parser = new OpenAPIParser();
    // Mock getOperation
    vi.spyOn(parser, 'getOperation').mockReturnValue({
      operationId: 'listItems',
      method: 'get',
      path: '/items',
      parameters: [
        {
          name: '$skip',
          in: 'query',
          schema: { type: 'integer' }
        },
        {
          name: '$top',
          in: 'query',
          schema: { type: 'integer' }
        }
      ],
      responses: {}
    } as any);

    const loader = new ProfileLoader();
    // Mock loading profile
    vi.spyOn(loader, 'load').mockResolvedValue(profile);

    const generator = new ToolGenerator(parser);

    // Mock logger
    mockLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    server = new MCPServer(mockLogger as any);

    // Inject dependencies
    (server as any).parser = parser;
    (server as any).profile = profile;
    (server as any).toolGenerator = generator;
    // Initialize httpClientFactory if needed, but it's initialized in constructor
    
    // We need to mock getHttpClientForSession to return our mock HttpClient
    // Pass dummy args to satisfy TS (runtime uses MockHttpClient which ignores them)
    vi.spyOn(server as any, 'getHttpClientForSession').mockResolvedValue(new HttpClient('http://test', {} as any));

    // 4. Execute tool
    await (server as any).executeSimpleTool(
      profile.tools[0],
      {
        action: 'list',
        skip: 10,
        top: 5
      }
    );

    // 5. Verify request URL contains mapped parameters
    expect(requestSpy).toHaveBeenCalled();
    const [method, url, options] = requestSpy.mock.calls[0];
    
    // Expecting: /items?$skip=10&$top=5
    // Note: URLSearchParams might encode $ as %24, but HttpClient usually handles it.
    // Let's check if the query params are present.
    expect(url).toContain('/items');
    
    // Check for query parameters in options
    expect(options.params).toBeDefined();
    expect(options.params['$skip']).toBe('10');
    expect(options.params['$top']).toBe('5');
  });
});
