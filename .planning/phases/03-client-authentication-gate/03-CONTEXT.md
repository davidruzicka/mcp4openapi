# Phase 3: Client Authentication Gate - Context

**Gathered:** 2026-04-12
**Status:** Ready for planning

<domain>
## Phase Boundary

Gate inbound MCP client session initialization via API keys; attach resolved principal to the
session before any upstream resource is consumed.

Scope: AUTH-02, AUTH-03 (partial) only.
- AUTH-01 (JWT/OIDC gate) is Phase 4.
- No policy enforcement (Phase X). No audit log emission (Phase 5).
- No changes to upstream credential pass-through (Phase 1 work is untouched).

</domain>

<decisions>
## Implementation Decisions

### JWT Validation Path (AUTH-01) — DEFERRED TO PHASE 4

D-01 through D-04 (JWT/OIDC decisions) moved to Phase 4 context. Phase 3 does not implement
any JWT validation, JWKS fetching, or OIDC discovery.

### API Key Store - Pluggable Interface (AUTH-02)

- **D-05:** An `ApiKeyStore` interface is introduced with a single method:
  `validate(key: string): Promise<AuthorizedPrincipal | null>`. Two implementations ship in
  Phase 3: `InlineApiKeyStore` and `SasankaApiKeyStore`.
- **D-06:** `InlineApiKeyStore` reads API keys from env vars configured in the profile. Each entry
  specifies `key_from_env`, `subject`, and optional `scopes`. Suitable for small deployments with
  no external secret store dependency.
- **D-07:** `SasankaApiKeyStore` validates a client-presented Bearer token by calling
  `GET /users/me` on the Sasanka API (authenticated with that same token). A successful response
  resolves identity: `subject = username`, `authType = 'token'`, `scopes` parsed from
  `token.scope`, `expiresAt` from `token.expires`. An HTTP 401 from Sasanka means the key is
  invalid; connection errors propagate as typed errors. SSRF protection applied to `base_url`.
- **D-08:** `SasankaApiKeyStore` does NOT cache `/users/me` responses. Sasanka manages token
  TTL and revocation; the gateway validates on every session init. Caching would delay revocation
  propagation and is not worth the complexity for session-init-only calls.
- **D-09:** The `ApiKeyStore` backend is selected by `client_auth_gate.api_keys.type`:
  `'inline'` or `'sasanka'`. Downstream implementations register via a factory/registry keyed on
  type string — adding a new backend does not require changes to the gate logic.

### Profile Config Structure (AUTH-02)

- **D-10:** A new optional `client_auth_gate` field is added to the `Profile` type. It is
  deliberately separate from the existing `enterprise_authorization` to keep concerns distinct.
  Existing profiles with no `client_auth_gate` field are unaffected.
- **D-11:** `client_auth_gate` structure for Phase 3 (authoritative type in `src/types/profile.ts`):
  ```
  ClientAuthGateConfig {
    mode?: 'required' | 'optional'   // default: 'required'
    mode_from_env?: string
    api_keys?: (
      { type: 'inline'; keys: {key_from_env: string; subject: string; scopes?: string[]}[] }
      | { type: 'sasanka'; base_url?: string; base_url_from_env?: string; timeout_ms?: number }
    )
    // jwt? field added in Phase 4
  }
  ```
- **D-12 (Phase 4):** JWT-first routing (decodeProtectedHeader → JWT path, opaque → API key) is
  a Phase 4 decision. Phase 3 ClientAuthGate routes all tokens to ApiKeyStore only.
- **D-13:** A profile with `client_auth_gate` AND no `upstream_mcp` is valid (auth gate applies
  to OpenAPI-backed tool calls too). Profile-level validation at load time checks config
  completeness.

### Session Identity Attachment (AUTH-03)

- **D-14:** `SessionData` (in `src/types/http-transport.ts`) gains a new optional field:
  `clientPrincipal?: AuthorizedPrincipal`. This is populated at session creation after successful
  auth gate validation and is immutable for the session lifetime.
- **D-15:** The resolved `clientPrincipal` is the full `AuthorizedPrincipal` type (existing type
  in `src/auth/inbound-auth-principal.ts`) — subject, authType, groups, scopes, expiresAt,
  tenantId. Phase 5 audit log reads it directly from session without needing further SessionData
  changes.
- **D-16:** Phase 3 does NOT emit structured audit log entries (that is Phase 5). It only attaches
  the principal to the session. Existing `logger.info` calls at session init will be updated to
  include `subject` and `authType` as structured fields for debug visibility.

### Claude's Discretion

- Auth gate execution in Phase 3: API key only. JWT ordering decisions deferred to Phase 4.
- `SasankaApiKeyStore` HTTP client: use Node.js native `fetch` with `AbortSignal.timeout()`
  (same pattern as existing `jwks-cache.ts` and validation endpoint calls). No new HTTP client
  dependency.
- Error code mapping: JWT validation failure → `EnterpriseTokenValidationError` (existing typed
  error, appropriate) or a new `ClientAuthValidationError` if the existing type is too tightly
  coupled to enterprise flow — planner decides based on error taxonomy review.
- Sasanka `token.scope` parsing: Sasanka uses custom scope format (`ns:~alias`, `grp:/team-/`).
  For Phase 3, store the raw scope string in `scopes[]` as a single element. Phase X policy
  can interpret Sasanka-specific scope semantics when needed.
- `InlineApiKeyStore` key comparison: constant-time string comparison (use `crypto.timingSafeEqual`)
  to prevent timing attacks.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Types and Schema (modify these)
