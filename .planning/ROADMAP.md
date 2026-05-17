# Roadmap: Enterprise MCP Gateway

## Overview

Transform mcp4openapi from an OpenAPI-to-MCP adapter into an enterprise MCP gateway that proxies tool calls to upstream remote HTTP MCP servers. The build order follows the dependency graph: upstream session infrastructure first (everything depends on it), then tool discovery and call forwarding, then API key auth gate, then observability, then upstream OAuth proxy (encrypted token payload, refresh token support), then OIDC JWT auth gate. Each phase delivers a coherent, testable capability on top of the existing HTTP transport, session management, and interceptor chain.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [ ] **Phase 1: Upstream Session Foundation** - Per-session upstream MCP connections with credential forwarding, heartbeats, cleanup, and typed error handling
- [ ] **Phase 2: Tool Discovery and Call Proxy** - tools/list and tools/call forwarded to upstream MCP servers with sanitization and notification relay
- [ ] **Phase 3: Client Authentication Gate (API Keys)** - API key identity verification before any upstream resource is consumed
- [ ] **Phase 4: Observability** - Structured audit logging, Prometheus gateway metrics, and health/readiness endpoints
- [ ] **Phase 5: Upstream OAuth Proxy** - Gateway-initiated OAuth authorization code flow against upstream MCP servers; encrypted refresh token payload in gateway token; zero-reauth on restart
- [ ] **Phase 6: Client Authentication Gate (OIDC JWT)** - JWT/JWKS identity verification, OIDC discovery, session identity completion

## Phase Details

