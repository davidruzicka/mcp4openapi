# Requirements - Enterprise MCP Gateway

Generated: 2026-03-27
Project: mcp4openapi enterprise MCP proxy/gate
Milestone: v1 - Proxy foundation + security gate

---

## v1 Requirements

### Proxy Core

- [ ] **PROXY-01**: A downstream client session connecting to a profile backed by an upstream MCP server
  creates a per-session upstream HTTP connection on first tool use (lazy, not at session init)
- [ ] **PROXY-02**: Client-supplied upstream credentials (Bearer token, custom header, OAuth token)
  provided at session initialization are stored in the session context and forwarded to the upstream
  MCP server for all requests in that session; the gateway stores no credentials server-side
- [ ] **PROXY-03**: A tools/list request from a downstream client returns the tool list fetched from
  the upstream MCP server defined in the active profile (same profile-per-upstream model as OpenAPI
  profiles; no aggregation or namespacing across providers)
- [ ] **PROXY-04**: A tools/call request is routed to the upstream MCP server defined in the active
  profile and the upstream response is returned to the downstream client with typed error mapping for
  upstream failure cases

### Client Authentication

- [ ] **AUTH-01**: Inbound client presenting a JWT is validated against the JWKS endpoint of the
  configured identity provider (Entra ID, Okta, or Keycloak); session is rejected if validation
  fails before any upstream connection is made
- [ ] **AUTH-02**: Inbound M2M client presenting an API key is validated against a configured API
  key store; a valid key resolves to a client identity before session is established
- [ ] **AUTH-03**: Client identity (resolved from SSO JWT or API key) is attached to the session
  context and included in every audit log entry for that session

### Security

- [ ] **SEC-01**: Tool definitions received from an upstream MCP server are sanitized before being
  forwarded to downstream clients; tool names and descriptions are validated against a safe-string
  allowlist to prevent tool poisoning and prompt injection via upstream tool metadata
- [ ] **SEC-02**: Upstream credential values are redacted from all logs, error responses, and
  diagnostic output; existing token-redaction infrastructure is extended to cover the new
  upstream-credential session fields

### Observability

- [ ] **OBS-01**: Every tools/call request produces a structured audit log entry containing: session
  ID, resolved client identity, tool name, upstream server URL (host only, no credentials),
  invocation outcome (success/error code), and wall-clock duration
- [ ] **OBS-02**: Prometheus metrics expose per-upstream and per-client-identity counters and
  latency histograms for tools/list and tools/call requests; existing prom-client registry is
  extended (no second registry)
- [ ] **OBS-03**: GET /health returns 200 when the server is running; GET /ready returns 200 when
  at least one profile is loaded and the server can accept sessions; both endpoints are unauthenticated

### Reliability

- [ ] **REL-01**: Application-level heartbeat pings are sent on upstream SSE connections at a
  configurable interval (default 30s) to detect silent disconnects before a tool call fails
- [ ] **REL-02**: A session reaper runs on a configurable interval (default 60s) and closes
  upstream connections for sessions that have been inactive beyond the session timeout; no upstream
  connections are leaked when downstream clients disconnect without explicit close
- [ ] **REL-03**: Upstream failure cases (connection timeout, auth failure, server unavailable,
  malformed response) produce typed error responses to the downstream client with correlation IDs;
  no raw stack traces or upstream credential fragments in error payloads
- [ ] **REL-04**: Upstream notifications/tools/list_changed events received on a live upstream
  session are forwarded to the connected downstream SSE client; if no stream is attached,
  notifications are queued and replayed on reconnect using existing SSE replay infrastructure

---

## v2 Requirements (Deferred)

### Policy

- Team-level allow/deny policy: client identity maps to a policy that allows or denies specific
  upstream MCP servers or tool name patterns - deferred until v1 adoption demonstrates which
  granularity teams need
- Policy dry-run mode: evaluate policy without enforcing, surface what would be denied

### Observability

- OpenTelemetry request tracing with trace context propagated to upstream MCP servers - deferred
  until core pipeline is stable; audit log + Prometheus covers operational needs for v1
- Per-tool budget and rate limiting by team identity

### Upstream Sources

- Third-party SaaS MCP endpoints (GitHub, Slack, etc.) - same model as internal HTTP upstreams,
  unblocked by v1; explicit phase for auth/trust configuration differences
- Stdio upstream MCP processes - deferred until process isolation boundary is defined

### Advanced Proxy

- Tool definition pinning: administrator can pin upstream tool schemas to detect upstream rug-pull
  changes between deployments

---

## Out of Scope

- Server-side upstream credential storage - pass-through model replaces the need; no vault
  integration in scope
- Tool namespacing/aggregation across multiple upstream providers in a single profile - profile-
  per-upstream model is the architecture; aggregation is a separate product decision
- Attribute-based access control (ABAC) - team allow/deny covers v1; ABAC adds authoring overhead
- Admin UI - CLI and profile config files are the management interface
- Public internet / multi-cloud SaaS distribution - on-prem/private cloud deployment only

---

## Traceability

| REQ-ID | Phase | Status |
|--------|-------|--------|
| PROXY-01 | Phase 1 | Pending |
| PROXY-02 | Phase 1 | Pending |
| PROXY-03 | Phase 2 | Pending |
| PROXY-04 | Phase 2 | Pending |
| AUTH-01 | Phase 3 | Pending |
| AUTH-02 | Phase 3 | Pending |
| AUTH-03 | Phase 3 | Pending |
| SEC-01 | Phase 2 | Pending |
| SEC-02 | Phase 1 | Pending |
| OBS-01 | Phase 4 | Pending |
| OBS-02 | Phase 4 | Pending |
| OBS-03 | Phase 4 | Pending |
| REL-01 | Phase 1 | Pending |
| REL-02 | Phase 1 | Pending |
| REL-03 | Phase 1 | Pending |
| REL-04 | Phase 2 | Pending |
