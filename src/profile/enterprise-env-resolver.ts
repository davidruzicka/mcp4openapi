import { EnterpriseAuthorizationConfigurationError } from '../core/errors.js';
import type {
  EnterpriseAccessPolicyConfig,
  EnterpriseAuthorizationConfig,
  EnterpriseIssuerConfig,
} from '../types/profile.js';

const ENTERPRISE_ALLOWED_ALGS = new Set(['RS256', 'RS384', 'RS512', 'ES256', 'ES384', 'ES512']);
const ENTERPRISE_ALLOWED_TOOL_CATEGORIES = new Set(['list', 'read', 'modify', 'admin']);
const ENTERPRISE_ALLOWED_MODES = new Set(['required', 'optional']);
const ENTERPRISE_ALLOWED_CLAIM_MAPPING_KEYS = new Set(['subject', 'email', 'groups', 'tenant_id', 'client_id']);

type EnvSource = NodeJS.ProcessEnv;

function getEnvVarName(reference: string | undefined, path: string): string | undefined {
  if (reference === undefined) {
    return undefined;
  }

  const envVarName = reference.trim();
  if (!envVarName) {
    throw new EnterpriseAuthorizationConfigurationError(`${path} must not be empty`);
  }

  return envVarName;
}

function getEnvValue(env: EnvSource, reference: string | undefined, path: string): string | undefined {
  const envVarName = getEnvVarName(reference, path);
  if (!envVarName) {
    return undefined;
  }

  const rawValue = env[envVarName];
  if (rawValue === undefined) {
    return undefined;
  }

  const trimmed = rawValue.trim();
  return trimmed ? trimmed : undefined;
}

function parseCsvEnvValue(rawValue: string, envVarName: string): string[] {
  const values = rawValue
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  if (values.length === 0) {
    throw new EnterpriseAuthorizationConfigurationError(`${envVarName} must contain at least one value`, {
      envVarName,
    });
  }

  return values;
}

function resolveMode(
  config: EnterpriseAuthorizationConfig,
  env: EnvSource,
): EnterpriseAuthorizationConfig['mode'] {
  const envVarName = getEnvVarName(config.mode_from_env, 'enterprise_authorization.mode_from_env');
  const envValue = envVarName ? getEnvValue(env, envVarName, 'enterprise_authorization.mode_from_env') : undefined;
  if (envValue === undefined) {
    return config.mode;
  }
  if (!ENTERPRISE_ALLOWED_MODES.has(envValue)) {
    throw new EnterpriseAuthorizationConfigurationError(`${envVarName} must be one of: required, optional`, {
      envVarName,
    });
  }
  return envValue as EnterpriseAuthorizationConfig['mode'];
}

function resolveAudience(
  config: EnterpriseAuthorizationConfig,
  env: EnvSource,
): EnterpriseAuthorizationConfig['audience'] {
  const envVarName = getEnvVarName(config.audience_from_env, 'enterprise_authorization.audience_from_env');
  const envValue = envVarName ? getEnvValue(env, envVarName, 'enterprise_authorization.audience_from_env') : undefined;
  if (envValue === undefined) {
    return Array.isArray(config.audience) ? [...config.audience] : config.audience;
  }

  const audiences = parseCsvEnvValue(envValue, envVarName!);
  return audiences.length === 1 ? audiences[0] : audiences;
}

function resolveIssuer(
  issuer: EnterpriseIssuerConfig,
  env: EnvSource,
): EnterpriseIssuerConfig {
  const resolvedIssuer = getEnvValue(env, issuer.issuer_from_env, 'enterprise_authorization.issuer.issuer_from_env') ?? issuer.issuer;
  if (!resolvedIssuer) {
    throw new EnterpriseAuthorizationConfigurationError(
      'enterprise_authorization.issuer.issuer is required or must resolve from issuer_from_env',
    );
  }

  const resolvedJwksUri = getEnvValue(env, issuer.jwks_uri_from_env, 'enterprise_authorization.issuer.jwks_uri_from_env')
    ?? issuer.jwks_uri;
  const envVarName = getEnvVarName(issuer.allowed_algs_from_env, 'enterprise_authorization.issuer.allowed_algs_from_env');
  const envValue = envVarName ? getEnvValue(env, envVarName, 'enterprise_authorization.issuer.allowed_algs_from_env') : undefined;
  const resolvedAllowedAlgs = envValue === undefined
    ? issuer.allowed_algs ? [...issuer.allowed_algs] : undefined
    : parseCsvEnvValue(envValue, envVarName!).map((alg) => {
      if (!ENTERPRISE_ALLOWED_ALGS.has(alg)) {
        throw new EnterpriseAuthorizationConfigurationError(
          `${envVarName} contains unsupported algorithm '${alg}'`,
          { envVarName },
        );
      }
      return alg as NonNullable<EnterpriseIssuerConfig['allowed_algs']>[number];
    });

  return {
    ...issuer,
    issuer: resolvedIssuer,
    jwks_uri: resolvedJwksUri,
    allowed_algs: resolvedAllowedAlgs,
  };
}

