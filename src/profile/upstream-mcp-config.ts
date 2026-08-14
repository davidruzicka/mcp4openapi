import { ValidationError } from '../core/errors.js';
import type { Logger } from '../core/logger.js';
import { upstreamMcpServerConfigSchema } from '../generated-schemas.js';
import type {
  Profile,
  UpstreamMcpAuthConfig,
  UpstreamMcpServerConfig,
  UpstreamMcpToolPolicy,
} from '../types/profile.js';
import { isSafePropertyName, isUri, isValidHttpHeaderName } from '../validation/validation-utils.js';

type EnvSource = NodeJS.ProcessEnv;

const UPSTREAM_TOOL_PREFIX_PATTERN = /^[A-Za-z0-9._-]+$/;
const UPSTREAM_ALLOWED_TRANSPORT_TYPES = new Set(['http-streamable']);
const UPSTREAM_ALLOWED_AUTH_TYPES = new Set(['bearer', 'query', 'custom-header']);

function getTrimmedEnvReference(reference: string | undefined, path: string): string | undefined {
  if (reference === undefined) {
    return undefined;
  }

  const trimmed = reference.trim();
  if (!trimmed) {
    throw new ValidationError(`${path} must not be empty`, { path });
  }

  return trimmed;
}

export const UPSTREAM_MCP_ARRAY_REJECTION_MESSAGE =
  'upstream_mcp must be a JSON object, not an array';

function parseUpstreamMcpJson(rawValue: string, path: string): UpstreamMcpServerConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawValue);
  } catch {
    throw new ValidationError(`${path} must contain valid JSON`, { path });
  }

  if (Array.isArray(parsed)) {
    throw new ValidationError(UPSTREAM_MCP_ARRAY_REJECTION_MESSAGE, { path });
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw new ValidationError(`${path} must contain a JSON object`, { path });
  }

  const result = upstreamMcpServerConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    const fieldPath = issue?.path.length ? `${path}.${issue.path.join('.')}` : path;
    throw new ValidationError(
      `${fieldPath}: ${issue?.message ?? 'invalid upstream MCP provider'}`,
      { path: fieldPath },
    );
  }
  return result.data;
}

function resolveUpstreamMcpFromEnv(profile: Profile, env: EnvSource): UpstreamMcpServerConfig | undefined {
  const envVarName = getTrimmedEnvReference(profile.upstream_mcp_from_env, 'upstream_mcp_from_env');
  if (!envVarName) {
    return undefined;
  }

  const rawValue = env[envVarName];
  if (rawValue === undefined || rawValue.trim() === '') {
    return undefined;
  }

  return parseUpstreamMcpJson(rawValue, 'upstream_mcp');
}

export interface EffectiveUpstreamOrigin {
  /** Scheme and authority of the effective upstream endpoint, without path or query. */
  origin: string;
  /** True when an environment override supplied the endpoint instead of the profile. */
  fromEnvOverride: boolean;
  /** Name of the environment variable the profile reads the override from, when declared. */
  envVarName?: string;
}

/**
 * Describe where upstream traffic will actually go, for the startup info log.
 *
 * The off-origin override warning is NOT derived from this: it is emitted by
 * `warnOnOffOriginOverride` during `resolveUpstreamMcpConfig`, where the static
 * profile endpoint is still available for comparison.
 */
export function describeEffectiveUpstreamOrigin(
  profile: Profile,
  env: EnvSource = process.env,
): EffectiveUpstreamOrigin | undefined {
  const envVarName = getTrimmedEnvReference(profile.upstream_mcp_from_env, 'upstream_mcp_from_env');
  const fromEnv = resolveUpstreamMcpFromEnv(profile, env);
  const effective = fromEnv ?? profile.upstream_mcp;
  if (!effective) return undefined;

  const origin = safeOrigin(effective.transport?.url);
  if (!origin) return undefined;

  return {
    origin,
    fromEnvOverride: fromEnv !== undefined,
    envVarName: envVarName ?? undefined,
  };
}

/** Origin of a URL, or undefined when it is absent or unparseable. */
function safeOrigin(urlValue: string | undefined): string | undefined {
  if (!urlValue?.trim()) return undefined;
  try {
    return new URL(urlValue.trim()).origin;
  } catch {
    return undefined;
  }
}

function validateToolPolicyList(values: string[] | undefined, path: string): void {
  if (values === undefined) {
    return;
  }

  if (values.length === 0) {
    throw new ValidationError(`${path} must contain at least one tool pattern`, { path });
  }

  values.forEach((value, index) => {
    if (!value.trim()) {
      throw new ValidationError(`${path}[${index}] must not be empty`, { path: `${path}[${index}]` });
    }
  });
}

