# Enterprise Managed Authorization Support Plan

## Goal
- Add enterprise managed authorization support for HTTP transport in this repository without implementing it yet.
- Keep the design aligned with the current profile-driven architecture while avoiding a misleading "just another auth.type" model.
- Treat security, issuer trust, claim validation, and bounded runtime behavior as first-class requirements.

## Status
- [x] Feasibility reviewed against current OAuth/profile architecture.
- [x] Plan documented in `plans/`.
- [x] Follow-up gap checklist completed.

## Follow-up Gap Checklist (Mar 2026)
- [x] Reuse the shared inbound principal/token model for OAuth-issued access tokens as well as enterprise-issued tokens.
- [x] Enforce enterprise tenant isolation during internal token verification and add regression coverage.
- [x] Enforce enterprise-specific rate limiting, concurrency limits, and globally bounded replay/JWKS/token caches.
- [x] Implement trust-mode aware issuer discovery/JWKS resolution and stricter semantic validation for conflicting policy combinations.
- [x] Enforce HTTP-only enterprise authorization runtime boundaries plus stricter `/oauth/token` request hardening.
- [x] Expose the remaining enterprise metadata fields and centralize auth redaction in transport logging/error paths.
- [x] Add enterprise observability hooks and broaden the security/transport test matrix for the remaining claim/cache/boundary cases.

## Executive Summary
- Enterprise managed authorization should be implemented as a server-side authorization capability for the MCP HTTP server, not as a simple upstream API auth method.
- Profiles should define authorization policy. Server runtime should own trust material, token issuance mechanics, cache budgets, concurrency limits, and metadata serving.
- Runtime components must implement the protocol mechanics: JWT bearer grant handling, issuer/JWKS validation, replay protection, bounded caches, grant routing, and metadata exposure.
- `stdio` transport should remain out of scope. This feature only makes sense for HTTP transport.