- `src/types/profile.ts` — add `ClientAuthGateConfig` (no jwt field), `ApiKeyStoreConfig`
  types and `client_auth_gate?: ClientAuthGateConfig` field to `Profile`; ClientAuthJwtConfig added in Phase 4
- `src/types/http-transport.ts` — add `clientPrincipal?: AuthorizedPrincipal` to `SessionData`
- `src/generated-schemas.ts` — auto-regenerated via `npm run generate-schemas` after type changes

### Existing Auth Infrastructure (reuse)
- `src/auth/inbound-auth-principal.ts` — `AuthorizedPrincipal` type; this is what the gate
  produces for the API key path
- `src/auth/jwks-cache.ts` — NOT used in Phase 3; Phase 4 injects it into ClientAuthGate for JWT
- `src/core/errors.ts` — error taxonomy; ClientAuthGateError added here

### Transport Integration Point
- `src/transport/http-transport.ts` — session init gate is around line 2731 (enterprise auth
  check). The new `client_auth_gate` validation inserts at the same point. Read the full
  `handlePost` method (line ~2567) and `createSession` (line ~3412) to understand the integration.

### Architecture
- `IMPLEMENTATION.md` — system-wide architecture decisions

### External: Sasanka API
- Swagger UI: `https://sasanka.seznam.net/docs` (reference for `GET /users/me` response schema)
- Key endpoint for `SasankaApiKeyStore`:
  `GET /api/v1/users/me` with `Authorization: Bearer <token>`
  Response: `{username, role, email, token: {token_id, read_only, expires, scope}}`
  - HTTP 401 = invalid/expired token
  - HTTP 200 = valid token, extract identity

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `JwksCache` (src/auth/jwks-cache.ts) — fully production-ready, SSRF-protected; inject into
  the new JWT validator the same way `EnterpriseAuthProvider` uses it
- `AuthorizedPrincipal` + `InboundAuthTokenRecord` types (src/auth/inbound-auth-principal.ts)
  — already define the resolved identity contract; no new types needed for this
- `EnterpriseReplayStore`, `InboundAuthTokenStore` — NOT needed for Phase 3; the new gate does
  not issue internal tokens or track replays (direct JWT validation is stateless)
- Existing `decodeProtectedHeader` + `jwtVerify` from `jose` — already a dependency, use these
  for the new JWT gate

### Established Patterns
- `SSRFValidator` (src/security/ssrf-validator.ts) — apply to `SasankaApiKeyStore.base_url` and
  any configurable JWT/JWKS URLs; existing pattern from upstream connection manager
- `value_from_env` pattern for secrets in profile config — use `key_from_env` in `InlineApiKeyStore`
  entries; consistent with how auth interceptors reference env vars
- `npm run generate-schemas` — MUST be run after any change to `src/types/profile.ts`
- Factory/registry pattern — `ApiKeyStoreFactory` keyed by `type` string for extensibility
  (consistent with existing data-driven approach in AGENTS.md directives)

### Integration Points
- `http-transport.ts` line ~2731 — existing enterprise auth gate; new `client_auth_gate`
  validation goes in the same block, triggered by `profileState.context.client_auth_gate` presence
- `createSession()` (line ~3412) — populate `session.clientPrincipal` from the resolved principal
  returned by the gate
- `src/profile/profile-loader.ts` — add `client_auth_gate` config validation at profile load time
  (fail-fast on misconfigured issuer, missing required fields, unknown backend type)

</code_context>

<specifics>
## Specific Ideas

- `SasankaApiKeyStore` is a clean example of the "validation endpoint" pattern applied to identity
  resolution: the token proves its own validity by successfully authenticating against Sasanka's
  `/users/me`. No gateway-side key storage required.
- The `ApiKeyStore` factory should be a simple lookup table: `{ inline: InlineApiKeyStore,
  sasanka: SasankaApiKeyStore }` keyed by `type` — consistent with data-driven approach.
- Token type detection (JWT vs opaque) via `decodeProtectedHeader` is cheap and doesn't require
  JWKS fetch; the fast path for opaque tokens skips JWT processing entirely.
- `SasankaApiKeyStore` constructor takes `base_url` (resolved from config or env) and a `Logger`.
  It uses `AbortSignal.timeout(timeout_ms ?? 5000)` for the `/users/me` fetch — same pattern as
  existing validation endpoint calls in `upstream-connection-manager.ts`.

</specifics>

<deferred>
## Deferred Ideas

- Team-level allow/deny policy based on `clientPrincipal.subject` or `groups` — Phase X (requires
  policy config design decision, deferred per REQUIREMENTS.md)
- Caching `SasankaApiKeyStore` responses — not needed for Phase 3; revisit if Sasanka rate limits
  become a concern in production
- Additional `ApiKeyStore` backends (HashiCorp Vault, AWS Secrets Manager, etc.) — architecture
  supports them; implement on demand
- Sasanka-specific scope parsing (`ns:~alias`, `grp:/team-/` format) into typed permissions —
  raw string storage is sufficient for Phase 3; Phase X policy can interpret
- JWT refresh / token renewal during active session — Phase 3 only gates at session init; mid-
  session JWT expiry is handled by existing session timeout mechanism
- JWKS key pinning (`allowed_kids`) — supported by existing `JwksCache`; planner may expose as
  optional config in `ClientAuthJwtConfig` if straightforward to wire
- Per-profile `JwksCache` instance vs shared global — planner decides based on how many profiles
  will have `client_auth_gate.jwt` in practice; start with per-profile, same pattern as
  `EnterpriseAuthProvider`

</deferred>

---

*Phase: 03-client-authentication-gate (API Keys only)*
*Context gathered: 2026-04-12*
*Revised: 2026-04-22 — JWT/OIDC work moved to Phase 4*
