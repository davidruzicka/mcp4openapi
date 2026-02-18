# HTTP Tenant Session Override - Detailed Implementation Plan

## Document Purpose
- [ ] Provide a durable, interruption-safe implementation plan for per-session tenant selection in HTTP transport.
- [ ] Preserve backward compatibility with current profile/env behavior.
- [ ] Define exact tenant config structure, precedence rules, validation rules, implementation steps, and test matrix.

## Scope
- [ ] In scope:
- [ ] HTTP Streamable transport session initialization flow.
- [ ] Tenant selection via request header at initialize.
- [ ] Per-session override for API base URL and auth/OAuth runtime settings.
- [ ] Startup validation for tenant configuration.
- [ ] Unit/integration/security tests and documentation updates.
- [ ] Out of scope:
- [ ] Stdio transport behavior changes.
- [ ] Dynamic tenant creation at runtime.
- [ ] Per-tool tenant routing.

## Goals and Non-goals
- [ ] Goal: one MCP server process can serve multiple team endpoints safely via session tenant selection.
- [ ] Goal: no behavior change for clients that do not send tenant header.
- [ ] Goal: allowlist-only endpoint selection.
- [ ] Non-goal: arbitrary URL passthrough from client.
- [ ] Non-goal: using multi-value `MCP4_API_BASE_URL` as canonical tenant store.

## Backward Compatibility Contract
- [ ] Keep existing profile-based `interceptors.base_url.value_from_env` behavior unchanged.
- [ ] Keep `MCP4_API_BASE_URL` usable as single endpoint default in current flows.
- [ ] If tenant config is not provided, runtime behavior remains identical to current code.
- [ ] Existing headers (`X-Mcp4-Params`, `X-Mcp4-Tools`) retain current semantics.

## Header API Design
- [ ] Primary selector header: `X-Mcp4-Tenant-Id`.
- [ ] Optional compatibility selector: `X-Mcp4-Api-Base-Url` (lookup only, not freeform passthrough).
- [ ] Session immutability rule:
- [ ] On `initialize`: header may be provided and is persisted in session.
- [ ] On non-initialize requests: header may be omitted.
- [ ] If provided later, it must match session value exactly, otherwise `400 ValidationError`.
- [ ] Precedence when both headers are sent:
- [ ] If both resolve to same tenant: accept.
- [ ] If mismatch: reject with `400 ValidationError` (ambiguous tenant selection).

## Tenant Configuration Model

### Source
- [ ] Primary source: `MCP4_HTTP_TENANTS_FILE=/path/to/tenants.json`.
- [ ] Optional source: `MCP4_HTTP_TENANTS_JSON` (stringified JSON for local/dev).
- [ ] Parsing precedence:
- [ ] `MCP4_HTTP_TENANTS_FILE` if present.
- [ ] Else `MCP4_HTTP_TENANTS_JSON`.
- [ ] Else tenant feature disabled.

### Canonical JSON structure
- [ ] Implement this structure as the source of truth:

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
- [ ] Add `src/types/http-tenants.ts`:
- [ ] `HttpTenantsConfig` with `version`, `tenants`.
- [ ] `HttpTenantConfig` with `tenant_id`, `default`, `api_base_url`, `auth_mode`, `auth`.
- [ ] `TenantAuthConfig` reusing existing `AuthInterceptor` where possible.
- [ ] Add runtime-resolved type:
- [ ] `ResolvedTenantContext` with normalized URL, resolved auth mode/config.

### Validation rules
- [ ] `version` must be supported integer (`1`).
- [ ] `tenants` must be non-empty array when feature enabled.
- [ ] `tenant_id` unique, regex: `^[a-z0-9][a-z0-9_-]{0,63}$`.
- [ ] Exactly one `default: true` tenant OR deterministic fallback rule (first item) with warning.
- [ ] `api_base_url` must be absolute URL.
- [ ] `api_base_url` must not contain credentials (`username/password`).
- [ ] `api_base_url` must use `https` unless explicit insecure mode is enabled (`MCP4_HTTP_TENANTS_ALLOW_HTTP=true`).
- [ ] `auth_mode=oauth` requires valid OAuth config shape.
- [ ] `auth_mode=token` requires non-OAuth auth config shape.
- [ ] `tenant.auth` can be single auth object or array, same shape as profile `interceptors.auth`.
- [ ] `tenant.auth` is a full override for session auth config (no merge with profile auth list).
- [ ] If `tenant.auth` is present, it may have different auth count than profile auth list.
- [ ] Guard: `auth_mode=oauth` requires at least one `oauth` auth entry in `tenant.auth`.
- [ ] Guard: `auth_mode=token` requires at least one non-`oauth` auth entry in `tenant.auth`.
- [ ] Guard: if `tenant.auth` is absent, effective auth comes from profile `interceptors.auth`; validate that effective auth satisfies `auth_mode`.
- [ ] Guard: startup must fail when `auth_mode` and effective auth entries are inconsistent.
- [ ] Collision rule:
- [ ] If two tenants share same normalized `api_base_url` and differ in auth/OAuth config -> startup error.
- [ ] If they share same `api_base_url` and same effective auth config -> allow with warning (discourage duplication).

