# Upstream MCP single-upstream profile proposal

Date: 2026-03-24
Status: Proposed / approved design direction before implementation
Scope: Remote MCP proxy profile shape, schema alignment, and validation changes

## Why this proposal exists

The first upstream MCP config draft introduced:

- `upstream_mcp` as an array
- `upstream_mcp_from_env` for full env-backed JSON override
- `tool_prefix` for downstream namespacing
- env-only upstream auth subset (`bearer`, `query`, `custom-header`)

After design review, the preferred direction changed to better match the intended product behavior:

- one remote MCP profile maps to one upstream MCP endpoint
- the config should live in the profile file, not in an env-backed JSON blob
- upstream auth must support forwarding an inbound HTTP header, with env only as local fallback
- empty `tools: []` should not be required when a profile is pure upstream MCP proxy
- no tool renaming/prefixing layer should be introduced for the single-upstream case

## Approved design decisions

1. `upstream_mcp` should be a **single object**, not an array.
2. `upstream_mcp_from_env` should be removed.
3. `tool_prefix` should be removed.
4. `tools` should become optional at the profile level.
5. A profile must define at least one of:
   - non-empty `tools`
   - `upstream_mcp`
6. Upstream auth must support:
   - forwarding an inbound HTTP auth header (`Authorization` or custom)
   - optional env fallback for local/dev usage
7. The first iteration remains **remote HTTP streamable only**.
8. Upstream config should include explicit trust, timeout, and discovery-cache fields so runtime behavior has a stable contract.

## Proposed TypeScript interfaces

### `Profile`

```ts
export interface Profile {
  profile_name: string;
  profile_id?: string;
  profile_aliases?: string[];
  openapi_spec_path?: string;
  description?: string;

  /**
   * Optional local OpenAPI-derived tools.
   * A profile may define either local tools, an upstream MCP proxy, or both.
   */
  tools?: ToolDefinition[];

  prompts?: PromptDefinition[];
  resources?: ResourceDefinition[];
  interceptors?: InterceptorConfig;
  parameter_aliases?: Record<string, string[]>;
  enterprise_authorization?: EnterpriseAuthorizationConfig;

  /**
   * Optional single upstream MCP proxy definition.
   * When present, mcp4openapi exposes tools discovered from this upstream MCP endpoint.
   */
  upstream_mcp?: UpstreamMcpConfig;

  resource_name?: string;
  resource_documentation?: string;
}
```

### `UpstreamMcpConfig`

```ts
export interface UpstreamMcpConfig {
  transport: UpstreamMcpTransportConfig;
  auth?: UpstreamMcpAuthConfig;
  tools?: UpstreamMcpToolPolicy;
  trust?: UpstreamMcpTrustConfig;
  discovery_timeout_ms?: number;
  call_timeout_ms?: number;
  discovery_cache?: UpstreamMcpDiscoveryCacheConfig;
}
```

### transport

```ts
export type UpstreamMcpTransportConfig =
  | UpstreamMcpHttpStreamableTransportConfig;

export interface UpstreamMcpHttpStreamableTransportConfig {
  type: 'http-streamable';
  url: string;
}
```

### auth

```ts
export type UpstreamMcpAuthConfig =
  | UpstreamMcpForwardAuthConfig
  | UpstreamMcpForwardOrEnvAuthConfig
  | UpstreamMcpEnvAuthConfig;

export interface UpstreamMcpForwardAuthConfig {
  mode: 'forward';
  forward_header: string;
}

export interface UpstreamMcpForwardOrEnvAuthConfig {
  mode: 'forward-or-env';
  forward_header: string;
  fallback: UpstreamMcpEnvCredentialConfig;
}

export interface UpstreamMcpEnvAuthConfig {
  mode: 'env';
  env: UpstreamMcpEnvCredentialConfig;
}
```

### env fallback credential

```ts
export type UpstreamMcpEnvCredentialConfig =
  | UpstreamMcpBearerEnvCredentialConfig
  | UpstreamMcpCustomHeaderEnvCredentialConfig;

export interface UpstreamMcpBearerEnvCredentialConfig {
  type: 'bearer';
  value_from_env: string;
}

export interface UpstreamMcpCustomHeaderEnvCredentialConfig {
  type: 'custom-header';
  header_name: string;
  value_from_env: string;
}
```

### tool policy

```ts
export interface UpstreamMcpToolPolicy {
  allow?: string[];
  deny?: string[];
}
```

### trust boundary

```ts
export interface UpstreamMcpTrustConfig {
  allowed_hosts?: string[];
  allow_private_network?: boolean;
}
```

