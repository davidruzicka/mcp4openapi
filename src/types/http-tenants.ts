import type { AuthInterceptor, OAuthConfig } from './profile.js';

export type TenantAuthMode = 'oauth' | 'token';
export type TenantSelectorType = 'exact' | 'mask';

export interface TenantMaskSelector {
  original: string;
  normalizedMask: string;
  scheme: 'http:' | 'https:';
  hostLabels: string[];
  port: string;
  path: string;
  pathSegments: string[];
}

export interface HttpTenantConfig {
  tenant_id: string;
  profile_ids: string[];
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
  tenantSelectorType: TenantSelectorType;
  tenantSelectorValue: string;
}

export interface TenantMaskSelectorEntry {
  tenantId: string;
  selector: TenantMaskSelector;
  context: ResolvedTenantContext;
}

export interface HttpTenantIndex {
  enabled: boolean;
  defaultTenantId?: string;
  byTenantId: Map<string, ResolvedTenantContext>;
  byBaseUrl: Map<string, ResolvedTenantContext>;
  maskSelectors: TenantMaskSelectorEntry[];
  selectorTypeByTenantId: Map<string, TenantSelectorType>;
}
