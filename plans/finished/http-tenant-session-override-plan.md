# HTTP Tenant Session Override - Detailed Implementation Plan

## Document Purpose
- [X] Provide a durable, interruption-safe implementation plan for per-session tenant selection in HTTP transport.
- [X] Preserve backward compatibility with current profile/env behavior.
- [X] Define exact tenant config structure, precedence rules, validation rules, implementation steps, and test matrix.

## Scope
- [X] In scope:
- [X] HTTP Streamable transport session initialization flow.
- [X] Tenant selection via request header at initialize.
- [X] Per-session override for API base URL and auth/OAuth runtime settings.
- [X] Startup validation for tenant configuration.
- [X] Unit/integration/security tests and documentation updates.
- [X] Out of scope:
- [X] Stdio transport behavior changes.
- [X] Dynamic tenant creation at runtime.
- [X] Per-tool tenant routing.

## Goals and Non-goals
- [X] Goal: one MCP server process can serve multiple team endpoints safely via session tenant selection.
- [X] Goal: no behavior change for clients that do not send tenant header.
- [X] Goal: allowlist-only endpoint selection.
- [X] Non-goal: arbitrary URL passthrough from client.
- [X] Non-goal: using multi-value `MCP4_API_BASE_URL` as canonical tenant store.

## Backward Compatibility Contract
- [X] Keep existing profile-based `interceptors.base_url.value_from_env` behavior unchanged.
- [X] Keep `MCP4_API_BASE_URL` usable as single endpoint default in current flows.
- [X] If tenant config is not provided, runtime behavior remains identical to current code.
- [X] Existing headers (`X-Mcp4-Params`, `X-Mcp4-Tools`) retain current semantics.

## Header API Design
- [X] Primary selector header: `X-Mcp4-Tenant-Id`.
- [X] Optional compatibility selector: `X-Mcp4-Api-Base-Url` (lookup only, not freeform passthrough).
- [X] Session immutability rule:
- [X] On `initialize`: header may be provided and is persisted in session.
- [X] On non-initialize requests: header may be omitted.
- [X] If provided later, it must match session value exactly, otherwise `400 ValidationError`.
- [X] Precedence when both headers are sent:
- [X] If both resolve to same tenant: accept.
- [X] If mismatch: reject with `400 ValidationError` (ambiguous tenant selection).

## Tenant Configuration Model

### Source
- [X] Primary source: `MCP4_HTTP_TENANTS_FILE=/path/to/tenants.json`.
- [X] Optional source: `MCP4_HTTP_TENANTS_JSON` (stringified JSON for local/dev).
- [X] Parsing precedence:
- [X] `MCP4_HTTP_TENANTS_FILE` if present.
- [X] Else `MCP4_HTTP_TENANTS_JSON`.
- [X] Else tenant feature disabled.

### Canonical JSON structure
- [X] Implement this structure as the source of truth:

```json
{
  "version": 1,
  "tenants": [
    {
      "tenant_id": "team-a",
      "default": true,
      "api_base_url": "https://grafana.team-a.example.com/api",
      "auth_mode": "oauth",
      "auth": {
        "type": "oauth",
        "oauth_config": {
          "issuer": "https://auth.team-a.example.com",
          "authorization_endpoint": "https://auth.team-a.example.com/oauth/authorize",
          "token_endpoint": "https://auth.team-a.example.com/oauth/token",
          "client_id": "${env:MCP4_TEAM_A_OAUTH_CLIENT_ID}",
          "client_secret": "${env:MCP4_TEAM_A_OAUTH_CLIENT_SECRET}",
          "redirect_uri": "${env:MCP4_TEAM_A_OAUTH_REDIRECT_URI}",
          "scopes": ["api"],
          "allowed_redirect_hosts": ["localhost", "127.0.0.1"]
        }
      }
    },
    {
      "tenant_id": "team-b",
      "api_base_url": "https://n8n.team-b.example.com/api/v1",
      "auth_mode": "token",
      "auth": {
        "type": "bearer",
        "value_from_env": "MCP4_TEAM_B_API_TOKEN"
      }
    }
  ]
}
```