### discovery cache

```ts
export interface UpstreamMcpDiscoveryCacheConfig {
  mode: 'startup' | 'lazy';
  ttl_seconds?: number;
}
```

## Proposed resolved/runtime interfaces

These separate raw profile config from normalized/validated runtime state.

```ts
export interface ResolvedUpstreamMcpConfig {
  transport: ResolvedUpstreamMcpTransportConfig;
  auth?: ResolvedUpstreamMcpAuthConfig;
  tools?: ResolvedUpstreamMcpToolPolicy;
  trust?: ResolvedUpstreamMcpTrustConfig;
  discovery_timeout_ms?: number;
  call_timeout_ms?: number;
  discovery_cache?: ResolvedUpstreamMcpDiscoveryCacheConfig;
}

export type ResolvedUpstreamMcpTransportConfig =
  | UpstreamMcpHttpStreamableTransportConfig;

export type ResolvedUpstreamMcpAuthConfig =
  | UpstreamMcpForwardAuthConfig
  | ResolvedUpstreamMcpForwardOrEnvAuthConfig
  | ResolvedUpstreamMcpEnvAuthConfig;

export interface ResolvedUpstreamMcpForwardOrEnvAuthConfig {
  mode: 'forward-or-env';
  forward_header: string;
  fallback: UpstreamMcpEnvCredentialConfig;
}

export interface ResolvedUpstreamMcpEnvAuthConfig {
  mode: 'env';
  env: UpstreamMcpEnvCredentialConfig;
}

export interface ResolvedUpstreamMcpToolPolicy {
  allow?: string[];
  deny?: string[];
}

export interface ResolvedUpstreamMcpTrustConfig {
  allowed_hosts?: string[];
  allow_private_network?: boolean;
}

export interface ResolvedUpstreamMcpDiscoveryCacheConfig {
  mode: 'startup' | 'lazy';
  ttl_seconds?: number;
}
```

## Proposed schema changes

### 1. `Profile.tools`

Change `tools` from required to optional.

Add cross-field validation so the profile must define at least one of:

- non-empty `tools`
- `upstream_mcp`

Suggested validation shape:

```ts
const profileSchema = baseProfileSchema.superRefine((profile, ctx) => {
  const hasLocalTools = Array.isArray(profile.tools) && profile.tools.length > 0;
  const hasUpstreamMcp = profile.upstream_mcp !== undefined;

  if (!hasLocalTools && !hasUpstreamMcp) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Profile must define at least one local tool or upstream_mcp',
      path: ['tools'],
    });
  }
});
```

### 2. Replace array-form `upstream_mcp`

Replace:

```ts
upstream_mcp: z.array(upstreamMcpServerConfigSchema).optional()
upstream_mcp_from_env: z.string().optional()
```

With:

```ts
upstream_mcp: upstreamMcpConfigSchema.optional()
```

And remove `upstream_mcp_from_env` entirely.

### 3. Zod transport schema

```ts
const upstreamMcpHttpStreamableTransportSchema = z.object({
  type: z.literal('http-streamable'),
  url: z.string().url(),
});
```

### 4. Zod auth schema

#### env credential

```ts
const upstreamMcpBearerEnvCredentialSchema = z.object({
  type: z.literal('bearer'),
  value_from_env: z.string().min(1),
});

const upstreamMcpCustomHeaderEnvCredentialSchema = z.object({
  type: z.literal('custom-header'),
  header_name: z.string().min(1),
  value_from_env: z.string().min(1),
});

const upstreamMcpEnvCredentialSchema = z.discriminatedUnion('type', [
  upstreamMcpBearerEnvCredentialSchema,
  upstreamMcpCustomHeaderEnvCredentialSchema,
]);
```

#### main auth schema

```ts
const upstreamMcpForwardAuthSchema = z.object({
  mode: z.literal('forward'),
  forward_header: z.string().min(1),
});

const upstreamMcpForwardOrEnvAuthSchema = z.object({
  mode: z.literal('forward-or-env'),
  forward_header: z.string().min(1),
  fallback: upstreamMcpEnvCredentialSchema,
});

const upstreamMcpEnvAuthSchema = z.object({
  mode: z.literal('env'),
  env: upstreamMcpEnvCredentialSchema,
});

const upstreamMcpAuthSchema = z.discriminatedUnion('mode', [
  upstreamMcpForwardAuthSchema,
  upstreamMcpForwardOrEnvAuthSchema,
  upstreamMcpEnvAuthSchema,
]);
```

### 5. Zod tool policy schema

