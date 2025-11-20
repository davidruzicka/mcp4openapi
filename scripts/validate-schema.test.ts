/**
 * Tests for profile schema validation
 * 
 * Why: Ensures profile-schema.json is always valid
 */

import { describe, it, expect, beforeAll } from 'vitest';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import fs from 'fs/promises';
import path from 'path';

describe('profile-schema.json', () => {
  let profileSchema: any;
  let ajv: Ajv;

  beforeAll(async () => {
    // Load the schema
    const schemaPath = path.resolve(process.cwd(), 'profile-schema.json');
    const content = await fs.readFile(schemaPath, 'utf-8');
    profileSchema = JSON.parse(content);

    // Create Ajv instance
    ajv = new Ajv({ strict: true, allErrors: true });
    addFormats(ajv);
  });

  it('should be valid JSON', () => {
    expect(profileSchema).toBeDefined();
    expect(typeof profileSchema).toBe('object');
  });

  it('should have required meta fields', () => {
    expect(profileSchema.$schema).toBe('http://json-schema.org/draft-07/schema#');
    expect(profileSchema.$id).toBeDefined();
    expect(profileSchema.title).toBeDefined();
    expect(profileSchema.description).toBeDefined();
  });

  it('should be valid against JSON Schema meta-schema', () => {
    // Validate against Draft-07 meta-schema
    const validate = ajv.compile(
      ajv.getSchema('http://json-schema.org/draft-07/schema')?.schema || {}
    );
    const valid = validate(profileSchema);
    
    if (!valid && validate.errors) {
      console.error('Schema validation errors:', validate.errors);
    }
    
    expect(valid).toBe(true);
  });

  it('should compile without errors', () => {
    expect(() => ajv.compile(profileSchema)).not.toThrow();
  });

  it('should have all expected definitions', () => {
    const expectedDefs = [
      'Tool',
      'Parameter',
      'CompositeStep',
      'Interceptors',
      'Auth',
      'BaseUrl',
      'RateLimit',
      'Retry',
    ];

    for (const def of expectedDefs) {
      expect(profileSchema.definitions).toHaveProperty(def);
    }
  });

  it('should have root required fields', () => {
    expect(profileSchema.required).toContain('profile_name');
    expect(profileSchema.required).toContain('tools');
  });

  it('should validate example GitLab profile', async () => {
    const examplePath = path.resolve(
      process.cwd(),
      'profiles/gitlab/developer-profile.json'
    );
    const exampleContent = await fs.readFile(examplePath, 'utf-8');
    const exampleProfile = JSON.parse(exampleContent);

    const validate = ajv.compile(profileSchema);
    const valid = validate(exampleProfile);

    if (!valid && validate.errors) {
      console.error('Example profile validation errors:', validate.errors);
    }

    expect(valid).toBe(true);
  });

  it('should reject invalid profiles', () => {
    const invalidProfile = {
      // Missing profile_name
      tools: [],
    };

    const validate = ajv.compile(profileSchema);
    const valid = validate(invalidProfile);

    expect(valid).toBe(false);
    expect(validate.errors).toBeDefined();
  });

  it('should validate auth types enum', () => {
    const authDef = profileSchema.definitions.Auth;
    expect(authDef.properties.type.enum).toEqual([
      'bearer',
      'query',
      'custom-header',
      'oauth',
    ]);
  });

  it('should enforce conditional auth validation', () => {
    // custom-header requires header_name
    const invalidAuth = {
      profile_name: 'test',
      tools: [
        {
          name: 'test_tool',
          description: 'Test tool',
          parameters: {},
        },
      ],
      interceptors: {
        auth: {
          type: 'custom-header',
          value_from_env: 'TOKEN',
          // Missing header_name
        },
      },
    };

    const validate = ajv.compile(profileSchema);
    const valid = validate(invalidAuth);

    expect(valid).toBe(false);
  });

  it('should validate OAuth auth configuration', () => {
    const validOAuth = {
      profile_name: 'test-oauth',
      tools: [
        {
          name: 'test_tool',
          description: 'Test tool for OAuth validation',
          operations: { list: 'listOp' },
          parameters: {},
        },
      ],
      interceptors: {
        auth: {
          type: 'oauth',
          oauth_config: {
            authorization_endpoint: 'https://oauth.example.com/authorize',
            token_endpoint: 'https://oauth.example.com/token',
            scopes: ['api', 'read_user'],
          },
        },
      },
    };

    const validate = ajv.compile(profileSchema);
    const valid = validate(validOAuth);

    if (!valid) {
      console.log('Validation errors:', validate.errors);
    }

    expect(valid).toBe(true);
  });

  it('should reject OAuth without required oauth_config', () => {
    const invalidOAuth = {
      profile_name: 'test-oauth',
      tools: [
        {
          name: 'test_tool',
          description: 'Test tool for OAuth validation',
          operations: { list: 'listOp' },
          parameters: {},
        },
      ],
      interceptors: {
        auth: {
          type: 'oauth',
          // Missing oauth_config
        },
      },
    };

    const validate = ajv.compile(profileSchema);
    const valid = validate(invalidOAuth);

    expect(valid).toBe(false);
    expect(validate.errors).toBeDefined();
  });

  it('should reject OAuth config without required fields', () => {
    const invalidOAuthConfig = {
      profile_name: 'test-oauth',
      tools: [
        {
          name: 'test_tool',
          description: 'Test tool for OAuth validation',
          operations: { list: 'listOp' },
          parameters: {},
        },
      ],
      interceptors: {
        auth: {
          type: 'oauth',
          oauth_config: {
            authorization_endpoint: 'https://oauth.example.com/authorize',
            // Missing token_endpoint and scopes
          },
        },
      },
    };

    const validate = ajv.compile(profileSchema);
    const valid = validate(invalidOAuthConfig);

    expect(valid).toBe(false);
    expect(validate.errors).toBeDefined();
  });

  it('should allow optional OAuth config fields', () => {
    const validOAuthWithOptional = {
      profile_name: 'test-oauth',
      tools: [
        {
          name: 'test_tool',
          description: 'Test tool for OAuth validation',
          operations: { list: 'listOp' },
          parameters: {},
        },
      ],
      interceptors: {
        auth: {
          type: 'oauth',
          oauth_config: {
            authorization_endpoint: 'https://oauth.example.com/authorize',
            token_endpoint: 'https://oauth.example.com/token',
            client_id: '${env:CLIENT_ID}',
            client_secret: '${env:CLIENT_SECRET}',
            scopes: ['api'],
            redirect_uri: 'http://localhost:3003/oauth/callback',
            introspection_endpoint: 'https://oauth.example.com/introspect',
            revocation_endpoint: 'https://oauth.example.com/revoke',
          },
        },
      },
    };

    const validate = ajv.compile(profileSchema);
    const valid = validate(validOAuthWithOptional);

    if (!valid) {
      console.log('Validation errors:', validate.errors);
    }

    expect(valid).toBe(true);
  });

  it('should validate GitLab OAuth example profile', () => {
    const gitlabOAuthProfile = {
      $schema: '../../profile-schema.json',
      profile_name: 'gitlab-oauth',
      description: 'GitLab API with OAuth 2.0 authentication',
      tools: [
        {
          name: 'manage_projects',
          description: 'Work with GitLab projects',
          operations: {
            list: 'getApiV4Projects',
            get: 'getApiV4ProjectsId',
          },
          metadata_params: ['action'],
          parameters: {
            action: {
              type: 'string',
              enum: ['list', 'get'],
              description: 'Action to perform',
              required: true,
            },
          },
        },
      ],
      interceptors: {
        auth: {
          type: 'oauth',
          oauth_config: {
            authorization_endpoint: '${env:MCP4_OAUTH_AUTHORIZATION_URL}',
            token_endpoint: '${env:MCP4_OAUTH_TOKEN_URL}',
            client_id: '${env:MCP4_OAUTH_CLIENT_ID}',
            client_secret: '${env:MCP4_OAUTH_CLIENT_SECRET}',
            scopes: ['api', 'read_user'],
            redirect_uri: 'http://localhost:3003/oauth/callback',
          },
        },
      },
    };

    const validate = ajv.compile(profileSchema);
    const valid = validate(gitlabOAuthProfile);

    if (!valid) {
      console.log('Validation errors:', validate.errors);
    }

    expect(valid).toBe(true);
  });
});

