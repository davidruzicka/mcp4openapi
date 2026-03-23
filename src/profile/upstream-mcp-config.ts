import { ValidationError } from '../core/errors.js';
import type {
  Profile,
  UpstreamMcpAuthConfig,
  UpstreamMcpServerConfig,
  UpstreamMcpToolPolicy,
} from '../types/profile.js';
import { isSafePropertyName, isUri } from '../validation/validation-utils.js';

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

function parseUpstreamMcpJson(rawValue: string, path: string): UpstreamMcpServerConfig[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawValue);
  } catch {
    throw new ValidationError(`${path} must contain valid JSON`, { path });
  }

  if (Array.isArray(parsed)) {
    if (parsed.length === 0) {
      throw new ValidationError(`${path} must contain at least one upstream MCP provider`, { path });
    }
    return parsed as UpstreamMcpServerConfig[];
  }

  if (parsed && typeof parsed === 'object') {
    return [parsed as UpstreamMcpServerConfig];
  }

  throw new ValidationError(`${path} must contain a JSON object or array of objects`, { path });
}

function resolveUpstreamMcpFromEnv(profile: Profile, env: EnvSource): UpstreamMcpServerConfig[] | undefined {
  const envVarName = getTrimmedEnvReference(profile.upstream_mcp_from_env, 'upstream_mcp_from_env');
  if (!envVarName) {
    return undefined;
  }

  const rawValue = env[envVarName];
  if (rawValue === undefined || rawValue.trim() === '') {
    return undefined;
  }

  return parseUpstreamMcpJson(rawValue, envVarName);
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

  if (!auth.value_from_env.trim()) {
    throw new ValidationError(`${path}.value_from_env must not be empty`, { path: `${path}.value_from_env` });
  }

  if (auth.type === 'custom-header') {
    if (!auth.header_name?.trim()) {
      throw new ValidationError(`${path}.header_name is required for custom-header auth`, { path: `${path}.header_name` });
    }
    if (!isSafePropertyName(auth.header_name)) {
      throw new ValidationError(`${path}.header_name contains invalid header name '${auth.header_name}'`, {
        path: `${path}.header_name`,
        headerName: auth.header_name,
      });
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

function validateUpstreamProvider(provider: UpstreamMcpServerConfig, index: number): void {
  const path = `upstream_mcp[${index}]`;

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

export function resolveUpstreamMcpConfig(profile: Profile, env: EnvSource = process.env): UpstreamMcpServerConfig[] | undefined {
  const envResolved = resolveUpstreamMcpFromEnv(profile, env);
  const providers = envResolved ?? (profile.upstream_mcp ? [...profile.upstream_mcp] : undefined);

  if (!providers) {
    return undefined;
  }

  if (providers.length === 0) {
    throw new ValidationError('upstream_mcp must contain at least one upstream MCP provider', { path: 'upstream_mcp' });
  }

  const seenNames = new Set<string>();
  providers.forEach((provider, index) => {
    validateUpstreamProvider(provider, index);
    const normalizedName = provider.name.trim();
    if (seenNames.has(normalizedName)) {
      throw new ValidationError(`Duplicate upstream_mcp provider name '${normalizedName}'`, {
        path: `upstream_mcp[${index}].name`,
        providerName: normalizedName,
      });
    }
    seenNames.add(normalizedName);
  });

  return providers.map((provider) => ({
    ...provider,
    name: provider.name.trim(),
    tool_prefix: provider.tool_prefix?.trim(),
    auth: provider.auth ? {
      ...provider.auth,
      value_from_env: provider.auth.value_from_env.trim(),
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
  }));
}