### Phase 1: Upstream Session Foundation
**Goal**: A downstream client session can establish, maintain, and cleanly tear down a connection to an upstream HTTP MCP server using client-supplied credentials
**Depends on**: Nothing (first phase; builds on existing UpstreamMcpProvider config schema from PR #219)
**Requirements**: PROXY-01, PROXY-02, REL-01, REL-02, REL-03, SEC-02
**Success Criteria** (what must be TRUE):
  1. A downstream session backed by an upstream MCP profile lazily creates an upstream HTTP connection on first tool use, not at session initialization
  2. Client-supplied upstream credentials (Bearer token, custom header) provided at session init are forwarded to the upstream MCP server and never appear in any log output, error response, or diagnostic endpoint
  3. Upstream connection failures (timeout, auth rejection, unavailable, malformed response) return typed MCP error responses to the downstream client with correlation IDs and no leaked credentials or stack traces
  4. Inactive sessions are reaped on a configurable interval and all associated upstream connections are explicitly closed; no upstream connections leak when downstream clients disconnect without clean close
  5. Application-level heartbeat pings detect silent upstream SSE disconnects before a tool call fails
**Plans**: 5 plans

Plans:
- [x] 01-01-PLAN.md - Types, errors, credential store, and redaction extension (PROXY-02, REL-03, SEC-02)
- [x] 01-02-PLAN.md - UpstreamConnectionManager with lazy getOrConnect and closeAll (PROXY-01, REL-02)
- [x] 01-03-PLAN.md - UpstreamHeartbeatManager with configurable pings (REL-01, REL-02, REL-03)
- [x] 01-04-PLAN.md - GAP CLOSURE: Remove dead X-Upstream-Authorization code, simplify to profile-per-upstream credential model (PROXY-02, SEC-02)
- [ ] 01-05-PLAN.md - GAP CLOSURE: Bearer redaction suffix preservation and optional validation_endpoint (SEC-02, REL-03)

### Phase 2: Tool Discovery and Call Proxy
**Goal**: Downstream clients can discover and invoke tools served by upstream MCP servers through the gateway
**Depends on**: Phase 1
**Requirements**: PROXY-03, PROXY-04, SEC-01, REL-04
**Success Criteria** (what must be TRUE):
  1. A tools/list request returns the tool list fetched from the upstream MCP server defined in the active profile
  2. A tools/call request is routed to the upstream MCP server and the response is returned to the downstream client, with upstream failures mapped to typed MCP errors
  3. Tool definitions received from upstream are sanitized before forwarding - tool names and descriptions are validated against a safe-string allowlist to prevent tool poisoning and prompt injection
  4. Upstream notifications/tools/list_changed events are forwarded to the connected downstream SSE client, with queuing and replay on reconnect for disconnected clients
**Plans**: 3 plans

Plans:
- [x] 02-01-PLAN.md - Tool sanitizer, notification queue, and profile mutual-exclusivity validation (SEC-01, REL-04, PROXY-03)
- [x] 02-02-PLAN.md - Upstream tools/list and tools/call handler wiring with error mapping (PROXY-03, PROXY-04, SEC-01)
- [x] 02-03-PLAN.md - Notification forwarding from upstream to downstream SSE with bounded queue replay (REL-04)

### Phase 3: Client Authentication Gate (API Keys)
**Goal**: M2M clients can be authenticated via API keys before any upstream resource is consumed; resolved identity attached to session
**Depends on**: Phase 1
**Requirements**: AUTH-02, AUTH-03 (partial)
**Success Criteria** (what must be TRUE):
  1. An inbound M2M client presenting an API key is validated against the configured key store (inline env-var keys) and resolved to a client identity before session establishment; Sasanka token-passthrough store added in Phase 4
  2. An invalid or missing API key when mode=required is rejected with HTTP 401 before any upstream connection
  3. The resolved client identity (API key path) is attached to the session as clientPrincipal and included in session-creation log entries
**Plans**: 3 plans

Plans:
- [x] 03-01-PLAN.md - Types (ApiKeyStoreConfig, ClientAuthGateConfig without jwt), ClientAuthGateError, schema sync, and profile-load-time validator (AUTH-02, AUTH-03)
- [x] 03-02-PLAN.md - ApiKeyStore interface, InlineApiKeyStore, and factory (AUTH-02; SasankaApiKeyStore deferred to Phase 4)
- [x] 03-03-PLAN.md - ClientAuthGate orchestrator (API key path only), http-transport wiring, session clientPrincipal attachment (AUTH-02, AUTH-03)

### Phase 03.4: encrypted-token-envelope (INSERTED)

**Goal:** Deliver AES-256-GCM encrypted token envelopes (`mcp4.v1.*`) so MCP OAuth clients survive gateway restarts in k8s without re-authenticating. After OAuth, gateway issues an encrypted token containing access_token + refresh_token + DCR client registration; on restart, client presents the same token, gateway decrypts and recovers session state. Backward-compatible: tokens without `mcp4.v1.` prefix continue to work as plain access tokens.
**Requirements**: TBD (locked decisions in 03.4-CONTEXT.md serve as acceptance criteria)
**Depends on:** Phase 03
**Plans:** 4/4 plans complete

Plans:
- [x] 03.4-01-PLAN.md - Pure crypto module src/auth/token-envelope.ts (encrypt/decrypt/deriveKey/isEncryptedToken) + 17-case TDD test suite
- [x] 03.4-02-PLAN.md - Wire MCP4_OAUTH_KEY into HttpTransportConfig (tokenKey?: Buffer field + buildHttpTransportBaseConfig parser) + tests
- [x] 03.4-03-PLAN.md - http-transport.ts integration: imports, DEFAULT_MAX_TOKEN_LENGTH=4096, startup warn, storeOAuthTokens refactor (returns string + registeredClient param), 3 call sites updated, session-init envelope-decrypt fallback with creg-driven registerClient
- [x] 03.4-04-PLAN.md - Documentation (env.example, README.md, docs/HTTP-TRANSPORT.md "Encrypted Token Envelopes" section, IMPLEMENTATION.md, CHANGELOG.md)

### Phase 03.3: Graceful OAuth degradation for incomplete config (INSERTED)

**Goal:** When an MCP profile has `auth.type = 'oauth'` but OAuth config is operationally incomplete (missing redirect_uri, or env vars not set), degrade gracefully instead of crashing with 500 or starting a broken OAuth flow. Reflect degradation on the HTML profile index page (hide OAuth auth tab/snippets when not operational).
**Requirements**: DEGRADE-01
**Depends on:** Phase 3
**Plans:** 2/2 plans complete

Plans:
- [x] 03.3-01-PLAN.md — isOAuthConfigOperational helper + OAuthOperationalCheck interface in oauth-provider.ts + unit tests (DEGRADE-01)
- [x] 03.3-02-PLAN.md — Wiring: profile-resolver extractAuthMethods filter + http-transport ProfileRuntimeState + getProfileState pre-flight + auth gate guard + test coverage (DEGRADE-01)

### Phase 03.2: Profile env-var description field (INSERTED)

**Goal:** Add optional admin-supplied HTML description per profile via a server-wide `MCP4_PROFILES_DESCRIPTION` env var (JSON map of profile-id/name/alias → HTML string). Description renders raw (no sanitization) in the HTML index detail card immediately before the profile's own description. Sidebar list view is unchanged. Fail-fast at startup on invalid JSON or duplicate-resolution conflicts.
**Requirements**: TBD (locked decisions D-01..D-12 in 03.2-CONTEXT.md serve as acceptance criteria)
**Depends on:** Phase 03
**Plans:** 3/3 plans complete

Plans:
- [x] 03.2-01-PLAN.md — Pure module: parseProfilesDescriptionEnv + resolveProfileAdminDescriptions helpers + unit tests (D-01..D-09)
- [x] 03.2-02-PLAN.md — Wiring: buildProfileIndexPayload 4th-arg adminDescriptions + HttpTransport.setProfileAdminDescriptions setter + main() startup parse/resolve/setter (D-01, D-04, D-05, D-07..D-10)
- [x] 03.2-03-PLAN.md — HTML template patch: raw-HTML adminDescription div in renderDetail before profile.description; sidebar untouched; end-to-end raw-HTML pass-through tests (D-06, D-10, D-11, D-12)

### Phase 03.1: Remove multi upstream MCP support (INSERTED)

**Goal**: Profile.upstream_mcp narrowed end-to-end from UpstreamMcpServerConfig[] to UpstreamMcpServerConfig (singular). The runtime single-provider constraint already exists in profile-loader (D-03 check); this phase relocates it into the type system (Zod + TS), removes the now-dead loader runtime check, and migrates all consumers + test fixtures to the singular shape. Breaking change for end-user profile JSON/YAML using array syntax.
**Requirements**: (none — internal type-narrowing refactor; preserves PROXY-01..04 and SEC-02 without modifying them)
**Depends on:** Phase 03
**Plans:** 3/3 plans complete

Plans:
- [x] 03.1-01-PLAN.md — Source-of-truth types narrowed (profile.ts, http-transport.ts), generated schemas regenerated, resolver/parser/validator in upstream-mcp-config.ts singularised, profile-loader D-02 presence check + D-07 dead-code removal
- [x] 03.1-02-PLAN.md — Call-site cleanup in mcp-server.ts, http-transport.ts, profile-resolver.ts, generic-profile.test.ts, and the in-repo profile fixture (singular access end-to-end; legacy-array tolerance preserved in list-view UX per Open Question 1)
- [x] 03.1-03-PLAN.md — Test fixture migration across 5 test files (~112 sites), D-01 + D-03 negative test additions, dead loader-D-03 + empty-array tests removed; phase gate via full npm test green

### Phase 4: Observability
**Goal**: Every tool call is audited with identity and outcome; operators have metrics and health endpoints to monitor the gateway
**Depends on**: Phase 2, Phase 3
**Requirements**: OBS-01, OBS-02, OBS-03
**Success Criteria** (what must be TRUE):
  1. Every tools/call request produces a structured audit log entry containing session ID, resolved client identity, tool name, upstream server URL (host only), invocation outcome, and wall-clock duration
  2. Prometheus metrics expose per-upstream and per-client-identity counters and latency histograms for tools/list and tools/call requests, extending the existing prom-client registry
  3. GET /health returns 200 when the server is running; GET /ready returns 200 when at least one profile is loaded and the server can accept sessions; both endpoints are unauthenticated
**Plans**: 2 plans

Plans:
- [x] 04-01-PLAN.md - Extend MetricsContextLabels with upstream_host/client_identity, add labels to counters/histograms, audit log for all tools/call paths (OBS-01, OBS-02)
- [x] 04-02-PLAN.md - Add /ready readiness probe endpoint, update normalizePath for /ready (OBS-03)

### Phase 5: Upstream OAuth Proxy
**Goal**: Non-technical users can authorize gateway access to upstream MCP servers via a single OAuth browser confirmation; upstream tokens survive gateway restarts via encrypted payload in the gateway token
**Depends on**: Phase 1, Phase 3
**Requirements**: AUTH-04 (new)
**Success Criteria** (what must be TRUE):
  1. When a profile has an OAuth-protected upstream, connecting the profile in an MCP client (e.g. Cursor) triggers a single browser OAuth flow against the upstream's authorization server; no manual token handling required
  2. The upstream access token and refresh token are encrypted (AES-GCM, key from env var) and embedded in the gateway token issued to the client; gateway restart does not require re-authorization as long as the refresh token is valid
  3. When the upstream access token is expired, the gateway silently exchanges the refresh token for a new access token and re-issues the gateway token to the client without user interaction
  4. Upstream OAuth configuration (client_id, client_secret, authorization_endpoint, token_endpoint, scopes) is supplied per-profile in the profile config; gateway acts as confidential OAuth client
  5. SSRF validation applied to all upstream OAuth endpoint URLs; redirect URI registered with upstream matches gateway's configured base URL
**Plans**: TBD

Plans:
- [ ] 05-01: TBD
- [ ] 05-02: TBD
- [ ] 05-03: TBD

### Phase 6: Client Authentication Gate (OIDC JWT)
**Goal**: Clients bearing OIDC JWTs are validated against a JWKS endpoint; resolved identity completes AUTH-03
**Depends on**: Phase 3
**Requirements**: AUTH-01, AUTH-03 (complete)
**Success Criteria** (what must be TRUE):
  1. An inbound client presenting a JWT is validated against the JWKS endpoint of the configured identity provider (Entra ID, Okta, Keycloak); session is rejected before any upstream connection if validation fails
  2. OIDC discovery validates that the discovered issuer matches the configured issuer (prevents JWKS hijacking)
  3. The resolved JWT identity is attached to the session as clientPrincipal (authType='oauth') — completing AUTH-03 for the JWT path
**Plans**: TBD

Plans:
- [ ] 06-01: ClientAuthJwtConfig types, oidc-discovery utility, EnterpriseAuthProvider refactor (AUTH-01)
- [ ] 06-02: JWT path in ClientAuthGate, JwksCache wiring, integration tests (AUTH-01, AUTH-03)
- [ ] 06-03: SasankaApiKeyStore (token-passthrough via /api/v1/users/me), sasanka variant in ApiKeyStoreConfig, factory extension (AUTH-02)

## Progress

**Execution Order:**
Phases execute in numeric order: 1 -> 2 -> 3 -> 4 -> 5 -> 6

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Upstream Session Foundation | 5/5 | Complete | 2026-03-30 |
| 2. Tool Discovery and Call Proxy | 3/3 | Complete | 2026-03-30 |
| 3. Client Auth Gate (API Keys) | 3/3 | Complete | 2026-04-30 |
| 4. Observability | 1/2 | In Progress|  |
| 5. Upstream OAuth Proxy | 0/3 | Not started | - |
| 6. Client Auth Gate (OIDC JWT) | 0/3 | Not started | - |