### Type definitions to add
- [X] Add `src/types/http-tenants.ts`:
- [X] `HttpTenantsConfig` with `version`, `tenants`.
- [X] `HttpTenantConfig` with `tenant_id`, `default`, `api_base_url`, `auth_mode`, `auth`.
- [X] `TenantAuthConfig` reusing existing `AuthInterceptor` where possible.
- [X] Add runtime-resolved type:
- [X] `ResolvedTenantContext` with normalized URL, resolved auth mode/config.

### Validation rules
- [X] `version` must be supported integer (`1`).
- [X] `tenants` must be non-empty array when feature enabled.
- [X] `tenant_id` unique, regex: `^[a-z0-9][a-z0-9_-]{0,63}$`.
- [X] Exactly one `default: true` tenant OR deterministic fallback rule (first item) with warning.
- [X] `api_base_url` must be absolute URL.
- [X] `api_base_url` must not contain credentials (`username/password`).
- [X] `api_base_url` must use `https` unless explicit insecure mode is enabled (`MCP4_HTTP_TENANTS_ALLOW_HTTP=true`).
- [X] `auth_mode=oauth` requires valid OAuth config shape.
- [X] `auth_mode=token` requires non-OAuth auth config shape.
- [X] `tenant.auth` can be single auth object or array, same shape as profile `interceptors.auth`.
- [X] `tenant.auth` is a full override for session auth config (no merge with profile auth list).
- [X] If `tenant.auth` is present, it may have different auth count than profile auth list.
- [X] Guard: `auth_mode=oauth` requires at least one `oauth` auth entry in `tenant.auth`.
- [X] Guard: `auth_mode=token` requires at least one non-`oauth` auth entry in `tenant.auth`.
- [X] Guard: if `tenant.auth` is absent, effective auth comes from profile `interceptors.auth`; validate that effective auth satisfies `auth_mode`.
- [X] Guard: startup must fail when `auth_mode` and effective auth entries are inconsistent.
- [X] Collision rule:
- [X] If two tenants share same normalized `api_base_url` and differ in auth/OAuth config -> startup error.
- [X] If they share same `api_base_url` and same effective auth config -> allow with warning (discourage duplication).

## Session Resolution Semantics
- [X] At initialize, resolve tenant in this order:
- [X] `X-Mcp4-Tenant-Id`.
- [X] `X-Mcp4-Api-Base-Url` mapped to allowlisted tenant.
- [X] default tenant from tenants config.
- [X] fallback to existing profile default behavior when tenant feature disabled.
- [X] Persist resolved session fields:
- [X] `tenantId`.
- [X] `tenantBaseUrl`.
- [X] `tenantAuthMode`.
- [X] `tenantAuthConfig` or `tenantOAuthConfig` (minimum fields needed for runtime refresh).
- [X] Non-initialize requests:
- [X] If selector headers absent -> use persisted session tenant.
- [X] If selector headers present -> must resolve to same `tenantId` persisted in session.

## Effective Configuration Precedence (per session)
- [X] For HTTP request execution:
- [X] `session tenant override` > `profile defaults` > `env/profile fallback` > parser default.
- [X] For OAuth challenge/metadata URLs:
- [X] Use session tenant OAuth settings when tenant selected.
- [X] Fallback to profile OAuth settings only if no tenant session context exists.

## Code Change Plan (by file)

### A. New tenant config module
- [X] Create `src/transport/http-tenant-config.ts`.
- [X] Implement:
- [X] source loading (`file` or `env json`),
- [X] parsing + normalization,
- [X] startup validation,
- [X] index maps (`byTenantId`, `byBaseUrl`),
- [X] default tenant resolver,
- [X] tenant lookup helpers.
- [X] Add tests: `src/transport/http-tenant-config.test.ts`.

