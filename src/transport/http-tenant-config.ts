import fs from 'fs';
import type { Logger } from '../core/logger.js';
import { ConfigurationError, ValidationError } from '../core/errors.js';
import type { AuthInterceptor, OAuthConfig } from '../types/profile.js';
import type {
  HttpTenantIndex,
  HttpTenantsConfig,
  ResolvedTenantContext,
  TenantAuthMode,
  TenantMaskSelector,
  TenantMaskSelectorEntry,
  TenantSelectorType,
} from '../types/http-tenants.js';
import type { HttpProfileContext } from '../types/http-transport.js';

const TENANT_ID_REGEX = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const TENANT_MASK_PREFIX = 'mask:';
const TENANT_MASK_HOST_LABEL_REGEX = /^[a-z0-9-]+$/;

interface ExactTenantSelector {
  type: 'exact';
  normalizedBaseUrl: string;
}

interface MaskTenantSelector {
  type: 'mask';
  selector: TenantMaskSelector;
}

type ParsedTenantSelector = ExactTenantSelector | MaskTenantSelector;

interface BuiltTenantContext {
  resolved: ResolvedTenantContext;
  selectorType: TenantSelectorType;
  maskSelector?: TenantMaskSelector;
}

function normalizePath(pathname: string): string {
  if (pathname === '/') {
    return '';
  }
  return pathname.replace(/\/$/, '');
}

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

  if (url.search || url.hash) {
    throw new ValidationError('Tenant api_base_url must not contain query or fragment.');
  }

  const allowHttp = process.env.MCP4_HTTP_TENANTS_ALLOW_HTTP === 'true';
  if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) {
    throw new ValidationError('Tenant api_base_url must use https unless MCP4_HTTP_TENANTS_ALLOW_HTTP=true.');
  }

  return url.toString().replace(/\/$/, '');
}

function parseTenantMaskSelector(rawValue: string): TenantMaskSelector {
  let url: URL;
  try {
    url = new URL(rawValue);
  } catch {
    throw new ValidationError(`Invalid tenant api_base_url: '${TENANT_MASK_PREFIX}${rawValue}'`);
  }

  if (url.username || url.password) {
    throw new ValidationError('Tenant api_base_url must not contain credentials.');
  }

  if (url.search || url.hash) {
    throw new ValidationError('Tenant api_base_url must not contain query or fragment.');
  }

  const allowHttp = process.env.MCP4_HTTP_TENANTS_ALLOW_HTTP === 'true';
  if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) {
    throw new ValidationError('Tenant api_base_url must use https unless MCP4_HTTP_TENANTS_ALLOW_HTTP=true.');
  }

  const hostLabels = url.hostname.toLowerCase().split('.');
  if (hostLabels.length === 0) {
    throw new ValidationError(`Invalid tenant mask host in api_base_url: '${TENANT_MASK_PREFIX}${rawValue}'`);
  }
  for (const label of hostLabels) {
    if (label === '*') {
      continue;
    }
    if (!TENANT_MASK_HOST_LABEL_REGEX.test(label)) {
      throw new ValidationError(`Invalid tenant mask host label '${label}' in api_base_url.`);
    }
  }

  if (url.pathname.includes('*')) {
    throw new ValidationError('Tenant api_base_url mask path must be literal (wildcards are not allowed in path).');
  }

  const path = normalizePath(url.pathname);
  const normalizedHost = hostLabels.join('.');
  const port = url.port;
  const portPart = port ? `:${port}` : '';
  const normalizedMask = `${url.protocol}//${normalizedHost}${portPart}${path}`;

  return {
    original: rawValue,
    normalizedMask,
    scheme: url.protocol as 'http:' | 'https:',
    hostLabels,
    port,
    path,
  };
}