## Why This Is Different From Existing Auth
- Current profile auth in [src/types/profile.ts](/workspace/src/types/profile.ts#L214) models how the server authenticates to the upstream API: `bearer`, `query`, `custom-header`, `session-cookie`, `oauth`.
- Current OAuth support in [src/auth/oauth-provider.ts](/workspace/src/auth/oauth-provider.ts#L1) models this server as an OAuth client/proxy to an external OAuth server.
- Current `/oauth/token` handling in [src/transport/http-transport.ts](/workspace/src/transport/http-transport.ts#L1712) only accepts `authorization_code` and `refresh_token`.
- Enterprise managed authorization introduces a different responsibility: the MCP server must validate enterprise-issued assertions and mint or proxy MCP access tokens under a new grant flow.

## Scope

### In Scope
- HTTP transport only.
- New profile-driven enterprise authorization configuration.
- JWT bearer grant support on `/oauth/token` for enterprise-managed authorization flows.
- Issuer trust configuration with JWKS discovery and validation.
- Strict claim validation and token exchange policy enforcement.
- Discovery and metadata extensions for clients that understand the capability.
- Unit, integration, security, and HTTP transport tests.
- Documentation for profile authors and operators.

### Out of Scope For First Iteration
- `stdio` support.
- Generic support for arbitrary non-JWT enterprise assertion formats.
- Multi-hop federation beyond one configured enterprise issuer per active policy.
- Dynamic policy loading from remote enterprise policy systems.
- Automatic role-to-tool authorization beyond scope/claim-to-policy mapping.

## Recommended Architecture Decision

### Decision
- Do not add `auth.type: "enterprise-managed"` to the existing interceptor auth union.
- Add a new top-level HTTP authorization capability in profiles, with dedicated runtime modules.
- Keep v1 to exactly one trusted issuer per profile.
- Introduce a dedicated grant router and a shared internal principal/token model for inbound auth.

### Rationale
- Existing `auth.type` represents outbound upstream API authentication.
- Enterprise managed authorization is inbound client-to-MCP authorization.
- Mixing both in one union would create ambiguous semantics, weak validation, and brittle runtime branching.
- Trust anchors, JWKS caching, replay protection, and concurrency budgets are server concerns and should not be modeled as purely profile-local behavior.

## Configuration Model

### Profile Policy Config

Add a new optional top-level block to `src/types/profile.ts`:

```ts
export interface Profile {
  // existing fields
  enterprise_authorization?: EnterpriseAuthorizationConfig;
}

export interface EnterpriseAuthorizationConfig {
  enabled: boolean;
  mode?: 'required' | 'optional';
  resource?: string;
  audience?: string | string[];
  issuer: EnterpriseIssuerConfig;
  token_exchange: EnterpriseTokenExchangeConfig;
  access_policy?: EnterpriseAccessPolicyConfig;
  metadata?: EnterpriseMetadataConfig;
}

export interface EnterpriseIssuerConfig {
  issuer: string;
  jwks_uri?: string;
  allowed_algs?: Array<'RS256' | 'RS384' | 'RS512' | 'ES256' | 'ES384' | 'ES512'>;
  allowed_kids?: string[];
  clock_skew_seconds?: number;
  require_signed_assertions?: boolean;
  trust_mode?: 'discovery' | 'explicit';
}

export interface EnterpriseTokenExchangeConfig {
  grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer';
  subject_token_type?: 'urn:ietf:params:oauth:token-type:id_token';
  required_typ?: string[];
  required_claims?: string[];
  max_assertion_ttl_seconds?: number;
  max_assertion_size_bytes?: number;
  replay_protection_ttl_seconds?: number;
  allowed_client_ids?: string[];
}

export interface EnterpriseAccessPolicyConfig {
  claim_mappings?: {
    subject?: string;
    email?: string;
    groups?: string;
    tenant_id?: string;
    client_id?: string;
  };
  scopes_supported?: string[];
  default_scopes?: string[];
  required_scopes?: string[];
  allowed_tool_categories?: Array<'list' | 'read' | 'modify' | 'admin'>;
  allow_dynamic_client_registration?: boolean;
}

export interface EnterpriseMetadataConfig {
  authorization_servers?: string[];
  documentation_url?: string;
  display_name?: string;
  extensions?: Record<string, string | boolean | number | string[]>;
}
```

### Design Notes
- `enterprise_authorization` is intentionally separate from `interceptors.auth`.
- `mode: optional` allows coexistence with current OAuth for migration periods.
- v1 uses one issuer per profile to keep trust boundaries and cache behavior simple.
- `token_exchange` is data-driven and keeps grant-specific rules out of imperative branching.
- `access_policy` is scoped to authorization at the MCP boundary, not upstream API credentials.

### Server Runtime Config

Do not store all operational controls under profile JSON. Add server/runtime configuration for:

```ts
export interface EnterpriseAuthorizationRuntimeConfig {
  enabled: boolean;
  global_max_cached_jwks_keys?: number;
  global_max_cached_issuers?: number;
  global_max_replay_entries?: number;
  global_max_enterprise_tokens?: number;
  jwks_refresh_timeout_ms?: number;
  jwks_refresh_backoff_ms?: number;
  enterprise_grant_rate_limit_max?: number;
  enterprise_grant_rate_limit_window_ms?: number;
  enterprise_grant_max_concurrency_per_profile?: number;
}
```

Runtime config should come from server config/env/CLI, not from individual profiles. Profiles define policy; runtime config defines capacity and operational limits.

## Validation Rules

Implement structural validation via `src/types/profile.ts` -> `npm run generate-schemas` -> `profile-schema.json` and `src/generated-schemas.ts`. Add semantic validation through a dedicated enterprise validator invoked by `ProfileLoader`, not by expanding `ProfileLoader.validateLogic()` inline.

### Structural Rules
- `enterprise_authorization.enabled=true` requires HTTP transport compatibility in docs and runtime checks.
- `issuer` is required.
- `issuer.issuer` and `issuer.jwks_uri`, when present, must be absolute HTTPS URLs unless explicitly allowed in tests/dev-only fixtures.
- `allowed_algs` must exclude `none` and symmetric algorithms in v1.
- `token_exchange.grant_type` must be fixed to JWT bearer grant.
- `max_assertion_ttl_seconds` must be bounded. Recommended default: `300`.
- `max_assertion_size_bytes` must be bounded. Recommended default: `16384`.
- `replay_protection_ttl_seconds` must be bounded. Recommended default: `600`.

### Semantic Rules
- `resource` and `audience` must not conflict; define clear precedence:
  - Recommended: validate `aud` against `resource` when `resource` is present, otherwise against `audience`.
- `allowed_client_ids`, if configured, must be unique.
- `required_typ`, if configured, must be unique and case-sensitive.
- `required_claims` must be unique and must include claims needed by configured claim mappings.
- `default_scopes` must be a subset of `scopes_supported` when both are set.
- `required_scopes` must be a subset of `scopes_supported` when both are set.
- `allow_dynamic_client_registration=false` must block enterprise token exchange for unknown clients unless an explicit public compatibility policy is configured.
- Reject profiles that enable both `enterprise_authorization.enabled=true` and incompatible auth metadata that would expose contradictory discovery behavior.

### Validation Module Design
- Add `src/profile/enterprise-profile-validator.ts`.
- `ProfileLoader` should call it after schema parsing and basic normalization.
- The validator should return a normalized enterprise policy object instead of scattering normalization in transport code.

### Error Taxonomy
- Add typed errors to [src/core/errors.ts](/workspace/src/core/errors.ts):
  - `EnterpriseAuthorizationConfigurationError`
  - `EnterpriseTokenValidationError`
  - `EnterpriseTokenReplayError`
  - `EnterpriseIssuerDiscoveryError`
  - `EnterprisePolicyViolationError`
- Add a dedicated auth-error mapping layer that converts internal typed errors into consistent OAuth/HTTP responses.
- Never return raw JWT or unredacted assertion fragments in error messages or logs.

## Runtime Design

### New Modules
- `src/auth/enterprise-auth-provider.ts`
  - Owns enterprise assertion validation and claim extraction.
- `src/auth/inbound-auth-principal.ts`
  - Defines a canonical internal `AuthorizedPrincipal` model shared by OAuth and enterprise flows.
- `src/auth/inbound-auth-token-store.ts`
  - Owns opaque internal token issuance, verification, expiry, and profile binding for all inbound auth modes.
- `src/auth/jwks-cache.ts`
  - Bounded JWKS fetch/cache with TTL, single-flight refresh, key rotation handling, and SSRF controls.
- `src/auth/enterprise-replay-store.ts`
  - Bounded replay detection using `jti` or assertion digest with incremental eviction on write.
- `src/auth/enterprise-policy.ts`
  - Maps validated claims to MCP authorization context and scopes.
- `src/auth/enterprise-metadata.ts`
  - Builds discovery metadata extensions consistently.
- `src/auth/auth-error-mapper.ts`
  - Maps typed auth errors to stable transport responses.
- `src/auth/auth-redaction.ts`
  - Centralized redaction for assertions, JWTs, and secret-bearing auth payloads.
- `src/transport/oauth-grant-router.ts`
  - Routes `/oauth/token` requests to grant-specific handlers with strict parameter allowlists.

### Changes To Existing Components
- [src/types/profile.ts](/workspace/src/types/profile.ts)
  - Add new config types.
- [src/profile/profile-loader.ts](/workspace/src/profile/profile-loader.ts)
  - Invoke enterprise validator/normalizer.
- [src/transport/http-transport.ts](/workspace/src/transport/http-transport.ts)
  - Delegate `/oauth/token` handling to a grant router.
  - Load enterprise provider state per profile.
  - Expose metadata for supported enterprise extension behavior.
- [src/auth/oauth-provider.ts](/workspace/src/auth/oauth-provider.ts)
  - Keep current OAuth provider focused on authorization code and refresh token flows.
  - Reuse shared inbound principal/token primitives where appropriate.

### Runtime Boundaries
- `ExternalOAuthProvider` remains responsible for OAuth client/proxy flows.
- `EnterpriseAuthProvider` handles inbound enterprise assertion processing.
- Shared inbound token/principal services own opaque token issuance and verification for both OAuth and enterprise flows.
- `HttpTransport` orchestrates profile-specific provider selection and delegates grant handling to a router.

## Token Flow Plan

### Incoming Enterprise Token Exchange
1. Client calls `/oauth/token` with `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer`.
2. Request validator enforces content type, body size, and required parameters.
3. Profile runtime resolves `enterprise_authorization` for the active profile.
4. `EnterpriseAuthProvider` validates issuer, JWKS signature, `alg`, `kid`, `exp`, `nbf`, `iat`, `iss`, `aud`, `typ`, and configured claim requirements.
5. Replay store rejects reused assertions based on `jti` or assertion digest.
6. Policy module derives a canonical internal `AuthorizedPrincipal`, scopes, and optional client constraints.
7. Shared inbound token store mints an opaque MCP access token bound to profile, subject, issuer, client, and scopes.
8. Server returns MCP access token representation compatible with current session initialization flow.
8. Session initialization uses derived auth context without requiring upstream PAT injection.

### Access Token Shape
- Reuse a shared internal token/session model across OAuth and enterprise flows.
- Prefer internal opaque MCP access tokens over directly reusing enterprise assertions as bearer tokens.
- Keep enterprise assertion details out of client-visible token payloads unless the spec requires otherwise.

### Recommendation
- Mint internal opaque access tokens after validating the enterprise assertion.
- Store minimal derived auth context server-side:
  - subject
  - issuer
  - client_id
  - scopes
  - tenant hint
  - expiry

This reduces token leakage impact, decouples session behavior from upstream assertion shape, and simplifies revocation/replay handling.

## Discovery And Metadata Plan

### Protected Resource Metadata
- Extend `/.well-known/oauth-protected-resource/mcp` output when enterprise authorization is enabled.
- Keep current behavior intact for clients that only understand existing OAuth metadata.
- Add extension fields only when explicitly configured and only if they do not break current tests/clients.

### Authorization Server Metadata
- Extend `/.well-known/oauth-authorization-server` to advertise support for:
  - JWT bearer grant type
  - supported subject token types, when applicable
  - any extension identifiers required by the enterprise-managed authorization draft

### Compatibility Principle
- Existing OAuth clients must continue to work when `enterprise_authorization.mode='optional'`.
- When `mode='required'`, initialization and token acquisition paths should fail deterministically with typed OAuth-style errors if the client attempts unsupported flows.

## Security Plan

### Threat Model
- Malicious client submits forged assertion.
- Malicious client replays a previously valid assertion.
- Attacker uses crafted issuer/JWKS URLs for SSRF.
- Attacker exploits weak algorithm handling (`alg=none`, key confusion, symmetric/asymmetric confusion).
- Attacker submits oversized JWT or deeply nested metadata to exhaust CPU/memory.
- Attacker exploits stale JWKS cache during key rotation.
- Logs leak assertions, claims, tokens, or upstream credentials.
- Multi-tenant profile routing causes issuer/policy confusion across profiles or sessions.

### Mandatory Security Controls

#### Issuer Trust
- Only trust configured issuers.
- Require HTTPS for issuer and JWKS endpoints in production code.
- Run issuer/JWKS fetches through existing SSRF protections.
- Allow explicit `jwks_uri` override to avoid unsafe discovery dependency when needed.

#### JWT Validation
- Use a vetted JOSE/JWT library instead of hand-rolled crypto.
- Enforce exact algorithm allowlist from config.
- Reject `alg=none`.
- Verify `kid` handling safely; do not select keys by attacker-controlled fields without issuer-bound key set lookup.
- Validate `iss`, `aud`, `exp`, `nbf`, `iat`, and `typ`.
- Bound acceptable clock skew with a small default. Recommended: `60` seconds.

#### Replay Protection
- Require `jti` if the enterprise flow guarantees it; otherwise use a digest fallback with shorter TTL.
- Store replay entries in a bounded TTL store with incremental eviction on write.
- Reject replays deterministically and log only correlation-safe metadata.

#### Request Hardening
- Enforce body size limit specific to enterprise assertion exchange.
- Enforce parameter allowlist for JWT bearer grant.
- Validate assertion encoding before deeper parsing.
- Bound per-profile concurrent validation operations.
- Add grant-confusion protection by rejecting parameters that do not belong to the active grant path.

#### Caching And Rotation
- Cache JWKS responses with bounded TTL and size.
- Honor rotation by refetching when `kid` is unknown, but with rate limiting and backoff.
- Do not refetch unboundedly on every unknown `kid`.
- Deduplicate concurrent refreshes per issuer with single-flight behavior.

#### Logging And Observability
- Redact JWTs and any field named `assertion`, `subject_token`, `access_token`, `refresh_token`.
- Centralize redaction in a reusable auth redaction utility used by logger and error serialization paths.
- Emit counters for:
  - validation success/failure
  - replay rejections
  - unknown issuer
  - JWKS refresh success/failure
  - policy rejection
- Include correlation IDs in client-facing errors.

#### Session Binding
- Bind internal access tokens to:
  - active profile ID
  - issuer
  - subject
  - client ID
  - derived scopes
- Prevent use of tokens across profile routes and tenant contexts.

### Security Defaults
- `enterprise_authorization.enabled` defaults to false.
- `mode` defaults to `optional` only if existing OAuth is configured for the same profile; otherwise default to `required`.
- `allow_dynamic_client_registration` defaults to false.
- `allowed_algs` defaults to a conservative asymmetric set.
- Opaque internal access tokens are preferred by default.

## Data Model And Session Plan

### Canonical Authorized Principal

All inbound auth modes should normalize to one internal shape:

```ts
export interface AuthorizedPrincipal {
  authType: 'oauth' | 'enterprise' | 'token';
  profileId: string;
  issuer?: string;
  subject: string;
  clientId?: string;
  scopes: string[];
  groups?: string[];
  tenantId?: string;
  expiresAt?: number;
  claimsHash?: string;
}
```

### Profile Runtime State

Extend HTTP profile runtime state with:

```ts
enterpriseAuthProvider: EnterpriseAuthProvider | null;
enterpriseGrantLimiter?: RequestHandler;
enterpriseGrantConcurrencyGate?: EnterpriseConcurrencyGate;
```

### Session Initialization
- Reuse the current initialization/session machinery where possible.
- During bearer token verification, detect whether the token is:
  - existing OAuth-derived internal token
  - enterprise-derived internal token
  - raw bearer/API token path from existing profiles
- Keep the verification path deterministic and profile-bound.
- Enforce profile and tenant isolation during token verification, not only during session creation.

## Implementation Phases

### Phase 1: Types, Schema, Validation
- Add `enterprise_authorization` types in `src/types/profile.ts`.
- Run `npm run generate-schemas`.
- Run `npm run check-schema-sync`.
- Add `src/profile/enterprise-profile-validator.ts`.
- Add loader tests for valid and invalid configurations.

### Phase 2: Provider And Security Primitives
- Implement `EnterpriseAuthProvider`.
- Implement canonical inbound principal/token primitives.
- Implement JWKS cache and replay store.
- Implement auth-error mapper and auth-redaction utility.
- Add typed enterprise auth errors.
- Add unit tests for:
  - issuer validation
  - JWT validation
  - claim requirements
  - replay detection
  - JWKS rotation/error handling
  - redaction behavior

### Phase 3: HTTP Transport Integration
- Add `/oauth/token` grant router with per-grant handlers and strict parameter allowlists.
- Add enterprise metadata output.
- Integrate internal opaque token minting and verification.
- Add HTTP transport tests for success and failure paths.

### Phase 4: Policy Enforcement And Compatibility
- Add claim-to-scope mapping.
- Define interaction with existing OAuth modes.
- Add multi-profile and tenant-aware tests.
- Verify no behavior regression for current OAuth authorization code flow.
- Add global and per-profile capacity limits for enterprise caches and tokens.

### Phase 5: Docs And Operational Guidance
- Update `README.md`, `docs/OAUTH.md`, and `docs/PROFILE-GUIDE.md`.
- Add example profile under `profiles/` only if there is a realistic enterprise example that does not embed secrets.
- Update `CHANGELOG.md`.

## Test Plan

### Unit Tests
- `src/profile/profile-loader.test.ts`
  - valid config
  - missing issuer
  - invalid algorithm
  - conflicting scope config
  - invalid discovery URLs
- `src/auth/enterprise-auth-provider.test.ts`
  - valid assertion exchange
  - invalid issuer
  - invalid audience
  - expired token
  - future `nbf`
  - missing required claim
  - wrong `typ`
  - unsupported `alg`
  - unknown `kid`
  - JWKS refresh path
  - replay rejection
  - grant-confusion parameter rejection
- `src/auth/jwks-cache.test.ts`
  - cache hit/miss
  - bounded growth
  - refresh backoff
  - SSRF rejection
  - single-flight refresh for concurrent unknown `kid`
- `src/auth/auth-redaction.test.ts`
  - assertion redaction
  - JWT redaction
  - error detail redaction

### HTTP Transport Tests
- `src/transport/http-transport.test.ts`
  - metadata advertises JWT bearer grant
  - `/oauth/token` enterprise grant success
  - `/oauth/token` rejects unsupported parameters
  - `/oauth/token` rejects invalid assertion
  - `/oauth/token` rejects replay
  - profile routing keeps issuer policies isolated
  - token minted for profile A is rejected on profile B
  - token minted for tenant A is rejected on tenant B
- `src/transport/http-transport-security.test.ts`
  - body size limits
  - malformed JWT handling
  - unknown issuer handling
  - `alg=none` rejection
  - symmetric algorithm rejection
  - SSRF defense on discovery/JWKS fetch
  - grant-confusion matrix across `authorization_code`, `refresh_token`, and JWT bearer grant
  - redaction assertions for logs and serialized errors

### Integration Tests
- Reuse mock HTTP/JWKS servers in `src/testing/`.
- Add deterministic JWKS rotation fixtures and replay fixtures.
- Add end-to-end validation of:
  - discovery
  - assertion exchange
  - initialize request with issued token
  - session expiry
  - profile isolation misuse
  - tenant isolation misuse

### Regression Coverage
- Existing OAuth authorization code and refresh token tests must continue to pass unchanged.
- Existing bearer/custom-header/session-cookie flows must continue to pass unchanged.

## Operational Guidance

### Config Defaults
- Keep feature disabled by default.
- Require explicit enterprise issuer configuration.
- Document that HTTP deployment should be behind TLS in production.

### Observability
- Add metrics and structured logs for enterprise validation outcomes.
- Expose enough signals to debug issuer/JWKS problems without exposing tokens.

### Performance Limits
- Maximum assertion size.
- Maximum JWKS document size.
- Maximum number of cached keys per profile.
- Global maximum number of cached issuers/keys.
- Global maximum number of replay entries.
- Global maximum number of enterprise-issued access tokens.
- Enterprise grant must have explicit rate limit and concurrency limit separate from current OAuth authorization flows.

### Capacity Model
- Define both per-profile budgets and process-wide budgets.
- Reject or shed new enterprise token-exchange work deterministically when capacity is exhausted.
- Do not rely on periodic cleanup alone for replay/JWKS/token stores.

## Open Design Questions

### 1. Internal Token Format
- Recommended: opaque internal tokens.
- Alternative: signed internal JWTs.
- Recommendation: opaque first, because revocation, replay, and profile binding are simpler.

### 2. Multi-Issuer Behavior
- Recommended: one issuer per profile in v1.
- Alternative: multiple issuers per profile in a future phase.
- Recommendation: keep v1 single-issuer and revisit multi-issuer only after token routing, isolation, and cache budgets are proven.

### 3. Discovery Source
- Recommended: explicit issuer/JWKS configuration with optional well-known discovery.
- Alternative: mandatory discovery.
- Recommendation: support both, prefer explicit overrides for production predictability.

### 4. Policy Granularity
- Recommended: claim-to-scope mapping only in v1.
- Alternative: full tool-level authorization policy engine now.
- Recommendation: defer tool-level policy engine. It is a separate authorization problem and would slow delivery materially.

## Definition Of Done
- New profile types and generated schemas are in sync.
- Semantic validation covers success and failure paths.
- JWT bearer grant works for enterprise-managed authorization in HTTP transport.
- SSRF, replay, algorithm confusion, and token redaction controls are covered by tests.
- Grant-confusion, profile isolation, and tenant isolation misuse paths are covered by tests.
- Shared inbound principal/token model is used by both OAuth and enterprise auth flows.
- Global and per-profile capacity limits are implemented and covered by tests.
- Existing OAuth and token-based auth regressions are clean.
- `npm run typecheck` passes.
- Relevant tests pass.
- Docs and changelog are updated.

## Suggested First Implementation Slice
- Add profile schema.
- Add loader validation.
- Add a minimal `EnterpriseAuthProvider` that validates a static test issuer with explicit JWKS URL.
- Extend `/oauth/token` for JWT bearer grant.
- Mint opaque internal access tokens.
- Add success/failure transport tests before broader discovery/policy features.

This slice is the smallest credible path that proves the architecture without prematurely committing to broader enterprise policy complexity.
