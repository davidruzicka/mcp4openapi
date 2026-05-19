# mcp4openapi - Enterprise MCP Gateway

## What This Is

A centralized, enterprise-grade MCP gateway that acts as the single front door for all AI clients
inside the company to reach upstream MCP servers. It authenticates clients via SSO/OIDC or API
keys, enforces team-level tool access policies, and forwards tool calls to upstream remote HTTP MCP
servers (internal services and third-party SaaS) using credentials supplied by the client at session
initialization - the gateway itself stores no upstream secrets.

Built on top of the existing mcp4openapi server, extending it from an OpenAPI-to-MCP adapter into a
full MCP proxy/gate.

## Core Value

A security boundary between internal AI clients and all upstream MCP servers: one place to
authenticate, authorize, audit, and proxy every tool call in the company.

## Requirements

### Validated

- Existing capabilities already shipped and working:
- ✓ MCP server over HTTP (SSE, sessions, MCP spec 2025-03-26) - existing
- ✓ Profile-driven configuration with Zod-validated schemas - existing
- ✓ OpenAPI-backed tool generation from REST APIs - existing
- ✓ OAuth 2.0 provider (PKCE, DCR, token exchange) - existing
- ✓ Multi-auth support (bearer, query, custom header, OAuth) - existing
- ✓ Multi-tenant HTTP transport with session isolation - existing
- ✓ Rate limiting, SSRF protection, token redaction - existing
- ✓ Prometheus metrics emission (prom-client) - existing
- ✓ Upstream MCP provider config schema (UpstreamMcpProvider type, Zod schemas) - existing (PR #219)

### Validated

- ✓ Upstream session lifecycle (Phase 01) - per-session `UpstreamConnectionManager` with lazy connect, concurrent-safe `getOrConnect`, heartbeat pings, and session-scoped cleanup wired into HTTP transport destruction lifecycle
- ✓ Pass-through credential forwarding (Phase 01) - client-supplied Bearer token forwarded directly to upstream; profile-per-upstream model; no credential storage on gateway; `validateCredentials` with SSRF-protected `validation_endpoint` for early auth validation
- ✓ Auth redaction hardening (Phase 01) - `sanitizeAuthErrorMessage` preserves last-4 Bearer suffix for debuggability; `redactString` fully redacts; token never appears in logs or error responses
- ✓ Upstream tool discovery and proxy (Phase 02) - `tools/list` and `tools/call` forwarded to correct upstream provider; upstream tools namespaced by provider; `NotificationQueue` with TTL eviction for `tools/list_changed` replay on reconnect; `sendToClient` SSE real-time dispatch
- ✓ API key authentication gate (Phase 03) - inbound M2M clients validated via inline env-var API keys before session establishment; `ClientAuthGate` runs after enterprise auth, before any upstream connection; `SessionData.clientPrincipal` populated with resolved identity (`subject`, `authType`, `scopes`); HMAC-SHA256 timing-safe comparison; fail-fast profile-load validator
- ✓ upstream_mcp singular constraint (Phase 03.1) - Profile.upstream_mcp narrowed from UpstreamMcpServerConfig[] to UpstreamMcpServerConfig; Zod schema rejects array shape at parse time with migration hint; all call sites (mcp-server.ts, http-transport.ts, profile-resolver.ts) narrowed; BREAKING CHANGE: profile JSON must use `upstream_mcp: {...}` not `upstream_mcp: [{...}]`
- ✓ Admin-supplied HTML profile descriptions (Phase 03.2) - `MCP4_PROFILES_DESCRIPTION` env var (JSON object: profile key → HTML string) parsed once at startup; keys matched against profileId/profileName/aliases; resolved adminDescription stored per-profile and rendered raw (no escaping) in HTML index detail card before the profile's own description; duplicate-key resolution and invalid JSON cause process exit at startup (fail-fast); sidebar list view unchanged
- ✓ Graceful OAuth degradation (Phase 03.3) - `isOAuthConfigOperational()` pre-flight check added to `oauth-provider.ts`; when OAuth config is incomplete (missing env vars, missing redirect_uri) the server sets `oauthDisabledReason` in `ProfileRuntimeState`, skips `ExternalOAuthProvider` construction, omits the OAuth tab from the HTML index, and never sends a 401 OAuth challenge; warning logged once per profile at load time; complete OAuth config behavior unchanged
- ✓ Encrypted token envelopes (Phase 03.4) - AES-256-GCM encrypted `mcp4.v1.*` tokens embed access_token + refresh_token + DCR client registration; gateway decrypts on session init for restart-resilient OAuth in k8s; `MCP4_OAUTH_KEY` (32-byte hex); `isEncryptedToken()` prefix guard; encrypt-failure degrades to plain Bearer (availability bias); backward-compatible
- ✓ Observability (Phase 04) - structured `audit:tool_call` INFO log at every tool-call outcome (sessionId, clientPrincipal, tool, upstreamHost, outcome, durationMs); Prometheus `upstream_host` + `client_identity` label dimensions on mcp_tool_calls_total/duration/errors; client_identity audit-log only (cardinality guard); GET /ready readiness probe returns 503 until at least one profile loaded

### Active

- [ ] **AUTH-01** (v1.1 Phase 6) - OIDC JWT client validation against JWKS endpoint (Entra ID, Okta, Keycloak); session rejected before upstream connection; completes AUTH-03 for JWT path
- [ ] **AUTH-04** (v1.1 Phase 5) - Upstream OAuth proxy: gateway-initiated OAuth authorization code flow against upstream MCP servers; encrypted refresh token in gateway token; zero-reauth on k8s restart
- [ ] Tool namespacing - upstream tool names prefixed/namespaced to prevent collisions across
  providers (#215)
- [ ] Team-level allow/deny policy - each client identity (team/API key/SSO principal) maps to a
  policy that allows or denies specific upstream servers and/or tool names (#216)
- [ ] Third-party SaaS MCP proxy - remote HTTP MCP endpoints for services like GitHub, Slack, etc.
  supported through the same upstream provider config model

### Out of Scope

- Stdio upstream MCP processes - execution boundary undefined, risk of process isolation issues;
  deferred to a later phase behind an explicit feature gate (#217)
- Server-side upstream credential storage - pass-through model replaces the need; vault integration
  adds complexity without benefit given the chosen auth model
- Attribute-based access control (ABAC) - team-level allow/deny covers v1 needs; ABAC adds
  authoring overhead before any team has adopted the gateway
- Public internet exposure - on-prem/private cloud deployment only; no multi-cloud SaaS distribution
  in scope

## Context

- **Shipped v1.0:** 8 phases, 25 plans, 58 tasks. TypeScript/Node.js 22, ESM, ~3333 passing tests. Core proxy pipeline (upstream session + tool forwarding + API key auth + observability) is production-ready.
- **Current state:** The gateway proxies tools/list and tools/call to upstream HTTP MCP servers, authenticates M2M clients via API keys, emits per-tool audit logs and Prometheus metrics, and handles OAuth sessions with encrypted restart-resilient tokens. OIDC JWT auth (AUTH-01) is the main missing capability for interactive user flows.
- **Tracking issue:** davidruzicka/mcp4openapi#211 groups the full MCP proxy roadmap. #212 (upstream config schema) done. #213-#218 map to requirements; most closed in v1.0.
- **Deployment target:** On-prem / private cloud. Docker/Kubernetes. MCP4_OAUTH_KEY required for encrypted token envelopes in k8s restarts.
- **Client auth model:** API keys (v1.0 complete); SSO/OIDC (AUTH-01, v1.1). Both paths resolve to clientPrincipal before upstream connection.
- **Upstream auth model:** Pass-through. Client-supplied credentials forwarded per-session. No gateway-side credential storage.
- **Security posture:** SSRF protection, token redaction, timing-safe key comparison, cardinality-guarded Prometheus labels. Trust boundaries: client auth and upstream auth are fully separate layers.

## Constraints

- **Tech stack:** TypeScript 5 / Node.js 22 / ESM - no runtime changes; extend, don't replace
- **MCP protocol:** MCP spec 2025-03-26 compliance must be preserved end-to-end (client <-> gateway
  <-> upstream)
- **Security:** Inbound client identity must be verified before any upstream connection is
  established; upstream credentials must never leak into logs or error responses
- **Compatibility:** Existing OpenAPI-backed tool generation must continue working unchanged;
  proxy mode is additive, not a replacement

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Pass-through upstream credentials | Gateway stores no secrets - client owns their own upstream tokens; simpler security model, no vault dependency | ✓ Validated v1.0 - profile-per-upstream model, `token: string \| undefined` passed directly |
| Profile-per-upstream (not session-level credential aggregation) | Simpler than per-session credential bag; one profile = one upstream = one token env var | ✓ Validated v1.0 - dead X-Upstream-Authorization extractor removed |
| API keys before OIDC JWT (Phase 3 before Phase 6) | M2M is the dominant first use case; deferring JWT avoids jose/JWKS dependency until needed | ✓ Validated v1.0 - API key gate ships clean without JWT entanglement; Phase 4 deferral guard test confirmed |
| AES-256-GCM encrypted token envelopes (not persistent session storage) | No DB dependency for restart resilience; token is the session; client re-presents on reconnect | ✓ Validated v1.0 - MCP4_OAUTH_KEY + mcp4.v1.* prefix; encrypt-failure degrades gracefully |
| client_identity audit-log only (not Prometheus label) | Unbounded identity set → unbounded cardinality in Prometheus; audit log handles identity-level queries | ✓ Validated v1.0 - caps at 64 chars in audit; upstream_host capped at 128 chars |
| Remote HTTP upstream first, stdio deferred | Stdio adds process isolation complexity; HTTP upstream covers the primary enterprise use case first | - Pending (v2.0+) |
| Build on mcp4openapi transport stack | Existing SSE session management, OAuth provider, multi-tenant HTTP transport are production-grade; extend rather than rewrite | ✓ Validated v1.0 - interceptor chain (auth→rate-limit→retry→fetch) unchanged |
| Team-level allow/deny (not RBAC/ABAC) | Explicit allow/deny per team is auditable and predictable; ABAC adds authoring overhead before adoption | - Pending (v1.1+) |
| Tool namespacing by upstream provider | Prevents tool name collisions across providers; makes audit logs and policy rules unambiguous | - Pending (v1.1+) |

---
*Last updated: 2026-05-19 after v1.0 milestone completion — 8 phases shipped; AUTH-01 (OIDC JWT) deferred to v1.1; upstream OAuth proxy (Phase 5) deferred to v1.1*

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd:transition`):
1. Requirements invalidated? -> Move to Out of Scope with reason
2. Requirements validated? -> Move to Validated with phase reference
3. New requirements emerged? -> Add to Active
4. Decisions to log? -> Add to Key Decisions
5. "What This Is" still accurate? -> Update if drifted

**After each milestone** (via `/gsd:complete-milestone`):
1. Full review of all sections
2. Core Value check - still the right priority?
3. Audit Out of Scope - reasons still valid?
4. Update Context with current state
