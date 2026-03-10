import { createHash } from 'node:crypto';
import type { EnterpriseAuthorizationConfig } from '../types/profile.js';
import type { AuthorizedPrincipal } from './inbound-auth-principal.js';
import { EnterprisePolicyViolationError } from '../core/errors.js';

export function buildEnterprisePrincipal(
  profileId: string,
  config: EnterpriseAuthorizationConfig,
  claims: Record<string, unknown>,
  clientId?: string,
): AuthorizedPrincipal {
  const mappings = config.access_policy?.claim_mappings ?? {};
  const subjectClaim = mappings.subject ?? 'sub';
  const subject = claims[subjectClaim];
  if (typeof subject !== 'string' || subject.trim().length === 0) {
    throw new EnterprisePolicyViolationError('Enterprise assertion did not resolve a subject', { subjectClaim });
  }

  const groupsClaim = mappings.groups ?? 'groups';
  const tenantClaim = mappings.tenant_id ?? 'tenant_id';
  const scopeClaim = typeof claims.scope === 'string' ? claims.scope.split(/\s+/).filter(Boolean) : [];
  const scopes = config.access_policy?.default_scopes?.length
    ? [...config.access_policy.default_scopes]
    : scopeClaim;

  if (config.access_policy?.required_scopes?.some((scope) => !scopes.includes(scope))) {
    throw new EnterprisePolicyViolationError('Enterprise assertion is missing required scopes', {
      requiredScopes: config.access_policy.required_scopes,
      scopes,
    });
  }

  const expiresAt = typeof claims.exp === 'number' ? claims.exp * 1000 : undefined;
  return {
    authType: 'enterprise',
    profileId,
    issuer: typeof claims.iss === 'string' ? claims.iss : config.issuer.issuer,
    subject,
    clientId,
    scopes,
    groups: Array.isArray(claims[groupsClaim]) ? claims[groupsClaim].filter((v): v is string => typeof v === 'string') : undefined,
    tenantId: typeof claims[tenantClaim] === 'string' ? claims[tenantClaim] : undefined,
    expiresAt,
    claimsHash: createHash('sha256').update(JSON.stringify(claims)).digest('base64url'),
  };
}
