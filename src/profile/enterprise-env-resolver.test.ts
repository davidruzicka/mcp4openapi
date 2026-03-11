import { afterEach, describe, expect, it } from 'vitest';
import { EnterpriseAuthorizationConfigurationError } from '../core/errors.js';
import { resolveEnterpriseAuthorizationEnv } from './enterprise-env-resolver.js';
import type { EnterpriseAuthorizationConfig } from '../types/profile.js';

function createConfig(overrides?: Partial<EnterpriseAuthorizationConfig>): EnterpriseAuthorizationConfig {
  return {
    enabled: true,
    mode: 'required',
    audience: 'https://resource.example/default',
    issuer: {
      issuer: 'https://issuer.example',
      jwks_uri: 'https://issuer.example/jwks',
      allowed_algs: ['RS256'],
    },
    token_exchange: {
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      allowed_client_ids: ['client-1'],
    },
    access_policy: {
      default_scopes: ['api'],
      required_scopes: ['api'],
      allowed_tool_categories: ['read'],
      claim_mappings: {
        subject: 'sub',
      },
    },
    ...overrides,
  };
}

describe('resolveEnterpriseAuthorizationEnv', () => {
  const previousEnv = { ...process.env };

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in previousEnv)) {
        delete process.env[key];
      }
    }
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) {
        delete process.env[key];
        continue;
      }
      process.env[key] = value;
    }
  });

  it('prefers env-backed values over static profile values', () => {
    process.env.ENTERPRISE_ISSUER = 'https://env-issuer.example';
    process.env.ENTERPRISE_ALLOWED_ALGS = 'RS384,ES256';
    process.env.ENTERPRISE_AUDIENCE = 'https://resource.example/one,https://resource.example/two';
    process.env.ENTERPRISE_DEFAULT_SCOPES = 'api,admin';
    process.env.ENTERPRISE_CATEGORIES = 'list,read';
    process.env.ENTERPRISE_CLAIM_MAPPINGS = JSON.stringify({ subject: 'preferred_username', tenant_id: 'tenant' });

    const resolved = resolveEnterpriseAuthorizationEnv(createConfig({
      mode_from_env: 'ENTERPRISE_MODE',
      audience_from_env: 'ENTERPRISE_AUDIENCE',
      issuer: {
        issuer: 'https://issuer.example',
        issuer_from_env: 'ENTERPRISE_ISSUER',
        jwks_uri: 'https://issuer.example/jwks',
        allowed_algs: ['RS256'],
        allowed_algs_from_env: 'ENTERPRISE_ALLOWED_ALGS',
      },
      access_policy: {
        default_scopes: ['api'],
        default_scopes_from_env: 'ENTERPRISE_DEFAULT_SCOPES',
        allowed_tool_categories: ['read'],
        allowed_tool_categories_from_env: 'ENTERPRISE_CATEGORIES',
        claim_mappings: { subject: 'sub' },
        claim_mappings_from_env: 'ENTERPRISE_CLAIM_MAPPINGS',
      },
    }));

    expect(resolved.issuer.issuer).toBe('https://env-issuer.example');
    expect(resolved.issuer.allowed_algs).toEqual(['RS384', 'ES256']);
    expect(resolved.audience).toEqual(['https://resource.example/one', 'https://resource.example/two']);
    expect(resolved.access_policy?.default_scopes).toEqual(['api', 'admin']);
    expect(resolved.access_policy?.allowed_tool_categories).toEqual(['list', 'read']);
    expect(resolved.access_policy?.claim_mappings).toEqual({
      subject: 'preferred_username',
      tenant_id: 'tenant',
    });
  });

  it('keeps static values when env var is unset or empty', () => {
    process.env.ENTERPRISE_MODE = '   ';

    const resolved = resolveEnterpriseAuthorizationEnv(createConfig({
      mode_from_env: 'ENTERPRISE_MODE',
      issuer: {
        issuer: 'https://issuer.example',
        issuer_from_env: 'MISSING_ISSUER',
      },
    }));

    expect(resolved.mode).toBe('required');
    expect(resolved.issuer.issuer).toBe('https://issuer.example');
  });

  it('rejects malformed JSON claim mappings', () => {
    process.env.ENTERPRISE_CLAIM_MAPPINGS = '{"subject":}';

    expect(() => resolveEnterpriseAuthorizationEnv(createConfig({
      access_policy: {
        claim_mappings_from_env: 'ENTERPRISE_CLAIM_MAPPINGS',
      },
    }))).toThrow(EnterpriseAuthorizationConfigurationError);
  });

  it('rejects unsupported algorithms and categories from env', () => {
    process.env.ENTERPRISE_ALLOWED_ALGS = 'RS256,HS256';
    process.env.ENTERPRISE_CATEGORIES = 'list,drop';

    expect(() => resolveEnterpriseAuthorizationEnv(createConfig({
      issuer: {
        issuer: 'https://issuer.example',
        allowed_algs_from_env: 'ENTERPRISE_ALLOWED_ALGS',
      },
    }))).toThrow(/unsupported algorithm/);

    expect(() => resolveEnterpriseAuthorizationEnv(createConfig({
      access_policy: {
        allowed_tool_categories_from_env: 'ENTERPRISE_CATEGORIES',
      },
    }))).toThrow(/unsupported value/);
  });

  it('rejects empty env variable references', () => {
    expect(() => resolveEnterpriseAuthorizationEnv(createConfig({
      issuer: {
        issuer: 'https://issuer.example',
        issuer_from_env: '   ',
      },
    }))).toThrow(/must not be empty/);
  });
});