function validateToolPolicy(policy: UpstreamMcpToolPolicy | undefined, path: string): void {
  if (!policy) {
    return;
  }

  validateToolPolicyList(policy.allow, `${path}.allow`);
  validateToolPolicyList(policy.deny, `${path}.deny`);
}

function validateEnvironmentToolPolicy(
  staticPolicy: UpstreamMcpToolPolicy | undefined,
  environmentPolicy: UpstreamMcpToolPolicy | undefined,
): void {
  if (!staticPolicy?.allow?.length && !staticPolicy?.deny?.length) {
    return;
  }

  if (!environmentPolicy) {
    throw new ValidationError(
      'upstream_mcp_from_env cannot broaden the static upstream_mcp.tools policy: tools policy is required',
      { path: 'upstream_mcp_from_env' },
    );
  }

  const staticAllow = new Set(staticPolicy.allow?.map((value) => value.trim()));
  if (staticAllow.size > 0) {
    const environmentAllow = environmentPolicy.allow?.map((value) => value.trim());
    if (!environmentAllow?.length || environmentAllow.some((pattern) => !staticAllow.has(pattern))) {
      throw new ValidationError(
        'upstream_mcp_from_env cannot broaden the static upstream_mcp.tools policy: allow patterns must remain within the static allow-list',
        { path: 'upstream_mcp_from_env' },
      );
    }
  }

  const staticDeny = staticPolicy.deny?.map((value) => value.trim()) ?? [];
  const environmentDeny = new Set(environmentPolicy.deny?.map((value) => value.trim()));
  if (staticDeny.some((pattern) => !environmentDeny.has(pattern))) {
    throw new ValidationError(
      'upstream_mcp_from_env cannot broaden the static upstream_mcp.tools policy: deny patterns must be retained',
      { path: 'upstream_mcp_from_env' },
    );
  }
}

/**
 * Description policies default to the strictest value in mcp-server.ts when omitted,
 * so an omitted override hardens, and any explicit env value weaker than the static
 * value (per the strictness ranks below) is rejected.
 */
const DESCRIPTION_POLICY_DEFAULT = 'drop';

type DescriptionPolicyField = 'html_description_policy' | 'tool_description_length_policy';

/** Higher rank = stricter. An env value with a lower rank than the static value is a downgrade. */
const DESCRIPTION_POLICY_STRICTNESS: Record<DescriptionPolicyField, Record<string, number>> = {
  html_description_policy: { drop: 2, strip: 1, allow: 0 },
  tool_description_length_policy: { drop: 2, truncate: 1, allow: 0 },
};

function rejectDescriptionPolicyDowngrade(field: DescriptionPolicyField): EnvironmentOverrideCheck {
  return (staticUpstream, environmentUpstream) => {
    const environmentValue = environmentUpstream[field];
    if (environmentValue === undefined) {
      return;
    }

    const ranks = DESCRIPTION_POLICY_STRICTNESS[field];
    const staticValue = staticUpstream?.[field] ?? DESCRIPTION_POLICY_DEFAULT;
    if (ranks[environmentValue] >= ranks[staticValue]) {
      return;
    }

    throw new ValidationError(
      `upstream_mcp_from_env cannot weaken the static upstream_mcp.${field}: ${environmentValue} is less strict than ${staticValue}`,
      { path: 'upstream_mcp_from_env' },
    );
  };
}

type EnvironmentOverrideCheck = (
  staticUpstream: UpstreamMcpServerConfig | undefined,
  environmentUpstream: UpstreamMcpServerConfig,
) => void;

/**
 * Declarative no-weakening rules applied to an environment override.
 *
 * Guarded fields: the tools allow/deny policy and both description policies,
 * because those bound what an upstream can expose to the model. All other
 * fields (transport/url, auth, timeout_ms, tool_prefix, validation_*) are
 * intentionally NOT guarded: deployment env vars are set by the administrator
 * and legitimately vary per environment (staging endpoints, proxies, timeouts).
 */
const ENVIRONMENT_OVERRIDE_RULES: readonly EnvironmentOverrideCheck[] = [
  (staticUpstream, environmentUpstream) => {
    validateToolPolicy(staticUpstream?.tools, 'upstream_mcp.tools');
    validateEnvironmentToolPolicy(staticUpstream?.tools, environmentUpstream.tools);
  },
  rejectDescriptionPolicyDowngrade('html_description_policy'),
  rejectDescriptionPolicyDowngrade('tool_description_length_policy'),
];

