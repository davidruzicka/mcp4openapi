/**
 * Tests for profile loader
 */

import { describe, it, expect } from 'vitest';
import { ValidationError } from '../core/errors.js';
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
    it('rejects invalid cache interceptor numeric constraints', async () => {
      const loader = new ProfileLoader();
      const fs = await import('fs/promises');

      const writeProfile = async (cache: Record<string, unknown>, suffix: string): Promise<string> => {
        const tmpPath = `/tmp/profile-cache-${suffix}-${Date.now()}-${Math.random()}.json`;
        await fs.writeFile(
          tmpPath,
          JSON.stringify({
            profile_name: 'test',
            tools: [
              {
                name: 'tool',
                description: 'Tool',
                parameters: {},
                operations: { execute: 'op' },
              },
            ],
            interceptors: { cache },
          }),
          'utf-8'
        );
        return tmpPath;
      };

      const ttlPath = await writeProfile({ ttl_seconds: 0 }, 'ttl');
      await expect(loader.load(ttlPath)).rejects.toThrow('interceptors.cache.ttl_seconds must be greater than 0');

      const maxEntriesPath = await writeProfile({ max_entries: 1.5 }, 'entries');
      await expect(loader.load(maxEntriesPath)).rejects.toThrow('interceptors.cache.max_entries must be a positive integer');

      const methodsPath = await writeProfile({ methods: [] }, 'methods');
      await expect(loader.load(methodsPath)).rejects.toThrow('interceptors.cache.methods must contain at least one HTTP method');
    });

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

      await expect(loader.load(tmpPath)).rejects.toThrow("has 'required_for' action 'get' but it's not in action enum");
    });

    it('rejects enum_for when action enum is missing', async () => {
      const loader = new ProfileLoader();
      const fs = await import('fs/promises');
      const tmpPath = `/tmp/profile-enum-for-no-action-${Date.now()}-${Math.random()}.json`;
      await fs.writeFile(
        tmpPath,
        JSON.stringify({
          profile_name: 'test',
          tools: [
            {
              name: 'tool',
              description: 'Tool',
              parameters: {
                state: {
                  type: 'string',
                  description: 'State',
                  enum: ['open', 'closed'],
                  enum_for: { list: ['open'] },
                },
              },
              operations: { list: 'op' },
            },
          ],
          interceptors: {},
        }),
        'utf-8'
      );

      await expect(loader.load(tmpPath)).rejects.toThrow("has 'enum_for' but 'action' parameter has no enum");
    });

    it('rejects enum_for actions that are not in action enum', async () => {
      const loader = new ProfileLoader();
      const fs = await import('fs/promises');
      const tmpPath = `/tmp/profile-enum-for-unknown-action-${Date.now()}-${Math.random()}.json`;
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
                state: {
                  type: 'string',
                  description: 'State',
                  enum: ['open', 'closed'],
                  enum_for: { get: ['open'] },
                },
              },
              operations: { list: 'op' },
            },
          ],
          interceptors: {},
        }),
        'utf-8'
      );

      await expect(loader.load(tmpPath)).rejects.toThrow("has 'enum_for' action 'get' but it's not in action enum");
    });

    it('rejects enum_for values that are not in base enum', async () => {
      const loader = new ProfileLoader();
      const fs = await import('fs/promises');
      const tmpPath = `/tmp/profile-enum-for-invalid-values-${Date.now()}-${Math.random()}.json`;
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
                state: {
                  type: 'string',
                  description: 'State',
                  enum: ['open', 'closed'],
                  enum_for: { list: ['resolved'] },
                },
              },
              operations: { list: 'op' },
            },
          ],
          interceptors: {},
        }),
        'utf-8'
      );

      await expect(loader.load(tmpPath)).rejects.toThrow("has 'enum_for' values not present in base enum");
    });

    it('rejects allowed_for when action enum is missing', async () => {
      const loader = new ProfileLoader();
      const fs = await import('fs/promises');
      const tmpPath = `/tmp/profile-allowed-for-${Date.now()}-${Math.random()}.json`;
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
                  allowed_for: ['get'],
                },
              },
              operations: { execute: 'op' },
            },
          ],
          interceptors: {},
        }),
        'utf-8'
      );

      await expect(loader.load(tmpPath)).rejects.toThrow("has 'allowed_for' but 'action' parameter has no enum");
    });

    it('rejects forbidden_for actions that are not in action enum', async () => {
      const loader = new ProfileLoader();
      const fs = await import('fs/promises');
      const tmpPath = `/tmp/profile-forbidden-for-enum-${Date.now()}-${Math.random()}.json`;
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
                  forbidden_for: ['get'],
                },
              },
              operations: { list: 'op' },
            },
          ],
          interceptors: {},
        }),
        'utf-8'
      );

      await expect(loader.load(tmpPath)).rejects.toThrow("has 'forbidden_for' action 'get' but it's not in action enum");
    });

    it('rejects overlapping allowed_for and forbidden_for actions', async () => {
      const loader = new ProfileLoader();
      const fs = await import('fs/promises');
      const tmpPath = `/tmp/profile-allowed-forbidden-overlap-${Date.now()}-${Math.random()}.json`;
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
                  enum: ['list', 'get'],
                },
                some_id: {
                  type: 'string',
                  description: 'id',
                  allowed_for: ['get'],
                  forbidden_for: ['get'],
                },
              },
              operations: { list: 'op' },
            },
          ],
          interceptors: {},
        }),
        'utf-8'
      );

      await expect(loader.load(tmpPath)).rejects.toThrow("overlapping 'allowed_for' and 'forbidden_for'");
    });

    it('rejects required_for actions missing from allowed_for', async () => {
      const loader = new ProfileLoader();
      const fs = await import('fs/promises');
      const tmpPath = `/tmp/profile-required-not-allowed-${Date.now()}-${Math.random()}.json`;
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
                  enum: ['list', 'get'],
                },
                some_id: {
                  type: 'string',
                  description: 'id',
                  required_for: ['get'],
                  allowed_for: ['list'],
                },
              },
              operations: { list: 'op' },
            },
          ],
          interceptors: {},
        }),
        'utf-8'
      );

      await expect(loader.load(tmpPath)).rejects.toThrow("required actions missing from 'allowed_for'");
    });

    it('rejects overlapping required_for and forbidden_for actions', async () => {
      const loader = new ProfileLoader();
      const fs = await import('fs/promises');
      const tmpPath = `/tmp/profile-required-forbidden-overlap-${Date.now()}-${Math.random()}.json`;
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
                  enum: ['get'],
                },
                some_id: {
                  type: 'string',
                  description: 'id',
                  required_for: ['get'],
                  forbidden_for: ['get'],
                },
              },
              operations: { get: 'op' },
            },
          ],
          interceptors: {},
        }),
        'utf-8'
      );

      await expect(loader.load(tmpPath)).rejects.toThrow('actions required and forbidden at the same time');
    });
  });

  describe('prompt validation', () => {
    it('accepts valid prompts and extracts required template variables', async () => {
      const loader = new ProfileLoader();
      const fs = await import('fs/promises');
      const tmpPath = `/tmp/profile-prompts-valid-${Date.now()}-${Math.random()}.json`;
      await fs.writeFile(
        tmpPath,
        JSON.stringify({
          profile_name: 'test',
          tools: [
            {
              name: 'tool_a',
              description: 'Tool A',
              parameters: {},
              operations: { execute: 'op' },
            },
          ],
          prompts: [
            {
              name: 'summarize_issue',
              arguments: [{ name: 'issue_title', required: true }],
              messages: [
                {
                  role: 'user',
                  content: { type: 'text', text: 'Summarize {{ issue_title }}' },
                },
              ],
            },
          ],
          interceptors: {},
        }),
        'utf-8'
      );

      const profile = await loader.load(tmpPath);
      expect(profile.prompts).toHaveLength(1);
    });

    it('accepts prompts without arguments', async () => {
      const loader = new ProfileLoader();
      const fs = await import('fs/promises');
      const tmpPath = `/tmp/profile-prompts-no-args-${Date.now()}-${Math.random()}.json`;
      await fs.writeFile(
        tmpPath,
        JSON.stringify({
          profile_name: 'test',
          tools: [
            {
              name: 'tool_a',
              description: 'Tool A',
              parameters: {},
              operations: { execute: 'op' },
            },
          ],
          prompts: [
            {
              name: 'plain_prompt',
              messages: [
                {
                  role: 'user',
                  content: { type: 'text', text: 'Hello world' },
                },
              ],
            },
          ],
          interceptors: {},
        }),
        'utf-8'
      );

      await expect(loader.load(tmpPath)).resolves.toBeDefined();
    });

    it('accepts prompts with non-required arguments only', async () => {
      const loader = new ProfileLoader();
      const fs = await import('fs/promises');
      const tmpPath = `/tmp/profile-prompts-optional-args-${Date.now()}-${Math.random()}.json`;
      await fs.writeFile(
        tmpPath,
        JSON.stringify({
          profile_name: 'test',
          tools: [
            {
              name: 'tool_a',
              description: 'Tool A',
              parameters: {},
              operations: { execute: 'op' },
            },
          ],
          prompts: [
            {
              name: 'optional_prompt',
              arguments: [{ name: 'note', required: false }],
              messages: [
                {
                  role: 'user',
                  content: { type: 'text', text: 'Optional note {{note}}' },
                },
              ],
            },
          ],
          interceptors: {},
        }),
        'utf-8'
      );

      await expect(loader.load(tmpPath)).resolves.toBeDefined();
    });

    it('rejects duplicate prompt names', async () => {
      const loader = new ProfileLoader();
      const fs = await import('fs/promises');
      const tmpPath = `/tmp/profile-prompts-dup-name-${Date.now()}-${Math.random()}.json`;
      await fs.writeFile(
        tmpPath,
        JSON.stringify({
          profile_name: 'test',
          tools: [{ name: 'tool_a', description: 'Tool A', parameters: {}, operations: { execute: 'op' } }],
          prompts: [
            { name: 'same_name', messages: [{ role: 'user', content: { type: 'text', text: 'A' } }] },
            { name: 'same_name', messages: [{ role: 'user', content: { type: 'text', text: 'B' } }] },
          ],
          interceptors: {},
        }),
        'utf-8'
      );

      await expect(loader.load(tmpPath)).rejects.toThrow("Duplicate prompt name 'same_name'");
    });

    it('rejects prompt name conflict with tool name', async () => {
      const loader = new ProfileLoader();
      const fs = await import('fs/promises');
      const tmpPath = `/tmp/profile-prompts-tool-conflict-${Date.now()}-${Math.random()}.json`;
      await fs.writeFile(
        tmpPath,
        JSON.stringify({
          profile_name: 'test',
          tools: [{ name: 'conflict_name', description: 'Tool A', parameters: {}, operations: { execute: 'op' } }],
          prompts: [
            { name: 'conflict_name', messages: [{ role: 'user', content: { type: 'text', text: 'A' } }] },
          ],
          interceptors: {},
        }),
        'utf-8'
      );

      await expect(loader.load(tmpPath)).rejects.toThrow("conflicts with existing tool name");
    });

    it('rejects prompts without messages', async () => {
      const loader = new ProfileLoader();
      const fs = await import('fs/promises');
      const tmpPath = `/tmp/profile-prompts-empty-messages-${Date.now()}-${Math.random()}.json`;
      await fs.writeFile(
        tmpPath,
        JSON.stringify({
          profile_name: 'test',
          tools: [{ name: 'tool_a', description: 'Tool A', parameters: {}, operations: { execute: 'op' } }],
          prompts: [{ name: 'empty_messages', messages: [] }],
          interceptors: {},
        }),
        'utf-8'
      );

      await expect(loader.load(tmpPath)).rejects.toThrow("must have at least one message");
    });

    it('rejects duplicate prompt argument names', async () => {
      const loader = new ProfileLoader();
      const fs = await import('fs/promises');
      const tmpPath = `/tmp/profile-prompts-dup-arg-${Date.now()}-${Math.random()}.json`;
      await fs.writeFile(
        tmpPath,
        JSON.stringify({
          profile_name: 'test',
          tools: [{ name: 'tool_a', description: 'Tool A', parameters: {}, operations: { execute: 'op' } }],
          prompts: [
            {
              name: 'dup_arg_prompt',
              arguments: [
                { name: 'issue_title', required: true },
                { name: 'issue_title', required: false },
              ],
              messages: [{ role: 'user', content: { type: 'text', text: 'Title {{issue_title}}' } }],
            },
          ],
          interceptors: {},
        }),
        'utf-8'
      );

      await expect(loader.load(tmpPath)).rejects.toThrow("duplicate argument 'issue_title'");
    });

    it('rejects required arguments not referenced in templates', async () => {
      const loader = new ProfileLoader();
      const fs = await import('fs/promises');
      const tmpPath = `/tmp/profile-prompts-missing-ref-${Date.now()}-${Math.random()}.json`;
      await fs.writeFile(
        tmpPath,
        JSON.stringify({
          profile_name: 'test',
          tools: [{ name: 'tool_a', description: 'Tool A', parameters: {}, operations: { execute: 'op' } }],
          prompts: [
            {
              name: 'missing_ref_prompt',
              arguments: [{ name: 'issue_title', required: true }],
              messages: [{ role: 'user', content: { type: 'text', text: 'No variables here' } }],
            },
          ],
          interceptors: {},
        }),
        'utf-8'
      );

      await expect(loader.load(tmpPath)).rejects.toThrow("no message references it as '{{issue_title}}'");
    });

    it('private validatePrompts skips non-text content and still enforces required argument references', () => {
      const loader = new ProfileLoader();
      const prompts = [
        {
          name: 'non_text_prompt',
          arguments: [{ name: 'issue_title', required: true }],
          messages: [
            { role: 'user', content: { type: 'image', data: 'abc' } },
          ],
        },
      ] as any;

      const tools = [{ name: 'tool_a' }] as any;
      expect(() => (loader as any).validatePrompts(prompts, tools)).toThrow(
        "no message references it as '{{issue_title}}'"
      );
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
    const parser = new (await import('../openapi/openapi-parser.js')).OpenAPIParser();
    await parser.load('profiles/gitlab/openapi.yaml');
    const profile = ProfileLoader.createDefaultProfile('my-api', parser);
    expect(profile.profile_name).toBe('my-api');
    expect(profile.tools.length).toBeGreaterThan(0);
    expect(profile.description).toContain('Auto-generated default profile');
  });

  it('should create default profile with auth from OpenAPI security', async () => {
    const parser = new (await import('../openapi/openapi-parser.js')).OpenAPIParser();
    await parser.load('profiles/gitlab/openapi.yaml');
    
    const profile = ProfileLoader.createDefaultProfile('my-api', parser);
    
    // GitLab spec has security defined
    expect(profile.interceptors).toBeDefined();
    expect(profile.interceptors?.auth).toBeDefined();
    const authConfig = Array.isArray(profile.interceptors?.auth) ? profile.interceptors.auth[0] : profile.interceptors?.auth;
    expect(authConfig?.value_from_env).toBe('MCP4_API_TOKEN');
  });

  it('should create default profile with bearer auth for bearer security scheme', async () => {
    const parser = new (await import('../openapi/openapi-parser.js')).OpenAPIParser();
    
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
    const parser = new (await import('../openapi/openapi-parser.js')).OpenAPIParser();
    
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
    const parser = new (await import('../openapi/openapi-parser.js')).OpenAPIParser();
    
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
    const parser = new (await import('../openapi/openapi-parser.js')).OpenAPIParser();
    
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
    const parser = new (await import('../openapi/openapi-parser.js')).OpenAPIParser();
    
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
    const parser = new (await import('../openapi/openapi-parser.js')).OpenAPIParser();
    
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
    const parser = new (await import('../openapi/openapi-parser.js')).OpenAPIParser();
    
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
      const parser = new (await import('../openapi/openapi-parser.js')).OpenAPIParser();
      
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
      const parser = new (await import('../openapi/openapi-parser.js')).OpenAPIParser();
      
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
      const parser = new (await import('../openapi/openapi-parser.js')).OpenAPIParser();
      
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
      const parser = new (await import('../openapi/openapi-parser.js')).OpenAPIParser();
      
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
      const parser = new (await import('../openapi/openapi-parser.js')).OpenAPIParser();
      
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
      const parser = new (await import('../openapi/openapi-parser.js')).OpenAPIParser();
      
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
      const parser = new (await import('../openapi/openapi-parser.js')).OpenAPIParser();
      
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
    const parser = new (await import('../openapi/openapi-parser.js')).OpenAPIParser();
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

    it('accepts OAuth auth entries that provide explicit endpoints without issuer', async () => {
      const loader = new ProfileLoader();
      const fs = await import('fs/promises');
      const tmpPath = `/tmp/valid-oauth-array-profile-${Date.now()}-${Math.random()}.json`;
      await fs.writeFile(
        tmpPath,
        JSON.stringify({
          profile_name: 'test',
          interceptors: {
            auth: [
              {
                type: 'oauth',
                oauth_config: {
                  client_id: 'test',
                  authorization_endpoint: 'https://auth.example.com/authorize',
                  token_endpoint: 'https://auth.example.com/token',
                },
              },
            ],
          },
          tools: [{
            name: 'test_tool',
            description: 'Test tool',
            operations: { list: 'getTest' },
            parameters: {},
          }],
        }),
      );

      await expect(loader.load(tmpPath)).resolves.toMatchObject({ profile_name: 'test' });
    });
  });

  describe('operation validation for proxy downloads and composite steps', () => {
    it('rejects missing proxy download metadata operations', async () => {
      const loader = new ProfileLoader();
      const fs = await import('fs/promises');
      const tmpPath = `/tmp/proxy-download-metadata-${Date.now()}-${Math.random()}.json`;
      await fs.writeFile(
        tmpPath,
        JSON.stringify({
          profile_name: 'test',
          tools: [{
            name: 'download_asset',
            description: 'Download asset',
            parameters: {},
            operations: {
              execute: {
                type: 'proxy_download',
                metadata_endpoint: 'missingMetadata',
                file_name_path: 'name',
              },
            },
          }],
          interceptors: {},
        }),
      );

      const parser = {
        getOperation: (operationId: string) => operationId === 'downloadFile' ? { operationId } : undefined,
        getPath: () => undefined,
      } as any;

      await expect(loader.load(tmpPath, parser)).rejects.toThrow(/missingMetadata/);
    });

    it('rejects missing proxy download download_endpoint operations', async () => {
      const loader = new ProfileLoader();
      const fs = await import('fs/promises');
      const tmpPath = `/tmp/proxy-download-endpoint-${Date.now()}-${Math.random()}.json`;
      await fs.writeFile(
        tmpPath,
        JSON.stringify({
          profile_name: 'test',
          tools: [{
            name: 'download_asset',
            description: 'Download asset',
            parameters: {},
            operations: {
              execute: {
                type: 'proxy_download',
                metadata_endpoint: 'getMetadata',
                download_endpoint: 'missingDownload',
                file_name_path: 'name',
              },
            },
          }],
          interceptors: {},
        }),
      );

      const parser = {
        getOperation: (operationId: string) => operationId === 'getMetadata' ? { operationId } : undefined,
        getPath: () => undefined,
      } as any;

      await expect(loader.load(tmpPath, parser)).rejects.toThrow(/missingDownload/);
    });

    it('rejects composite steps that do not resolve to OpenAPI operations', async () => {
      const loader = new ProfileLoader();
      const fs = await import('fs/promises');
      const tmpPath = `/tmp/composite-missing-step-${Date.now()}-${Math.random()}.json`;
      await fs.writeFile(
        tmpPath,
        JSON.stringify({
          profile_name: 'test',
          tools: [{
            name: 'read_asset',
            description: 'Read asset',
            composite: true,
            parameters: {},
            steps: [{ call: 'GET /missing', store_as: 'asset' }],
          }],
          interceptors: {},
        }),
      );

      const parser = {
        getOperation: () => undefined,
        getPath: () => undefined,
      } as any;

      await expect(loader.load(tmpPath, parser)).rejects.toThrow(/Composite step 'GET \/missing'/);
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

  describe('session cookie auth validation', () => {
    it('should reject dangerous login_endpoint URIs', async () => {
      const loader = new ProfileLoader();
      const fs = await import('fs/promises');
      const tmpPath = `/tmp/auth-invalid-${Date.now()}-${Math.random()}.json`;
      await fs.writeFile(
        tmpPath,
        JSON.stringify({
          profile_name: 'auth-invalid',
          interceptors: {
            auth: [
              {
                type: 'session-cookie',
                session_cookie_config: {
                  login_endpoint: 'javascript:alert(1)',
                  cookie_names: ['session'],
                  username_field: 'user',
                  username_from_env: 'USER',
                  password_field: 'pass',
                  password_from_env: 'PASS'
                }
              }
            ]
          },
          tools: [
            {
              name: 'tool_a',
              description: 'Tool A',
              operations: { list: 'getItems' },
              parameters: {
                action: { type: 'string', required: true, description: 'Action' },
              },
            },
          ],
        }),
        'utf-8'
      );

      await expect(loader.load(tmpPath)).rejects.toThrow(
        /login_endpoint.*must be a valid absolute URL/
      );
    });
  });

  describe('enterprise authorization validation', () => {
    afterEach(() => {
      delete process.env.ENTERPRISE_MODE;
      delete process.env.ENTERPRISE_ISSUER;
      delete process.env.ENTERPRISE_ALLOWED_ALGS;
      delete process.env.ENTERPRISE_CATEGORIES;
    });

    it('normalizes valid enterprise authorization config', async () => {
      const loader = new ProfileLoader();
      const fs = await import('fs/promises');
      const tmpPath = `/tmp/enterprise-valid-${Date.now()}-${Math.random()}.json`;
      await fs.writeFile(
        tmpPath,
        JSON.stringify({
          profile_name: 'enterprise-valid',
          enterprise_authorization: {
            enabled: true,
            issuer: { issuer: 'https://issuer.example', jwks_uri: 'https://issuer.example/jwks' },
            token_exchange: {
              grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
              allowed_client_ids: ['enterprise-client'],
            },
            access_policy: { claim_mappings: { subject: 'sub' }, scopes_supported: ['api'], default_scopes: ['api'] }
          },
          tools: [{
            name: 'tool_a',
            description: 'Tool A',
            operations: { list: 'getItems' },
            parameters: { action: { type: 'string', description: 'Action', enum: ['list'], required: true } }
          }]
        }),
        'utf-8'
      );

      const profile = await loader.load(tmpPath);
      expect(profile.enterprise_authorization?.mode).toBe('required');
      expect(profile.enterprise_authorization?.token_exchange.required_claims).toContain('sub');
    });

    it('loads env-backed enterprise authorization values from the profile', async () => {
      process.env.ENTERPRISE_MODE = 'optional';
      process.env.ENTERPRISE_ISSUER = 'https://env-issuer.example';
      process.env.ENTERPRISE_ALLOWED_ALGS = 'RS384';
      process.env.ENTERPRISE_CATEGORIES = 'list,read';

      const loader = new ProfileLoader();
      const fs = await import('fs/promises');
      const tmpPath = `/tmp/enterprise-env-backed-${Date.now()}-${Math.random()}.json`;
      await fs.writeFile(
        tmpPath,
        JSON.stringify({
          profile_name: 'enterprise-env-backed',
          enterprise_authorization: {
            enabled: true,
            mode: 'required',
            mode_from_env: 'ENTERPRISE_MODE',
            issuer: {
              issuer: 'https://issuer.example',
              issuer_from_env: 'ENTERPRISE_ISSUER',
              allowed_algs: ['RS256'],
              allowed_algs_from_env: 'ENTERPRISE_ALLOWED_ALGS'
            },
            token_exchange: {
              grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
              allowed_client_ids: ['enterprise-client']
            },
            access_policy: {
              scopes_supported: ['api'],
              default_scopes: ['api'],
              allowed_tool_categories_from_env: 'ENTERPRISE_CATEGORIES'
            }
          },
          tools: [{
            name: 'tool_a',
            description: 'Tool A',
            operations: { list: 'getItems' },
            parameters: { action: { type: 'string', description: 'Action', enum: ['list'], required: true } }
          }]
        }),
        'utf-8'
      );

      const profile = await loader.load(tmpPath);
      expect(profile.enterprise_authorization?.mode).toBe('optional');
      expect(profile.enterprise_authorization?.issuer.issuer).toBe('https://env-issuer.example');
      expect(profile.enterprise_authorization?.issuer.allowed_algs).toEqual(['RS384']);
      expect(profile.enterprise_authorization?.access_policy?.allowed_tool_categories).toEqual(['list', 'read']);
    });

    it('fails profile loading when enterprise env-backed authorization values are invalid', async () => {
      process.env.ENTERPRISE_INVALID_CATEGORIES = 'list,unknown';

      const loader = new ProfileLoader();
      const fs = await import('fs/promises');
      const tmpPath = `/tmp/enterprise-env-invalid-categories-${Date.now()}-${Math.random()}.json`;
      await fs.writeFile(
        tmpPath,
        JSON.stringify({
          profile_name: 'enterprise-env-invalid-categories',
          enterprise_authorization: {
            enabled: true,
            issuer: {
              issuer: 'https://issuer.example',
              jwks_uri: 'https://issuer.example/jwks'
            },
            token_exchange: {
              grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
              allowed_client_ids: ['enterprise-client']
            },
            access_policy: {
              scopes_supported: ['api'],
              default_scopes: ['api'],
              allowed_tool_categories_from_env: 'ENTERPRISE_INVALID_CATEGORIES'
            }
          },
          tools: [{
            name: 'tool_a',
            description: 'Tool A',
            operations: { list: 'getItems' },
            parameters: { action: { type: 'string', description: 'Action', enum: ['list'], required: true } }
          }]
        }),
        'utf-8'
      );

      await expect(loader.load(tmpPath)).rejects.toThrow(/unsupported value 'unknown'/);
    });

    it('fails profile loading when enterprise claim mappings env JSON is malformed', async () => {
      process.env.ENTERPRISE_INVALID_CLAIM_MAPPINGS = '{';

      const loader = new ProfileLoader();
      const fs = await import('fs/promises');
      const tmpPath = `/tmp/enterprise-env-invalid-claims-${Date.now()}-${Math.random()}.json`;
      await fs.writeFile(
        tmpPath,
        JSON.stringify({
          profile_name: 'enterprise-env-invalid-claims',
          enterprise_authorization: {
            enabled: true,
            issuer: {
              issuer: 'https://issuer.example',
              jwks_uri: 'https://issuer.example/jwks'
            },
            token_exchange: {
              grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
              allowed_client_ids: ['enterprise-client']
            },
            access_policy: {
              scopes_supported: ['api'],
              default_scopes: ['api'],
              claim_mappings_from_env: 'ENTERPRISE_INVALID_CLAIM_MAPPINGS'
            }
          },
          tools: [{
            name: 'tool_a',
            description: 'Tool A',
            operations: { list: 'getItems' },
            parameters: { action: { type: 'string', description: 'Action', enum: ['list'], required: true } }
          }]
        }),
        'utf-8'
      );

      await expect(loader.load(tmpPath)).rejects.toThrow(/must be valid JSON/);
    });

    it('fails profile loading when enterprise env var references are empty', async () => {
      const loader = new ProfileLoader();
      const fs = await import('fs/promises');
      const tmpPath = `/tmp/enterprise-env-empty-reference-${Date.now()}-${Math.random()}.json`;
      await fs.writeFile(
        tmpPath,
        JSON.stringify({
          profile_name: 'enterprise-env-empty-reference',
          enterprise_authorization: {
            enabled: true,
            issuer: {
              issuer: 'https://issuer.example',
              jwks_uri: 'https://issuer.example/jwks'
            },
            token_exchange: {
              grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
              allowed_client_ids: ['enterprise-client']
            },
            access_policy: {
              scopes_supported: ['api'],
              default_scopes: ['api'],
              allowed_tool_categories_from_env: '   '
            }
          },
          tools: [{
            name: 'tool_a',
            description: 'Tool A',
            operations: { list: 'getItems' },
            parameters: { action: { type: 'string', description: 'Action', enum: ['list'], required: true } }
          }]
        }),
        'utf-8'
      );

      await expect(loader.load(tmpPath)).rejects.toThrow(/allowed_tool_categories_from_env must not be empty/);
    });

    it('rejects non-https enterprise issuer URLs', async () => {
      const loader = new ProfileLoader();
      const fs = await import('fs/promises');
      const previousNodeEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      const tmpPath = `/tmp/enterprise-invalid-${Date.now()}-${Math.random()}.json`;
      await fs.writeFile(
        tmpPath,
        JSON.stringify({
          profile_name: 'enterprise-invalid',
          enterprise_authorization: {
            enabled: true,
            issuer: { issuer: 'http://issuer.example' },
            token_exchange: { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer' }
          },
          tools: [{
            name: 'tool_a',
            description: 'Tool A',
            operations: { list: 'getItems' },
            parameters: { action: { type: 'string', description: 'Action', enum: ['list'], required: true } }
          }]
        }),
        'utf-8'
      );

      await expect(loader.load(tmpPath)).rejects.toThrow(/must use https/);
      process.env.NODE_ENV = previousNodeEnv;
    });

    it('rejects enterprise profiles without allowed clients when dynamic registration uses secure default', async () => {
      const loader = new ProfileLoader();
      const fs = await import('fs/promises');
      const tmpPath = `/tmp/enterprise-clients-invalid-${Date.now()}-${Math.random()}.json`;
      await fs.writeFile(
        tmpPath,
        JSON.stringify({
          profile_name: 'enterprise-client-validation',
          enterprise_authorization: {
            enabled: true,
            issuer: { issuer: 'https://issuer.example', jwks_uri: 'https://issuer.example/jwks' },
            token_exchange: { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer' },
            access_policy: { scopes_supported: ['api'], default_scopes: ['api'] }
          },
          tools: [{
            name: 'tool_a',
            description: 'Tool A',
            operations: { list: 'getItems' },
            parameters: { action: { type: 'string', description: 'Action', enum: ['list'], required: true } }
          }]
        }),
        'utf-8'
      );

      await expect(loader.load(tmpPath)).rejects.toThrow(/allowed_client_ids is required/);
    });

    it('rejects enterprise resources that are not included in audience', async () => {
      const loader = new ProfileLoader();
      const fs = await import('fs/promises');
      const tmpPath = `/tmp/enterprise-resource-audience-invalid-${Date.now()}-${Math.random()}.json`;
      await fs.writeFile(
        tmpPath,
        JSON.stringify({
          profile_name: 'enterprise-resource-audience-invalid',
          enterprise_authorization: {
            enabled: true,
            issuer: { issuer: 'https://issuer.example', jwks_uri: 'https://issuer.example/jwks' },
            resource: 'https://resource.example/a',
            audience: ['https://resource.example/b'],
            token_exchange: {
              grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
              allowed_client_ids: ['enterprise-client']
            }
          },
          tools: [{
            name: 'tool_a',
            description: 'Tool A',
            operations: { list: 'getItems' },
            parameters: { action: { type: 'string', description: 'Action', enum: ['list'], required: true } }
          }]
        }),
        'utf-8'
      );

      await expect(loader.load(tmpPath)).rejects.toThrow(/resource must be included in audience/);
    });

    it('rejects required enterprise mode when oauth auth metadata is configured', async () => {
      const loader = new ProfileLoader();
      const fs = await import('fs/promises');
      const tmpPath = `/tmp/enterprise-required-oauth-invalid-${Date.now()}-${Math.random()}.json`;
      await fs.writeFile(
        tmpPath,
        JSON.stringify({
          profile_name: 'enterprise-required-oauth-invalid',
          enterprise_authorization: {
            enabled: true,
            mode: 'required',
            issuer: { issuer: 'https://issuer.example', jwks_uri: 'https://issuer.example/jwks' },
            token_exchange: {
              grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
              allowed_client_ids: ['enterprise-client']
            }
          },
          interceptors: {
            auth: {
              type: 'oauth',
              authorization_url: 'https://issuer.example/authorize',
              token_url: 'https://issuer.example/token',
              client_id: 'client-id',
              scopes: ['api']
            }
          },
          tools: [{
            name: 'tool_a',
            description: 'Tool A',
            operations: { list: 'getItems' },
            parameters: { action: { type: 'string', description: 'Action', enum: ['list'], required: true } }
          }]
        }),
        'utf-8'
      );

      await expect(loader.load(tmpPath)).rejects.toThrow(/cannot be combined with profile oauth auth metadata/);
    });
  });

  describe('cache interceptor validation', () => {
    it('should reject non-positive cache max_memory_bytes', async () => {
      const loader = new ProfileLoader();
      const fs = await import('fs/promises');
      const tmpPath = `/tmp/cache-memory-invalid-${Date.now()}-${Math.random()}.json`;
      await fs.writeFile(
        tmpPath,
        JSON.stringify({
          profile_name: 'cache-invalid',
          interceptors: {
            cache: {
              ttl_seconds: 300,
              max_entries: 100,
              max_memory_bytes: 0,
            },
          },
          tools: [
            {
              name: 'tool_a',
              description: 'Tool A',
              operations: { list: 'getItems' },
              parameters: {
                action: {
                  type: 'string',
                  description: 'Action',
                  enum: ['list'],
                  required: true,
                },
              },
            },
          ],
        }),
        'utf-8'
      );

      await expect(loader.load(tmpPath)).rejects.toThrow(
        'interceptors.cache.max_memory_bytes must be a positive integer'
      );
    });

    it('should accept valid cache max_memory_bytes configuration', async () => {
      const loader = new ProfileLoader();
      const fs = await import('fs/promises');
      const tmpPath = `/tmp/cache-memory-valid-${Date.now()}-${Math.random()}.json`;
      await fs.writeFile(
        tmpPath,
        JSON.stringify({
          profile_name: 'cache-valid',
          interceptors: {
            cache: {
              enabled: true,
              ttl_seconds: 300,
              max_entries: 100,
              max_memory_bytes: 2_000_000,
              methods: ['GET'],
            },
          },
          tools: [
            {
              name: 'tool_a',
              description: 'Tool A',
              operations: { list: 'getItems' },
              parameters: {
                action: {
                  type: 'string',
                  description: 'Action',
                  enum: ['list'],
                  required: true,
                },
              },
            },
          ],
        }),
        'utf-8'
      );

      const profile = await loader.load(tmpPath);
      expect(profile.interceptors?.cache?.max_memory_bytes).toBe(2_000_000);
    });

    it('should reject empty cache max_memory_bytes_from_env', async () => {
      const loader = new ProfileLoader();
      const fs = await import('fs/promises');
      const tmpPath = `/tmp/cache-memory-env-invalid-${Date.now()}-${Math.random()}.json`;
      await fs.writeFile(
        tmpPath,
        JSON.stringify({
          profile_name: 'cache-env-invalid',
          interceptors: {
            cache: {
              max_memory_bytes_from_env: '   ',
            },
          },
          tools: [
            {
              name: 'tool_a',
              description: 'Tool A',
              operations: { list: 'getItems' },
              parameters: {
                action: {
                  type: 'string',
                  description: 'Action',
                  enum: ['list'],
                  required: true,
                },
              },
            },
          ],
        }),
        'utf-8'
      );

      await expect(loader.load(tmpPath)).rejects.toThrow(
        'interceptors.cache.max_memory_bytes_from_env must not be empty'
      );
    });
  });

  describe('upstream MCP provider configuration', () => {
    it('loads remote http-streamable upstream providers from profile JSON', async () => {
      const loader = new ProfileLoader();
      const fs = await import('fs/promises');
      const tmpPath = `/tmp/upstream-mcp-static-${Date.now()}-${Math.random()}.json`;

      await fs.writeFile(
        tmpPath,
        JSON.stringify({
          profile_name: 'upstream-static',
          tools: [],
          upstream_mcp: {
            name: 'remote-mcp',
            transport: {
              type: 'http-streamable',
              url: 'https://remote-mcp.example/mcp',
            },
            auth: {
              type: 'bearer',
              value_from_env: 'REMOTE_MCP_TOKEN',
            },
            tool_prefix: 'remote',
            tools: {
              allow: ['github_*'],
              deny: ['admin_*'],
            },
            timeout_ms: 30000,
          },
        }),
        'utf-8',
      );

      const profile = await loader.load(tmpPath);

      expect(profile.upstream_mcp).toEqual(
        {
          name: 'remote-mcp',
          transport: {
            type: 'http-streamable',
            url: 'https://remote-mcp.example/mcp',
          },
          auth: {
            type: 'bearer',
            value_from_env: 'REMOTE_MCP_TOKEN',
          },
          tool_prefix: 'remote',
          tools: {
            allow: ['github_*'],
            deny: ['admin_*'],
          },
          timeout_ms: 30000,
        },
      );
    });

    it('prefers upstream_mcp_from_env over static upstream_mcp', async () => {
      const loader = new ProfileLoader();
      const fs = await import('fs/promises');
      const tmpPath = `/tmp/upstream-mcp-env-${Date.now()}-${Math.random()}.json`;
      const previous = process.env.MCP4_UPSTREAM_MCP_JSON;
      process.env.MCP4_UPSTREAM_MCP_JSON = JSON.stringify({
        name: 'env-remote',
        transport: {
          type: 'http-streamable',
          url: 'https://env-remote.example/mcp',
        },
        auth: {
          type: 'custom-header',
          header_name: 'X-Upstream-Key',
          value_from_env: 'ENV_REMOTE_TOKEN',
        },
        tool_prefix: 'env_remote',
      });

      await fs.writeFile(
        tmpPath,
        JSON.stringify({
          profile_name: 'upstream-env',
          tools: [],
          upstream_mcp_from_env: 'MCP4_UPSTREAM_MCP_JSON',
          upstream_mcp: {
            name: 'static-remote',
            transport: {
              type: 'http-streamable',
              url: 'https://static-remote.example/mcp',
            },
          },
        }),
        'utf-8',
      );

      try {
        const profile = await loader.load(tmpPath);
        expect(profile.upstream_mcp).toEqual(
          {
            name: 'env-remote',
            transport: {
              type: 'http-streamable',
              url: 'https://env-remote.example/mcp',
            },
            auth: {
              type: 'custom-header',
              header_name: 'X-Upstream-Key',
              value_from_env: 'ENV_REMOTE_TOKEN',
            },
            tool_prefix: 'env_remote',
          },
        );
      } finally {
        if (previous === undefined) {
          delete process.env.MCP4_UPSTREAM_MCP_JSON;
        } else {
          process.env.MCP4_UPSTREAM_MCP_JSON = previous;
        }
      }
    });

    it('rejects stdio upstream transport in the first iteration', async () => {
      const loader = new ProfileLoader();
      const fs = await import('fs/promises');
      const tmpPath = `/tmp/upstream-mcp-stdio-${Date.now()}-${Math.random()}.json`;

      await fs.writeFile(
        tmpPath,
        JSON.stringify({
          profile_name: 'upstream-stdio',
          tools: [
            {
              name: 'tool_a',
              description: 'Tool A',
              operations: { list: 'listItems' },
              parameters: {},
            },
          ],
          upstream_mcp: {
            name: 'stdio-mcp',
            transport: {
              type: 'stdio',
              command: 'npx',
              args: ['-y', 'mcp-github'],
            },
          },
        }),
        'utf-8',
      );

      await expect(loader.load(tmpPath)).rejects.toThrow(/invalid_literal|http-streamable/);
    });

    it('rejects invalid upstream auth combinations', async () => {
      const loader = new ProfileLoader();
      const fs = await import('fs/promises');
      const tmpPath = `/tmp/upstream-mcp-auth-${Date.now()}-${Math.random()}.json`;

      await fs.writeFile(
        tmpPath,
        JSON.stringify({
          profile_name: 'upstream-auth',
          tools: [
            {
              name: 'tool_a',
              description: 'Tool A',
              operations: { list: 'listItems' },
              parameters: {},
            },
          ],
          upstream_mcp: {
            name: 'remote-mcp',
            transport: {
              type: 'http-streamable',
              url: 'https://remote-mcp.example/mcp',
            },
            auth: {
              type: 'custom-header',
              value_from_env: 'REMOTE_MCP_TOKEN',
            },
          },
        }),
        'utf-8',
      );

      await expect(loader.load(tmpPath)).rejects.toThrow(
        'upstream_mcp.auth.header_name is required for custom-header auth',
      );
    });

    it('rejects empty upstream_mcp_from_env references', async () => {
      const loader = new ProfileLoader();
      const fs = await import('fs/promises');
      const tmpPath = `/tmp/upstream-mcp-env-ref-${Date.now()}-${Math.random()}.json`;

      await fs.writeFile(
        tmpPath,
        JSON.stringify({
          profile_name: 'upstream-env-ref',
          tools: [
            {
              name: 'tool_a',
              description: 'Tool A',
              operations: { list: 'listItems' },
              parameters: {},
            },
          ],
          upstream_mcp_from_env: '   ',
        }),
        'utf-8',
      );

      await expect(loader.load(tmpPath)).rejects.toThrow('upstream_mcp_from_env must not be empty');
    });

    it('rejects invalid upstream MCP JSON from env', async () => {
      const loader = new ProfileLoader();
      const fs = await import('fs/promises');
      const tmpPath = `/tmp/upstream-mcp-invalid-env-${Date.now()}-${Math.random()}.json`;
      const previous = process.env.MCP4_UPSTREAM_MCP_JSON;
      process.env.MCP4_UPSTREAM_MCP_JSON = '{not-json';

      await fs.writeFile(
        tmpPath,
        JSON.stringify({
          profile_name: 'upstream-invalid-env',
          tools: [
            {
              name: 'tool_a',
              description: 'Tool A',
              operations: { list: 'listItems' },
              parameters: {},
            },
          ],
          upstream_mcp_from_env: 'MCP4_UPSTREAM_MCP_JSON',
        }),
        'utf-8',
      );

      try {
        await expect(loader.load(tmpPath)).rejects.toThrow('upstream_mcp must contain valid JSON');
      } finally {
        if (previous === undefined) {
          delete process.env.MCP4_UPSTREAM_MCP_JSON;
        } else {
          process.env.MCP4_UPSTREAM_MCP_JSON = previous;
        }
      }
    });

    it('rejects env upstream JSON with missing name as ValidationError', async () => {
      const loader = new ProfileLoader();
      const fs = await import('fs/promises');
      const tmpPath = `/tmp/upstream-mcp-missing-name-${Date.now()}-${Math.random()}.json`;
      const envVarName = `MCP4_TEST_UPSTREAM_${Date.now()}`;
      const previous = process.env[envVarName];
      process.env[envVarName] = JSON.stringify({
        transport: { type: 'http-streamable', url: 'https://remote.example/mcp' },
      });

      await fs.writeFile(
        tmpPath,
        JSON.stringify({
          profile_name: 'upstream-missing-name',
          tools: [{ name: 'tool_a', description: 'Tool A', operations: { list: 'listItems' }, parameters: {} }],
          upstream_mcp_from_env: envVarName,
        }),
        'utf-8',
      );

      try {
        await expect(loader.load(tmpPath)).rejects.toThrow(ValidationError);
      } finally {
        if (previous === undefined) {
          delete process.env[envVarName];
        } else {
          process.env[envVarName] = previous;
        }
        await fs.unlink(tmpPath).catch(() => undefined);
      }
    });

    it('rejects env upstream JSON with missing auth.value_from_env as ValidationError', async () => {
      const loader = new ProfileLoader();
      const fs = await import('fs/promises');
      const tmpPath = `/tmp/upstream-mcp-missing-auth-env-${Date.now()}-${Math.random()}.json`;
      const envVarName = `MCP4_TEST_UPSTREAM_${Date.now()}`;
      const previous = process.env[envVarName];
      // auth.value_from_env is missing - would previously crash with TypeError
      process.env[envVarName] = JSON.stringify({
        name: 'remote-mcp',
        transport: { type: 'http-streamable', url: 'https://remote.example/mcp' },
        auth: { type: 'bearer' },
      });

      await fs.writeFile(
        tmpPath,
        JSON.stringify({
          profile_name: 'upstream-missing-auth-env',
          tools: [{ name: 'tool_a', description: 'Tool A', operations: { list: 'listItems' }, parameters: {} }],
          upstream_mcp_from_env: envVarName,
        }),
        'utf-8',
      );

      try {
        await expect(loader.load(tmpPath)).rejects.toThrow(ValidationError);
      } finally {
        if (previous === undefined) {
          delete process.env[envVarName];
        } else {
          process.env[envVarName] = previous;
        }
        await fs.unlink(tmpPath).catch(() => undefined);
      }
    });

    it('rejects env upstream JSON with non-array tools as ValidationError instead of silently dropping policy', async () => {
      const loader = new ProfileLoader();
      const fs = await import('fs/promises');
      const tmpPath = `/tmp/upstream-mcp-tools-string-${Date.now()}-${Math.random()}.json`;
      const envVarName = `MCP4_TEST_UPSTREAM_${Date.now()}`;
      const previous = process.env[envVarName];
      // tools as string would previously pass validateToolPolicy but crash or silently lose policy
      process.env[envVarName] = JSON.stringify({
        name: 'remote-mcp',
        transport: { type: 'http-streamable', url: 'https://remote.example/mcp' },
        tools: 'admin_*',
      });

      await fs.writeFile(
        tmpPath,
        JSON.stringify({
          profile_name: 'upstream-tools-string',
          tools: [{ name: 'tool_a', description: 'Tool A', operations: { list: 'listItems' }, parameters: {} }],
          upstream_mcp_from_env: envVarName,
        }),
        'utf-8',
      );

      try {
        await expect(loader.load(tmpPath)).rejects.toThrow(ValidationError);
      } finally {
        if (previous === undefined) {
          delete process.env[envVarName];
        } else {
          process.env[envVarName] = previous;
        }
        await fs.unlink(tmpPath).catch(() => undefined);
      }
    });

    it('rejects empty JSON array in env upstream MCP', async () => {
      const loader = new ProfileLoader();
      const fs = await import('fs/promises');
      const tmpPath = `/tmp/upstream-mcp-empty-arr-${Date.now()}-${Math.random()}.json`;
      const envVarName = `MCP4_TEST_UPSTREAM_${Date.now()}`;
      const previous = process.env[envVarName];
      process.env[envVarName] = '[]';

      await fs.writeFile(
        tmpPath,
        JSON.stringify({
          profile_name: 'upstream-empty-array',
          tools: [{ name: 'tool_a', description: 'Tool A', operations: { list: 'listItems' }, parameters: {} }],
          upstream_mcp_from_env: envVarName,
        }),
        'utf-8',
      );

      try {
        await expect(loader.load(tmpPath)).rejects.toThrow(ValidationError);
      } finally {
        if (previous === undefined) { delete process.env[envVarName]; } else { process.env[envVarName] = previous; }
        await fs.unlink(tmpPath).catch(() => undefined);
      }
    });

    it('rejects primitive value in env upstream MCP JSON', async () => {
      const loader = new ProfileLoader();
      const fs = await import('fs/promises');
      const tmpPath = `/tmp/upstream-mcp-primitive-${Date.now()}-${Math.random()}.json`;
      const envVarName = `MCP4_TEST_UPSTREAM_${Date.now()}`;
      const previous = process.env[envVarName];
      process.env[envVarName] = '42';

      await fs.writeFile(
        tmpPath,
        JSON.stringify({
          profile_name: 'upstream-primitive',
          tools: [{ name: 'tool_a', description: 'Tool A', operations: { list: 'listItems' }, parameters: {} }],
          upstream_mcp_from_env: envVarName,
        }),
        'utf-8',
      );

      try {
        await expect(loader.load(tmpPath)).rejects.toThrow(ValidationError);
      } finally {
        if (previous === undefined) { delete process.env[envVarName]; } else { process.env[envVarName] = previous; }
        await fs.unlink(tmpPath).catch(() => undefined);
      }
    });

    it('rejects array JSON in env upstream MCP (must be single object after D-01 migration)', async () => {
      const loader = new ProfileLoader();
      const fs = await import('fs/promises');
      const tmpPath = `/tmp/upstream-mcp-dup-names-${Date.now()}-${Math.random()}.json`;
      const envVarName = `MCP4_TEST_UPSTREAM_${Date.now()}`;
      const previous = process.env[envVarName];
      process.env[envVarName] = JSON.stringify([
        { name: 'same-name', transport: { type: 'http-streamable', url: 'https://a.example/mcp' } },
        { name: 'same-name', transport: { type: 'http-streamable', url: 'https://b.example/mcp' } },
      ]);

      await fs.writeFile(
        tmpPath,
        JSON.stringify({
          profile_name: 'upstream-dup-names',
          tools: [{ name: 'tool_a', description: 'Tool A', operations: { list: 'listItems' }, parameters: {} }],
          upstream_mcp_from_env: envVarName,
        }),
        'utf-8',
      );

      try {
        await expect(loader.load(tmpPath)).rejects.toThrow(/single JSON object, not an array/);
      } finally {
        if (previous === undefined) { delete process.env[envVarName]; } else { process.env[envVarName] = previous; }
        await fs.unlink(tmpPath).catch(() => undefined);
      }
    });

    it('validates provider without auth and with deny-only tools policy', async () => {
      const loader = new ProfileLoader();
      const fs = await import('fs/promises');
      const tmpPath = `/tmp/upstream-mcp-no-auth-${Date.now()}-${Math.random()}.json`;

      await fs.writeFile(
        tmpPath,
        JSON.stringify({
          profile_name: 'upstream-no-auth',
          tools: [],
          upstream_mcp: {
            name: 'no-auth-mcp',
            transport: { type: 'http-streamable', url: 'https://public.example/mcp' },
            tools: { deny: ['blocked_tool'] },
          },
        }),
        'utf-8',
      );

      try {
        const profile = await loader.load(tmpPath);
        expect(profile.upstream_mcp?.name).toBe('no-auth-mcp');
        expect(profile.upstream_mcp?.auth).toBeUndefined();
        expect(profile.upstream_mcp?.tools?.deny).toEqual(['blocked_tool']);
      } finally {
        await fs.unlink(tmpPath).catch(() => undefined);
      }
    });
  });

  describe('OpenAPI-backed validation', () => {
    it('rejects missing tool operations when parser is provided', async () => {
      const loader = new ProfileLoader();
      const fs = await import('fs/promises');
      const specPath = `/tmp/profile-loader-openapi-${Date.now()}-${Math.random()}.yaml`;
      const profilePath = `/tmp/profile-loader-profile-${Date.now()}-${Math.random()}.json`;

      await fs.writeFile(specPath, `openapi: 3.0.0
info:
  title: Loader Test
  version: 1.0.0
paths:
  /items:
    get:
      operationId: listItems
      responses:
        '200':
          description: ok
`, 'utf8');
      await fs.writeFile(profilePath, JSON.stringify({
        profile_name: 'loader-test',
        tools: [
          {
            name: 'missing_operation',
            description: 'Missing op',
            parameters: {},
            operations: { list: 'missingOperation' },
          },
        ],
      }), 'utf8');

      const parserModule = await import('../openapi/openapi-parser.js');
      const parser = new parserModule.OpenAPIParser();
      await parser.load(specPath);

      await expect(loader.load(profilePath, parser)).rejects.toThrow("Operation 'missingOperation' in tool 'missing_operation' not found in OpenAPI spec");
    });
  });

  describe('upstream_mcp and tools mutual exclusivity (D-02)', () => {
    it('rejects profile with both upstream_mcp and non-empty tools[]', async () => {
      const loader = new ProfileLoader();
      const fs = await import('fs/promises');
      const tmpPath = `/tmp/profile-mutex-both-${Date.now()}-${Math.random()}.json`;
      await fs.writeFile(
        tmpPath,
        JSON.stringify({
          profile_name: 'mutex-test',
          upstream_mcp: {
            name: 'test-upstream',
            transport: { type: 'http-streamable', url: 'https://example.com/mcp' },
          },
          tools: [
            {
              name: 'test_tool',
              description: 'A tool',
              parameters: {},
              operations: { execute: 'op' },
            },
          ],
        }),
        'utf-8'
      );

      await expect(loader.load(tmpPath)).rejects.toThrow('mutually exclusive');
    });

    it('loads profile with upstream_mcp and empty tools[] (no conflict)', async () => {
      const loader = new ProfileLoader();
      const fs = await import('fs/promises');
      const tmpPath = `/tmp/profile-mutex-upstream-only-${Date.now()}-${Math.random()}.json`;
      await fs.writeFile(
        tmpPath,
        JSON.stringify({
          profile_name: 'upstream-only',
          upstream_mcp: {
            name: 'test-upstream',
            transport: { type: 'http-streamable', url: 'https://example.com/mcp' },
          },
          tools: [],
        }),
        'utf-8'
      );

      await expect(loader.load(tmpPath)).resolves.toBeDefined();
    });

    it('loads profile with tools[] and no upstream_mcp', async () => {
      const loader = new ProfileLoader();
      const fs = await import('fs/promises');
      const tmpPath = `/tmp/profile-mutex-tools-only-${Date.now()}-${Math.random()}.json`;
      await fs.writeFile(
        tmpPath,
        JSON.stringify({
          profile_name: 'tools-only',
          tools: [
            {
              name: 'test_tool',
              description: 'A tool',
              parameters: {},
              operations: { execute: 'op' },
            },
          ],
        }),
        'utf-8'
      );

      await expect(loader.load(tmpPath)).resolves.toBeDefined();
    });
  });

  describe('upstream_mcp single-provider constraint (D-03 — schema-level)', () => {
    const makeUpstreamProvider = (name: string) => ({
      name,
      transport: { type: 'http-streamable', url: 'https://upstream.example.com/mcp' },
      auth: { type: 'bearer', value_from_env: 'TOKEN' },
    });

    it('rejects array-typed upstream_mcp at schema parse time', async () => {
      const loader = new ProfileLoader();
      const fs = await import('fs/promises');
      const tmpPath = `/tmp/profile-upstream-array-${Date.now()}-${Math.random()}.json`;
      await fs.writeFile(
        tmpPath,
        JSON.stringify({
          profile_name: 'array-upstream',
          tools: [],
          upstream_mcp: [makeUpstreamProvider('provider-a')],
        }),
        'utf-8',
      );
      // Loader wraps Zod's array-rejection into a friendly ValidationError.
      const err = await loader.load(tmpPath).catch(e => e);
      expect(err).toBeInstanceOf(ValidationError);
      expect(err.message).toMatch(/must be a single object, not an array/);
      expect(err.message).toMatch(/Change \[/);
    });

    it('rejects multi-entry array upstream_mcp at schema parse time', async () => {
      const loader = new ProfileLoader();
      const fs = await import('fs/promises');
      const tmpPath = `/tmp/profile-upstream-multi-${Date.now()}-${Math.random()}.json`;
      await fs.writeFile(
        tmpPath,
        JSON.stringify({
          profile_name: 'multi-upstream',
          tools: [],
          upstream_mcp: [makeUpstreamProvider('provider-a'), makeUpstreamProvider('provider-b')],
        }),
        'utf-8',
      );
      // Loader wraps Zod's array-rejection into a friendly ValidationError.
      const err = await loader.load(tmpPath).catch(e => e);
      expect(err).toBeInstanceOf(ValidationError);
      expect(err.message).toMatch(/must be a single object, not an array/);
      expect(err.message).toMatch(/Change \[/);
    });

    it('loads profile with single-object upstream_mcp', async () => {
      const loader = new ProfileLoader();
      const fs = await import('fs/promises');
      const tmpPath = `/tmp/profile-upstream-single-${Date.now()}-${Math.random()}.json`;
      await fs.writeFile(
        tmpPath,
        JSON.stringify({
          profile_name: 'single-upstream',
          tools: [],
          upstream_mcp: makeUpstreamProvider('provider-a'),
        }),
        'utf-8',
      );

      const profile = await loader.load(tmpPath);
      expect(profile.upstream_mcp).toBeDefined();
      expect(profile.upstream_mcp?.name).toBe('provider-a');
    });
  });
});