## Session Resolution Semantics
- [ ] At initialize, resolve tenant in this order:
- [ ] `X-Mcp4-Tenant-Id`.
- [ ] `X-Mcp4-Api-Base-Url` mapped to allowlisted tenant.
- [ ] default tenant from tenants config.
- [ ] fallback to existing profile default behavior when tenant feature disabled.
- [ ] Persist resolved session fields:
- [ ] `tenantId`.
- [ ] `tenantBaseUrl`.
- [ ] `tenantAuthMode`.
- [ ] `tenantAuthConfig` or `tenantOAuthConfig` (minimum fields needed for runtime refresh).
- [ ] Non-initialize requests:
- [ ] If selector headers absent -> use persisted session tenant.
- [ ] If selector headers present -> must resolve to same `tenantId` persisted in session.

## Effective Configuration Precedence (per session)
- [ ] For HTTP request execution:
- [ ] `session tenant override` > `profile defaults` > `env/profile fallback` > parser default.
- [ ] For OAuth challenge/metadata URLs:
- [ ] Use session tenant OAuth settings when tenant selected.
- [ ] Fallback to profile OAuth settings only if no tenant session context exists.

## Code Change Plan (by file)

### A. New tenant config module
- [ ] Create `src/transport/http-tenant-config.ts`.
- [ ] Implement:
- [ ] source loading (`file` or `env json`),
- [ ] parsing + normalization,
- [ ] startup validation,
- [ ] index maps (`byTenantId`, `byBaseUrl`),
- [ ] default tenant resolver,
- [ ] tenant lookup helpers.
- [ ] Add tests: `src/transport/http-tenant-config.test.ts`.

### B. HTTP transport types
- [ ] Update `src/types/http-transport.ts` `SessionData` with:
- [ ] `tenantId?: string`
- [ ] `tenantBaseUrl?: string`
- [ ] `tenantHeaderValue?: string` (for mismatch diagnostics)
- [ ] `tenantAuthMode?: 'oauth' | 'token'`
- [ ] `tenantOAuthConfig?: OAuthConfig`
- [ ] `tenantAuthConfigs?: AuthInterceptor[]`
- [ ] Keep existing fields unchanged to avoid regressions.

### C. HTTP transport runtime flow
- [ ] Update `src/transport/http-transport.ts`:
- [ ] parse new headers via dedicated helpers (`getTenantIdHeaderValue`, `getTenantBaseUrlHeaderValue`).
- [ ] resolve tenant in initialize flow.
- [ ] persist tenant fields in `createSession(...)`.
- [ ] enforce header/session mismatch on non-initialize requests.
- [ ] expose getters:
- [ ] `getSessionTenantContext(profileId, sessionId)`.
- [ ] update CORS preflight allow-headers list to include new headers.
- [ ] ensure logs do not print full sensitive URL values.
- [ ] Add unit tests for all branches.

### D. MCP server client creation
- [ ] Update `src/mcp/mcp-server.ts`:
- [ ] in `getHttpClientForSession(...)` resolve base URL from session tenant context when present.
- [ ] use tenant auth config for session client interceptors when present.
- [ ] keep stdio/global client path unchanged.
- [ ] Add tests verifying session client uses tenant base URL and fallback path.

### E. OAuth provider/session handling
- [ ] Ensure OAuth challenge/metadata uses tenant OAuth config when session has tenant context.
- [ ] Ensure refresh flow (`ensureValidSessionToken`) respects tenant-specific OAuth endpoints/client metadata.
- [ ] Ensure token validation endpoint checks use effective session base URL/allowed hosts policy.
- [ ] Add focused tests in HTTP security/auth suites.

### F. Startup integration
- [ ] Wire tenant loader into startup path (`src/core/index.ts` and/or HTTP transport initialization path).
- [ ] Fail startup on invalid tenant config.
- [ ] Log tenant feature enabled/disabled and number of tenants loaded.

