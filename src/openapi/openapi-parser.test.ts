/**
 * Tests for OpenAPI parser
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { OpenAPIParser } from './openapi-parser.js';
import { ConfigurationError } from '../core/errors.js';
import path from 'path';

describe('OpenAPIParser', () => {
  let parser: OpenAPIParser;

  beforeAll(async () => {
    parser = new OpenAPIParser();
    const specPath = path.join(process.cwd(), 'profiles/gitlab/openapi.yaml');
    await parser.load(specPath);
  });

  it('should load GitLab OpenAPI spec', () => {
    expect(parser).toBeDefined();
  });

  it('should find operation by operationId', () => {
    const operation = parser.getOperation('getApiV4ProjectsIdBadges');
    expect(operation).toBeDefined();
    expect(operation?.method).toBe('GET');
    expect(operation?.path).toBe('/projects/{id}/badges');
  });

  it('should extract path parameters', () => {
    const operation = parser.getOperation('getApiV4ProjectsIdBadgesBadgeId');
    expect(operation?.parameters).toBeDefined();
    
    const pathParams = operation?.parameters.filter(p => p.in === 'path');
    expect(pathParams?.length).toBeGreaterThan(0);
    expect(pathParams?.some(p => p.name === 'id')).toBe(true);
    expect(pathParams?.some(p => p.name === 'badge_id')).toBe(true);
  });

  it('should extract query parameters', () => {
    const operation = parser.getOperation('getApiV4ProjectsIdBadges');
    const queryParams = operation?.parameters.filter(p => p.in === 'query');
    
    expect(queryParams?.some(p => p.name === 'page')).toBe(true);
    expect(queryParams?.some(p => p.name === 'per_page')).toBe(true);
  });

  it('should extract request body for POST operations', () => {
    const operation = parser.getOperation('postApiV4ProjectsIdBadges');
    expect(operation?.requestBody).toBeDefined();
    expect(operation?.requestBody?.required).toBe(true);
  });

  it('should get base URL from servers', () => {
    const baseUrl = parser.getBaseUrl();
    expect(baseUrl).toContain('gitlab.com/api/v4');
  });

  it('should list all operations', () => {
    const operations = parser.getAllOperations();
    expect(operations.length).toBeGreaterThan(0);
    expect(operations.every(op => op.operationId)).toBe(true);
  });

  it('should find operations by tag', () => {
    const operations = parser.getAllOperations();
    const badgeOps = operations.filter(op => op.tags?.includes('badges'));
    expect(badgeOps.length).toBeGreaterThan(0);
  });

  it('should extract security scheme from GitLab spec', () => {
    const security = parser.getSecurityScheme();
    expect(security).toBeDefined();
    // GitLab uses apiKey in header (PRIVATE-TOKEN)
    expect(['bearer', 'apiKey']).toContain(security?.type);
  });
});

describe('OpenAPIParser - schema resolution', () => {
  const baseSpec = {
    openapi: '3.0.0',
    info: { title: 'Test API', version: '1.0.0' },
    paths: {},
    components: {
      schemas: {
        Category: {
          type: 'object',
          properties: {
            name: { type: 'string' },
          },
          required: ['name'],
        },
        Pet: {
          type: 'object',
          properties: {
            id: { type: 'integer', format: 'int64' },
            category: { $ref: '#/components/schemas/Category' },
          },
          required: ['id'],
        },
        PetList: {
          type: 'array',
          items: { $ref: '#/components/schemas/Pet' },
        },
        PetStatus: {
          allOf: [
            { $ref: '#/components/schemas/Pet' },
            {
              type: 'object',
              properties: {
                status: {
                  type: 'string',
                  enum: ['available', 'sold'],
                },
              },
              required: ['status'],
            },
          ],
        },
        Node: {
          type: 'object',
          properties: {
            value: { type: 'string' },
            next: { $ref: '#/components/schemas/Node' },
          },
        },
        Base: {
          type: 'object',
          properties: {
            code: { type: 'string' },
          },
          required: ['code'],
        },
        BaseAlias: { $ref: '#/components/schemas/Base' },
        ExtendedBase: {
          allOf: [
            { $ref: '#/components/schemas/BaseAlias' },
            {
              type: 'object',
              properties: {
                code: { type: 'string', format: 'uuid' },
              },
            },
          ],
        },
      },
    },
  } as const;

  it('resolves nested referenced schemas', () => {
    const parser = new OpenAPIParser();
    (parser as any).spec = JSON.parse(JSON.stringify(baseSpec));

    const resolved = (parser as any).resolveSchema('#/components/schemas/PetList');

    expect(resolved?.type).toBe('array');
    expect(resolved?.items?.ref).toBe('#/components/schemas/Pet');
    expect(resolved?.items?.properties?.category?.ref).toBe('#/components/schemas/Category');
    expect(resolved?.items?.properties?.category?.properties?.name?.type).toBe('string');
  });

  it('merges composed schemas', () => {
    const parser = new OpenAPIParser();
    (parser as any).spec = JSON.parse(JSON.stringify(baseSpec));

    const resolved = (parser as any).resolveSchema('#/components/schemas/PetStatus');

    expect(resolved?.properties?.id?.type).toBe('integer');
    expect(resolved?.properties?.status?.enum).toEqual(['available', 'sold']);
    expect(resolved?.required).toEqual(expect.arrayContaining(['id', 'status']));
    expect(resolved?.allOf?.length).toBe(2);
  });

  it('detects circular references', () => {
    const parser = new OpenAPIParser();
    (parser as any).spec = JSON.parse(JSON.stringify(baseSpec));

    const resolved = (parser as any).resolveSchema('#/components/schemas/Node');

    expect(resolved?.properties?.next?.ref).toBe('#/components/schemas/Node');
    expect(resolved?.properties?.next?.circular).toBe(true);
  });

  it('does not mutate cached schemas when merging compositions', () => {
    const parser = new OpenAPIParser();
    (parser as any).spec = JSON.parse(JSON.stringify(baseSpec));

    const extended = (parser as any).resolveSchema('#/components/schemas/ExtendedBase');
    expect(extended?.properties?.code?.format).toBe('uuid');

    const base = (parser as any).resolveSchema('#/components/schemas/Base');
    expect(base?.properties?.code?.format).toBeUndefined();
    expect(base?.properties?.code?.type).toBe('string');
  });

  it('returns fresh clones for cached schemas', () => {
    const parser = new OpenAPIParser();
    (parser as any).spec = JSON.parse(JSON.stringify(baseSpec));

    const first = (parser as any).resolveSchema('#/components/schemas/Pet');
    expect(first).toBeDefined();
    if (!first?.properties?.id) {
      throw new Error('Expected id property to be present');
    }
    first.properties.id.type = 'string';

    const second = (parser as any).resolveSchema('#/components/schemas/Pet');
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
    expect(second?.properties?.id?.type).toBe('integer');
  });

  it('returns undefined for unknown references', () => {
    const parser = new OpenAPIParser();
    (parser as any).spec = JSON.parse(JSON.stringify(baseSpec));

    const resolved = (parser as any).resolveSchema('#/components/schemas/Missing');
    expect(resolved).toBeUndefined();
  });
});

describe('OpenAPIParser - additional coverage', () => {
  it('detectYamlFormat falls back to YAML when JSON parsing fails', () => {
    const parser = new OpenAPIParser();
    const isYaml = (parser as any).detectYamlFormat('spec.unknown', null, 'openapi: 3.0.0');
    expect(isYaml).toBe(true);
  });

  it('extractSchema processes oneOf schemas', () => {
    const parser = new OpenAPIParser();
    const schema = {
      oneOf: [{ type: 'string' }, { type: 'number' }],
    };
    const info = (parser as any).extractSchema(schema, new Set());
    expect(info.oneOf).toBeDefined();
    expect(info.oneOf).toHaveLength(2);
  });

  it('resolveSchema returns undefined when traversing a non-object path', () => {
    const parser = new OpenAPIParser();
    (parser as any).spec = { components: 'not-an-object' };
    const out = (parser as any).resolveSchema('#/components/schemas/X');
    expect(out).toBeUndefined();
  });

  it('resolveSchema returns undefined when $ref contains unsafe segments', () => {
    const parser = new OpenAPIParser();
    (parser as any).spec = { components: { schemas: { X: { type: 'string' } } } };
    const out = (parser as any).resolveSchema('#/components/__proto__/polluted');
    expect(out).toBeUndefined();
  });

  it('getSecurityScheme returns undefined for unknown scheme types', () => {
    const parser = new OpenAPIParser();
    (parser as any).spec = {
      openapi: '3.0.0',
      info: { title: 'Test', version: '1.0.0' },
      paths: {},
      security: [{ mTls: [] }],
      components: { securitySchemes: { mTls: { type: 'mutualTLS' } } },
    };
    expect(parser.getSecurityScheme()).toBeUndefined();
  });
});

describe('OpenAPIParser - Security Schemes', () => {
  it('should parse bearer token auth', async () => {
    const parser = new OpenAPIParser();
    
    // Mock spec with bearer auth directly without loading file
    (parser as any).spec = {
      openapi: '3.0.0',
      info: { title: 'Test API', version: '1.0' },
      security: [{ bearerAuth: [] }],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
          },
        },
      },
      paths: {},
    };
    (parser as any).buildIndex();

    const security = parser.getSecurityScheme();
    expect(security).toEqual({
      type: 'bearer',
      scheme: 'bearer',
    });
  });

  it('should parse API key in header', async () => {
    const parser = new OpenAPIParser();
    await parser.load('test-spec.yaml').catch(() => {});
    
    (parser as any).spec = {
      openapi: '3.0.0',
      info: { title: 'Test API', version: '1.0' },
      security: [{ apiKeyAuth: [] }],
      components: {
        securitySchemes: {
          apiKeyAuth: {
            type: 'apiKey',
            name: 'X-API-Key',
            in: 'header',
          },
        },
      },
      paths: {},
    };
    (parser as any).buildIndex();

    const security = parser.getSecurityScheme();
    expect(security).toEqual({
      type: 'apiKey',
      name: 'X-API-Key',
      in: 'header',
    });
  });

  it('should parse API key in query', async () => {
    const parser = new OpenAPIParser();
    await parser.load('test-spec.yaml').catch(() => {});
    
    (parser as any).spec = {
      openapi: '3.0.0',
      info: { title: 'Test API', version: '1.0' },
      security: [{ apiKeyAuth: [] }],
      components: {
        securitySchemes: {
          apiKeyAuth: {
            type: 'apiKey',
            name: 'api_key',
            in: 'query',
          },
        },
      },
      paths: {},
    };
    (parser as any).buildIndex();

    const security = parser.getSecurityScheme();
    expect(security).toEqual({
      type: 'apiKey',
      name: 'api_key',
      in: 'query',
    });
  });

  it('should return undefined for public API (no security)', async () => {
    const parser = new OpenAPIParser();
    await parser.load('test-spec.yaml').catch(() => {});
    
    (parser as any).spec = {
      openapi: '3.0.0',
      info: { title: 'Test API', version: '1.0' },
      paths: {},
    };
    (parser as any).buildIndex();

    const security = parser.getSecurityScheme();
    expect(security).toBeUndefined();
  });

  it('should map OAuth2 to bearer', async () => {
    const parser = new OpenAPIParser();
    await parser.load('test-spec.yaml').catch(() => {});
    
    (parser as any).spec = {
      openapi: '3.0.0',
      info: { title: 'Test API', version: '1.0' },
      security: [{ oauth2: [] }],
      components: {
        securitySchemes: {
          oauth2: {
            type: 'oauth2',
            flows: {
              implicit: {
                authorizationUrl: 'https://example.com/oauth',
                scopes: {},
              },
            },
          },
        },
      },
      paths: {},
    };
    (parser as any).buildIndex();

    const security = parser.getSecurityScheme();
    expect(security).toEqual({
      type: 'bearer',
      scheme: 'bearer',
    });
  });

  it('should clone schema with anyOf', async () => {
    const parser = new OpenAPIParser();
    
    const schema = {
      type: 'object',
      anyOf: [
        { type: 'string' },
        { type: 'number' }
      ]
    };
    
    const cloned = (parser as any).cloneSchemaInfo(schema);
    expect(cloned.anyOf).toHaveLength(2);
    expect(cloned.anyOf[0].type).toBe('string');
  });

  it('should clone schema with oneOf', async () => {
    const parser = new OpenAPIParser();
    
    const schema = {
      type: 'object',
      oneOf: [
        { type: 'boolean' },
        { type: 'null' }
      ]
    };
    
    const cloned = (parser as any).cloneSchemaInfo(schema);
    expect(cloned.oneOf).toHaveLength(2);
    expect(cloned.oneOf[0].type).toBe('boolean');
  });
});

describe('OpenAPIParser - HTTP URL loading', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('should load OpenAPI spec from HTTP URL with YAML Content-Type', async () => {
    const yamlContent = `openapi: 3.0.0
info:
  title: Test API
  version: 1.0.0
paths:
  /test:
    get:
      operationId: getTest
      responses:
        '200':
          description: Success`;

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => yamlContent,
      headers: new Headers({
        'content-type': 'application/yaml',
      }),
    } as Response);

    const parser = new OpenAPIParser();
    await parser.load('http://example.com/openapi.yaml');

    expect(parser.getOperation('getTest')).toBeDefined();
    expect(parser.getOperation('getTest')?.method).toBe('GET');
    expect(global.fetch).toHaveBeenCalledWith(
      'http://example.com/openapi.yaml',
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        headers: expect.objectContaining({
          'Accept': 'application/json, application/yaml, text/yaml, application/x-yaml, */*',
        }),
      })
    );
  });

  it('should load OpenAPI spec from HTTPS URL with JSON Content-Type', async () => {
    const jsonContent = JSON.stringify({
      openapi: '3.0.0',
      info: {
        title: 'Test API',
        version: '1.0.0',
      },
      paths: {
        '/test': {
          get: {
            operationId: 'getTest',
            responses: {
              '200': {
                description: 'Success',
              },
            },
          },
        },
      },
    });

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => jsonContent,
      headers: new Headers({
        'content-type': 'application/json',
      }),
    } as Response);

    const parser = new OpenAPIParser();
    await parser.load('https://example.com/openapi.json');

    expect(parser.getOperation('getTest')).toBeDefined();
    expect(parser.getOperation('getTest')?.method).toBe('GET');
  });

  it('should detect YAML format from URL extension when Content-Type is missing', async () => {
    const yamlContent = `openapi: 3.0.0
info:
  title: Test API
  version: 1.0.0
paths: {}`;

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => yamlContent,
      headers: new Headers({}),
    } as Response);

    const parser = new OpenAPIParser();
    await parser.load('https://example.com/spec.yaml');

    expect(parser.getBaseUrl()).toBeDefined();
  });

  it('should detect JSON format from URL extension when Content-Type is missing', async () => {
    const jsonContent = JSON.stringify({
      openapi: '3.0.0',
      info: { title: 'Test API', version: '1.0.0' },
      paths: {},
    });

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => jsonContent,
      headers: new Headers({}),
    } as Response);

    const parser = new OpenAPIParser();
    await parser.load('https://example.com/spec.json');

    expect(parser.getBaseUrl()).toBeDefined();
  });

  it('should fallback to JSON/YAML detection when Content-Type and extension are missing', async () => {
    const jsonContent = JSON.stringify({
      openapi: '3.0.0',
      info: { title: 'Test API', version: '1.0.0' },
      paths: {},
    });

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => jsonContent,
      headers: new Headers({}),
    } as Response);

    const parser = new OpenAPIParser();
    await parser.load('https://example.com/spec');

    expect(parser.getBaseUrl()).toBeDefined();
  });

  it('should throw ConfigurationError on HTTP 404', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      text: async () => 'Not Found',
      headers: new Headers({}),
    } as Response);

    const parser = new OpenAPIParser();
    await expect(parser.load('https://example.com/missing.yaml')).rejects.toThrow(ConfigurationError);
    await expect(parser.load('https://example.com/missing.yaml')).rejects.toThrow(
      'Failed to load OpenAPI spec from URL'
    );
  });

  it('should throw ConfigurationError on HTTP 500', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      text: async () => 'Server Error',
      headers: new Headers({}),
    } as Response);

    const parser = new OpenAPIParser();
    await expect(parser.load('https://example.com/error.yaml')).rejects.toThrow(ConfigurationError);
    await expect(parser.load('https://example.com/error.yaml')).rejects.toThrow('HTTP 500');
  });

  it('should throw ConfigurationError on timeout', async () => {
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';

    global.fetch = vi.fn().mockRejectedValue(abortError);

    const parser = new OpenAPIParser();
    await expect(parser.load('https://example.com/slow.yaml')).rejects.toThrow(ConfigurationError);
    await expect(parser.load('https://example.com/slow.yaml')).rejects.toThrow('Timeout');
  });

  it('should throw ConfigurationError on network error', async () => {
    const networkError = new Error('Network request failed');
    networkError.name = 'TypeError';

    global.fetch = vi.fn().mockRejectedValue(networkError);

    const parser = new OpenAPIParser();
    await expect(parser.load('https://example.com/unreachable.yaml')).rejects.toThrow(ConfigurationError);
    await expect(parser.load('https://example.com/unreachable.yaml')).rejects.toThrow(
      'Failed to load OpenAPI spec from URL'
    );
  });

  it('should still load from local file path', async () => {
    // Mock fetch to verify it's not called for local files
    const fetchSpy = vi.spyOn(global, 'fetch');
    
    const parser = new OpenAPIParser();
    const specPath = path.join(process.cwd(), 'profiles/gitlab/openapi.yaml');
    await parser.load(specPath);

    expect(parser.getOperation('getApiV4ProjectsIdBadges')).toBeDefined();
    expect(fetchSpy).not.toHaveBeenCalled();
    
    fetchSpy.mockRestore();
  });

  it('should handle various YAML Content-Type headers', async () => {
    const yamlContent = `openapi: 3.0.0
info:
  title: Test API
  version: 1.0.0
paths: {}`;

    const contentTypes = [
      'application/yaml',
      'text/yaml',
      'application/x-yaml',
      'text/x-yaml',
      'application/yaml; charset=utf-8',
    ];

    for (const contentType of contentTypes) {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => yamlContent,
        headers: new Headers({
          'content-type': contentType,
        }),
      } as Response);

      const parser = new OpenAPIParser();
      await parser.load('https://example.com/spec');
      expect(parser.getBaseUrl()).toBeDefined();
    }
  });
});
