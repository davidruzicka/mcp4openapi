import { afterEach, describe, expect, it } from 'vitest';
import { validateEnterpriseAuthorizationProfile } from './enterprise-profile-validator.js';
import {
  EnterpriseAuthorizationConfigurationError,
  ValidationError,
} from '../core/errors.js';
import type { Profile } from '../types/profile.js';

function createProfile(overrides?: Partial<Profile>): Profile {
  return {
    profile_name: 'enterprise-test',
    enterprise_authorization: {
      enabled: true,
      issuer: {
        issuer: 'https://issuer.example',
        jwks_uri: 'https://issuer.example/jwks',
      },
      token_exchange: {
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        allowed_client_ids: ['client-1'],
      },
    },
    ...overrides,
  } as Profile;
}

describe('validateEnterpriseAuthorizationProfile', () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const enterpriseEnvKeys = [
    'ENTERPRISE_ISSUER',
    'ENTERPRISE_ALLOWED_ALGS',
    'ENTERPRISE_DEFAULT_SCOPES',
    'ENTERPRISE_CATEGORIES',
  ] as const;

  afterEach(() => {
    process.env.NODE_ENV = previousNodeEnv;
    for (const key of enterpriseEnvKeys) {
      delete process.env[key];
    }
  });

  it('returns undefined when enterprise authorization is not configured', () => {
    expect(validateEnterpriseAuthorizationProfile({ profile_name: 'test' } as Profile)).toBeUndefined();
  });

  it('returns disabled enterprise authorization config without normalization', () => {
    const profile = createProfile({
      enterprise_authorization: {
        enabled: false,
        issuer: { issuer: 'https://issuer.example' },
        token_exchange: { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer' },
      },
    } as Profile);

    expect(validateEnterpriseAuthorizationProfile(profile)).toEqual(
      expect.objectContaining({ enabled: false })
    );
  });

  it('rejects duplicate enterprise authorization lists', () => {
    const profile = createProfile({
      enterprise_authorization: {
        enabled: true,
        issuer: {
          issuer: 'https://issuer.example',
          jwks_uri: 'https://issuer.example/jwks',
          allowed_kids: ['kid-1', 'kid-1'],
        },
        token_exchange: {
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          allowed_client_ids: ['client-1', 'client-1'],
          required_typ: ['at+jwt', 'at+jwt'],
          required_claims: ['tenant_id', 'tenant_id'],
        },
      },
    } as Profile);

    expect(() => validateEnterpriseAuthorizationProfile(profile)).toThrow(
      EnterpriseAuthorizationConfigurationError
    );
  });

  it('rejects unsupported grant types', () => {
    const profile = createProfile({
      enterprise_authorization: {
        enabled: true,
        issuer: { issuer: 'https://issuer.example', jwks_uri: 'https://issuer.example/jwks' },
        token_exchange: {
          grant_type: 'client_credentials',
          allowed_client_ids: ['client-1'],
        },
      },
    } as Profile);

    expect(() => validateEnterpriseAuthorizationProfile(profile)).toThrow(ValidationError);
  });

  it('rejects default and required scopes outside scopes_supported', () => {
    const defaultScopesProfile = createProfile({
      enterprise_authorization: {
        enabled: true,
        issuer: { issuer: 'https://issuer.example', jwks_uri: 'https://issuer.example/jwks' },
        token_exchange: {
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          allowed_client_ids: ['client-1'],
        },
        access_policy: {
          scopes_supported: ['api'],
          default_scopes: ['admin'],
        },
      },
    } as Profile);
    const requiredScopesProfile = createProfile({
      enterprise_authorization: {
        enabled: true,
        issuer: { issuer: 'https://issuer.example', jwks_uri: 'https://issuer.example/jwks' },
        token_exchange: {
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          allowed_client_ids: ['client-1'],
        },
        access_policy: {
          scopes_supported: ['api'],
          required_scopes: ['admin'],
        },
      },
    } as Profile);

    expect(() => validateEnterpriseAuthorizationProfile(defaultScopesProfile)).toThrow(
      /default_scopes must be a subset/
    );
    expect(() => validateEnterpriseAuthorizationProfile(requiredScopesProfile)).toThrow(
      /required_scopes must be a subset/
    );
  });

  it('rejects non-https metadata URLs outside test mode', () => {
    process.env.NODE_ENV = 'production';
    const profile = createProfile({
      enterprise_authorization: {
        enabled: true,
        issuer: { issuer: 'https://issuer.example', jwks_uri: 'https://issuer.example/jwks' },
        token_exchange: {
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          allowed_client_ids: ['client-1'],
        },
        metadata: {
          authorization_servers: ['http://metadata.example/oauth'],
          documentation_url: 'http://metadata.example/docs',
        },
      },
    } as Profile);

    expect(() => validateEnterpriseAuthorizationProfile(profile)).toThrow(/must use https/);
  });

  it('adds mapped claims to required_claims and defaults mode to optional when auth metadata exists', () => {
    const normalized = validateEnterpriseAuthorizationProfile(
      createProfile({
        interceptors: {
          auth: {
            type: 'bearer',
            token: 'token',
          },
        },
        enterprise_authorization: {
          enabled: true,
          issuer: { issuer: 'https://issuer.example' },
          token_exchange: {
            grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            allowed_client_ids: ['client-1'],
            required_claims: ['sub'],
          },
          access_policy: {
            claim_mappings: {
              tenant_id: 'tenant_id',
            },
          },
        },
      } as Profile)
    );

    expect(normalized?.mode).toBe('optional');
    expect(normalized?.token_exchange.required_claims).toEqual(expect.arrayContaining(['sub', 'tenant_id']));
  });

  it('resolves env-backed issuer and access policy values before validation', () => {
    process.env.ENTERPRISE_ISSUER = 'https://env-issuer.example';
    process.env.ENTERPRISE_ALLOWED_ALGS = 'RS384';
    process.env.ENTERPRISE_DEFAULT_SCOPES = 'api';
    process.env.ENTERPRISE_CATEGORIES = 'list,read';

    const normalized = validateEnterpriseAuthorizationProfile(createProfile({
      enterprise_authorization: {
        enabled: true,
        issuer: {
          issuer: 'https://issuer.example',
          issuer_from_env: 'ENTERPRISE_ISSUER',
          allowed_algs_from_env: 'ENTERPRISE_ALLOWED_ALGS',
        },
        token_exchange: {
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          allowed_client_ids: ['client-1'],
        },
        access_policy: {
          scopes_supported: ['api'],
          default_scopes_from_env: 'ENTERPRISE_DEFAULT_SCOPES',
          allowed_tool_categories_from_env: 'ENTERPRISE_CATEGORIES',
        },
      },
    } as Profile));

    expect(normalized?.issuer.issuer).toBe('https://env-issuer.example');
    expect(normalized?.issuer.allowed_algs).toEqual(['RS384']);
    expect(normalized?.access_policy?.default_scopes).toEqual(['api']);
    expect(normalized?.access_policy?.allowed_tool_categories).toEqual(['list', 'read']);
  });
});
