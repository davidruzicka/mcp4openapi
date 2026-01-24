/**
 * Tests for profile loader
 */

import { describe, it, expect } from 'vitest';
import { ProfileLoader } from './profile-loader.js';
import path from 'path';

describe('ProfileLoader', () => {
  it('should load valid GitLab profile', async () => {
    const loader = new ProfileLoader();
    const profilePath = path.join(process.cwd(), 'profiles/gitlab/developer-profile-oauth.json');

    const profile = await loader.load(profilePath);

    expect(profile.profile_name).toBe('gitlab-default');
    expect(profile.profile_aliases).toContain('gitlab-developer');
    expect(profile.tools.length).toBeGreaterThan(0);
    expect(profile.interceptors).toBeDefined();
  });

  it('should validate required_for references', async () => {
    const loader = new ProfileLoader();
    const profilePath = path.join(process.cwd(), 'profiles/gitlab/developer-profile-oauth.json');

    const profile = await loader.load(profilePath);
    const badgeTool = profile.tools.find(t => t.name === 'manage_project_badges');

    expect(badgeTool).toBeDefined();
    expect(badgeTool?.parameters.badge_id.required_for).toContain('get');
    expect(badgeTool?.parameters.link_url.required_for).toContain('create');
  });

  it('should reject invalid profile', async () => {
    const loader = new ProfileLoader();

    // Create invalid profile (missing required fields)
    const invalidJson = JSON.stringify({
      profile_name: 'test',
      tools: [
        {
          name: 'test_tool',
          // missing description
          parameters: {}
        }
      ]
    });

    await expect(async () => {
      const fs = await import('fs/promises');
      const tmpPath = '/tmp/invalid-profile.json';
      await fs.writeFile(tmpPath, invalidJson);
      await loader.load(tmpPath);
    }).rejects.toThrow();
  });

  it('should reject non-object JSON (array)', async () => {
    const loader = new ProfileLoader();

    // Create JSON array instead of object
    const arrayJson = JSON.stringify([
      {
        profile_name: 'test',
        tools: []
      }
    ]);

    await expect(async () => {
      const fs = await import('fs/promises');
      const tmpPath = '/tmp/array-profile.json';
      await fs.writeFile(tmpPath, arrayJson);
      await loader.load(tmpPath);
    }).rejects.toThrow();
  });

  it('should reject non-object JSON (string)', async () => {
    const loader = new ProfileLoader();

    // Create JSON string instead of object
    const stringJson = JSON.stringify('not an object');

    await expect(async () => {
      const fs = await import('fs/promises');
      const tmpPath = '/tmp/string-profile.json';
      await fs.writeFile(tmpPath, stringJson);
      await loader.load(tmpPath);
    }).rejects.toThrow();
  });

  it('normalizes tool names using NFC', async () => {
    const loader = new ProfileLoader();
    const fs = await import('fs/promises');
    const tmpPath = `/tmp/profile-nfc-${Date.now()}-${Math.random()}.json`;
    await fs.writeFile(
      tmpPath,
      JSON.stringify({
        profile_name: 'nfc-test',
        tools: [
          {
            name: 'cafe\u0301',
            description: 'Unicode tool',
            parameters: {},
            operations: { execute: 'op' },
          },
        ],
        interceptors: {},
      }),
      'utf-8'
    );

    const profile = await loader.load(tmpPath);
    expect(profile.tools[0].name).toBe('café');
  });

  describe('tool semantic validation', () => {
    it('rejects composite tools without steps', async () => {
      const loader = new ProfileLoader();
      const fs = await import('fs/promises');
      const tmpPath = `/tmp/profile-no-steps-${Date.now()}-${Math.random()}.json`;
      await fs.writeFile(
        tmpPath,
        JSON.stringify({
          profile_name: 'test',
          tools: [
            {
              name: 'composite_tool',
              description: 'Composite',
              composite: true,
              parameters: {},
            },
          ],
          interceptors: {},
        }),
        'utf-8'
      );

      await expect(loader.load(tmpPath)).rejects.toThrow('marked as composite but has no steps');
    });

    it('rejects non-composite tools without operations', async () => {
      const loader = new ProfileLoader();
      const fs = await import('fs/promises');
      const tmpPath = `/tmp/profile-no-ops-${Date.now()}-${Math.random()}.json`;
      await fs.writeFile(
        tmpPath,
        JSON.stringify({
          profile_name: 'test',
          tools: [
            {
              name: 'plain_tool',
              description: 'Plain',
              parameters: {},
            },
          ],
          interceptors: {},
        }),
        'utf-8'
      );

      await expect(loader.load(tmpPath)).rejects.toThrow(
        "must have either 'operations' or be marked as 'composite' with 'steps'"
      );
    });

    it('rejects required_for when action enum is missing', async () => {
      const loader = new ProfileLoader();
      const fs = await import('fs/promises');
      const tmpPath = `/tmp/profile-required-for-${Date.now()}-${Math.random()}.json`;
      await fs.writeFile(
        tmpPath,
        JSON.stringify({
          profile_name: 'test',
          tools: [
            {
              name: 'tool',
              description: 'Tool',
              parameters: {
                some_id: {
                  type: 'string',
                  description: 'id',
                  required_for: ['get'],
                },
              },
              operations: { execute: 'op' },
            },
          ],
          interceptors: {},
        }),
        'utf-8'
      );

      await expect(loader.load(tmpPath)).rejects.toThrow("has 'required_for' but 'action' parameter has no enum");
    });

    it('rejects required_for actions that are not in action enum', async () => {
      const loader = new ProfileLoader();
      const fs = await import('fs/promises');
      const tmpPath = `/tmp/profile-required-for-enum-${Date.now()}-${Math.random()}.json`;
      await fs.writeFile(
        tmpPath,
        JSON.stringify({
          profile_name: 'test',
          tools: [
            {
              name: 'tool',
              description: 'Tool',
              parameters: {
                action: {
                  type: 'string',
                  description: 'Action',
                  enum: ['list'],
                },
                some_id: {
                  type: 'string',
                  description: 'id',
                  required_for: ['get'],
                },
              },
              operations: { execute: 'op' },
            },
          ],
          interceptors: {},
        }),
        'utf-8'
      );

      await expect(loader.load(tmpPath)).rejects.toThrow("requires action 'get' but it's not in action enum");
    });
  });

  describe('auth interceptor validation', () => {
    it('should accept array-form auth interceptors', async () => {
      const loader = new ProfileLoader();

      const profileJson = JSON.stringify({
        profile_name: 'test-profile',
        interceptors: {
          auth: [
            {
              type: 'bearer',
              value_from_env: 'FIRST_TOKEN',
            },
            {
              type: 'custom-header',
              header_name: 'X-Secondary-Token',
              value_from_env: 'SECOND_TOKEN',
            },
          ],
        },
        tools: [
          {
            name: 'array_auth_tool',
            description: 'Tool using array-form auth interceptors',
            parameters: {
              action: {
                type: 'string',
                description: 'Action selector',
                enum: ['list'],
              },
            },
            operations: {
              list: 'getListOperation',
            },
          },
        ],
      });

      const fs = await import('fs/promises');
      const tmpPath = '/tmp/array-auth-profile.json';
      await fs.writeFile(tmpPath, profileJson);

      const profile = await loader.load(tmpPath);
      expect(Array.isArray(profile.interceptors?.auth)).toBe(true);
      expect((profile.interceptors?.auth as unknown[]).length).toBe(2);
    });

    it('should reject array-form auth interceptors with invalid entry', async () => {
      const loader = new ProfileLoader();

      const profileJson = JSON.stringify({
        profile_name: 'test-profile',
        interceptors: {
          auth: [
            {
              type: 'custom-header',
              value_from_env: 'MISSING_HEADER_NAME',
            },
          ],
        },
        tools: [
          {
            name: 'invalid_array_auth_tool',
            description: 'Tool with invalid array-form auth interceptor',
            parameters: {
              action: {
                type: 'string',
                description: 'Action selector',
                enum: ['list'],
              },
            },
            operations: {
              list: 'getListOperation',
            },
          },
        ],
      });

      const fs = await import('fs/promises');
      const tmpPath = '/tmp/invalid-array-auth-profile.json';
      await fs.writeFile(tmpPath, profileJson);

      await expect(loader.load(tmpPath)).rejects.toThrow('custom-header requires header_name');
    });

    it('should reject query auth interceptor without query_param', async () => {
      const loader = new ProfileLoader();
      const fs = await import('fs/promises');
      const tmpPath = `/tmp/profile-query-missing-${Date.now()}-${Math.random()}.json`;
      await fs.writeFile(
        tmpPath,
        JSON.stringify({
          profile_name: 'test-profile',
          interceptors: {
            auth: {
              type: 'query',
              value_from_env: 'API_KEY',
            },
          },
          tools: [
            {
              name: 'tool',
              description: 'Tool',
              parameters: {},
              operations: { execute: 'op' },
            },
          ],
        }),
        'utf-8'
      );

      await expect(loader.load(tmpPath)).rejects.toThrow('query type requires query_param');
    });
  });

  describe('Composite steps DAG validation', () => {
    it('should accept valid composite steps without dependencies', async () => {
      const loader = new ProfileLoader();

      const validProfileJson = JSON.stringify({
        profile_name: 'test',
        tools: [
          {
            name: 'valid_composite',
            description: 'Valid composite tool',
            composite: true,
            parameters: {
              id: { type: 'string', description: 'ID' }
            },
            steps: [
              { call: 'GET /api/1', store_as: 'result1' },
              { call: 'GET /api/2', store_as: 'result2' }
            ]
          }
        ]
      });

      const fs = await import('fs/promises');
      const tmpPath = '/tmp/valid-dag-profile.json';
      await fs.writeFile(tmpPath, validProfileJson);

      const profile = await loader.load(tmpPath);
      expect(profile.tools[0].steps).toHaveLength(2);
    });

    it('should accept valid composite steps with dependencies', async () => {
      const loader = new ProfileLoader();

      const validProfileJson = JSON.stringify({
        profile_name: 'test',
        tools: [
          {
            name: 'valid_dag_composite',
            description: 'Valid DAG composite tool',
            composite: true,
            parameters: {
              id: { type: 'string', description: 'ID' }
            },
            steps: [
              { call: 'GET /api/project', store_as: 'project' },
              {
                call: 'GET /api/mrs',
                store_as: 'mrs',
                depends_on: ['project']
              },
              {
                call: 'GET /api/issues',
                store_as: 'issues',
                depends_on: ['project']
              }
            ]
          }
        ]
      });

      const fs = await import('fs/promises');
      const tmpPath = '/tmp/valid-dag-profile.json';
      await fs.writeFile(tmpPath, validProfileJson);

      const profile = await loader.load(tmpPath);
      expect(profile.tools[0].steps).toHaveLength(3);
    });

    it('should reject composite steps with circular dependencies', async () => {
      const loader = new ProfileLoader();

      const circularProfileJson = JSON.stringify({
        profile_name: 'test',
        tools: [
          {
            name: 'circular_composite',
            description: 'Circular dependency composite tool',
            composite: true,
            parameters: {
              id: { type: 'string', description: 'ID' }
            },
            steps: [
              { call: 'GET /api/a', store_as: 'a', depends_on: ['c'] },
              { call: 'GET /api/b', store_as: 'b', depends_on: ['a'] },
              { call: 'GET /api/c', store_as: 'c', depends_on: ['b'] }
            ]
          }
        ]
      });

      const fs = await import('fs/promises');
      const tmpPath = '/tmp/circular-dag-profile.json';
      await fs.writeFile(tmpPath, circularProfileJson);

      await expect(loader.load(tmpPath)).rejects.toThrow(
        'Circular dependency detected in composite steps of tool \'circular_composite\''
      );
    });

    it('should reject composite steps with self-dependency', async () => {
      const loader = new ProfileLoader();

      const selfDepProfileJson = JSON.stringify({
        profile_name: 'test',
        tools: [
          {
            name: 'self_dep_composite',
            description: 'Self dependency composite tool',
            composite: true,
            parameters: {
              id: { type: 'string', description: 'ID' }
            },
            steps: [
              { call: 'GET /api/a', store_as: 'a', depends_on: ['a'] }
            ]
          }
        ]
      });

      const fs = await import('fs/promises');
      const tmpPath = '/tmp/self-dep-profile.json';
      await fs.writeFile(tmpPath, selfDepProfileJson);

      await expect(loader.load(tmpPath)).rejects.toThrow(
        'Circular dependency detected in composite steps of tool \'self_dep_composite\''
      );
    });

    it('should reject composite steps with missing dependency', async () => {
      const loader = new ProfileLoader();

      const missingDepProfileJson = JSON.stringify({
        profile_name: 'test',
        tools: [
          {
            name: 'missing_dep_composite',
            description: 'Missing dependency composite tool',
            composite: true,
            parameters: {
              id: { type: 'string', description: 'ID' }
            },
            steps: [
              { call: 'GET /api/a', store_as: 'a', depends_on: ['nonexistent'] }
            ]
          }
        ]
      });

      const fs = await import('fs/promises');
      const tmpPath = '/tmp/missing-dep-profile.json';
      await fs.writeFile(tmpPath, missingDepProfileJson);

      await expect(loader.load(tmpPath)).rejects.toThrow(
        'depends on \'nonexistent\' but no step produces \'nonexistent\''
      );
    });
  });

  it('should create default profile', async () => {
    const parser = new (await import('./openapi-parser.js')).OpenAPIParser();
    await parser.load('profiles/gitlab/openapi.yaml');
    const profile = ProfileLoader.createDefaultProfile('my-api', parser);
    expect(profile.profile_name).toBe('my-api');
    expect(profile.tools.length).toBeGreaterThan(0);
    expect(profile.description).toContain('Auto-generated default profile');
  });

  it('should create default profile with auth from OpenAPI security', async () => {
    const parser = new (await import('./openapi-parser.js')).OpenAPIParser();
    await parser.load('profiles/gitlab/openapi.yaml');
    
    const profile = ProfileLoader.createDefaultProfile('my-api', parser);
    
    // GitLab spec has security defined
    expect(profile.interceptors).toBeDefined();
    expect(profile.interceptors?.auth).toBeDefined();
    const authConfig = Array.isArray(profile.interceptors?.auth) ? profile.interceptors.auth[0] : profile.interceptors?.auth;
    expect(authConfig?.value_from_env).toBe('MCP4_API_TOKEN');
  });

  it('should create default profile with bearer auth for bearer security scheme', async () => {
    const parser = new (await import('./openapi-parser.js')).OpenAPIParser();
    
    // Mock OpenAPI spec with bearer auth
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
      paths: {
        '/test': {
          get: {
            operationId: 'getTest',
            summary: 'Get test',
            responses: { '200': { description: 'OK' } },
          },
        },
      },
    };
    (parser as any).buildIndex();
    
    const profile = ProfileLoader.createDefaultProfile('test-api', parser);
    
    expect(profile.interceptors?.auth).toEqual({
      type: 'bearer',
      value_from_env: 'MCP4_API_TOKEN',
    });
  });

  it('should create default profile with custom header auth for apiKey in header', async () => {
    const parser = new (await import('./openapi-parser.js')).OpenAPIParser();
    
    // Mock OpenAPI spec with apiKey in header
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
      paths: {
        '/test': {
          get: {
            operationId: 'getTest',
            summary: 'Get test',
            responses: { '200': { description: 'OK' } },
          },
        },
      },
    };
    (parser as any).buildIndex();
    
    const profile = ProfileLoader.createDefaultProfile('test-api', parser);
    
    expect(profile.interceptors?.auth).toEqual({
      type: 'custom-header',
      header_name: 'X-API-Key',
      value_from_env: 'MCP4_API_TOKEN',
    });
  });

  it('should create default profile with query auth for apiKey in query', async () => {
    const parser = new (await import('./openapi-parser.js')).OpenAPIParser();
    
    // Mock OpenAPI spec with apiKey in query
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
      paths: {
        '/test': {
          get: {
            operationId: 'getTest',
            summary: 'Get test',
            responses: { '200': { description: 'OK' } },
          },
        },
      },
    };
    (parser as any).buildIndex();
    
    const profile = ProfileLoader.createDefaultProfile('test-api', parser);
    
    expect(profile.interceptors?.auth).toEqual({
      type: 'query',
      query_param: 'api_key',
      value_from_env: 'MCP4_API_TOKEN',
    });
  });

  it('should create default profile without auth for public API', async () => {
    const parser = new (await import('./openapi-parser.js')).OpenAPIParser();
    
    // Mock OpenAPI spec without security
    (parser as any).spec = {
      openapi: '3.0.0',
      info: { title: 'Public API', version: '1.0' },
      paths: {
        '/test': {
          get: {
            operationId: 'getTest',
            summary: 'Get test',
            responses: { '200': { description: 'OK' } },
          },
        },
      },
    };
    (parser as any).buildIndex();
    
    const profile = ProfileLoader.createDefaultProfile('public-api', parser);
    
    expect(profile.interceptors).toEqual({});
  });

  it('should use custom AUTH_ENV_VAR if set', async () => {
    const parser = new (await import('./openapi-parser.js')).OpenAPIParser();
    
    // Mock OpenAPI spec with bearer auth
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
      paths: {
        '/test': {
          get: {
            operationId: 'getTest',
            summary: 'Get test',
            responses: { '200': { description: 'OK' } },
          },
        },
      },
    };
    (parser as any).buildIndex();
    
    const oldEnvVar = process.env.MCP4_AUTH_ENV_VAR;
    process.env.MCP4_AUTH_ENV_VAR = 'MY_CUSTOM_TOKEN';
    
    try {
      const profile = ProfileLoader.createDefaultProfile('test-api', parser);
      
      const authConfig = Array.isArray(profile.interceptors?.auth) ? profile.interceptors.auth[0] : profile.interceptors?.auth;
      expect(authConfig?.value_from_env).toBe('MY_CUSTOM_TOKEN');
    } finally {
      if (oldEnvVar !== undefined) {
        process.env.MCP4_AUTH_ENV_VAR = oldEnvVar;
      } else {
        delete process.env.MCP4_AUTH_ENV_VAR;
      }
    }
  });

  it('should use bearer auth for apiKey in Authorization header', async () => {
    const parser = new (await import('./openapi-parser.js')).OpenAPIParser();
    
    (parser as any).spec = {
      openapi: '3.0.0',
      info: { title: 'Test API', version: '1.0' },
      security: [{ apiKeyAuth: [] }],
      components: {
        securitySchemes: {
          apiKeyAuth: {
            type: 'apiKey',
            name: 'Authorization',
            in: 'header',
          },
        },
      },
      paths: {
        '/test': {
          get: {
            operationId: 'getTest',
            summary: 'Get test',
            responses: { '200': { description: 'OK' } },
          },
        },
      },
    };
    (parser as any).buildIndex();
    
    const profile = ProfileLoader.createDefaultProfile('test-api', parser);
    
    expect(profile.interceptors?.auth).toEqual({
      type: 'bearer',
      value_from_env: 'MCP4_API_TOKEN',
    });
  });

  it('should default to bearer auth for unknown security type', async () => {
    const parser = new (await import('./openapi-parser.js')).OpenAPIParser();
    
    (parser as any).spec = {
      openapi: '3.0.0',
      info: { title: 'Test API', version: '1.0' },
      security: [{ unknownAuth: [] }],
      components: {
        securitySchemes: {
          unknownAuth: {
            type: 'unknownType',
          },
        },
      },
      paths: {
        '/test': {
          get: {
            operationId: 'getTest',
            summary: 'Get test',
            responses: { '200': { description: 'OK' } },
          },
        },
      },
    };
    (parser as any).buildIndex();
    
    // Mock getSecurityScheme to return unknown type (normally filtered by parser)
    (parser as any).getSecurityScheme = () => ({ type: 'someUnknownType' });
    
    const profile = ProfileLoader.createDefaultProfile('test-api', parser);
    
    expect(profile.interceptors?.auth).toEqual({
      type: 'bearer',
      value_from_env: 'MCP4_API_TOKEN',
    });
  });

  describe('Force authentication override', () => {
    it('should force bearer auth when AUTH_FORCE=true', async () => {
      const parser = new (await import('./openapi-parser.js')).OpenAPIParser();
      
      // Mock OpenAPI spec WITHOUT security
      (parser as any).spec = {
        openapi: '3.0.0',
        info: { title: 'Public API', version: '1.0' },
        paths: {
          '/test': {
            get: {
              operationId: 'getTest',
              summary: 'Get test',
              responses: { '200': { description: 'OK' } },
            },
          },
        },
      };
      (parser as any).buildIndex();
      
      const oldForce = process.env.MCP4_AUTH_FORCE;
      const oldType = process.env.MCP4_AUTH_TYPE;
      process.env.MCP4_AUTH_FORCE = 'true';
      process.env.MCP4_AUTH_TYPE = 'bearer';
      
      try {
        const profile = ProfileLoader.createDefaultProfile('test-api', parser);
        
        expect(profile.interceptors?.auth).toEqual({
          type: 'bearer',
          value_from_env: 'MCP4_API_TOKEN',
        });
      } finally {
        if (oldForce !== undefined) process.env.MCP4_AUTH_FORCE = oldForce;
        else delete process.env.MCP4_AUTH_FORCE;
        if (oldType !== undefined) process.env.MCP4_AUTH_TYPE = oldType;
        else delete process.env.MCP4_AUTH_TYPE;
      }
    });

    it('should force query auth when AUTH_FORCE=true and AUTH_TYPE=query', async () => {
      const parser = new (await import('./openapi-parser.js')).OpenAPIParser();
      
      (parser as any).spec = {
        openapi: '3.0.0',
        info: { title: 'Public API', version: '1.0' },
        paths: {
          '/test': {
            get: {
              operationId: 'getTest',
              summary: 'Get test',
              responses: { '200': { description: 'OK' } },
            },
          },
        },
      };
      (parser as any).buildIndex();
      
      const oldForce = process.env.MCP4_AUTH_FORCE;
      const oldType = process.env.MCP4_AUTH_TYPE;
      const oldParam = process.env.MCP4_AUTH_QUERY_PARAM;
      process.env.MCP4_AUTH_FORCE = 'true';
      process.env.MCP4_AUTH_TYPE = 'query';
      process.env.MCP4_AUTH_QUERY_PARAM = 'api_key';
      
      try {
        const profile = ProfileLoader.createDefaultProfile('test-api', parser);
        
        expect(profile.interceptors?.auth).toEqual({
          type: 'query',
          query_param: 'api_key',
          value_from_env: 'MCP4_API_TOKEN',
        });
      } finally {
        if (oldForce !== undefined) process.env.MCP4_AUTH_FORCE = oldForce;
        else delete process.env.MCP4_AUTH_FORCE;
        if (oldType !== undefined) process.env.MCP4_AUTH_TYPE = oldType;
        else delete process.env.MCP4_AUTH_TYPE;
        if (oldParam !== undefined) process.env.MCP4_AUTH_QUERY_PARAM = oldParam;
        else delete process.env.MCP4_AUTH_QUERY_PARAM;
      }
    });

    it('should force custom-header auth when AUTH_FORCE=true and AUTH_TYPE=custom-header', async () => {
      const parser = new (await import('./openapi-parser.js')).OpenAPIParser();
      
      (parser as any).spec = {
        openapi: '3.0.0',
        info: { title: 'Public API', version: '1.0' },
        paths: {
          '/test': {
            get: {
              operationId: 'getTest',
              summary: 'Get test',
              responses: { '200': { description: 'OK' } },
            },
          },
        },
      };
      (parser as any).buildIndex();
      
      const oldForce = process.env.MCP4_AUTH_FORCE;
      const oldType = process.env.MCP4_AUTH_TYPE;
      const oldHeader = process.env.MCP4_AUTH_HEADER_NAME;
      process.env.MCP4_AUTH_FORCE = 'true';
      process.env.MCP4_AUTH_TYPE = 'custom-header';
      process.env.MCP4_AUTH_HEADER_NAME = 'X-Custom-Auth';
      
      try {
        const profile = ProfileLoader.createDefaultProfile('test-api', parser);
        
        expect(profile.interceptors?.auth).toEqual({
          type: 'custom-header',
          header_name: 'X-Custom-Auth',
          value_from_env: 'MCP4_API_TOKEN',
        });
      } finally {
        if (oldForce !== undefined) process.env.MCP4_AUTH_FORCE = oldForce;
        else delete process.env.MCP4_AUTH_FORCE;
        if (oldType !== undefined) process.env.MCP4_AUTH_TYPE = oldType;
        else delete process.env.MCP4_AUTH_TYPE;
        if (oldHeader !== undefined) process.env.MCP4_AUTH_HEADER_NAME = oldHeader;
        else delete process.env.MCP4_AUTH_HEADER_NAME;
      }
    });

    it('should throw error when AUTH_TYPE=query but AUTH_QUERY_PARAM is missing', async () => {
      const parser = new (await import('./openapi-parser.js')).OpenAPIParser();
      
      (parser as any).spec = {
        openapi: '3.0.0',
        info: { title: 'Public API', version: '1.0' },
        paths: {
          '/test': {
            get: {
              operationId: 'getTest',
              summary: 'Get test',
              responses: { '200': { description: 'OK' } },
            },
          },
        },
      };
      (parser as any).buildIndex();
      
      const oldForce = process.env.MCP4_AUTH_FORCE;
      const oldType = process.env.MCP4_AUTH_TYPE;
      const oldParam = process.env.MCP4_AUTH_QUERY_PARAM;
      process.env.MCP4_AUTH_FORCE = 'true';
      process.env.MCP4_AUTH_TYPE = 'query';
      delete process.env.MCP4_AUTH_QUERY_PARAM;
      
      try {
        expect(() => ProfileLoader.createDefaultProfile('test-api', parser))
          .toThrow('MCP4_AUTH_QUERY_PARAM is required when MCP4_AUTH_TYPE=query');
      } finally {
        if (oldForce !== undefined) process.env.MCP4_AUTH_FORCE = oldForce;
        else delete process.env.MCP4_AUTH_FORCE;
        if (oldType !== undefined) process.env.MCP4_AUTH_TYPE = oldType;
        else delete process.env.MCP4_AUTH_TYPE;
        if (oldParam !== undefined) process.env.MCP4_AUTH_QUERY_PARAM = oldParam;
        else delete process.env.MCP4_AUTH_QUERY_PARAM;
      }
    });

    it('should throw error when AUTH_TYPE=custom-header but AUTH_HEADER_NAME is missing', async () => {
      const parser = new (await import('./openapi-parser.js')).OpenAPIParser();
      
      (parser as any).spec = {
        openapi: '3.0.0',
        info: { title: 'Public API', version: '1.0' },
        paths: {
          '/test': {
            get: {
              operationId: 'getTest',
              summary: 'Get test',
              responses: { '200': { description: 'OK' } },
            },
          },
        },
      };
      (parser as any).buildIndex();
      
      const oldForce = process.env.MCP4_AUTH_FORCE;
      const oldType = process.env.MCP4_AUTH_TYPE;
      const oldHeader = process.env.MCP4_AUTH_HEADER_NAME;
      process.env.MCP4_AUTH_FORCE = 'true';
      process.env.MCP4_AUTH_TYPE = 'custom-header';
      delete process.env.MCP4_AUTH_HEADER_NAME;
      
      try {
        expect(() => ProfileLoader.createDefaultProfile('test-api', parser))
          .toThrow('MCP4_AUTH_HEADER_NAME is required when MCP4_AUTH_TYPE=custom-header');
      } finally {
        if (oldForce !== undefined) process.env.MCP4_AUTH_FORCE = oldForce;
        else delete process.env.MCP4_AUTH_FORCE;
        if (oldType !== undefined) process.env.MCP4_AUTH_TYPE = oldType;
        else delete process.env.MCP4_AUTH_TYPE;
        if (oldHeader !== undefined) process.env.MCP4_AUTH_HEADER_NAME = oldHeader;
        else delete process.env.MCP4_AUTH_HEADER_NAME;
      }
    });

    it('should throw error for invalid AUTH_TYPE', async () => {
      const parser = new (await import('./openapi-parser.js')).OpenAPIParser();
      
      (parser as any).spec = {
        openapi: '3.0.0',
        info: { title: 'Public API', version: '1.0' },
        paths: {
          '/test': {
            get: {
              operationId: 'getTest',
              summary: 'Get test',
              responses: { '200': { description: 'OK' } },
            },
          },
        },
      };
      (parser as any).buildIndex();
      
      const oldForce = process.env.MCP4_AUTH_FORCE;
      const oldType = process.env.MCP4_AUTH_TYPE;
      process.env.MCP4_AUTH_FORCE = 'true';
      process.env.MCP4_AUTH_TYPE = 'invalid-type';
      
      try {
        expect(() => ProfileLoader.createDefaultProfile('test-api', parser))
          .toThrow('Invalid MCP4_AUTH_TYPE: invalid-type');
      } finally {
        if (oldForce !== undefined) process.env.MCP4_AUTH_FORCE = oldForce;
        else delete process.env.MCP4_AUTH_FORCE;
        if (oldType !== undefined) process.env.MCP4_AUTH_TYPE = oldType;
        else delete process.env.MCP4_AUTH_TYPE;
      }
    });

    it('should prefer OpenAPI security over force auth when both exist', async () => {
      const parser = new (await import('./openapi-parser.js')).OpenAPIParser();
      
      // Mock OpenAPI spec WITH security
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
        paths: {
          '/test': {
            get: {
              operationId: 'getTest',
              summary: 'Get test',
              responses: { '200': { description: 'OK' } },
            },
          },
        },
      };
      (parser as any).buildIndex();
      
      const oldForce = process.env.MCP4_AUTH_FORCE;
      const oldType = process.env.MCP4_AUTH_TYPE;
      const oldHeader = process.env.MCP4_AUTH_HEADER_NAME;
      process.env.MCP4_AUTH_FORCE = 'true';
      process.env.MCP4_AUTH_TYPE = 'custom-header';
      process.env.MCP4_AUTH_HEADER_NAME = 'X-Custom';
      
      try {
        const profile = ProfileLoader.createDefaultProfile('test-api', parser);
        
        // Should use OpenAPI security (bearer), not force config (custom-header)
        expect(profile.interceptors?.auth).toEqual({
          type: 'bearer',
          value_from_env: 'MCP4_API_TOKEN',
        });
      } finally {
        if (oldForce !== undefined) process.env.MCP4_AUTH_FORCE = oldForce;
        else delete process.env.MCP4_AUTH_FORCE;
        if (oldType !== undefined) process.env.MCP4_AUTH_TYPE = oldType;
        else delete process.env.MCP4_AUTH_TYPE;
        if (oldHeader !== undefined) process.env.MCP4_AUTH_HEADER_NAME = oldHeader;
        else delete process.env.MCP4_AUTH_HEADER_NAME;
      }
    });
  });

  it('should shorten tool names when strategy is configured', async () => {
    const parser = new (await import('./openapi-parser.js')).OpenAPIParser();
    await parser.load('profiles/gitlab/openapi.yaml');
    
    // Set env vars for shortening
    const oldStrategy = process.env.MCP4_TOOLNAME_STRATEGY;
    const oldWarn = process.env.MCP4_TOOLNAME_WARN_ONLY;
    const oldMax = process.env.MCP4_TOOLNAME_MAX;
    
    process.env.MCP4_TOOLNAME_STRATEGY = 'hash';
    process.env.MCP4_TOOLNAME_WARN_ONLY = 'false';
    process.env.MCP4_TOOLNAME_MAX = '30';
    
    try {
      const profile = ProfileLoader.createDefaultProfile('my-api', parser);
      
      // All tool names should be ≤ 30 characters
      profile.tools.forEach(tool => {
        expect(tool.name.length).toBeLessThanOrEqual(30);
      });
      
      // Should have some tools with shortened names
      const hasShortNames = profile.tools.some(t => t.name.length < 20);
      expect(hasShortNames).toBe(true);
    } finally {
      // Restore env vars
      if (oldStrategy !== undefined) process.env.MCP4_TOOLNAME_STRATEGY = oldStrategy;
      else delete process.env.MCP4_TOOLNAME_STRATEGY;
      if (oldWarn !== undefined) process.env.MCP4_TOOLNAME_WARN_ONLY = oldWarn;
      else delete process.env.MCP4_TOOLNAME_WARN_ONLY;
      if (oldMax !== undefined) process.env.MCP4_TOOLNAME_MAX = oldMax;
      else delete process.env.MCP4_TOOLNAME_MAX;
    }
  });

  describe('Operation keys validation', () => {
    it('should accept direct action enum values', async () => {
      const loader = new ProfileLoader();

      const validProfileJson = JSON.stringify({
        profile_name: 'test',
        base_url: 'https://api.example.com',
        tools: [{
          name: 'test_tool',
          description: 'Test tool',
          operations: {
            'list': 'getTest',
            'get': 'getTestId',
            'create': 'postTest'
          },
          parameters: {
            action: {
              type: 'string',
              enum: ['list', 'get', 'create'],
              description: 'Action',
              required: true
            }
          }
        }]
      });

      const fs = await import('fs/promises');
      const tmpPath = '/tmp/valid-ops-profile.json';
      await fs.writeFile(tmpPath, validProfileJson);

      const profile = await loader.load(tmpPath);
      expect(profile.tools[0].operations).toHaveProperty('list');
      expect(profile.tools[0].operations).toHaveProperty('get');
      expect(profile.tools[0].operations).toHaveProperty('create');
    });

    it('should accept {action}_{resourceType} composite keys', async () => {
      const loader = new ProfileLoader();

      const validProfileJson = JSON.stringify({
        profile_name: 'test',
        base_url: 'https://api.example.com',
        tools: [{
          name: 'test_tool',
          description: 'Test tool',
          operations: {
            'list_project': 'getProjects',
            'list_group': 'getGroups',
            'get_project': 'getProjectId'
          },
          parameters: {
            action: {
              type: 'string',
              enum: ['list', 'get'],
              description: 'Action',
              required: true
            },
            resource_type: {
              type: 'string',
              enum: ['project', 'group'],
              description: 'Resource type',
              required: true
            }
          }
        }]
      });

      const fs = await import('fs/promises');
      const tmpPath = '/tmp/valid-composite-ops-profile.json';
      await fs.writeFile(tmpPath, validProfileJson);

      const profile = await loader.load(tmpPath);
      expect(profile.tools[0].operations).toHaveProperty('list_project');
      expect(profile.tools[0].operations).toHaveProperty('list_group');
      expect(profile.tools[0].operations).toHaveProperty('get_project');
    });

    it('should reject unknown operation key', async () => {
      const loader = new ProfileLoader();

      const invalidProfileJson = JSON.stringify({
        profile_name: 'test',
        base_url: 'https://api.example.com',
        tools: [{
          name: 'test_tool',
          description: 'Test tool',
          operations: {
            'invalid_action': 'getTest' // 'invalid_action' not in action enum
          },
          parameters: {
            action: {
              type: 'string',
              enum: ['list', 'get', 'create'],
              description: 'Action',
              required: true
            }
          }
        }]
      });

      const fs = await import('fs/promises');
      const tmpPath = '/tmp/invalid-ops-profile.json';
      await fs.writeFile(tmpPath, invalidProfileJson);

      await expect(loader.load(tmpPath)).rejects.toThrow('Invalid operation key \'invalid_action\'');
    });

    it('should reject invalid composite key format', async () => {
      const loader = new ProfileLoader();

      const invalidProfileJson = JSON.stringify({
        profile_name: 'test',
        base_url: 'https://api.example.com',
        tools: [{
          name: 'test_tool',
          description: 'Test tool',
          operations: {
            'list_invalid_resource': 'getTest' // 'invalid_resource' not in resource_type enum
          },
          parameters: {
            action: {
              type: 'string',
              enum: ['list', 'get'],
              description: 'Action',
              required: true
            },
            resource_type: {
              type: 'string',
              enum: ['project', 'group'],
              description: 'Resource type',
              required: true
            }
          }
        }]
      });

      const fs = await import('fs/promises');
      const tmpPath = '/tmp/invalid-composite-ops-profile.json';
      await fs.writeFile(tmpPath, invalidProfileJson);

      await expect(loader.load(tmpPath)).rejects.toThrow('Invalid operation key \'list_invalid_resource\'');
    });

    it('should provide helpful suggestions for typos', async () => {
      const loader = new ProfileLoader();

      const typoProfileJson = JSON.stringify({
        profile_name: 'test',
        base_url: 'https://api.example.com',
        tools: [{
          name: 'test_tool',
          description: 'Test tool',
          operations: {
            'creat': 'postTest' // typo: 'creat' instead of 'create'
          },
          parameters: {
            action: {
              type: 'string',
              enum: ['list', 'get', 'create'],
              description: 'Action',
              required: true
            }
          }
        }]
      });

      const fs = await import('fs/promises');
      const tmpPath = '/tmp/typo-ops-profile.json';
      await fs.writeFile(tmpPath, typoProfileJson);

      await expect(loader.load(tmpPath)).rejects.toThrow('Did you mean one of: create?');
    });
  });

  describe('OAuth config validation in array auth', () => {
    it('should validate OAuth config in array auth entries', async () => {
      const loader = new ProfileLoader();

      const invalidOAuthArrayJson = JSON.stringify({
        profile_name: 'test',
        base_url: 'https://api.example.com',
        interceptors: {
          auth: [
            {
              type: 'oauth',
              oauth_config: {
                client_id: 'test',
                // missing both issuer AND endpoints - should fail
              }
            }
          ]
        },
        tools: [{
          name: 'test_tool',
          description: 'Test tool',
          operations: { 'list': 'getTest' },
          parameters: {}
        }]
      });

      const fs = await import('fs/promises');
      const tmpPath = '/tmp/invalid-oauth-array-profile.json';
      await fs.writeFile(tmpPath, invalidOAuthArrayJson);

      await expect(loader.load(tmpPath)).rejects.toThrow(
        "OAuth config at interceptors.auth[0].oauth_config must provide either 'issuer' OR both 'authorization_endpoint' and 'token_endpoint'"
      );
    });
  });

  it('should warn when generated tool exceeds 60 parameters', async () => {
    const warnSpy = (await import('vitest')).vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Fake parser with one operation having 61 query parameters
    const fakeParser: any = {
      getAllOperations: () => {
        const params = Array.from({ length: 61 }).map((_, i) => ({
          name: `p${i}`,
          in: 'query',
          required: false,
          schema: { type: 'string' },
          description: `Param ${i}`,
        }));

        return [{
          operationId: 'op_many_params',
          method: 'get',
          path: '/test',
          parameters: params,
          summary: 'Many params',
        }];
      },
      getSecurityScheme: () => undefined, // Public API
    };

    const profile = ProfileLoader.createDefaultProfile('test', fakeParser);
    expect(profile.tools.length).toBe(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('>60');

    warnSpy.mockRestore();
  });

  describe('mapOpenAPIType', () => {
    it('should map number type correctly', async () => {
      const fakeParser: any = {
        getAllOperations: () => [{
          operationId: 'op_number',
          method: 'get',
          path: '/test',
          parameters: [{
            name: 'price',
            in: 'query',
            required: false,
            schema: { type: 'number' },
            description: 'Price',
          }],
          summary: 'Test',
        }],
        getSecurityScheme: () => undefined,
      };

      const profile = ProfileLoader.createDefaultProfile('test', fakeParser);
      expect(profile.tools[0].parameters.price.type).toBe('number');
    });

    it('should map boolean type correctly', async () => {
      const fakeParser: any = {
        getAllOperations: () => [{
          operationId: 'op_boolean',
          method: 'get',
          path: '/test',
          parameters: [{
            name: 'active',
            in: 'query',
            required: false,
            schema: { type: 'boolean' },
            description: 'Is active',
          }],
          summary: 'Test',
        }],
        getSecurityScheme: () => undefined,
      };

      const profile = ProfileLoader.createDefaultProfile('test', fakeParser);
      expect(profile.tools[0].parameters.active.type).toBe('boolean');
    });

    it('should map array type correctly', async () => {
      const fakeParser: any = {
        getAllOperations: () => [{
          operationId: 'op_array',
          method: 'get',
          path: '/test',
          parameters: [{
            name: 'tags',
            in: 'query',
            required: false,
            schema: { type: 'array', items: { type: 'string' } },
            description: 'Tags',
          }],
          summary: 'Test',
        }],
        getSecurityScheme: () => undefined,
      };

      const profile = ProfileLoader.createDefaultProfile('test', fakeParser);
      expect(profile.tools[0].parameters.tags.type).toBe('array');
    });

    it('should map object type correctly', async () => {
      const fakeParser: any = {
        getAllOperations: () => [{
          operationId: 'op_object',
          method: 'post',
          path: '/test',
          parameters: [{
            name: 'metadata',
            in: 'body',
            required: false,
            schema: { type: 'object' },
            description: 'Metadata object',
          }],
          summary: 'Test',
        }],
        getSecurityScheme: () => undefined,
      };

      const profile = ProfileLoader.createDefaultProfile('test', fakeParser);
      expect(profile.tools[0].parameters.metadata.type).toBe('object');
    });

    it('should fallback to string for unknown types', async () => {
      const fakeParser: any = {
        getAllOperations: () => [{
          operationId: 'op_unknown',
          method: 'get',
          path: '/test',
          parameters: [{
            name: 'weird',
            in: 'query',
            required: false,
            schema: { type: 'unknownType' },
            description: 'Unknown type param',
          }],
          summary: 'Test',
        }],
        getSecurityScheme: () => undefined,
      };

      const profile = ProfileLoader.createDefaultProfile('test', fakeParser);
      expect(profile.tools[0].parameters.weird.type).toBe('string');
    });
  });

  describe('JSON Schema validation', () => {
    it('should reject array parameter without items', async () => {
      const loader = new ProfileLoader();

      const invalidProfile = JSON.stringify({
        profile_name: 'test-invalid-array',
        tools: [
          {
            name: 'test_tool',
            description: 'Test tool with invalid array',
            operations: { test: 'op_test' },
            parameters: {
              tags: {
                type: 'array',
                description: 'List of tags'
                // Missing items property - should fail
              }
            }
          }
        ]
      });

      await expect(async () => {
        const fs = await import('fs/promises');
        const tmpPath = '/tmp/invalid-array-profile.json';
        await fs.writeFile(tmpPath, invalidProfile);
        await loader.load(tmpPath);
      }).rejects.toThrow(/missing required 'items'/);
    });

    it('should reject object parameter without properties', async () => {
      const loader = new ProfileLoader();

      const invalidProfile = JSON.stringify({
        profile_name: 'test-invalid-object',
        tools: [
          {
            name: 'test_tool',
            description: 'Test tool with invalid object',
            operations: { test: 'op_test' },
            parameters: {
              config: {
                type: 'object',
                description: 'Configuration object'
                // Missing properties - should fail
              }
            }
          }
        ]
      });

      await expect(async () => {
        const fs = await import('fs/promises');
        const tmpPath = '/tmp/invalid-object-profile.json';
        await fs.writeFile(tmpPath, invalidProfile);
        await loader.load(tmpPath);
      }).rejects.toThrow(/missing 'properties'/);
    });

    it('should accept object parameter with empty properties', async () => {
      const loader = new ProfileLoader();

      const validProfile = JSON.stringify({
        profile_name: 'test-valid-object',
        tools: [
          {
            name: 'test_tool',
            description: 'Test tool with valid object',
            operations: { test: 'op_test' },
            parameters: {
              config: {
                type: 'object',
                description: 'Free-form configuration object',
                properties: {} // Empty properties = free-form object
              }
            }
          }
        ]
      });

      const fs = await import('fs/promises');
      const tmpPath = '/tmp/valid-object-profile.json';
      await fs.writeFile(tmpPath, validProfile);
      
      const profile = await loader.load(tmpPath);
      expect(profile.tools[0].parameters.config.type).toBe('object');
      expect(profile.tools[0].parameters.config.properties).toEqual({});
    });
  });
});
