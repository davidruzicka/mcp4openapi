import fs from 'fs';
import type { Logger } from '../core/logger.js';
import { ConfigurationError, ValidationError } from '../core/errors.js';
import type { AuthInterceptor, OAuthConfig } from '../types/profile.js';
import type {
  HttpTenantIndex,
  HttpTenantsConfig,
  ResolvedTenantContext,
  TenantAuthMode,
} from '../types/http-tenants.js';
import type { HttpProfileContext } from '../types/http-transport.js';

const TENANT_ID_REGEX = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function normalizeBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ValidationError(`Invalid tenant api_base_url: '${raw}'`);
  }

  if (url.username || url.password) {
    throw new ValidationError('Tenant api_base_url must not contain credentials.');
  }

  const allowHttp = process.env.MCP4_HTTP_TENANTS_ALLOW_HTTP === 'true';
  if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) {
    throw new ValidationError('Tenant api_base_url must use https unless MCP4_HTTP_TENANTS_ALLOW_HTTP=true.');
  }

  return url.toString().replace(/\/$/, '');
}

function parseTenantsJson(source: string): HttpTenantsConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new ConfigurationError(`Invalid tenant JSON config: ${(error as Error).message}`);
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new ValidationError('Tenant config must be an object.');
  }

  const config = parsed as Partial<HttpTenantsConfig>;
  if (config.version !== 1) {
    throw new ValidationError(`Unsupported tenant config version: ${String(config.version)}. Expected 1.`);
  }

  if (!Array.isArray(config.tenants) || config.tenants.length === 0) {
    throw new ValidationError('Tenant config must contain a non-empty tenants array.');
  }

  return config as HttpTenantsConfig;
}

function getEffectiveAuth(tenantAuth: AuthInterceptor | AuthInterceptor[] | undefined, profileAuth: AuthInterceptor[] | undefined): AuthInterceptor[] {
  if (tenantAuth) {
    return Array.isArray(tenantAuth) ? tenantAuth : [tenantAuth];
  }
  return profileAuth || [];
}

function filterAuthConfigsByMode(authMode: TenantAuthMode, authConfigs: AuthInterceptor[]): AuthInterceptor[] {
  if (authMode === 'oauth') {
    return authConfigs.filter((config) => config.type === 'oauth');
  }
  return authConfigs.filter((config) => config.type !== 'oauth');
}

function validateAuthMode(authMode: TenantAuthMode, authConfigs: AuthInterceptor[], tenantId: string): void {
  const hasOAuth = authConfigs.some((config) => config.type === 'oauth');
  const hasToken = authConfigs.some((config) => config.type !== 'oauth');

  if (authMode === 'oauth' && !hasOAuth) {
    throw new ValidationError(`Tenant '${tenantId}' requires oauth auth_mode but no oauth auth config is available.`);
  }

  if (authMode === 'token' && !hasToken) {
    throw new ValidationError(`Tenant '${tenantId}' requires token auth_mode but no token auth config is available.`);
  }
}

interface EffectiveTenantAuthContext {
  authConfigs: AuthInterceptor[];
  oauthConfig?: OAuthConfig;
}

export function resolveEffectiveTenantAuthContext(
  authMode: TenantAuthMode,
  tenantAuth: AuthInterceptor | AuthInterceptor[] | undefined,
  profileAuth: AuthInterceptor[] | undefined,
  profileOauthConfig: OAuthConfig | undefined,
  tenantId: string,
): EffectiveTenantAuthContext {
  const inheritedAuthConfigs = getEffectiveAuth(tenantAuth, profileAuth);
  validateAuthMode(authMode, inheritedAuthConfigs, tenantId);
  const authConfigs = filterAuthConfigsByMode(authMode, inheritedAuthConfigs);
  const oauthConfig = authMode === 'oauth'
    ? authConfigs.find((config) => config.type === 'oauth')?.oauth_config || profileOauthConfig
    : undefined;

  if (authMode === 'oauth' && !oauthConfig) {
    throw new ValidationError(`Tenant '${tenantId}' requires oauth auth_mode but no oauth configuration is available.`);
  }

  return { authConfigs, oauthConfig };
}

function buildResolvedContext(
  tenant: HttpTenantsConfig['tenants'][number],
  profileContext: HttpProfileContext,
): ResolvedTenantContext {
  if (!TENANT_ID_REGEX.test(tenant.tenant_id)) {
    throw new ValidationError(`Invalid tenant_id '${tenant.tenant_id}'.`);
  }

  const effectiveAuthContext = resolveEffectiveTenantAuthContext(
    tenant.auth_mode,
    tenant.auth,
    profileContext.authConfigs,
    profileContext.oauthConfig,
    tenant.tenant_id,
  );

  return {
    tenantId: tenant.tenant_id,
    tenantBaseUrl: normalizeBaseUrl(tenant.api_base_url),
    tenantAuthMode: tenant.auth_mode,
    tenantAuthConfigs: effectiveAuthContext.authConfigs,
    tenantOAuthConfig: tenant.auth_mode === 'oauth' ? effectiveAuthContext.oauthConfig : undefined,
  };
}