function validateEnvironmentOverride(
  staticUpstream: UpstreamMcpServerConfig | undefined,
  environmentUpstream: UpstreamMcpServerConfig,
): void {
  for (const check of ENVIRONMENT_OVERRIDE_RULES) {
    check(staticUpstream, environmentUpstream);
  }
}

/**
 * Warn when an environment override points at a different origin than the
 * static profile endpoint. This must happen at resolution time: the loader
 * overwrites `profile.upstream_mcp` with the resolved config, so a later
 * static-vs-effective comparison would compare the override against itself.
 *
 * An off-origin override is a legitimate deployment case (staging, an egress
 * proxy), so it is deliberately NOT rejected. It is surfaced because the
 * override lives outside git and outside code review: a copied or stale value
 * would otherwise redirect the connection silently.
 */
function warnOnOffOriginOverride(
  profile: Profile,
  environmentUpstream: UpstreamMcpServerConfig,
  logger: Pick<Logger, 'warn'> | undefined,
): void {
  if (!logger) return;
  const staticOrigin = safeOrigin(profile.upstream_mcp?.transport?.url);
  const overrideOrigin = safeOrigin(environmentUpstream.transport?.url);
  if (staticOrigin === undefined || overrideOrigin === undefined || staticOrigin === overrideOrigin) {
    return;
  }
  logger.warn('Upstream MCP endpoint overridden to a different origin by the environment', {
    profile: profile.profile_name,
    staticOrigin,
    overrideOrigin,
    envVarName: profile.upstream_mcp_from_env?.trim(),
  });
}

function validateUpstreamAuth(auth: UpstreamMcpAuthConfig | undefined, path: string): void {
  if (!auth) {
    return;
  }

  if (!UPSTREAM_ALLOWED_AUTH_TYPES.has(auth.type)) {
    throw new ValidationError(
      `${path}.type must be one of: bearer, query, custom-header`,
      { path: `${path}.type`, type: auth.type },
    );
  }

  if (auth.value_from_env !== undefined && !auth.value_from_env.trim()) {
    throw new ValidationError(`${path}.value_from_env must not be empty when provided`, { path: `${path}.value_from_env` });
  }

  if (auth.type === 'custom-header') {
    if (!auth.header_name?.trim()) {
      throw new ValidationError(`${path}.header_name is required for custom-header auth`, { path: `${path}.header_name` });
    }
    if (!isSafePropertyName(auth.header_name)) {
      throw new ValidationError(`${path}.header_name contains invalid header name ${JSON.stringify(auth.header_name)}`, {
        path: `${path}.header_name`,
        headerName: auth.header_name,
      });
    }
    if (!isValidHttpHeaderName(auth.header_name)) {
      throw new ValidationError(
        `${path}.header_name must be a valid HTTP header field-name (RFC7230 token); got ${JSON.stringify(auth.header_name)}`,
        { path: `${path}.header_name`, headerName: auth.header_name },
      );
    }
  }

  if (auth.type === 'query' && !auth.query_param?.trim()) {
    throw new ValidationError(`${path}.query_param is required for query auth`, { path: `${path}.query_param` });
  }
}

function validateUpstreamUrl(urlValue: string, path: string): void {
  if (!urlValue.trim()) {
    throw new ValidationError(`${path} must not be empty`, { path });
  }

  if (!isUri(urlValue)) {
    throw new ValidationError(`${path} must be a valid absolute URL`, { path });
  }

  const parsedUrl = new URL(urlValue);
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new ValidationError(`${path} must use http or https`, { path, protocol: parsedUrl.protocol });
  }

  if (parsedUrl.username || parsedUrl.password) {
    throw new ValidationError(`${path} must not include inline credentials`, { path });
  }

  if (parsedUrl.hash) {
    throw new ValidationError(`${path} must not include a URL fragment`, { path });
  }
}

