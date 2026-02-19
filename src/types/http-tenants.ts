import type { AuthInterceptor, OAuthConfig } from './profile.js';

export type TenantAuthMode = 'oauth' | 'token';

export interface HttpTenantConfig {
  tenant_id: string;
  default?: boolean;
  api_base_url: string;
  auth_mode: TenantAuthMode;
  auth?: AuthInterceptor | AuthInterceptor[];
}

export interface HttpTenantsConfig {
  version: number;
  tenants: HttpTenantConfig[];
}

export interface ResolvedTenantContext {
  tenantId: string;
  tenantBaseUrl: string;
  tenantAuthMode: TenantAuthMode;
  tenantAuthConfigs: AuthInterceptor[];
  tenantOAuthConfig?: OAuthConfig;
}

export interface HttpTenantIndex {
  enabled: boolean;
  defaultTenantId?: string;
  byTenantId: Map<string, ResolvedTenantContext>;
  byBaseUrl: Map<string, ResolvedTenantContext>;
}