```ts
const upstreamMcpToolPolicySchema = z.object({
  allow: z.array(z.string().min(1)).optional(),
  deny: z.array(z.string().min(1)).optional(),
}).optional();
```

### 6. Zod trust schema

```ts
const upstreamMcpTrustSchema = z.object({
  allowed_hosts: z.array(z.string().min(1)).optional(),
  allow_private_network: z.boolean().optional(),
}).optional();
```

### 7. Zod discovery cache schema

```ts
const upstreamMcpDiscoveryCacheSchema = z.object({
  mode: z.enum(['startup', 'lazy']),
  ttl_seconds: z.number().int().positive().optional(),
}).optional();
```

### 8. Zod main upstream schema

```ts
const upstreamMcpConfigSchema = z.object({
  transport: upstreamMcpHttpStreamableTransportSchema,
  auth: upstreamMcpAuthSchema.optional(),
  tools: upstreamMcpToolPolicySchema,
  trust: upstreamMcpTrustSchema,
  discovery_timeout_ms: z.number().int().positive().optional(),
  call_timeout_ms: z.number().int().positive().optional(),
  discovery_cache: upstreamMcpDiscoveryCacheSchema,
});
```

## Proposed validation changes in loader logic

### Remove from upstream MCP validation

- array parsing
- duplicate provider-name checks
- `tool_prefix`
- `upstream_mcp_from_env`
- provider `name`

### Add to upstream MCP validation

1. Validate `auth.forward_header`
2. Validate `env.header_name` for `custom-header`
3. Keep strict URL validation:
   - absolute URL only
   - `http` or `https` only
   - no inline credentials
   - no fragment
4. If `trust.allowed_hosts` is present, require `transport.url` host to match at config-load time
5. Keep tool policy validation:
   - no empty strings in `allow` / `deny`
   - `deny` precedence documented and tested

## Proposed docs updates

### README / PROFILE-GUIDE direction

Document the remote MCP profile as:

- single upstream object
- no `tool_prefix`
- no env-backed full JSON override
- auth forwarding first, env fallback second
- `tools` optional when the profile is pure upstream MCP proxy

### Example: forward Authorization header

```json
{
  "profile_name": "remote-mcp",
  "upstream_mcp": {
    "transport": {
      "type": "http-streamable",
      "url": "https://remote.example/mcp"
    },
    "auth": {
      "mode": "forward",
      "forward_header": "Authorization"
    }
  }
}
```

### Example: custom header with local env fallback

```json
{
  "profile_name": "remote-mcp-local",
  "upstream_mcp": {
    "transport": {
      "type": "http-streamable",
      "url": "https://remote.example/mcp"
    },
    "auth": {
      "mode": "forward-or-env",
      "forward_header": "X-Remote-MCP-Auth",
      "fallback": {
        "type": "custom-header",
        "header_name": "X-Remote-MCP-Auth",
        "value_from_env": "REMOTE_MCP_AUTH"
      }
    }
  }
}
```

## Proposed tests

### valid profiles

- profile with `upstream_mcp` only and no `tools`
- `auth.mode = forward`
- `auth.mode = forward-or-env`
- `auth.mode = env`

### invalid profiles

- no `tools` and no `upstream_mcp`
- empty `forward_header`
- invalid custom header name
- `transport.url` host not allowed by `trust.allowed_hosts`
- empty strings in `allow` / `deny`
- invalid `discovery_timeout_ms`
- invalid `call_timeout_ms`

### contract tests

- `deny` takes precedence over `allow`
- `tools` may be omitted when `upstream_mcp` exists

## Explicit non-goals for this proposal

- stdio upstream support
- multi-upstream remote profile support
- tool name prefixing or translation
- env-backed full JSON override for upstream MCP config
- query-parameter upstream auth in the first iteration

## Fit with current schema style

This proposal intentionally reuses current project patterns:

- `*_from_env` remains only for secret value references, not whole-profile JSON override
- trust config mirrors existing host-allowlist / private-network patterns
- integer timeout fields follow existing numeric validation style
- discriminated unions match current generated-schema conventions
- cross-field validation is added in enhanced schema, consistent with existing profile logic

## Recommended next implementation step

1. Update `src/types/profile.ts` to the single-object model.
2. Update schema generation inputs so `generated-schemas.ts` and `profile-schema.json` reflect the new shape.
3. Refactor `src/profile/upstream-mcp-config.ts` to validate a single-object config.
4. Update `README.md` and `docs/PROFILE-GUIDE.md` from the array/env-override draft to this approved single-upstream design.
5. Add contract tests before runtime transport/discovery implementation.
