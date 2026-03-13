import { describe, expect, it } from 'vitest';
import { buildAuthorizationServerMetadata, buildProtectedResourceMetadata } from './enterprise-metadata.js';
import type { EnterpriseAuthorizationConfig } from '../types/profile.js';

const enterpriseConfig: EnterpriseAuthorizationConfig = {
  enabled: true,
  resource: 'https://resource.example/mcp',
  issuer: {
    issuer: 'https://issuer.example',
    allowed_algs: ['RS256'],
  },
  token_exchange: {
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
  },
  metadata: {
    authorization_servers: ['https://issuer.example'],
    display_name: 'Enterprise Authorization',
    documentation_url: 'https://issuer.example/docs',
    extensions: {
      enterprise_policy_uri: 'https://issuer.example/policy',
    },
  },
};

describe('enterprise-metadata', () => {
  it('returns base protected resource metadata when enterprise auth is disabled', () => {
    const base = { resource: 'unchanged' };
    expect(buildProtectedResourceMetadata(base)).toBe(base);
    expect(buildProtectedResourceMetadata(base, { ...enterpriseConfig, enabled: false })).toBe(base);
  });

  it('adds protected resource metadata fields when enterprise auth is enabled', () => {
    expect(buildProtectedResourceMetadata({ issuer: 'base' }, enterpriseConfig)).toEqual({
      issuer: 'base',
      resource: 'https://resource.example/mcp',
      authorization_servers: ['https://issuer.example'],
      display_name: 'Enterprise Authorization',
      documentation_url: 'https://issuer.example/docs',
    });
  });

  it('merges authorization server metadata without duplicating grant types', () => {
    expect(
      buildAuthorizationServerMetadata(
        { grant_types_supported: ['authorization_code', 'urn:ietf:params:oauth:grant-type:jwt-bearer'] },
        enterpriseConfig,
      ),
    ).toEqual({
      grant_types_supported: ['authorization_code', 'urn:ietf:params:oauth:grant-type:jwt-bearer'],
      subject_token_types_supported: ['urn:ietf:params:oauth:token-type:jwt'],
      display_name: 'Enterprise Authorization',
      documentation_url: 'https://issuer.example/docs',
      enterprise_policy_uri: 'https://issuer.example/policy',
    });
  });
});
