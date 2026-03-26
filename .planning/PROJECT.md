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

### Active

- [ ] Remote upstream MCP session lifecycle - per-downstream-session upstream connection manager for
  streamable HTTP MCP servers (#213)
- [ ] Pass-through credential forwarding - client-supplied tokens (Bearer, custom header, OAuth)
  provided at session initialize are forwarded to upstream MCP servers for that session; gateway
  stores no upstream secrets
- [ ] Upstream tool discovery and proxy - tools/list and tools/call forwarded to correct upstream
  provider; upstream tools appear in tools/list alongside (or instead of) OpenAPI-backed tools
- [ ] Tool namespacing - upstream tool names prefixed/namespaced to prevent collisions across
  providers (#215)
- [ ] Team-level allow/deny policy - each client identity (team/API key/SSO principal) maps to a
  policy that allows or denies specific upstream servers and/or tool names (#216)
- [ ] Client authentication gate - SSO/OIDC (Entra ID / Okta / Keycloak) for interactive clients;
  API keys for M2M; identity resolved before any tool call is processed
- [ ] Upstream notification forwarding - tools/list_changed and other server-initiated upstream
  notifications forwarded to downstream SSE clients with replay on reconnect (#214)
- [ ] Audit log - structured persistent log of every tool call: client identity, team, tool name,
  upstream server, outcome, timestamp
- [ ] Request tracing - OpenTelemetry trace context propagated through gateway and forwarded to
  upstream where possible
- [ ] Third-party SaaS MCP proxy - remote HTTP MCP endpoints for services like GitHub, Slack, etc.
  supported through the same upstream provider config model
- [ ] End-to-end documentation and test coverage for proxy mode (#218)

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

- **Existing codebase:** mcp4openapi is a TypeScript/Node.js MCP server (Express, MCP SDK 1.26.0,
  jose for JWT, Zod for schema validation). The HTTP transport already handles SSE sessions,
  multi-tenancy, OAuth provider, and interceptor chains (auth -> rate-limit -> retry -> fetch).
- **Tracking issue:** davidruzicka/mcp4openapi#211 groups the full MCP proxy roadmap. Issues
  #213-#218 map directly to the active requirements above. #212 (upstream config schema) is done.
- **Deployment target:** On-prem / private cloud. No public internet exposure. Docker/Kubernetes
  packaging assumed.
- **Client auth model:** SSO/OIDC tokens from the company IdP (Entra ID, Okta, Keycloak) for
  interactive users; API keys for machine-to-machine. Both paths must resolve to a team identity
  before policy is checked.
- **Upstream auth model:** Pass-through. Clients supply their own upstream credentials at HTTP
  session initialization. The gateway extracts and stores them in the session context, then forwards
  them on each upstream call. No credential storage or rotation responsibility on the gateway.
- **Security posture:** SSRF protection already in place. Token redaction in logs. Trust boundaries:
  inbound client auth and upstream auth are fully separate layers.

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
| Pass-through upstream credentials | Gateway stores no secrets - client owns their own upstream tokens; simpler security model, no vault dependency | - Pending |
| Remote HTTP upstream first, stdio deferred | Stdio adds process isolation complexity; HTTP upstream covers the primary enterprise use case first | - Pending |
| Build on mcp4openapi transport stack | Existing SSE session management, OAuth provider, multi-tenant HTTP transport are production-grade; extend rather than rewrite | - Pending |
| Team-level allow/deny (not RBAC/ABAC) | Explicit allow/deny per team is auditable and predictable; ABAC adds authoring overhead before adoption | - Pending |
| Tool namespacing by upstream provider | Prevents tool name collisions across providers; makes audit logs and policy rules unambiguous | - Pending |

---
*Last updated: 2026-03-26 after initialization*

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