function resolveClaimMappings(
  accessPolicy: EnterpriseAccessPolicyConfig,
  env: EnvSource,
): EnterpriseAccessPolicyConfig['claim_mappings'] {
  const envVarName = getEnvVarName(
    accessPolicy.claim_mappings_from_env,
    'enterprise_authorization.access_policy.claim_mappings_from_env',
  );
  const envValue = envVarName
    ? getEnvValue(env, envVarName, 'enterprise_authorization.access_policy.claim_mappings_from_env')
    : undefined;

  if (envValue === undefined) {
    return accessPolicy.claim_mappings ? { ...accessPolicy.claim_mappings } : undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(envValue);
  } catch {
    throw new EnterpriseAuthorizationConfigurationError(`${envVarName} must be valid JSON`, { envVarName });
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new EnterpriseAuthorizationConfigurationError(`${envVarName} must be a JSON object`, { envVarName });
  }

  const mappingsEntries = Object.entries(parsed);
  for (const [key, value] of mappingsEntries) {
    if (!ENTERPRISE_ALLOWED_CLAIM_MAPPING_KEYS.has(key)) {
      throw new EnterpriseAuthorizationConfigurationError(
        `${envVarName} contains unsupported claim mapping key '${key}'`,
        { envVarName },
      );
    }
    if (typeof value !== 'string' || !value.trim()) {
      throw new EnterpriseAuthorizationConfigurationError(
        `${envVarName}.${key} must be a non-empty string`,
        { envVarName },
      );
    }
  }

  return Object.fromEntries(mappingsEntries) as NonNullable<EnterpriseAccessPolicyConfig['claim_mappings']>;
}

function resolveStringArrayFromEnv<T extends string>(
  currentValue: T[] | undefined,
  reference: string | undefined,
  path: string,
  env: EnvSource,
  allowedValues?: ReadonlySet<string>,
): T[] | undefined {
  const envVarName = getEnvVarName(reference, path);
  const envValue = envVarName ? getEnvValue(env, envVarName, path) : undefined;
  if (envValue === undefined) {
    return currentValue ? [...currentValue] : undefined;
  }

  return parseCsvEnvValue(envValue, envVarName!).map((value) => {
    if (allowedValues && !allowedValues.has(value)) {
      throw new EnterpriseAuthorizationConfigurationError(
        `${envVarName} contains unsupported value '${value}'`,
        { envVarName },
      );
    }
    return value as T;
  });
}

function resolveAccessPolicy(
  accessPolicy: EnterpriseAccessPolicyConfig | undefined,
  env: EnvSource,
): EnterpriseAccessPolicyConfig | undefined {
  if (!accessPolicy) {
    return undefined;
  }

  return {
    ...accessPolicy,
    claim_mappings: resolveClaimMappings(accessPolicy, env),
    default_scopes: resolveStringArrayFromEnv(
      accessPolicy.default_scopes,
      accessPolicy.default_scopes_from_env,
      'enterprise_authorization.access_policy.default_scopes_from_env',
      env,
    ),
    required_scopes: resolveStringArrayFromEnv(
      accessPolicy.required_scopes,
      accessPolicy.required_scopes_from_env,
      'enterprise_authorization.access_policy.required_scopes_from_env',
      env,
    ),
    allowed_tool_categories: resolveStringArrayFromEnv(
      accessPolicy.allowed_tool_categories,
      accessPolicy.allowed_tool_categories_from_env,
      'enterprise_authorization.access_policy.allowed_tool_categories_from_env',
      env,
      ENTERPRISE_ALLOWED_TOOL_CATEGORIES,
    ) as EnterpriseAccessPolicyConfig['allowed_tool_categories'],
  };
}

export function resolveEnterpriseAuthorizationEnv(
  config: EnterpriseAuthorizationConfig,
  env: EnvSource = process.env,
): EnterpriseAuthorizationConfig {
  if (!config.enabled) {
    return { ...config, enabled: false };
  }

  return {
    ...config,
    mode: resolveMode(config, env),
    audience: resolveAudience(config, env),
    issuer: resolveIssuer(config.issuer, env),
    access_policy: resolveAccessPolicy(config.access_policy, env),
  };
}
