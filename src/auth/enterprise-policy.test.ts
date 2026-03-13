import { describe, expect, it } from 'vitest';
import { buildEnterprisePrincipal } from './enterprise-policy.js';
import { EnterprisePolicyViolationError } from '../core/errors.js';
import type { EnterpriseAuthorizationConfig } from '../types/profile.js';

const baseConfig: EnterpriseAuthorizationConfig = {
  enabled: true,
  issuer: {
    issuer: 'https://issuer.example',
    allowed_algs: ['RS256'],
  },
  token_exchange: {
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
  },
};

describe('buildEnterprisePrincipal', () => {
  it('builds a principal from mapped claims', () => {
    const principal = buildEnterprisePrincipal(
      'profile-a',
      {
        ...baseConfig,
        access_policy: {
          default_scopes: ['api'],
          claim_mappings: {
            subject: 'preferred_username',
            groups: 'roles',
            tenant_id: 'tenant',
          },
        },
      },
      {
        preferred_username: 'user-1',
        roles: ['admin', 'viewer', 1],
        tenant: 'tenant-a',
        iss: 'https://issuer.override',
        exp: 123,
      },
      'client-1',
    );

    expect(principal).toMatchObject({
      authType: 'enterprise',
      profileId: 'profile-a',
      issuer: 'https://issuer.override',
      subject: 'user-1',
      clientId: 'client-1',
      scopes: ['api'],
      groups: ['admin', 'viewer'],
      tenantId: 'tenant-a',
      expiresAt: 123000,
    });
    expect(principal.claimsHash).toBeTruthy();
  });

  it('rejects missing mapped subjects', () => {
    expect(() =>
      buildEnterprisePrincipal(
        'profile-a',
        {
          ...baseConfig,
          access_policy: { claim_mappings: { subject: 'preferred_username' } },
        },
        { sub: 'fallback-only' },
      ),
    ).toThrow(EnterprisePolicyViolationError);
  });

  it('rejects assertions missing required scopes', () => {
    expect(() =>
      buildEnterprisePrincipal(
        'profile-a',
        {
          ...baseConfig,
          access_policy: { required_scopes: ['admin'] },
        },
        { sub: 'user-1', scope: 'api' },
      ),
    ).toThrow(/required scopes/);
  });
});
