import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import {
  resolveProfileById,
  resolveProfileFromPath,
  listProfilesDetailed,
  resolveProfileDetailsFromPath,
  listProfiles,
} from './profile-resolver.js';

async function writeJson(filePath: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

async function createTempDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'mcp4-profiles-'));
}

describe('profile-resolver', () => {
  it('resolves profile by id or alias', async () => {
    const root = await createTempDir();
    const profilesDir = path.join(root, 'profiles');
    const profilePath = path.join(profilesDir, 'gitlab', 'profile.json');
    const specPath = path.join(profilesDir, 'gitlab', 'openapi.yaml');
    const ignoredPath = path.join(profilesDir, 'ignored-link');

    await writeJson(profilePath, {
      profile_name: 'gitlab-dev',
      profile_id: 'gitlab',
      profile_aliases: ['gitlab-default'],
      openapi_spec_path: './openapi.yaml',
      tools: [],
    });
    await fs.writeFile(specPath, 'openapi: 3.1.0', 'utf-8');
    await fs.writeFile(path.join(profilesDir, '.hidden.json'), '{}', 'utf-8');
    await fs.writeFile(path.join(profilesDir, 'notes.txt'), 'ignored', 'utf-8');
    await writeJson(path.join(profilesDir, 'profile.test.json'), { profile_name: 'skip', tools: [] });
    await writeJson(path.join(profilesDir, 'string.json'), 'not an object');
    await fs.symlink(specPath, ignoredPath);

    const resolved = await resolveProfileById('gitlab', profilesDir);
    expect(resolved.profilePath).toBe(profilePath);
    expect(resolved.specPath).toBe(specPath);

    const resolvedAlias = await resolveProfileById('gitlab-default', profilesDir);
    expect(resolvedAlias.profilePath).toBe(profilePath);
  });

  it('ignores non-profile JSON files', async () => {
    const root = await createTempDir();
    const profilesDir = path.join(root, 'profiles');
    const apiPath = path.join(profilesDir, 'youtrack', 'openapi.json');

    await writeJson(apiPath, { openapi: '3.1.0', info: { title: 'API' } });

    await expect(resolveProfileById('youtrack', profilesDir)).rejects.toThrow('Profile not found');
  });

  it('throws when profile is missing openapi_spec_path', async () => {
    const root = await createTempDir();
    const profilesDir = path.join(root, 'profiles');
    const profilePath = path.join(profilesDir, 'profile.json');

    await writeJson(profilePath, {
      profile_name: 'missing-spec',
      profile_id: 'missing',
      tools: [],
    });

    await expect(resolveProfileById('missing', profilesDir)).rejects.toThrow('openapi_spec_path');
  });

  it('collects env vars from upstream_mcp bearer auth', async () => {
    const root = await createTempDir();
    const profilesDir = path.join(root, 'profiles');

    await writeJson(path.join(profilesDir, 'proxy-auth.json'), {
      profile_name: 'proxy-auth-profile',
      profile_id: 'proxy-auth',
      tools: [],
      upstream_mcp: {
        name: 'youtrack',
        transport: { type: 'http-streamable', url: 'https://youtrack.example.com/mcp' },
        auth: { type: 'bearer', value_from_env: 'YOUTRACK_TOKEN' },
      },
    });

    const profiles = await listProfilesDetailed(profilesDir);
    expect(profiles).toHaveLength(1);
    expect(profiles[0].envVars).toEqual(['YOUTRACK_TOKEN']);
    expect(profiles[0].authMethods).toEqual([]);
  });

  it('collects env vars from upstream_mcp custom-header auth', async () => {
    const root = await createTempDir();
    const profilesDir = path.join(root, 'profiles');

    await writeJson(path.join(profilesDir, 'upstream-custom-header.json'), {
      profile_name: 'upstream-custom-header',
      profile_id: 'upstream-custom-header',
      tools: [],
      upstream_mcp: {
        name: 'svc-b',
        transport: { type: 'http-streamable', url: 'https://svc-b.example.com/mcp' },
        auth: { type: 'custom-header', header_name: 'X-Api-Key', value_from_env: 'SVC_B_KEY' },
      },
    });

    const profiles = await listProfilesDetailed(profilesDir);
    expect(profiles).toHaveLength(1);
    expect(profiles[0].envVars).toEqual(['SVC_B_KEY']);
    expect(profiles[0].authMethods).toEqual([]);
  });

  it('collects env vars from upstream_mcp session-cookie auth', async () => {
    const root = await createTempDir();
    const profilesDir = path.join(root, 'profiles');

    await writeJson(path.join(profilesDir, 'upstream-cookie.json'), {
      profile_name: 'upstream-cookie',
      profile_id: 'upstream-cookie',
      tools: [],
      upstream_mcp: {
        name: 'legacy',
        transport: { type: 'http-streamable', url: 'https://legacy.example.com/mcp' },
        auth: {
          type: 'session-cookie',
          session_cookie_config: {
            login_endpoint: '/login',
            login_method: 'POST',
            login_content_type: 'application/json',
            username_field: 'user',
            username_from_env: 'LEGACY_USER',
            password_field: 'pass',
            password_from_env: 'LEGACY_PASS',
            cookie_names: ['sid'],
          },
        },
      },
    });

    const profiles = await listProfilesDetailed(profilesDir);
    expect(profiles).toHaveLength(1);
    expect(profiles[0].envVars).toEqual(['LEGACY_PASS', 'LEGACY_USER']);
    expect(profiles[0].authMethods).toEqual([]);
  });

  it('merges env vars from both interceptors.auth and upstream_mcp auth without duplication', async () => {
    const root = await createTempDir();
    const profilesDir = path.join(root, 'profiles');

    await writeJson(path.join(profilesDir, 'combined.json'), {
      profile_name: 'combined',
      profile_id: 'combined',
      tools: [],
      interceptors: {
        auth: { type: 'bearer', value_from_env: 'CLIENT_TOKEN' },
      },
      upstream_mcp: {
        name: 'upstream',
        transport: { type: 'http-streamable', url: 'https://upstream.example.com/mcp' },
        auth: { type: 'bearer', value_from_env: 'UPSTREAM_TOKEN' },
      },
    });

    const profiles = await listProfilesDetailed(profilesDir);
    expect(profiles).toHaveLength(1);
    expect(profiles[0].envVars).toEqual(['CLIENT_TOKEN', 'UPSTREAM_TOKEN']);
    expect(profiles[0].authMethods).toEqual([
      { type: 'bearer', headerName: undefined, queryParam: undefined, valueFromEnv: 'CLIENT_TOKEN' },
    ]);
  });

  it('returns specPath=undefined for upstream_mcp proxy profile with no openapi_spec_path', async () => {
    const root = await createTempDir();
    const profilesDir = path.join(root, 'profiles');
    const profilePath = path.join(profilesDir, 'proxy.json');

    await writeJson(profilePath, {
      profile_name: 'proxy-profile',
      profile_id: 'proxy',
      tools: [],
      upstream_mcp: { server_url: 'https://example.com/mcp' },
    });

    const resolved = await resolveProfileById('proxy', profilesDir);
    expect(resolved.specPath).toBeUndefined();
  });

  it('extracts env vars and auth methods for profile index', async () => {
    const root = await createTempDir();
    const profilesDir = path.join(root, 'profiles');
    const profilePath = path.join(profilesDir, 'sample.json');

    await writeJson(profilePath, {
      profile_name: 'sample',
      profile_id: 'sample',
      openapi_spec_path: './openapi.yaml',
      description: 'Sample',
      interceptors: {
        base_url: {
          value_from_env: 'SAMPLE_API_BASE_URL',
          default: 'https://api.example.com',
        },
        auth: [
          {
            type: 'bearer',
            value_from_env: 'API_TOKEN',
          },
          {
            type: 'oauth',
            oauth_config: {
              issuer: '${env:OAUTH_ISSUER}',
            },
          },
          {
            type: 'custom-header',
            header_name: 'X-API-KEY',
            value_from_env: 'CUSTOM_KEY',
          },
          {
            type: 'query',
            query_param: 'api_key',
            value_from_env: 'QUERY_TOKEN',
          },
          {
            type: 'session-cookie',
            session_cookie_config: {
              login_endpoint: '/login',
              login_method: 'POST',
              login_content_type: 'application/json',
              username_field: 'username',
              username_from_env: 'LOGIN_USER',
              password_field: 'password',
              password_from_env: 'LOGIN_PASSWORD',
              cookie_names: ['session'],
            },
          },
        ],
      },
      tools: [],
    });

    const profiles = await listProfilesDetailed(profilesDir);
    expect(profiles).toHaveLength(1);
    expect(profiles[0].envVars).toEqual([
      'API_TOKEN',
      'CUSTOM_KEY',
      'LOGIN_PASSWORD',
      'LOGIN_USER',
      'OAUTH_ISSUER',
      'QUERY_TOKEN',
      'SAMPLE_API_BASE_URL',
    ]);
    expect(profiles[0].oauthEnvVars).toEqual(['OAUTH_ISSUER']);
    expect(profiles[0].authMethods).toEqual([
      { type: 'bearer', headerName: undefined, queryParam: undefined, valueFromEnv: 'API_TOKEN' },
      { type: 'oauth', headerName: undefined, queryParam: undefined, valueFromEnv: undefined },
      { type: 'custom-header', headerName: 'X-API-KEY', queryParam: undefined, valueFromEnv: 'CUSTOM_KEY' },
      { type: 'query', headerName: undefined, queryParam: 'api_key', valueFromEnv: 'QUERY_TOKEN' },
      {
        type: 'session-cookie',
        headerName: undefined,
        queryParam: undefined,
        valueFromEnv: undefined,
        usernameFromEnv: 'LOGIN_USER',
        passwordFromEnv: 'LOGIN_PASSWORD',
      },
    ]);
    expect(profiles[0].apiBaseUrl).toEqual({
      valueFromEnv: 'SAMPLE_API_BASE_URL',
      defaultValue: 'https://api.example.com',
    });

    const resolved = await resolveProfileDetailsFromPath(profilePath);
    expect(resolved?.profileId).toBe('sample');
  });

  it('extracts compact tool catalog summaries for profile index', async () => {
    const root = await createTempDir();
    const profilesDir = path.join(root, 'profiles');
    const profilePath = path.join(profilesDir, 'catalog.json');

    await writeJson(profilePath, {
      profile_name: 'catalog',
      profile_id: 'catalog',
      openapi_spec_path: './openapi.yaml',
      tools: [
        {
          name: 'manage_projects',
          description: 'Manage projects.',
          metadata_params: ['action'],
          operations: {
            update: 'updateProject',
            list: 'listProjects',
          },
          parameters: {
            project_id: {
              type: 'string',
              description: 'Project ID',
              required_for: ['update'],
            },
            action: {
              type: 'string',
              description: 'Action',
              required: true,
              enum: ['list', 'update'],
            },
            page: {
              type: ['integer', 'string'],
              description: 'Page number',
              default: 1,
            },
          },
        },
        {
          name: 'get_deployment',
          description: 'Get deployment.',
          composite: true,
          steps: [
            {
              call: 'GET /deployments',
              store_as: 'deployment',
            },
          ],
          parameters: {},
        },
      ],
    });

    const profiles = await listProfilesDetailed(profilesDir);
    expect(profiles).toHaveLength(1);
    expect(profiles[0].toolCatalog).toEqual([
      {
        name: 'manage_projects',
        description: 'Manage projects.',
        kind: 'simple',
        actions: ['list', 'update'],
        hasActionSelector: true,
        operationCount: 2,
        stepCount: 0,
        parameters: [
          {
            name: 'action',
            typeLabel: 'string',
            description: 'Action',
            required: true,
            requiredFor: [],
            isMetadata: true,
            supportsFilterHeader: true,
            enumValues: ['list', 'update'],
            defaultValue: undefined,
          },
          {
            name: 'page',
            typeLabel: 'integer | string',
            description: 'Page number',
            required: false,
            requiredFor: [],
            isMetadata: false,
            supportsFilterHeader: true,
            enumValues: undefined,
            defaultValue: '1',
          },
          {
            name: 'project_id',
            typeLabel: 'string',
            description: 'Project ID',
            required: false,
            requiredFor: ['update'],
            isMetadata: false,
            supportsFilterHeader: true,
            enumValues: undefined,
            defaultValue: undefined,
          },
        ],
      },
      {
        name: 'get_deployment',
        description: 'Get deployment.',
        kind: 'composite',
        actions: [],
        hasActionSelector: false,
        operationCount: 0,
        stepCount: 1,
        parameters: [],
      },
    ]);
  });

  it('ignores invalid tool entries and invalid parameter summaries in the profile index catalog', async () => {
    const root = await createTempDir();
    const profilesDir = path.join(root, 'profiles');
    const profilePath = path.join(profilesDir, 'edge-cases.json');

    await writeJson(profilePath, {
      profile_name: 'edge-cases',
      profile_id: 'edge-cases',
      openapi_spec_path: './openapi.yaml',
      tools: [
        null,
        'not-a-tool',
        {
          name: '',
          description: 'Blank name should be dropped.',
          parameters: {},
        },
        {
          name: 'edge_cases',
          description: 'Exercises summary guards.',
          parameters: {
            invalid_param: null,
            missing_description: {
              type: 'string',
            },
            mixed_enum: {
              type: 'string',
              description: 'Mixed enum values',
              enum: ['merge', 7, true, { nested: 'ignored' }],
            },
            string_default: {
              type: ['string', null],
              description: 'String default value',
              default: 'hello',
            },
            'managed_scan_config.diff_scan.enabled': {
              type: 'boolean',
              description: 'Unsafe for X-Mcp4-Params key serialization',
            },
          },
        },
      ],
    });

    const profiles = await listProfilesDetailed(profilesDir);
    expect(profiles).toHaveLength(1);
    expect(profiles[0].toolCatalog).toEqual([
      {
        name: 'edge_cases',
        description: 'Exercises summary guards.',
        kind: 'simple',
        actions: [],
        hasActionSelector: false,
        operationCount: 0,
        stepCount: 0,
        parameters: [
          {
            name: 'managed_scan_config.diff_scan.enabled',
            typeLabel: 'boolean',
            description: 'Unsafe for X-Mcp4-Params key serialization',
            required: false,
            requiredFor: [],
            isMetadata: false,
            supportsFilterHeader: false,
            enumValues: undefined,
            defaultValue: undefined,
          },
          {
            name: 'mixed_enum',
            typeLabel: 'string',
            description: 'Mixed enum values',
            required: false,
            requiredFor: [],
            isMetadata: false,
            supportsFilterHeader: true,
            enumValues: ['merge', '7', 'true'],
            defaultValue: undefined,
          },
          {
            name: 'string_default',
            typeLabel: 'string | unknown',
            description: 'String default value',
            required: false,
            requiredFor: [],
            isMetadata: false,
            supportsFilterHeader: true,
            enumValues: undefined,
            defaultValue: 'hello',
          },
        ],
      },
    ]);
  });

  it('extracts env vars from single auth interceptor and ignores unknown auth types', async () => {
    const root = await createTempDir();
    const profilesDir = path.join(root, 'profiles');
    const profilePath = path.join(profilesDir, 'single.json');

    await writeJson(profilePath, {
      profile_name: 'single-auth',
      openapi_spec_path: './openapi.yaml',
      interceptors: {
        auth: {
          type: 'bearer',
          value_from_env: 'SINGLE_TOKEN',
        },
      },
      tools: [],
    });

    await writeJson(path.join(profilesDir, 'invalid.json'), {
      profile_name: 'invalid-auth',
      openapi_spec_path: './openapi.yaml',
      interceptors: {
        auth: {
          type: 'unknown',
        },
      },
      tools: [],
    });

    const profiles = await listProfilesDetailed(profilesDir);
    const single = profiles.find(profile => profile.profileName === 'single-auth');
    const invalid = profiles.find(profile => profile.profileName === 'invalid-auth');

    expect(single?.envVars).toEqual(['SINGLE_TOKEN']);
    expect(single?.authMethods).toEqual([
      { type: 'bearer', headerName: undefined, queryParam: undefined, valueFromEnv: 'SINGLE_TOKEN' },
    ]);
    expect(invalid?.authMethods).toEqual([]);
  });

  it('throws when listing profiles in missing directory', async () => {
    await expect(listProfilesDetailed(path.join(os.tmpdir(), 'missing-profiles'))).rejects.toThrow('Profiles directory not found');
  });

  it('accepts openapi_spec_path override when profile is missing it', async () => {
    const root = await createTempDir();
    const profilesDir = path.join(root, 'profiles');
    const profilePath = path.join(profilesDir, 'profile.json');
    const specPath = path.join(root, 'override.yaml');

    await writeJson(profilePath, {
      profile_name: 'missing-spec',
      profile_id: 'missing',
      tools: [],
    });
    await fs.writeFile(specPath, 'openapi: 3.1.0', 'utf-8');

    const resolved = await resolveProfileById('missing', profilesDir, { specPathOverride: specPath });
    expect(resolved.specPath).toBe(specPath);
  });

  it('uses override when resolving profile by path', async () => {
    const root = await createTempDir();
    const profilePath = path.join(root, 'profile.json');
    const specPath = path.join(root, 'override.yaml');

    await writeJson(profilePath, {
      profile_name: 'missing-spec',
      tools: [],
    });
    await fs.writeFile(specPath, 'openapi: 3.1.0', 'utf-8');

    const resolved = await resolveProfileFromPath(profilePath, { specPathOverride: specPath });
    expect(resolved.specPath).toBe(specPath);
  });

  it('throws when alias is ambiguous', async () => {
    const root = await createTempDir();
    const profilesDir = path.join(root, 'profiles');

    await writeJson(path.join(profilesDir, 'a', 'profile.json'), {
      profile_name: 'a',
      profile_id: 'a',
      profile_aliases: ['shared'],
      openapi_spec_path: './openapi.yaml',
      tools: [],
    });

    await writeJson(path.join(profilesDir, 'b', 'profile.json'), {
      profile_name: 'b',
      profile_id: 'b',
      profile_aliases: ['shared'],
      openapi_spec_path: './openapi.yaml',
      tools: [],
    });

    await expect(resolveProfileById('shared', profilesDir)).rejects.toThrow('not unique');
  });

  it('throws when profiles directory is missing', async () => {
    const missingDir = path.join(os.tmpdir(), `missing-profiles-${Date.now()}`);
    await expect(resolveProfileById('anything', missingDir)).rejects.toThrow('Profiles directory not found');
  });

  it('throws when profile JSON is invalid', async () => {
    const root = await createTempDir();
    const profilesDir = path.join(root, 'profiles');
    const profilePath = path.join(profilesDir, 'broken.json');
    await fs.mkdir(profilesDir, { recursive: true });
    await fs.writeFile(profilePath, '{', 'utf-8');

    await expect(resolveProfileById('broken', profilesDir)).rejects.toThrow('Failed to parse profile JSON');
  });

  it('throws when resolving profile details from invalid JSON', async () => {
    const root = await createTempDir();
    const profilePath = path.join(root, 'broken.json');
    await fs.writeFile(profilePath, '{', 'utf-8');

    await expect(resolveProfileDetailsFromPath(profilePath)).rejects.toThrow('Failed to parse profile JSON');
  });

  it('matches profiles by profile_name when profile_id differs', async () => {
    const root = await createTempDir();
    const profilesDir = path.join(root, 'profiles');
    const profilePath = path.join(profilesDir, 'profile.json');
    const specPath = path.join(profilesDir, 'openapi.yaml');

    await writeJson(profilePath, {
      profile_name: 'by-name',
      profile_id: 'by-id',
      openapi_spec_path: './openapi.yaml',
      tools: [],
    });
    await fs.writeFile(specPath, 'openapi: 3.1.0', 'utf-8');

    const resolved = await resolveProfileById('by-name', profilesDir);
    expect(resolved.profileId).toBe('by-id');
    expect(resolved.profileName).toBe('by-name');
  });

  it('throws when profile file is not a valid profile', async () => {
    const root = await createTempDir();
    const profilePath = path.join(root, 'profile.json');
    await writeJson(profilePath, { profile_name: 'invalid' });

    await expect(resolveProfileFromPath(profilePath)).rejects.toThrow('valid profile');
  });

  it('falls back to profile_name when profile_id is missing', async () => {
    const root = await createTempDir();
    const profilesDir = path.join(root, 'profiles');
    const profilePath = path.join(profilesDir, 'default.json');
    const specPath = path.join(profilesDir, 'openapi.yaml');

    await writeJson(profilePath, {
      profile_name: 'fallback-name',
      openapi_spec_path: './openapi.yaml',
      tools: [],
      profile_aliases: ['alias', 123],
    });
    await fs.writeFile(specPath, 'openapi: 3.1.0', 'utf-8');

    const resolved = await resolveProfileById('fallback-name', profilesDir);
    expect(resolved.profileId).toBe('fallback-name');
    expect(resolved.profileName).toBe('fallback-name');
  });

  it('falls back to profile_name for profile index when profile_id is missing', async () => {
    const root = await createTempDir();
    const profilesDir = path.join(root, 'profiles');
    const profilePath = path.join(profilesDir, 'fallback.json');

    await writeJson(profilePath, {
      profile_name: 'fallback-index',
      openapi_spec_path: './openapi.yaml',
      profile_aliases: ['alias', 123],
      tools: [],
    });

    const profiles = await listProfilesDetailed(profilesDir);
    expect(profiles).toHaveLength(1);
    expect(profiles[0].profileId).toBe('fallback-index');
    expect(profiles[0].profileAliases).toEqual(['alias']);
  });

  it('skips files that are not valid profiles when listing details', async () => {
    const root = await createTempDir();
    const profilesDir = path.join(root, 'profiles');
    const validPath = path.join(profilesDir, 'valid.json');
    const invalidPath = path.join(profilesDir, 'invalid.json');

    await writeJson(validPath, {
      profile_name: 'valid',
      profile_id: 'valid',
      openapi_spec_path: './openapi.yaml',
      tools: [],
    });
    await writeJson(invalidPath, { profile_name: 'invalid' });

    const profiles = await listProfilesDetailed(profilesDir);
    expect(profiles.map(profile => profile.profileId)).toEqual(['valid']);
  });

  it('resolves relative profilesDir paths', async () => {
    const root = await createTempDir();
    const profilesDir = path.join(root, 'profiles');
    const profilePath = path.join(profilesDir, 'profile.json');
    const specPath = path.join(profilesDir, 'openapi.yaml');

    await writeJson(profilePath, {
      profile_name: 'relative-dir',
      profile_id: 'relative',
      openapi_spec_path: './openapi.yaml',
      tools: [],
    });
    await fs.writeFile(specPath, 'openapi: 3.1.0', 'utf-8');

    const relativeDir = path.relative(process.cwd(), profilesDir);
    const resolved = await resolveProfileById('relative', relativeDir);
    expect(resolved.profilePath).toBe(profilePath);
  });

  it('uses default profiles directory when profilesDir is empty', async () => {
    const resolved = await resolveProfileById('gitlab');
    expect(resolved.profileId).toBe('gitlab');
  });

  it('falls back to bundled profiles when cwd profiles directory is missing', async () => {
    const tempDir = await createTempDir();
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tempDir);

    try {
      const resolved = await resolveProfileById('gitlab');
      expect(resolved.profileId).toBe('gitlab');
    } finally {
      cwdSpy.mockRestore();
    }
  });

  it('resolves absolute openapi_spec_path values', async () => {
    const root = await createTempDir();
    const profilesDir = path.join(root, 'profiles');
    const profilePath = path.join(profilesDir, 'profile.json');
    const specPath = path.join(profilesDir, 'openapi.yaml');

    await writeJson(profilePath, {
      profile_name: 'absolute-spec',
      profile_id: 'absolute',
      openapi_spec_path: specPath,
      tools: [],
    });
    await fs.writeFile(specPath, 'openapi: 3.1.0', 'utf-8');

    const resolved = await resolveProfileById('absolute', profilesDir);
    expect(resolved.specPath).toBe(specPath);
  });

  it('resolves relative profile paths via resolveProfileFromPath', async () => {
    const root = await createTempDir();
    const profilePath = path.join(root, 'profile.json');
    const specPath = path.join(root, 'openapi.yaml');

    await writeJson(profilePath, {
      profile_name: 'relative-profile',
      profile_id: 'relative-profile',
      openapi_spec_path: './openapi.yaml',
      tools: [],
    });
    await fs.writeFile(specPath, 'openapi: 3.1.0', 'utf-8');

    const relativePath = path.relative(process.cwd(), profilePath);
    const resolved = await resolveProfileFromPath(relativePath);
    expect(resolved.profilePath).toBe(profilePath);
  });

  it('treats non-http URLs as file paths', async () => {
    const root = await createTempDir();
    const profilesDir = path.join(root, 'profiles');
    const profilePath = path.join(profilesDir, 'profile.json');

    await writeJson(profilePath, {
      profile_name: 'non-http-url',
      profile_id: 'non-http',
      openapi_spec_path: 'ftp://example.com/openapi.yaml',
      tools: [],
    });

    const resolved = await resolveProfileById('non-http', profilesDir);
    expect(resolved.specPath).toBe(path.resolve(profilesDir, 'ftp://example.com/openapi.yaml'));
  });

  it('resolves HTTP OpenAPI spec URLs without path normalization', async () => {
    const root = await createTempDir();
    const profilesDir = path.join(root, 'profiles');
    const profilePath = path.join(profilesDir, 'profile.json');

    await writeJson(profilePath, {
      profile_name: 'remote-spec',
      profile_id: 'remote',
      openapi_spec_path: 'https://example.com/openapi.json',
      tools: [],
    });

    const resolved = await resolveProfileById('remote', profilesDir);
    expect(resolved.specPath).toBe('https://example.com/openapi.json');
  });

  it('resolves profile from explicit path', async () => {
    const root = await createTempDir();
    const profilePath = path.join(root, 'profile.json');
    const specPath = path.join(root, 'openapi.yaml');

    await writeJson(profilePath, {
      profile_name: 'direct',
      profile_id: 'direct',
      openapi_spec_path: './openapi.yaml',
      tools: [],
    });
    await fs.writeFile(specPath, 'openapi: 3.1.0', 'utf-8');

    const resolved = await resolveProfileFromPath(profilePath);
    expect(resolved.specPath).toBe(specPath);
  });

  it('lists profiles with aliases for index summaries', async () => {
    const root = await createTempDir();
    const profilesDir = path.join(root, 'profiles');
    const profilePath = path.join(profilesDir, 'profile.json');

    await writeJson(profilePath, {
      profile_name: 'list-profile',
      profile_id: 'list-profile',
      profile_aliases: ['alias-one', 'alias-two'],
      openapi_spec_path: './openapi.yaml',
      tools: [],
    });

    const listed = await listProfiles(profilesDir);
    expect(listed).toEqual([
      {
        profileId: 'list-profile',
        profileName: 'list-profile',
        profileAliases: ['alias-one', 'alias-two'],
      },
    ]);
  });
});