### B. HTTP transport types
- [X] Update `src/types/http-transport.ts` `SessionData` with:
- [X] `tenantId?: string`
- [X] `tenantBaseUrl?: string`
- [X] `tenantHeaderValue?: string` (for mismatch diagnostics)
- [X] `tenantAuthMode?: 'oauth' | 'token'`
- [X] `tenantOAuthConfig?: OAuthConfig`
- [X] `tenantAuthConfigs?: AuthInterceptor[]`
- [X] Keep existing fields unchanged to avoid regressions.

### C. HTTP transport runtime flow
- [X] Update `src/transport/http-transport.ts`:
- [X] parse new headers via dedicated helpers (`getTenantIdHeaderValue`, `getTenantBaseUrlHeaderValue`).
- [X] resolve tenant in initialize flow.
- [X] persist tenant fields in `createSession(...)`.
- [X] enforce header/session mismatch on non-initialize requests.
- [X] expose getters:
- [X] `getSessionTenantContext(profileId, sessionId)`.
- [X] update CORS preflight allow-headers list to include new headers.
- [X] ensure logs do not print full sensitive URL values.
- [X] Add unit tests for all branches.

### D. MCP server client creation
- [X] Update `src/mcp/mcp-server.ts`:
- [X] in `getHttpClientForSession(...)` resolve base URL from session tenant context when present.
- [X] use tenant auth config for session client interceptors when present.
- [X] keep stdio/global client path unchanged.
- [X] Add tests verifying session client uses tenant base URL and fallback path.

### E. OAuth provider/session handling
- [X] Ensure OAuth challenge/metadata uses tenant OAuth config when session has tenant context.
- [X] Ensure refresh flow (`ensureValidSessionToken`) respects tenant-specific OAuth endpoints/client metadata.
- [X] Ensure token validation endpoint checks use effective session base URL/allowed hosts policy.
- [X] Add focused tests in HTTP security/auth suites.

### F. Startup integration
- [X] Wire tenant loader into startup path (`src/core/index.ts` and/or HTTP transport initialization path).
- [X] Fail startup on invalid tenant config.
- [X] Log tenant feature enabled/disabled and number of tenants loaded.

## K8s Deployment Blueprint
- [X] ConfigMap for tenant JSON.
- [X] Secret for OAuth client secrets/tokens referenced by env placeholders.
- [X] Deployment changes:
- [X] mount ConfigMap to `/etc/mcp4/tenants.json`.
- [X] set `MCP4_HTTP_TENANTS_FILE=/etc/mcp4/tenants.json`.
- [X] set referenced env vars from Secret.

### Example ConfigMap
- [X] Provide example manifest:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: mcp4-tenants
data:
  tenants.json: |
    {
      "version": 1,
      "tenants": [
        {
          "tenant_id": "team-a",
          "default": true,
          "api_base_url": "https://grafana.team-a.example.com/api",
          "auth_mode": "oauth",
          "auth": {
            "type": "oauth",
            "oauth_config": {
              "issuer": "https://auth.team-a.example.com",
              "client_id": "${env:MCP4_TEAM_A_OAUTH_CLIENT_ID}",
              "client_secret": "${env:MCP4_TEAM_A_OAUTH_CLIENT_SECRET}",
              "redirect_uri": "${env:MCP4_TEAM_A_OAUTH_REDIRECT_URI}",
              "scopes": ["api"]
            }
          }
        }
      ]
    }
```

### Example Deployment snippet
- [X] Provide example manifest snippet:

```yaml
spec:
  template:
    spec:
      containers:
      - name: mcp4openapi
        env:
        - name: MCP4_HTTP_TENANTS_FILE
          value: /etc/mcp4/tenants.json
        - name: MCP4_TEAM_A_OAUTH_CLIENT_ID
          valueFrom:
            secretKeyRef:
              name: mcp4-secrets
              key: team-a-client-id
        - name: MCP4_TEAM_A_OAUTH_CLIENT_SECRET
          valueFrom:
            secretKeyRef:
              name: mcp4-secrets
              key: team-a-client-secret
        - name: MCP4_TEAM_A_OAUTH_REDIRECT_URI
          valueFrom:
            secretKeyRef:
              name: mcp4-secrets
              key: team-a-redirect-uri
        volumeMounts:
        - name: mcp4-tenants
          mountPath: /etc/mcp4
          readOnly: true
      volumes:
      - name: mcp4-tenants
        configMap:
          name: mcp4-tenants
