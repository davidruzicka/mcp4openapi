import type { EnterpriseAuthorizationConfig } from '../types/profile.js';

export function buildProtectedResourceMetadata(baseMetadata: Record<string, unknown>, enterprise?: EnterpriseAuthorizationConfig): Record<string, unknown> {
  if (!enterprise?.enabled) {
    return baseMetadata;
  }
  return {
    ...baseMetadata,
    ...(enterprise.resource ? { resource: enterprise.resource } : {}),
    ...(enterprise.metadata?.authorization_servers ? { authorization_servers: enterprise.metadata.authorization_servers } : {}),
  };
}

export function buildAuthorizationServerMetadata(baseMetadata: Record<string, unknown>, enterprise?: EnterpriseAuthorizationConfig): Record<string, unknown> {
  if (!enterprise?.enabled) {
    return baseMetadata;
  }
  const supportedGrantTypes = new Set<string>(Array.isArray(baseMetadata.grant_types_supported) ? baseMetadata.grant_types_supported as string[] : []);
  supportedGrantTypes.add('urn:ietf:params:oauth:grant-type:jwt-bearer');
  return {
    ...baseMetadata,
    grant_types_supported: [...supportedGrantTypes],
    ...(enterprise.token_exchange.subject_token_type ? { subject_token_types_supported: [enterprise.token_exchange.subject_token_type] } : {}),
    ...(enterprise.metadata?.extensions ?? {}),
  };
}