function validateUpstreamProvider(provider: UpstreamMcpServerConfig): void {
  const path = 'upstream_mcp';

  if (!provider.name.trim()) {
    throw new ValidationError(`${path}.name must not be empty`, { path: `${path}.name` });
  }

  if (!provider.transport || typeof provider.transport !== 'object') {
    throw new ValidationError(`${path}.transport is required`, { path: `${path}.transport` });
  }

  if (!UPSTREAM_ALLOWED_TRANSPORT_TYPES.has(provider.transport.type)) {
    throw new ValidationError(
      `${path}.transport.type must be 'http-streamable'. stdio upstreams are not supported in this iteration`,
      { path: `${path}.transport.type`, type: provider.transport.type },
    );
  }

  validateUpstreamUrl(provider.transport.url, `${path}.transport.url`);
  validateUpstreamAuth(provider.auth, `${path}.auth`);
  validateToolPolicy(provider.tools, `${path}.tools`);

  if (provider.timeout_ms !== undefined && (!Number.isInteger(provider.timeout_ms) || provider.timeout_ms <= 0)) {
    throw new ValidationError(`${path}.timeout_ms must be a positive integer`, {
      path: `${path}.timeout_ms`,
      value: provider.timeout_ms,
    });
  }

  if (provider.validation_endpoint !== undefined) {
    validateUpstreamUrl(provider.validation_endpoint, `${path}.validation_endpoint`);
  }

  if (provider.validation_timeout_ms !== undefined && (!Number.isInteger(provider.validation_timeout_ms) || provider.validation_timeout_ms <= 0)) {
    throw new ValidationError(`${path}.validation_timeout_ms must be a positive integer`, {
      path: `${path}.validation_timeout_ms`,
      value: provider.validation_timeout_ms,
    });
  }

  if (provider.tool_prefix !== undefined) {
    if (!provider.tool_prefix.trim()) {
      throw new ValidationError(`${path}.tool_prefix must not be empty`, { path: `${path}.tool_prefix` });
    }
    if (!UPSTREAM_TOOL_PREFIX_PATTERN.test(provider.tool_prefix)) {
      throw new ValidationError(
        `${path}.tool_prefix may only contain letters, numbers, dots, underscores, and hyphens`,
        { path: `${path}.tool_prefix`, value: provider.tool_prefix },
      );
    }
  }
}

/**
 * Returns true only when the raw value looks like a valid upstream MCP proxy config —
 * requires at minimum a transport object with type='http-streamable' and a non-empty url.
 * Use this as the gate for suppressing the openapi_spec_path requirement in resolveSpecPath.
 * Contrast with hasUpstreamMcpFlag (loose, for list-view display only).
 */
export function looksLikeUpstreamMcpProxy(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  const transport = v.transport;
  if (!transport || typeof transport !== 'object' || Array.isArray(transport)) return false;
  const t = transport as Record<string, unknown>;
  return t.type === 'http-streamable' && typeof t.url === 'string' && t.url.trim().length > 0;
}

// MIGRATION-CLEANUP(phase-03.1): remove this function and all its callers once
// all deployed profiles have been migrated to singular upstream_mcp object.
// Cleanup sites (must all be removed together):
//   1. This function (hasUpstreamMcpFlag)
//   2. Array.isArray branch in profile-resolver.ts extractEnvVars
//   3. UPSTREAM_MCP_ARRAY_REJECTION_MESSAGE export + its import in profile-loader.ts
// Removal: grep -rn "MIGRATION-CLEANUP(phase-03.1)" src/ — 3 code sites.
/**
 * Returns true if the raw profile.upstream_mcp value indicates an upstream MCP
 * provider is configured. Tolerates BOTH the legacy array shape and the post
 * phase-03.1 singular-object shape so list-view UX still flags un-migrated
 * profiles as "uses upstream MCP" until the user opens them and gets the
 * migration error from Zod (see CONTEXT.md D-03).
 */
export function hasUpstreamMcpFlag(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  return value !== null && typeof value === 'object';
}

export function resolveUpstreamMcpConfig(
  profile: Profile,
  env: EnvSource = process.env,
  logger?: Pick<Logger, 'warn'>,
): UpstreamMcpServerConfig | undefined {
  const envResolved = resolveUpstreamMcpFromEnv(profile, env);
  if (envResolved) {
    validateEnvironmentOverride(profile.upstream_mcp, envResolved);
    warnOnOffOriginOverride(profile, envResolved, logger);
  }
  const provider = envResolved ?? profile.upstream_mcp;
  if (!provider) return undefined;

  validateUpstreamProvider(provider);

  return {
    ...provider,
    name: provider.name.trim(),
    tool_prefix: provider.tool_prefix?.trim(),
    auth: provider.auth ? {
      ...provider.auth,
      value_from_env: provider.auth.value_from_env?.trim(),
      header_name: provider.auth.header_name?.trim(),
      query_param: provider.auth.query_param?.trim(),
    } : undefined,
    tools: provider.tools ? {
      allow: provider.tools.allow?.map((value) => value.trim()),
      deny: provider.tools.deny?.map((value) => value.trim()),
    } : undefined,
    transport: {
      ...provider.transport,
      url: provider.transport.url.trim(),
    },
  };
}
