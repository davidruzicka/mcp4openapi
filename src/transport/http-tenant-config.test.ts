import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFile, unlink } from 'node:fs/promises';
import type { HttpProfileContext } from '../types/http-transport.js';
import { ConsoleLogger } from '../core/logger.js';
import {
  buildTenantIndexForProfile,
  loadRawTenantsConfigFromEnv,
  resolveTenantFromHeaders,
} from './http-tenant-config.js';

describe('http-tenant-config', () => {
  const logger = new ConsoleLogger();
  const originalEnv = { ...process.env };

  const profileContext: HttpProfileContext = {
    profileId: 'default',
    baseUrl: 'https://api.default.example.com',
    authConfigs: [{ type: 'bearer', value_from_env: 'TOKEN' }],
  };

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.MCP4_HTTP_TENANTS_FILE;
    delete process.env.MCP4_HTTP_TENANTS_JSON;
    delete process.env.MCP4_HTTP_TENANTS_ALLOW_HTTP;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns disabled index when tenant config is missing', () => {
    const index = buildTenantIndexForProfile(null, profileContext, logger);
    expect(index.enabled).toBe(false);
    expect(resolveTenantFromHeaders(index, 'team-a', undefined)).toBeNull();
  });

  it('returns null when tenant env configuration is not provided', () => {
    expect(loadRawTenantsConfigFromEnv()).toBeNull();
  });

  it('applies tenants only to matching profile_ids and disables tenant index for unmatched profile', () => {
    const raw = {
      version: 1,
      tenants: [
        {
          tenant_id: 'team-a',
          profile_ids: ['profile-a'],
          api_base_url: 'https://team-a.example.com/api',
          auth_mode: 'token',
          auth: { type: 'bearer', value_from_env: 'TEAM_A_TOKEN' },
        },
        {
          tenant_id: 'team-b',
          profile_ids: ['profile-b'],
          api_base_url: 'https://team-b.example.com/api',
          auth_mode: 'token',
          auth: { type: 'bearer', value_from_env: 'TEAM_B_TOKEN' },
        },
      ],
    };

    const profileAIndex = buildTenantIndexForProfile(raw as any, { ...profileContext, profileId: 'profile-a' }, logger);
    expect(profileAIndex.enabled).toBe(true);
    expect(Array.from(profileAIndex.byTenantId.keys())).toEqual(['team-a']);
    expect(resolveTenantFromHeaders(profileAIndex, undefined, undefined)).toBeNull();

    const profileBIndex = buildTenantIndexForProfile(raw as any, { ...profileContext, profileId: 'profile-b' }, logger);
    expect(profileBIndex.enabled).toBe(true);
    expect(Array.from(profileBIndex.byTenantId.keys())).toEqual(['team-b']);
    expect(resolveTenantFromHeaders(profileBIndex, undefined, undefined)).toBeNull();

    const unmatchedIndex = buildTenantIndexForProfile(raw as any, { ...profileContext, profileId: 'profile-c' }, logger);
    expect(unmatchedIndex.enabled).toBe(false);
    expect(unmatchedIndex.byTenantId.size).toBe(0);
    expect(resolveTenantFromHeaders(unmatchedIndex, undefined, undefined)).toBeNull();
  });

  it('loads valid tenant config from env json and resolves by tenant id', () => {
    process.env.MCP4_HTTP_TENANTS_JSON = JSON.stringify({
      version: 1,
      tenants: [
        {
          tenant_id: 'team-a',
          profile_ids: ['default'],
          api_base_url: 'https://team-a.example.com/api',
          auth_mode: 'token',
          auth: { type: 'bearer', value_from_env: 'TEAM_A_TOKEN' },
        },
      ],
    });

    const raw = loadRawTenantsConfigFromEnv();
    const index = buildTenantIndexForProfile(raw, profileContext, logger);
    const resolved = resolveTenantFromHeaders(index, 'team-a', undefined);
    expect(resolved?.tenantId).toBe('team-a');
  });

  it('loads config from file when both file and inline json are provided', async () => {
    const tempFile = `.tmp-tenants-${Date.now()}.json`;
    process.env.MCP4_HTTP_TENANTS_FILE = tempFile;
    process.env.MCP4_HTTP_TENANTS_JSON = JSON.stringify({ version: 1, tenants: [] });
    await writeFile(
      tempFile,
      JSON.stringify({
        version: 1,
        tenants: [
          {
            tenant_id: 'team-file',
            profile_ids: ['default'],
            api_base_url: 'https://file.example.com/api',
            auth_mode: 'token',
            auth: { type: 'bearer', value_from_env: 'FILE_TOKEN' },
          },
        ],
      }),
      'utf8',
    );

    try {
      const raw = loadRawTenantsConfigFromEnv();
      expect(raw?.tenants[0].tenant_id).toBe('team-file');
    } finally {
      await unlink(tempFile);
    }
  });

  it('fails on invalid tenant json payload', () => {
    process.env.MCP4_HTTP_TENANTS_JSON = '{invalid-json';
    expect(() => loadRawTenantsConfigFromEnv()).toThrow(/Invalid tenant JSON config/);
  });

  it('fails when tenant config payload is not an object', () => {
    process.env.MCP4_HTTP_TENANTS_JSON = JSON.stringify(null);
    expect(() => loadRawTenantsConfigFromEnv()).toThrow(/Tenant config must be an object/i);
  });

  it('fails when tenant profile_ids is invalid', () => {
    const missing = {
      version: 1,
      tenants: [
        {
          tenant_id: 'team-a',
          api_base_url: 'https://team-a.example.com/api',
          auth_mode: 'token',
          auth: { type: 'bearer', value_from_env: 'TEAM_A_TOKEN' },
        },
      ],
    };
    expect(() => buildTenantIndexForProfile(missing as any, profileContext, logger)).toThrow(/profile_ids is required/i);

    const nonArray = {
      version: 1,
      tenants: [
        {
          tenant_id: 'team-a',
          profile_ids: 'profile-a',
          api_base_url: 'https://team-a.example.com/api',
          auth_mode: 'token',
          auth: { type: 'bearer', value_from_env: 'TEAM_A_TOKEN' },
        },
      ],
    };
    expect(() => buildTenantIndexForProfile(nonArray as any, profileContext, logger)).toThrow(/profile_ids must be an array/i);

    const emptyArray = {
      version: 1,
      tenants: [
        {
          tenant_id: 'team-a',
          profile_ids: [],
          api_base_url: 'https://team-a.example.com/api',
          auth_mode: 'token',
          auth: { type: 'bearer', value_from_env: 'TEAM_A_TOKEN' },
        },
      ],
    };
    expect(() => buildTenantIndexForProfile(emptyArray as any, profileContext, logger)).toThrow(/profile_ids must not be empty/i);
  });

  it('fails when tenant config version is not supported', () => {
    process.env.MCP4_HTTP_TENANTS_JSON = JSON.stringify({
      version: 2,
      tenants: [
        {
          tenant_id: 'team-a',
          profile_ids: ['default'],
          api_base_url: 'https://team-a.example.com/api',
          auth_mode: 'token',
          auth: { type: 'bearer', value_from_env: 'TEAM_A_TOKEN' },
        },
      ],
    });
    expect(() => loadRawTenantsConfigFromEnv()).toThrow(/Unsupported tenant config version/i);
  });

  it('fails when tenants array is empty', () => {
    process.env.MCP4_HTTP_TENANTS_JSON = JSON.stringify({
      version: 1,
      tenants: [],
    });
    expect(() => loadRawTenantsConfigFromEnv()).toThrow(/non-empty tenants array/i);
  });

  it('fails for duplicate tenant_id', () => {
    const raw = {
      version: 1,
      tenants: [
        { tenant_id: 'team-a', profile_ids: ['default'], api_base_url: 'https://a.example.com/api', auth_mode: 'token', auth: { type: 'bearer', value_from_env: 'A' } },
        { tenant_id: 'team-a', profile_ids: ['default'], api_base_url: 'https://b.example.com/api', auth_mode: 'token', auth: { type: 'bearer', value_from_env: 'B' } },
      ],
    };
    expect(() => buildTenantIndexForProfile(raw as any, profileContext, logger)).toThrow(/Duplicate tenant_id/);
  });

  it('fails when same base URL has different auth config', () => {
    const raw = {
      version: 1,
      tenants: [
        { tenant_id: 'team-a', profile_ids: ['default'], api_base_url: 'https://same.example.com/api', auth_mode: 'token', auth: { type: 'bearer', value_from_env: 'A' } },
        { tenant_id: 'team-b', profile_ids: ['default'], api_base_url: 'https://same.example.com/api/', auth_mode: 'token', auth: { type: 'query', value_from_env: 'B' } },
      ],
    };
    expect(() => buildTenantIndexForProfile(raw as any, profileContext, logger)).toThrow(/collision/i);
  });

  it('fails when oauth auth_mode does not provide oauth config', () => {
    const raw = {
      version: 1,
      tenants: [
        { tenant_id: 'team-a', profile_ids: ['default'], api_base_url: 'https://team-a.example.com/api', auth_mode: 'oauth', auth: { type: 'bearer', value_from_env: 'A' } },
      ],
    };
    expect(() => buildTenantIndexForProfile(raw as any, profileContext, logger)).toThrow(/requires oauth auth_mode/i);
  });

  it('filters inherited oauth auth when tenant auth_mode is token', () => {
    const mixedProfileContext: HttpProfileContext = {
      profileId: 'default',
      baseUrl: 'https://api.default.example.com',
      oauthConfig: {
        authorization_endpoint: 'https://auth.example.com/oauth/authorize',
        token_endpoint: 'https://auth.example.com/oauth/token',
        client_id: 'oauth-client',
        client_secret: 'oauth-secret',
      },
      authConfigs: [
        { type: 'oauth' },
        { type: 'custom-header', header_name: 'X-Tenant-Token', value_from_env: 'TENANT_TOKEN' },
      ],
    };

    const raw = {
      version: 1,
      tenants: [
        { tenant_id: 'team-a', profile_ids: ['default'], api_base_url: 'https://team-a.example.com/api', auth_mode: 'token' as const },
      ],
    };

    const index = buildTenantIndexForProfile(raw as any, mixedProfileContext, logger);
    const resolved = resolveTenantFromHeaders(index, 'team-a', undefined);
    expect(resolved?.tenantAuthConfigs).toEqual([
      { type: 'custom-header', header_name: 'X-Tenant-Token', value_from_env: 'TENANT_TOKEN' },
    ]);
    expect(resolved?.tenantOAuthConfig).toBeUndefined();
  });

  it('uses profile oauth config for oauth auth_mode when interceptor config is inherited', () => {
    const oauthProfileContext: HttpProfileContext = {
      profileId: 'default',
      baseUrl: 'https://api.default.example.com',
      oauthConfig: {
        authorization_endpoint: 'https://auth.example.com/oauth/authorize',
        token_endpoint: 'https://auth.example.com/oauth/token',
        client_id: 'oauth-client',
        client_secret: 'oauth-secret',
      },
      authConfigs: [{ type: 'oauth' }],
    };
    const raw = {
      version: 1,
      tenants: [
        { tenant_id: 'team-a', profile_ids: ['default'], api_base_url: 'https://team-a.example.com/api', auth_mode: 'oauth' as const },
      ],
    };

    const index = buildTenantIndexForProfile(raw as any, oauthProfileContext, logger);
    const resolved = resolveTenantFromHeaders(index, 'team-a', undefined);
    expect(resolved?.tenantAuthConfigs).toEqual([{ type: 'oauth' }]);
    expect(resolved?.tenantOAuthConfig?.authorization_endpoint).toBe('https://auth.example.com/oauth/authorize');
  });

  it('fails on invalid tenant id and insecure scheme by default', () => {
    const invalidId = {
      version: 1,
      tenants: [
        { tenant_id: 'Invalid Tenant', profile_ids: ['default'], api_base_url: 'https://ok.example.com/api', auth_mode: 'token', auth: { type: 'bearer', value_from_env: 'A' } },
      ],
    };
    expect(() => buildTenantIndexForProfile(invalidId as any, profileContext, logger)).toThrow(/Invalid tenant_id/);

    const invalidScheme = {
      version: 1,
      tenants: [
        { tenant_id: 'team-a', profile_ids: ['default'], api_base_url: 'http://insecure.example.com/api', auth_mode: 'token', auth: { type: 'bearer', value_from_env: 'A' } },
      ],
    };
    expect(() => buildTenantIndexForProfile(invalidScheme as any, profileContext, logger)).toThrow(/must use https/);
  });

  it('fails on invalid tenant api_base_url values', () => {
    const malformedUrl = {
      version: 1,
      tenants: [
        { tenant_id: 'team-a', profile_ids: ['default'], api_base_url: 'not-a-url', auth_mode: 'token', auth: { type: 'bearer', value_from_env: 'A' } },
      ],
    };
    expect(() => buildTenantIndexForProfile(malformedUrl as any, profileContext, logger)).toThrow(/Invalid tenant api_base_url/i);

    const credentialsUrl = {
      version: 1,
      tenants: [
        { tenant_id: 'team-b', profile_ids: ['default'], api_base_url: 'https://user:pass@example.com/api', auth_mode: 'token', auth: { type: 'bearer', value_from_env: 'B' } },
      ],
    };
    expect(() => buildTenantIndexForProfile(credentialsUrl as any, profileContext, logger)).toThrow(/must not contain credentials/i);
  });

  it('allows http scheme only when MCP4_HTTP_TENANTS_ALLOW_HTTP=true', () => {
    process.env.MCP4_HTTP_TENANTS_ALLOW_HTTP = 'true';
    const raw = {
      version: 1,
      tenants: [
        { tenant_id: 'team-a', profile_ids: ['default'], api_base_url: 'http://insecure.example.com/api/', auth_mode: 'token', auth: { type: 'bearer', value_from_env: 'A' } },
      ],
    };

    const index = buildTenantIndexForProfile(raw as any, profileContext, logger);
    const resolved = resolveTenantFromHeaders(index, 'team-a', undefined);
    expect(resolved?.tenantBaseUrl).toBe('http://insecure.example.com/api');
  });

  it('rejects unknown selectors and mismatched selector combination', () => {
    const raw = {
      version: 1,
      tenants: [
        { tenant_id: 'team-a', profile_ids: ['default'], api_base_url: 'https://a.example.com/api', auth_mode: 'token', auth: { type: 'bearer', value_from_env: 'A' } },
        { tenant_id: 'team-b', profile_ids: ['default'], api_base_url: 'https://b.example.com/api', auth_mode: 'token', auth: { type: 'bearer', value_from_env: 'B' } },
      ],
    };

    const index = buildTenantIndexForProfile(raw as any, profileContext, logger);
    expect(() => resolveTenantFromHeaders(index, 'missing', undefined)).toThrow(/Unknown tenant id/);
    expect(() => resolveTenantFromHeaders(index, undefined, 'https://missing.example.com/api')).toThrow(/Unknown tenant base URL/);
    expect(() => resolveTenantFromHeaders(index, 'team-a', 'https://b.example.com/api')).toThrow(/mismatch/);
  });

  it('returns null when no tenant selector headers are provided', () => {
    const raw = {
      version: 1,
      tenants: [
        { tenant_id: 'first', profile_ids: ['default'], api_base_url: 'https://first.example.com/api', auth_mode: 'token', auth: { type: 'bearer', value_from_env: 'A' } },
        { tenant_id: 'second', profile_ids: ['default'], api_base_url: 'https://second.example.com/api', auth_mode: 'token', auth: { type: 'bearer', value_from_env: 'B' } },
      ],
    };

    const index = buildTenantIndexForProfile(raw as any, profileContext, logger);
    const resolved = resolveTenantFromHeaders(index, undefined, undefined);
    expect(resolved).toBeNull();
  });

  it('fails when token auth_mode has no token auth configuration', () => {
    const oauthOnlyProfileContext: HttpProfileContext = {
      profileId: 'default',
      baseUrl: 'https://api.default.example.com',
      authConfigs: [{ type: 'oauth' }],
      oauthConfig: {
        authorization_endpoint: 'https://auth.example.com/oauth/authorize',
        token_endpoint: 'https://auth.example.com/oauth/token',
        client_id: 'oauth-client',
        client_secret: 'oauth-secret',
      },
    };

    const raw = {
      version: 1,
      tenants: [
        { tenant_id: 'team-a', profile_ids: ['default'], api_base_url: 'https://team-a.example.com/api', auth_mode: 'token' as const },
      ],
    };

    expect(() => buildTenantIndexForProfile(raw as any, oauthOnlyProfileContext, logger)).toThrow(/requires token auth_mode/i);
  });

  it('fails when oauth auth_mode has oauth interceptor without oauth configuration', () => {
    const oauthProfileContextWithoutConfig: HttpProfileContext = {
      profileId: 'default',
      baseUrl: 'https://api.default.example.com',
      authConfigs: [{ type: 'oauth' }],
    };

    const raw = {
      version: 1,
      tenants: [
        { tenant_id: 'team-a', profile_ids: ['default'], api_base_url: 'https://team-a.example.com/api', auth_mode: 'oauth' as const },
      ],
    };

    expect(() => buildTenantIndexForProfile(raw as any, oauthProfileContextWithoutConfig, logger)).toThrow(
      /requires oauth auth_mode but no oauth configuration is available/i,
    );
  });

  it('rejects deprecated tenant default property', () => {
    const raw = {
      version: 1,
      tenants: [
        { tenant_id: 'team-a', profile_ids: ['default'], default: true, api_base_url: 'https://team-a.example.com/api', auth_mode: 'token', auth: { type: 'bearer', value_from_env: 'A' } },
      ],
    };

    expect(() => buildTenantIndexForProfile(raw as any, profileContext, logger)).toThrow(/unsupported 'default' property/i);
  });

  it('allows duplicate base URL for identical auth config and warns', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const raw = {
      version: 1,
      tenants: [
        {
          tenant_id: 'team-a',
          profile_ids: ['default'],
          api_base_url: 'https://same.example.com/api',
          auth_mode: 'token',
          auth: { type: 'bearer', value_from_env: 'SHARED_TOKEN' },
        },
        {
          tenant_id: 'team-b',
          profile_ids: ['default'],
          api_base_url: 'https://same.example.com/api/',
          auth_mode: 'token',
          auth: { type: 'bearer', value_from_env: 'SHARED_TOKEN' },
        },
      ],
    };

    try {
      const index = buildTenantIndexForProfile(raw as any, profileContext, logger);
      expect(index.byTenantId.size).toBe(2);
      expect(index.byBaseUrl.size).toBe(1);
      expect(warnSpy).toHaveBeenCalledWith(
        'Multiple tenants share the same api_base_url and auth config',
        expect.objectContaining({
          profileId: 'default',
          tenantIds: ['team-a', 'team-b'],
        }),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('resolves mask tenant from concrete base URL and requires concrete URL for tenant id selector', () => {
    const raw = {
      version: 1,
      tenants: [
        {
          tenant_id: 'grafana',
          profile_ids: ['default'],
          api_base_url: 'mask:https://grafana.*.ops.iszn.cz/api',
          auth_mode: 'token',
          auth: { type: 'bearer', value_from_env: 'GRAFANA_TOKEN' },
        },
      ],
    };

    const index = buildTenantIndexForProfile(raw as any, profileContext, logger);
    expect(() => resolveTenantFromHeaders(index, 'grafana', undefined)).toThrow(/requires X-Mcp4-Api-Base-Url/i);

    const resolvedFromBaseUrl = resolveTenantFromHeaders(
      index,
      undefined,
      'https://grafana.team-a.ops.iszn.cz/api',
    );
    expect(resolvedFromBaseUrl?.tenantId).toBe('grafana');
    expect(resolvedFromBaseUrl?.tenantBaseUrl).toBe('https://grafana.team-a.ops.iszn.cz/api');

    const resolvedFromBoth = resolveTenantFromHeaders(
      index,
      'grafana',
      'https://grafana.security.ops.iszn.cz/api',
    );
    expect(resolvedFromBoth?.tenantId).toBe('grafana');
    expect(resolvedFromBoth?.tenantBaseUrl).toBe('https://grafana.security.ops.iszn.cz/api');
  });

  it('resolves mask tenant when wildcard is used in path segment', () => {
    const raw = {
      version: 1,
      tenants: [
        {
          tenant_id: 'reklama',
          profile_ids: ['default'],
          api_base_url: 'mask:https://monitoring.ops.iszn.cz/*/api',
          auth_mode: 'token',
          auth: { type: 'bearer', value_from_env: 'GRAFANA_TOKEN' },
        },
      ],
    };

    const index = buildTenantIndexForProfile(raw as any, profileContext, logger);
    const resolved = resolveTenantFromHeaders(
      index,
      'reklama',
      'https://monitoring.ops.iszn.cz/team-a/api',
    );
    expect(resolved?.tenantId).toBe('reklama');
    expect(resolved?.tenantBaseUrl).toBe('https://monitoring.ops.iszn.cz/team-a/api');

    expect(() =>
      resolveTenantFromHeaders(
        index,
        undefined,
        'https://monitoring.ops.iszn.cz/security/team-a/api',
      ),
    ).toThrow(/Unknown tenant base URL selector/i);
  });

  it('returns null for mask tenant when no selector headers are provided', () => {
    const raw = {
      version: 1,
      tenants: [
        {
          tenant_id: 'grafana',
          profile_ids: ['default'],
          api_base_url: 'mask:https://grafana.*.ops.iszn.cz/api',
          auth_mode: 'token',
          auth: { type: 'bearer', value_from_env: 'GRAFANA_TOKEN' },
        },
      ],
    };

    const index = buildTenantIndexForProfile(raw as any, profileContext, logger);
    expect(resolveTenantFromHeaders(index, undefined, undefined)).toBeNull();
  });

  it('rejects ambiguous mask base URL selector at runtime', () => {
    const raw = {
      version: 1,
      tenants: [
        {
          tenant_id: 'grafana-a',
          profile_ids: ['default'],
          api_base_url: 'mask:https://grafana.*.ops.iszn.cz/api',
          auth_mode: 'token',
          auth: { type: 'bearer', value_from_env: 'GRAFANA_A_TOKEN' },
        },
      ],
    };

    const index = buildTenantIndexForProfile(raw as any, profileContext, logger);
    // Force ambiguity guard path using a crafted runtime index.
    index.maskSelectors.push({
      tenantId: 'grafana-b',
      selector: {
        original: 'https://grafana.*.ops.iszn.cz/api',
        normalizedMask: 'https://grafana.*.ops.iszn.cz/api',
        scheme: 'https:',
        hostLabels: ['grafana', '*', 'ops', 'iszn', 'cz'],
        port: '',
        path: '/api',
        pathSegments: ['api'],
      },
      context: {
        tenantId: 'grafana-b',
        tenantBaseUrl: 'https://grafana.*.ops.iszn.cz/api',
        tenantAuthMode: 'token',
        tenantAuthConfigs: [{ type: 'bearer', value_from_env: 'GRAFANA_B_TOKEN' }],
        tenantSelectorType: 'mask',
        tenantSelectorValue: 'mask:https://grafana.*.ops.iszn.cz/api',
      },
    });

    expect(() =>
      resolveTenantFromHeaders(index, undefined, 'https://grafana.team-a.ops.iszn.cz/api'),
    ).toThrow(/ambiguous/i);
  });

  it('rejects selector collisions between exact and mask tenants at startup', () => {
    const exactVsMask = {
      version: 1,
      tenants: [
        {
          tenant_id: 'exact',
          profile_ids: ['default'],
          api_base_url: 'https://grafana.team-a.ops.iszn.cz/api',
          auth_mode: 'token',
          auth: { type: 'bearer', value_from_env: 'EXACT_TOKEN' },
        },
        {
          tenant_id: 'mask',
          profile_ids: ['default'],
          api_base_url: 'mask:https://grafana.*.ops.iszn.cz/api',
          auth_mode: 'token',
          auth: { type: 'bearer', value_from_env: 'MASK_TOKEN' },
        },
      ],
    };
    expect(() => buildTenantIndexForProfile(exactVsMask as any, profileContext, logger)).toThrow(/selector collision/i);

    const maskVsMask = {
      version: 1,
      tenants: [
        {
          tenant_id: 'mask-a',
          profile_ids: ['default'],
          api_base_url: 'mask:https://monitoring.ops.iszn.cz/*/api',
          auth_mode: 'token',
          auth: { type: 'bearer', value_from_env: 'MASK_A_TOKEN' },
        },
        {
          tenant_id: 'mask-b',
          profile_ids: ['default'],
          api_base_url: 'mask:https://monitoring.ops.iszn.cz/team-a/api',
          auth_mode: 'token',
          auth: { type: 'bearer', value_from_env: 'MASK_B_TOKEN' },
        },
      ],
    };
    expect(() => buildTenantIndexForProfile(maskVsMask as any, profileContext, logger)).toThrow(/selector collision/i);
  });

  it('rejects invalid mask patterns', () => {
    const partialWildcardPathSegment = {
      version: 1,
      tenants: [
        {
          tenant_id: 'mask-a',
          profile_ids: ['default'],
          api_base_url: 'mask:https://monitoring.ops.iszn.cz/team-*/api',
          auth_mode: 'token',
          auth: { type: 'bearer', value_from_env: 'MASK_A_TOKEN' },
        },
      ],
    };
    expect(() => buildTenantIndexForProfile(partialWildcardPathSegment as any, profileContext, logger))
      .toThrow(/wildcard must be "\*" as a whole segment/i);
  });

  it('validates profile_ids entries as non-empty unique strings', () => {
    const nonStringProfileId = {
      version: 1,
      tenants: [
        {
          tenant_id: 'team-a',
          profile_ids: ['default', 42],
          api_base_url: 'https://team-a.example.com/api',
          auth_mode: 'token',
          auth: { type: 'bearer', value_from_env: 'TEAM_A_TOKEN' },
        },
      ],
    };
    expect(() => buildTenantIndexForProfile(nonStringProfileId as any, profileContext, logger))
      .toThrow(/profile_ids must contain non-empty strings/i);

    const duplicateProfileId = {
      version: 1,
      tenants: [
        {
          tenant_id: 'team-a',
          profile_ids: ['default', 'default'],
          api_base_url: 'https://team-a.example.com/api',
          auth_mode: 'token',
          auth: { type: 'bearer', value_from_env: 'TEAM_A_TOKEN' },
        },
      ],
    };
    expect(() => buildTenantIndexForProfile(duplicateProfileId as any, profileContext, logger))
      .toThrow(/profile_ids must not contain duplicates/i);
  });

  it('uses index-based tenant id in profile_ids validation when tenant_id is missing', () => {
    const missingTenantId = {
      version: 1,
      tenants: [
        {
          tenant_id: '',
          profile_ids: ['default', 'default'],
          api_base_url: 'https://team-a.example.com/api',
          auth_mode: 'token',
          auth: { type: 'bearer', value_from_env: 'TEAM_A_TOKEN' },
        },
      ],
    };

    expect(() => buildTenantIndexForProfile(missingTenantId as any, profileContext, logger))
      .toThrow(/Tenant 'index-0' profile_ids must not contain duplicates/i);
  });

  it('supports mask selectors with root path and no path segments', () => {
    const raw = {
      version: 1,
      tenants: [
        {
          tenant_id: 'grafana-root',
          profile_ids: ['default'],
          api_base_url: 'mask:https://grafana.*.ops.iszn.cz/',
          auth_mode: 'token',
          auth: { type: 'bearer', value_from_env: 'GRAFANA_TOKEN' },
        },
      ],
    };

    const index = buildTenantIndexForProfile(raw as any, profileContext, logger);
    const resolved = resolveTenantFromHeaders(index, 'grafana-root', 'https://grafana.team-a.ops.iszn.cz/');
    expect(resolved?.tenantId).toBe('grafana-root');
    expect(resolved?.tenantBaseUrl).toBe('https://grafana.team-a.ops.iszn.cz');
  });

  it('rejects query and fragment in exact and mask api_base_url selectors', () => {
    const exactWithQuery = {
      version: 1,
      tenants: [
        {
          tenant_id: 'team-a',
          profile_ids: ['default'],
          api_base_url: 'https://team-a.example.com/api?x=1',
          auth_mode: 'token',
          auth: { type: 'bearer', value_from_env: 'TOKEN' },
        },
      ],
    };
    expect(() => buildTenantIndexForProfile(exactWithQuery as any, profileContext, logger))
      .toThrow(/must not contain query or fragment/i);

    const maskWithFragment = {
      version: 1,
      tenants: [
        {
          tenant_id: 'team-mask',
          profile_ids: ['default'],
          api_base_url: 'mask:https://grafana.ops.iszn.cz/api#section',
          auth_mode: 'token',
          auth: { type: 'bearer', value_from_env: 'TOKEN' },
        },
      ],
    };
    expect(() => buildTenantIndexForProfile(maskWithFragment as any, profileContext, logger))
      .toThrow(/must not contain query or fragment/i);
  });

  it('rejects invalid mask selector variants', () => {
    const invalidMaskUrl = {
      version: 1,
      tenants: [
        {
          tenant_id: 'mask-invalid-url',
          profile_ids: ['default'],
          api_base_url: 'mask:not-a-url',
          auth_mode: 'token',
          auth: { type: 'bearer', value_from_env: 'TOKEN' },
        },
      ],
    };
    expect(() => buildTenantIndexForProfile(invalidMaskUrl as any, profileContext, logger))
      .toThrow(/Invalid tenant api_base_url/i);

    const maskWithCredentials = {
      version: 1,
      tenants: [
        {
          tenant_id: 'mask-credentials',
          profile_ids: ['default'],
          api_base_url: 'mask:https://user:pass@grafana.ops.iszn.cz/api',
          auth_mode: 'token',
          auth: { type: 'bearer', value_from_env: 'TOKEN' },
        },
      ],
    };
    expect(() => buildTenantIndexForProfile(maskWithCredentials as any, profileContext, logger))
      .toThrow(/must not contain credentials/i);

    const maskWithInvalidProtocol = {
      version: 1,
      tenants: [
        {
          tenant_id: 'mask-protocol',
          profile_ids: ['default'],
          api_base_url: 'mask:ftp://grafana.ops.iszn.cz/api',
          auth_mode: 'token',
          auth: { type: 'bearer', value_from_env: 'TOKEN' },
        },
      ],
    };
    expect(() => buildTenantIndexForProfile(maskWithInvalidProtocol as any, profileContext, logger))
      .toThrow(/must use https/i);

    const maskWithInvalidHostLabel = {
      version: 1,
      tenants: [
        {
          tenant_id: 'mask-host-label',
          profile_ids: ['default'],
          api_base_url: 'mask:https://grafana._bad.ops.iszn.cz/api',
          auth_mode: 'token',
          auth: { type: 'bearer', value_from_env: 'TOKEN' },
        },
      ],
    };
    expect(() => buildTenantIndexForProfile(maskWithInvalidHostLabel as any, profileContext, logger))
      .toThrow(/Invalid tenant mask host label/i);

    const emptyMask = {
      version: 1,
      tenants: [
        {
          tenant_id: 'mask-empty',
          profile_ids: ['default'],
          api_base_url: 'mask:',
          auth_mode: 'token',
          auth: { type: 'bearer', value_from_env: 'TOKEN' },
        },
      ],
    };
    expect(() => buildTenantIndexForProfile(emptyMask as any, profileContext, logger))
      .toThrow(/Invalid tenant api_base_url/i);
  });

  it('rejects empty parsed mask host labels via defensive guard', () => {
    const originalURL = globalThis.URL;
    class MockUrlWithEmptyHostLabels {
      username = '';
      password = '';
      search = '';
      hash = '';
      protocol = 'https:';
      pathname = '/api';
      port = '';
      hostname = {
        toLowerCase: () => ({
          split: () => [] as string[],
        }),
      } as any;
    }
    vi.stubGlobal('URL', MockUrlWithEmptyHostLabels as any);

    const raw = {
      version: 1,
      tenants: [
        {
          tenant_id: 'mask-empty-host',
          profile_ids: ['default'],
          api_base_url: 'mask:https://grafana.ops.iszn.cz/api',
          auth_mode: 'token',
          auth: { type: 'bearer', value_from_env: 'TOKEN' },
        },
      ],
    };

    try {
      expect(() => buildTenantIndexForProfile(raw as any, profileContext, logger))
        .toThrow(/Invalid tenant mask host/i);
    } finally {
      vi.stubGlobal('URL', originalURL);
    }
  });

  it('rejects non-matching mask selector dimensions in runtime resolution', () => {
    const index = {
      enabled: true,
      byTenantId: new Map(),
      byBaseUrl: new Map(),
      selectorTypeByTenantId: new Map<string, 'exact' | 'mask'>(),
      maskSelectors: [
        {
          tenantId: 'grafana',
          selector: {
            original: 'https://grafana.*.ops.iszn.cz/api',
            normalizedMask: 'https://grafana.*.ops.iszn.cz/api',
            scheme: 'https:',
            hostLabels: ['grafana', '*', 'ops', 'iszn', 'cz'],
            port: '',
            path: '/api',
            pathSegments: ['api'],
          },
          context: {
            tenantId: 'grafana',
            tenantBaseUrl: 'https://grafana.*.ops.iszn.cz/api',
            tenantAuthMode: 'token',
            tenantAuthConfigs: [{ type: 'bearer', value_from_env: 'TOKEN' }],
            tenantSelectorType: 'mask',
            tenantSelectorValue: 'mask:https://grafana.*.ops.iszn.cz/api',
          },
        },
      ],
    };

    process.env.MCP4_HTTP_TENANTS_ALLOW_HTTP = 'true';
    expect(() => resolveTenantFromHeaders(index as any, undefined, 'http://grafana.team-a.ops.iszn.cz/api'))
      .toThrow(/Unknown tenant base URL selector/i);
    expect(() => resolveTenantFromHeaders(index as any, undefined, 'https://grafana.team-a.ops.iszn.cz:8443/api'))
      .toThrow(/Unknown tenant base URL selector/i);
    expect(() => resolveTenantFromHeaders(index as any, undefined, 'https://grafana.ops.iszn.cz/api'))
      .toThrow(/Unknown tenant base URL selector/i);
    expect(() => resolveTenantFromHeaders(index as any, undefined, 'https://kibana.team-a.ops.iszn.cz/api'))
      .toThrow(/Unknown tenant base URL selector/i);
    expect(() => resolveTenantFromHeaders(index as any, undefined, 'https://grafana.team-a.ops.iszn.cz/v2'))
      .toThrow(/Unknown tenant base URL selector/i);
  });

  it('returns false for non-intersecting mask combinations across mismatch dimensions', () => {
    const scenarios = [
      [
        'mask:https://grafana.*.ops.iszn.cz/api',
        'mask:http://grafana.*.ops.iszn.cz/api',
      ],
      [
        'mask:https://grafana.*.ops.iszn.cz:443/api',
        'mask:https://grafana.*.ops.iszn.cz:8443/api',
      ],
      [
        'mask:https://grafana.*.ops.iszn.cz/api',
        'mask:https://grafana.*.ops.iszn.cz/api/v1',
      ],
      [
        'mask:https://grafana.*.ops.iszn.cz/api',
        'mask:https://*.ops.iszn.cz/api',
      ],
      [
        'mask:https://grafana.*.ops.iszn.cz/api',
        'mask:https://kibana.*.ops.iszn.cz/api',
      ],
      [
        'mask:https://monitoring.ops.iszn.cz/api/*',
        'mask:https://monitoring.ops.iszn.cz/v1/*',
      ],
    ];

    process.env.MCP4_HTTP_TENANTS_ALLOW_HTTP = 'true';
    for (const [leftMask, rightMask] of scenarios) {
      const raw = {
        version: 1,
        tenants: [
          {
            tenant_id: 'left',
            profile_ids: ['default'],
            api_base_url: leftMask,
            auth_mode: 'token',
            auth: { type: 'bearer', value_from_env: 'LEFT_TOKEN' },
          },
          {
            tenant_id: 'right',
            profile_ids: ['default'],
            api_base_url: rightMask,
            auth_mode: 'token',
            auth: { type: 'bearer', value_from_env: 'RIGHT_TOKEN' },
          },
        ],
      };
      const index = buildTenantIndexForProfile(raw as any, profileContext, logger);
      expect(index.enabled).toBe(true);
      expect(index.byTenantId.size).toBe(2);
    }
  });

  it('rejects selector collisions when exact tenant is added after overlapping mask', () => {
    const raw = {
      version: 1,
      tenants: [
        {
          tenant_id: 'mask',
          profile_ids: ['default'],
          api_base_url: 'mask:https://grafana.*.ops.iszn.cz/api',
          auth_mode: 'token',
          auth: { type: 'bearer', value_from_env: 'MASK_TOKEN' },
        },
        {
          tenant_id: 'exact',
          profile_ids: ['default'],
          api_base_url: 'https://grafana.team-a.ops.iszn.cz/api',
          auth_mode: 'token',
          auth: { type: 'bearer', value_from_env: 'EXACT_TOKEN' },
        },
      ],
    };

    expect(() => buildTenantIndexForProfile(raw as any, profileContext, logger))
      .toThrow(/selector collision between exact/i);
  });

  it('covers defensive fallback branches for invalid concrete URL parsing and missing default mapping', () => {
    const originalURL = globalThis.URL;
    class MockUrlReturningInvalidNormalized {
      username = '';
      password = '';
      search = '';
      hash = '';
      protocol = 'https:';
      pathname = '/api';
      hostname = 'grafana.team-a.ops.iszn.cz';
      port = '';

      constructor(raw: string) {
        if (raw === 'not-a-url') {
          throw new TypeError('invalid url');
        }
      }

      toString() {
        return 'not-a-url';
      }
    }

    const runtimeMaskIndex = {
      enabled: true,
      byTenantId: new Map(),
      byBaseUrl: new Map(),
      selectorTypeByTenantId: new Map<string, 'exact' | 'mask'>(),
      maskSelectors: [
        {
          tenantId: 'mask-a',
          selector: {
            original: 'https://grafana.*.ops.iszn.cz/api',
            normalizedMask: 'https://grafana.*.ops.iszn.cz/api',
            scheme: 'https:',
            hostLabels: ['grafana', '*', 'ops', 'iszn', 'cz'],
            port: '',
            path: '/api',
            pathSegments: ['api'],
          },
          context: {
            tenantId: 'mask-a',
            tenantBaseUrl: 'https://grafana.*.ops.iszn.cz/api',
            tenantAuthMode: 'token',
            tenantAuthConfigs: [{ type: 'bearer', value_from_env: 'TOKEN' }],
            tenantSelectorType: 'mask',
            tenantSelectorValue: 'mask:https://grafana.*.ops.iszn.cz/api',
          },
        },
      ],
    };

    vi.stubGlobal('URL', MockUrlReturningInvalidNormalized as any);
    try {
      expect(() =>
        resolveTenantFromHeaders(runtimeMaskIndex as any, undefined, 'https://grafana.team-a.ops.iszn.cz/api'),
      ).toThrow(/Unknown tenant base URL selector/i);
    } finally {
      vi.stubGlobal('URL', originalURL);
    }

    expect(resolveTenantFromHeaders(runtimeMaskIndex as any, undefined, undefined)).toBeNull();
  });
});