## K8s Deployment Blueprint
- [ ] ConfigMap for tenant JSON.
- [ ] Secret for OAuth client secrets/tokens referenced by env placeholders.
- [ ] Deployment changes:
- [ ] mount ConfigMap to `/etc/mcp4/tenants.json`.
- [ ] set `MCP4_HTTP_TENANTS_FILE=/etc/mcp4/tenants.json`.
- [ ] set referenced env vars from Secret.

### Example ConfigMap
- [ ] Provide example manifest:

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
- [ ] Provide example manifest snippet:

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
- [ ] Enforce allowlist-only tenant selection.
- [ ] Reject unknown tenant IDs/base URLs.
- [ ] Reject malformed headers (array duplication, invalid chars, overlong values).
- [ ] Reject HTTP scheme unless explicitly allowed.
- [ ] Reject base URLs with credentials.
- [ ] Keep SSRF protections active for all outbound requests.
- [ ] Ensure sensitive values are redacted in logs.
- [ ] Keep correlation IDs in validation/auth errors.

## Testing Plan

### Unit tests
- [ ] `http-tenant-config.test.ts`:
- [ ] valid config parse.
- [ ] duplicate tenant_id fails.
- [ ] invalid URL fails.
- [ ] collision same URL + different auth fails.
- [ ] default tenant resolution.
- [ ] `http-transport.unit.test.ts`:
- [ ] initialize with tenant ID header stores session tenant.
- [ ] initialize with base URL header maps to tenant.
- [ ] no header selects default tenant.
- [ ] non-initialize mismatch header returns 400.
- [ ] invalid tenant returns 400.
- [ ] CORS includes new headers.
- [ ] `mcp-server.test.ts`:
- [ ] `getHttpClientForSession` uses `tenantBaseUrl`.
- [ ] fallback to profile base URL when tenant not set.

### Security tests
- [ ] reject `http://` tenant URL when insecure mode off.
- [ ] reject `https://user:pass@host/...`.
- [ ] ensure unknown host/base URL cannot be selected.

### Integration tests
- [ ] HTTP initialize -> session created with tenant A -> tools call uses tenant A endpoint.
- [ ] HTTP initialize without header -> default tenant endpoint.
- [ ] OAuth tenant A challenge uses tenant A metadata URL.

## Documentation Plan
- [ ] Update `docs/HTTP-TRANSPORT.md`:
- [ ] new headers,
- [ ] tenant resolution order,
- [ ] immutable session behavior,
- [ ] error cases.
- [ ] Update `README.md`:
- [ ] tenant config env vars,
- [ ] k8s example.
- [ ] Update `docs/PROFILE-GUIDE.md`:
- [ ] explain profile defaults vs tenant session overrides.

## Schema and Type Sync Requirements
- [ ] If profile schema changes are needed:
- [ ] edit `src/types/profile.ts`.
- [ ] run `npm run generate-schemas`.
- [ ] run `npm run check-schema-sync`.
- [ ] run `npm test`.
- [ ] If tenant config is external-only (recommended), avoid profile schema changes.

## Implementation Sequence (interrupt-safe)
- [ ] Step 1: Add tenant config types + loader + validation + tests.
- [ ] Step 2: Add session fields and header parsing in HTTP transport.
- [ ] Step 3: Persist tenant context during initialize and enforce immutability.
- [ ] Step 4: Use session tenant base URL in `MCPServer` session client creation.
- [ ] Step 5: Wire tenant-aware OAuth behavior for challenge/refresh paths.
- [ ] Step 6: Add/adjust tests for HTTP flow, security, and OAuth.
- [ ] Step 7: Update docs + changelog.
- [ ] Step 8: Run full quality gate.

## Quality Gate Before Merge
- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm run validate` (profile validation remains green)
- [ ] optional: `npm audit`
- [ ] Update `CHANGELOG.md` (single-line user perspective entry).

## Rollout Strategy
- [ ] Phase 1: deploy with tenant feature disabled (no tenant config) to verify no regressions.
- [ ] Phase 2: add tenants config with one default tenant identical to current endpoint.
- [ ] Phase 3: enable additional tenants and start routing selected clients via header.
- [ ] Phase 4: monitor auth errors, 400 validation errors, and session metrics.

## Suggested Conventional Commit Titles
- [ ] `feat(http): add tenant-based per-session api base url and auth override`
- [ ] `test(http): cover tenant selection, immutability, and fallback behavior`
- [ ] `docs(http): document tenant headers, config, and k8s deployment`