```

## Security Checklist
- [X] Enforce allowlist-only tenant selection.
- [X] Reject unknown tenant IDs/base URLs.
- [X] Reject malformed headers (array duplication, invalid chars, overlong values).
- [X] Reject HTTP scheme unless explicitly allowed.
- [X] Reject base URLs with credentials.
- [X] Keep SSRF protections active for all outbound requests.
- [X] Ensure sensitive values are redacted in logs.
- [X] Keep correlation IDs in validation/auth errors.

## Testing Plan

### Unit tests
- [X] `http-tenant-config.test.ts`:
- [X] valid config parse.
- [X] duplicate tenant_id fails.
- [X] invalid URL fails.
- [X] collision same URL + different auth fails.
- [X] default tenant resolution.
- [X] `http-transport.unit.test.ts`:
- [X] initialize with tenant ID header stores session tenant.
- [X] initialize with base URL header maps to tenant.
- [X] no header selects default tenant.
- [X] non-initialize mismatch header returns 400.
- [X] invalid tenant returns 400.
- [X] CORS includes new headers.
- [X] `mcp-server.test.ts`:
- [X] `getHttpClientForSession` uses `tenantBaseUrl`.
- [X] fallback to profile base URL when tenant not set.

### Security tests
- [X] reject `http://` tenant URL when insecure mode off.
- [X] reject `https://user:pass@host/...`.
- [X] ensure unknown host/base URL cannot be selected.

### Integration tests
- [X] HTTP initialize -> session created with tenant A -> tools call uses tenant A endpoint.
- [X] HTTP initialize without header -> default tenant endpoint.
- [X] OAuth tenant A challenge uses tenant A metadata URL.

## Documentation Plan
- [X] Update `docs/HTTP-TRANSPORT.md`:
- [X] new headers,
- [X] tenant resolution order,
- [X] immutable session behavior,
- [X] error cases.
- [X] Update `README.md`:
- [X] tenant config env vars,
- [X] k8s example.
- [X] Update `docs/PROFILE-GUIDE.md`:
- [X] explain profile defaults vs tenant session overrides.

## Schema and Type Sync Requirements
- [X] If profile schema changes are needed:
- [X] edit `src/types/profile.ts`.
- [X] run `npm run generate-schemas`.
- [X] run `npm run check-schema-sync`.
- [X] run `npm test`.
- [X] If tenant config is external-only (recommended), avoid profile schema changes.

## Implementation Sequence (interrupt-safe)
- [X] Step 1: Add tenant config types + loader + validation + tests.
- [X] Step 2: Add session fields and header parsing in HTTP transport.
- [X] Step 3: Persist tenant context during initialize and enforce immutability.
- [X] Step 4: Use session tenant base URL in `MCPServer` session client creation.
- [X] Step 5: Wire tenant-aware OAuth behavior for challenge/refresh paths.
- [X] Step 6: Add/adjust tests for HTTP flow, security, and OAuth.
- [X] Step 7: Update docs + changelog.
- [X] Step 8: Run full quality gate.

## Quality Gate Before Merge
- [X] `npm run typecheck`
- [X] `npm test`
- [X] `npm run validate` (profile validation remains green)
- [X] optional: `npm audit`
- [X] Update `CHANGELOG.md` (single-line user perspective entry).

## Rollout Strategy
- [X] Phase 1: deploy with tenant feature disabled (no tenant config) to verify no regressions.
- [X] Phase 2: add tenants config with one default tenant identical to current endpoint.
- [X] Phase 3: enable additional tenants and start routing selected clients via header.
- [X] Phase 4: monitor auth errors, 400 validation errors, and session metrics.

## Suggested Conventional Commit Titles
- [X] `feat(http): add tenant-based per-session api base url and auth override`
- [X] `test(http): cover tenant selection, immutability, and fallback behavior`
- [X] `docs(http): document tenant headers, config, and k8s deployment`