function authFingerprint(authConfigs: AuthInterceptor[]): string {
  return JSON.stringify(authConfigs.map((entry) => ({
    type: entry.type,
    header_name: entry.header_name,
    value_from_env: entry.value_from_env,
    priority: entry.priority,
    validation_endpoint: entry.validation_endpoint,
    oauth_config: entry.type === 'oauth' ? entry.oauth_config : undefined,
  })));
}

export function loadRawTenantsConfigFromEnv(): HttpTenantsConfig | null {
  const filePath = process.env.MCP4_HTTP_TENANTS_FILE;
  const inlineJson = process.env.MCP4_HTTP_TENANTS_JSON;

  if (filePath) {
    const content = fs.readFileSync(filePath, 'utf8');
    return parseTenantsJson(content);
  }

  if (inlineJson) {
    return parseTenantsJson(inlineJson);
  }

  return null;
}

export function buildTenantIndexForProfile(
  rawConfig: HttpTenantsConfig | null,
  profileContext: HttpProfileContext,
  logger: Logger,
): HttpTenantIndex {
  if (!rawConfig) {
    return {
      enabled: false,
      byTenantId: new Map(),
      byBaseUrl: new Map(),
    };
  }

  const byTenantId = new Map<string, ResolvedTenantContext>();
  const byBaseUrl = new Map<string, ResolvedTenantContext>();
  let defaultTenantId: string | undefined;

  for (let i = 0; i < rawConfig.tenants.length; i += 1) {
    const tenant = rawConfig.tenants[i];
    const resolved = buildResolvedContext(tenant, profileContext);

    if (byTenantId.has(resolved.tenantId)) {
      throw new ValidationError(`Duplicate tenant_id '${resolved.tenantId}'.`);
    }

    if (tenant.default === true) {
      if (defaultTenantId) {
        throw new ValidationError('Only one tenant can be marked as default.');
      }
      defaultTenantId = resolved.tenantId;
    }

    const existingByBaseUrl = byBaseUrl.get(resolved.tenantBaseUrl);
    if (existingByBaseUrl) {
      const sameAuth = authFingerprint(existingByBaseUrl.tenantAuthConfigs) === authFingerprint(resolved.tenantAuthConfigs);
      if (!sameAuth || existingByBaseUrl.tenantAuthMode !== resolved.tenantAuthMode) {
        throw new ValidationError(
          `Tenant base URL collision for '${resolved.tenantBaseUrl}' with different auth configuration (${existingByBaseUrl.tenantId}, ${resolved.tenantId}).`
        );
      }
      logger.warn('Multiple tenants share the same api_base_url and auth config', {
        profileId: profileContext.profileId,
        tenantIds: [existingByBaseUrl.tenantId, resolved.tenantId],
      });
    }

    byTenantId.set(resolved.tenantId, resolved);
    if (!existingByBaseUrl) {
      byBaseUrl.set(resolved.tenantBaseUrl, resolved);
    }
  }

  if (!defaultTenantId && rawConfig.tenants.length > 0) {
    defaultTenantId = rawConfig.tenants[0].tenant_id;
    logger.warn('No default tenant configured, using first tenant as fallback.', {
      profileId: profileContext.profileId,
      tenantId: defaultTenantId,
    });
  }

  return {
    enabled: true,
    defaultTenantId,
    byTenantId,
    byBaseUrl,
  };
}

export function resolveTenantFromHeaders(
  tenantIndex: HttpTenantIndex,
  tenantIdHeader: string | undefined,
  tenantBaseUrlHeader: string | undefined,
): ResolvedTenantContext | null {
  if (!tenantIndex.enabled) {
    return null;
  }

  const byId = tenantIdHeader ? tenantIndex.byTenantId.get(tenantIdHeader) : undefined;
  const byBaseUrl = tenantBaseUrlHeader
    ? tenantIndex.byBaseUrl.get(normalizeBaseUrl(tenantBaseUrlHeader))
    : undefined;

  if (tenantIdHeader && !byId) {
    throw new ValidationError(`Unknown tenant id '${tenantIdHeader}'.`);
  }

  if (tenantBaseUrlHeader && !byBaseUrl) {
    throw new ValidationError('Unknown tenant base URL selector.');
  }

  if (byId && byBaseUrl && byId.tenantId !== byBaseUrl.tenantId) {
    throw new ValidationError('Tenant selector headers mismatch.');
  }

  const selected = byId || byBaseUrl;
  if (selected) {
    return selected;
  }

  if (!tenantIndex.defaultTenantId) {
    throw new ValidationError('Tenant selector is required because no default tenant is configured.');
  }

  return tenantIndex.byTenantId.get(tenantIndex.defaultTenantId) || null;
}