function parseTenantSelector(raw: string): ParsedTenantSelector {
  const trimmed = raw.trim();
  if (trimmed.startsWith(TENANT_MASK_PREFIX)) {
    const rawMask = trimmed.slice(TENANT_MASK_PREFIX.length).trim();
    if (!rawMask) {
      throw new ValidationError(`Invalid tenant api_base_url: '${raw}'`);
    }
    return {
      type: 'mask',
      selector: parseTenantMaskSelector(rawMask),
    };
  }

  return {
    type: 'exact',
    normalizedBaseUrl: normalizeBaseUrl(trimmed),
  };
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

function getEffectiveAuth(
  tenantAuth: AuthInterceptor | AuthInterceptor[] | undefined,
  profileAuth: AuthInterceptor[] | undefined,
): AuthInterceptor[] {
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
): BuiltTenantContext {
  if (!TENANT_ID_REGEX.test(tenant.tenant_id)) {
    throw new ValidationError(`Invalid tenant_id '${tenant.tenant_id}'.`);
  }

  const parsedSelector = parseTenantSelector(tenant.api_base_url);
  const effectiveAuthContext = resolveEffectiveTenantAuthContext(
    tenant.auth_mode,
    tenant.auth,
    profileContext.authConfigs,
    profileContext.oauthConfig,
    tenant.tenant_id,
  );

  if (parsedSelector.type === 'exact') {
    return {
      selectorType: 'exact',
      resolved: {
        tenantId: tenant.tenant_id,
        tenantBaseUrl: parsedSelector.normalizedBaseUrl,
        tenantAuthMode: tenant.auth_mode,
        tenantAuthConfigs: effectiveAuthContext.authConfigs,
        tenantOAuthConfig: tenant.auth_mode === 'oauth' ? effectiveAuthContext.oauthConfig : undefined,
        tenantSelectorType: 'exact',
        tenantSelectorValue: parsedSelector.normalizedBaseUrl,
      },
    };
  }

  return {
    selectorType: 'mask',
    maskSelector: parsedSelector.selector,
    resolved: {
      tenantId: tenant.tenant_id,
      tenantBaseUrl: parsedSelector.selector.normalizedMask,
      tenantAuthMode: tenant.auth_mode,
      tenantAuthConfigs: effectiveAuthContext.authConfigs,
      tenantOAuthConfig: tenant.auth_mode === 'oauth' ? effectiveAuthContext.oauthConfig : undefined,
      tenantSelectorType: 'mask',
      tenantSelectorValue: `${TENANT_MASK_PREFIX}${parsedSelector.selector.normalizedMask}`,
    },
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

function maskMatchesBaseUrl(selector: TenantMaskSelector, normalizedBaseUrl: string): boolean {
  let concrete: URL;
  try {
    concrete = new URL(normalizedBaseUrl);
  } catch {
    return false;
  }

  const concreteScheme = concrete.protocol as 'http:' | 'https:';
  const concretePort = concrete.port;
  const concretePath = normalizePath(concrete.pathname);
  const concreteLabels = concrete.hostname.toLowerCase().split('.');

  if (selector.scheme !== concreteScheme) {
    return false;
  }
  if (selector.port !== concretePort) {
    return false;
  }
  if (selector.path !== concretePath) {
    return false;
  }
  if (selector.hostLabels.length !== concreteLabels.length) {
    return false;
  }

  for (let index = 0; index < selector.hostLabels.length; index += 1) {
    const maskLabel = selector.hostLabels[index];
    const concreteLabel = concreteLabels[index];
    if (maskLabel !== '*' && maskLabel !== concreteLabel) {
      return false;
    }
  }

  return true;
}

function masksIntersect(left: TenantMaskSelector, right: TenantMaskSelector): boolean {
  if (left.scheme !== right.scheme) {
    return false;
  }
  if (left.port !== right.port) {
    return false;
  }
  if (left.path !== right.path) {
    return false;
  }
  if (left.hostLabels.length !== right.hostLabels.length) {
    return false;
  }

  for (let index = 0; index < left.hostLabels.length; index += 1) {
    const leftLabel = left.hostLabels[index];
    const rightLabel = right.hostLabels[index];
    if (leftLabel !== '*' && rightLabel !== '*' && leftLabel !== rightLabel) {
      return false;
    }
  }

  return true;
}

function cloneContextWithConcreteBaseUrl(context: ResolvedTenantContext, concreteBaseUrl: string): ResolvedTenantContext {
  return {
    ...context,
    tenantBaseUrl: concreteBaseUrl,
  };
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
      maskSelectors: [],
      selectorTypeByTenantId: new Map(),
    };
  }

  const byTenantId = new Map<string, ResolvedTenantContext>();
  const byBaseUrl = new Map<string, ResolvedTenantContext>();
  const maskSelectors: TenantMaskSelectorEntry[] = [];
  const selectorTypeByTenantId = new Map<string, TenantSelectorType>();
  let defaultTenantId: string | undefined;

  for (let i = 0; i < rawConfig.tenants.length; i += 1) {
    const tenant = rawConfig.tenants[i];
    const built = buildResolvedContext(tenant, profileContext);
    const resolved = built.resolved;

    if (byTenantId.has(resolved.tenantId)) {
      throw new ValidationError(`Duplicate tenant_id '${resolved.tenantId}'.`);
    }

    if (tenant.default === true) {
      if (defaultTenantId) {
        throw new ValidationError('Only one tenant can be marked as default.');
      }
      defaultTenantId = resolved.tenantId;
    }

    if (built.selectorType === 'exact') {
      const existingByBaseUrl = byBaseUrl.get(resolved.tenantBaseUrl);
      if (existingByBaseUrl) {
        const sameAuth = authFingerprint(existingByBaseUrl.tenantAuthConfigs) === authFingerprint(resolved.tenantAuthConfigs);
        if (!sameAuth || existingByBaseUrl.tenantAuthMode !== resolved.tenantAuthMode) {
          throw new ValidationError(
            `Tenant base URL collision for '${resolved.tenantBaseUrl}' with different auth configuration (${existingByBaseUrl.tenantId}, ${resolved.tenantId}).`,
          );
        }
        logger.warn('Multiple tenants share the same api_base_url and auth config', {
          profileId: profileContext.profileId,
          tenantIds: [existingByBaseUrl.tenantId, resolved.tenantId],
        });
      }

      for (const maskEntry of maskSelectors) {
        if (maskMatchesBaseUrl(maskEntry.selector, resolved.tenantBaseUrl)) {
          throw new ValidationError(
            `Tenant selector collision between exact '${resolved.tenantBaseUrl}' (${resolved.tenantId}) and mask '${maskEntry.context.tenantSelectorValue}' (${maskEntry.tenantId}).`,
          );
        }
      }

      byTenantId.set(resolved.tenantId, resolved);
      selectorTypeByTenantId.set(resolved.tenantId, 'exact');
      if (!existingByBaseUrl) {
        byBaseUrl.set(resolved.tenantBaseUrl, resolved);
      }
      continue;
    }

    const maskSelector = built.maskSelector!;

    for (const existing of byBaseUrl.values()) {
      if (maskMatchesBaseUrl(maskSelector, existing.tenantBaseUrl)) {
        throw new ValidationError(
          `Tenant selector collision between mask '${resolved.tenantSelectorValue}' (${resolved.tenantId}) and exact '${existing.tenantBaseUrl}' (${existing.tenantId}).`,
        );
      }
    }

    for (const existingMask of maskSelectors) {
      if (masksIntersect(existingMask.selector, maskSelector)) {
        throw new ValidationError(
          `Tenant selector collision between masks '${existingMask.context.tenantSelectorValue}' (${existingMask.tenantId}) and '${resolved.tenantSelectorValue}' (${resolved.tenantId}).`,
        );
      }
    }

    byTenantId.set(resolved.tenantId, resolved);
    selectorTypeByTenantId.set(resolved.tenantId, 'mask');
    maskSelectors.push({
      tenantId: resolved.tenantId,
      selector: maskSelector,
      context: resolved,
    });
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
    maskSelectors,
    selectorTypeByTenantId,
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
  const normalizedBaseUrlHeader = tenantBaseUrlHeader ? normalizeBaseUrl(tenantBaseUrlHeader) : undefined;
  const byExactBaseUrl = normalizedBaseUrlHeader ? tenantIndex.byBaseUrl.get(normalizedBaseUrlHeader) : undefined;
  const byMaskMatches = normalizedBaseUrlHeader && !byExactBaseUrl
    ? tenantIndex.maskSelectors
      .filter((entry) => maskMatchesBaseUrl(entry.selector, normalizedBaseUrlHeader))
      .map((entry) => cloneContextWithConcreteBaseUrl(entry.context, normalizedBaseUrlHeader))
    : [];
  const byMaskBaseUrl = byMaskMatches[0];
  const byBaseUrl = byExactBaseUrl || byMaskBaseUrl;

  if (tenantIdHeader && !byId) {
    throw new ValidationError(`Unknown tenant id '${tenantIdHeader}'.`);
  }

  if (byMaskMatches.length > 1) {
    throw new ValidationError('Tenant base URL selector is ambiguous.');
  }

  if (tenantBaseUrlHeader && !byBaseUrl) {
    throw new ValidationError('Unknown tenant base URL selector.');
  }

  if (byId) {
    const selectorType = tenantIndex.selectorTypeByTenantId.get(byId.tenantId) || byId.tenantSelectorType;
    if (selectorType === 'mask' && !normalizedBaseUrlHeader) {
      throw new ValidationError(`Tenant '${byId.tenantId}' requires X-Mcp4-Api-Base-Url header for mask selector.`);
    }

    if (byBaseUrl && byId.tenantId !== byBaseUrl.tenantId) {
      throw new ValidationError('Tenant selector headers mismatch.');
    }

    if (selectorType === 'mask') {
      if (!byBaseUrl) {
        throw new ValidationError('Unknown tenant base URL selector.');
      }
      return byBaseUrl;
    }

    return byId;
  }

  if (byBaseUrl) {
    return byBaseUrl;
  }

  if (!tenantIndex.defaultTenantId) {
    throw new ValidationError('Tenant selector is required because no default tenant is configured.');
  }

  const fallback = tenantIndex.byTenantId.get(tenantIndex.defaultTenantId) || null;
  if (!fallback) {
    return null;
  }

  const fallbackType = tenantIndex.selectorTypeByTenantId.get(fallback.tenantId) || fallback.tenantSelectorType;
  if (fallbackType === 'mask') {
    throw new ValidationError(
      `Tenant selector is required because default tenant '${fallback.tenantId}' uses mask selector.`,
    );
  }

  return fallback;
}
