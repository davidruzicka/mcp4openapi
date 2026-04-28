# Project Research Summary

**Project:** mcp4openapi - Enterprise MCP Gateway
**Domain:** MCP proxy/gateway with enterprise auth, policy, audit, and observability
**Researched:** 2026-03-26
**Confidence:** HIGH

## Executive Summary

mcp4openapi is being extended from an OpenAPI-to-MCP adapter into a full enterprise MCP gateway. The pattern is well-established in adjacent systems (Kong, Envoy, Microsoft mcp-gateway): a filter-chain pipeline gates inbound clients on identity, enforces team-level policy, routes tool calls to upstream MCP servers using credentials the client supplies at session init, and emits structured audit trails. The key differentiator is the hybrid mode - serving both OpenAPI-backed tools and proxied upstream MCP tools through the same session, which no existing competitor offers. The recommended build order is upstream connections first, client auth second, credential pass-through third, policy fourth, then observability as a cross-cutting cap.

The chosen stack requires minimal new dependencies. Three new runtime additions cover the full feature set: `openid-client` for OIDC token validation, `pino` for audit logging, and the OTel SDK (5 packages) for distributed tracing. Everything else reuses what is already in the codebase: the MCP SDK Client (same package, upgrade to 1.28.0), `jose` for raw JWT ops, `express-rate-limit` for rate limiting, and `prom-client` for metrics. Policy enforcement requires no external library; a Zod-validated in-memory allow/deny map is sufficient for the v1 scope. The MCP SDK client and OTel instrumentation have medium-confidence integration points that need early testing.

The highest risks cluster around Phase 1: credential leakage in error paths, SSRF on upstream URLs, SSE connection lifecycle mismatch, and session memory leak. These are not theoretical - they are based on real CVEs and real MCP implementation issues. Each has a specific prevention strategy tied to existing code (`auth-redaction.ts`, `ssrf-validator.ts`, session cleanup hooks). The MCP-specific risks - tool poisoning via upstream description mutation and policy bypass via tool name homoglyphs - are well-documented and the existing codebase already has the right patterns (`tool-filter` NFC normalization, `UPSTREAM_TOOL_PREFIX_PATTERN`); they just need to be applied to the upstream tool path.

## Key Findings

### Recommended Stack

The stack is additive - the existing TypeScript/Node.js/Express/MCP SDK/Zod/jose/prom-client base covers most of the ground. Three packages are net-new. `openid-client` v6 (by the same author as `jose`) handles OIDC discovery, token introspection, and userinfo without the browser-flow overhead of passport.js. `pino` v10 handles audit logging separately from the existing `ConsoleLogger`/`JsonLogger` - audit and application logging are different concerns with different transport and retention requirements. The OTel SDK handles tracing-only; `prom-client` continues handling metrics and supports OTel exemplars natively, avoiding dual-registry conflicts.

See `.planning/research/STACK.md` for the full alternatives analysis and integration notes.

**Core technologies:**
- `@modelcontextprotocol/sdk` (upgrade to 1.28.0): MCP Client for upstream connections - already a dependency, Client API is in the same package
- `openid-client` 6.8.x: OIDC Relying Party for client authentication - OpenID Certified, ESM-native, same author as `jose`
- `pino` 10.3.x + `pino-http`: Structured audit logging - 5x faster than winston, worker-thread transports for async persistence
- `@opentelemetry/sdk-node` + `@opentelemetry/api` + targeted instrumentations: Distributed tracing - OTel 2.0 stable, Express 5 supported, OTLP export
- In-house allow/deny map (no library): Policy engine - v1 scope is flat allow/deny per team; Casbin/OPA are overkill

### Expected Features

See `.planning/research/FEATURES.md` for the full dependency graph and rationale per feature.

**Must have (table stakes):**
- T12 Upstream registry config - admins declare upstream providers in profile; already partially done (PR #219)
- T11 Session lifecycle management - downstream-to-upstream session mapping, TTL cleanup, reconnect
- T3 Pass-through credential forwarding - client supplies tokens at init; gateway forwards, never persists
- T2 Upstream MCP proxy - tools/list + tools/call forwarded to correct upstream provider
- T4 Tool namespacing - `{provider}__{toolname}` prefix prevents cross-provider collisions
- T10 Graceful error handling - upstream failures surface as structured MCP errors, not HTTP 502s
- T1 Client authentication gate - OIDC (Entra ID/Okta/Keycloak) + API keys for M2M
- T5 Team-level allow/deny policy - governance gate; required for enterprise security approval
- T7 Token redaction (extend existing) - upstream credentials must never appear in logs or errors
- T6 Structured audit logging - SOC 2 / ISO 27001 baseline; who called what, when, outcome
- T8 Rate limiting (extend existing) - per-client-identity and per-tool dimensions
- T9 Upstream health checks / circuit breaker - passive failure tracking per upstream

**Should have (competitive):**
- D6 Prometheus metrics with gateway dimensions - upstream, team, tool, policy_decision labels
- D2 OpenTelemetry trace propagation - multi-hop tracing from client through gateway to upstream
- D1 OpenAPI + MCP hybrid mode - unique differentiator; serve both sources in same session
- D3 Upstream notification forwarding - tools/list_changed propagated to downstream SSE clients
- D5 Policy dry-run mode - audit mode that logs would-be denials without enforcing them
- D4 Per-tool rate limiting with budgets - quota per (team, tool) pair across time windows

**Defer (v2+):**
- Stdio upstream MCP processes - process isolation risk, blocks horizontal scaling
- Server-side credential storage / vault integration - pass-through model eliminates the need
- ABAC / RBAC - team-level allow/deny covers v1; ABAC requires authoring tooling before adoption
- Admin UI, auto-discovery, response caching, load balancing across upstream replicas, plugin system

### Architecture Approach

The gateway follows the industry-standard filter-chain pipeline: `Transport -> ClientAuthGate -> SessionManagement -> PolicyEngine -> ToolRouter -> Execution -> Audit/OTel`. The critical insight for MCP is that the pipeline must distinguish between session lifecycle events (initialize, reconnect, terminate) and operational requests (tools/list, tools/call), because sessions carry upstream connection state. Auth runs before session creation to block unauthenticated clients from consuming upstream resources. Policy runs before routing to ensure denied calls never reach upstream servers. Audit wraps everything to capture both allowed and rejected operations.

The existing codebase provides strong integration points: `EnterpriseAuthProvider` + `JwksCache` for OIDC validation, `InboundAuthTokenStore` for API key lookup, `ToolFilterService` strategy pattern for policy composition, `SSRFValidator` for upstream URL validation, and the existing `SSEStreamState` infrastructure for notification forwarding.

See `.planning/research/ARCHITECTURE.md` for the full pipeline diagram, component interface table, data flow diagrams, and scalability analysis.

**Major components:**
1. **ClientAuthGate** - validates OIDC tokens or API keys, resolves team identity; Express middleware before session handler
2. **UpstreamConnectionManager** - per-session MCP client connections to upstream providers, lazy connect, health monitoring
3. **UpstreamToolRegistry** - aggregates and namespaces tools from all upstream providers per session
4. **PolicyEngine** - evaluates team allow/deny rules against tool+provider; composes with existing ToolFilterService
5. **ToolRouter** - determines OpenAPI vs upstream execution path; stateless lookup
6. **NotificationForwarder** - relays upstream SSE events to downstream clients with debounce and buffer
7. **AuditLogger** - append-only structured JSON log per tool call; pino transport, separate from app logger
8. **OTelIntegration** - trace context propagation, per-stage spans, OTLP export

### Critical Pitfalls

See `.planning/research/PITFALLS.md` for the full priority table per phase and all sources.

1. **Credential leakage in error paths (S1, CRITICAL)** - pass-through credentials can surface in error messages, stack traces, 500 responses, Prometheus labels. Prevention: extend `auth-redaction.ts` to cover upstream credential field names; enforce redaction at the JSON-RPC serializer and Express error handler boundary; add integration tests that inject credentials into error paths.

2. **SSRF via upstream MCP URLs (S2, CRITICAL)** - upstream connection establishment is a separate code path from existing `SSRFValidator` proxy downloads. Prevention: reuse `SSRFValidator` on upstream URL at connection time; pin DNS resolution at connect; block cloud metadata endpoints unconditionally; validate at profile load AND at connection time.

3. **SSE upstream connection lifecycle mismatch (R1, CRITICAL)** - upstream SSE connections can die silently; TCP keepalive may not detect failure for minutes; intermediate proxies close idle connections. Prevention: application-level heartbeats (15-30s); explicit connection state machine (CONNECTING/CONNECTED/RECONNECTING/FAILED); bounded exponential backoff before FAILED; `Last-Event-ID` replay on reconnect.

4. **Session memory leak (R3, HIGH)** - each session holds upstream connections, credential refs, cached tool lists, and event queues; SSE disconnects can be silent. Prevention: session reaper on a fixed interval; explicit upstream connection close on session end; hard limits on max concurrent sessions; Prometheus gauge for active sessions.

5. **Tool poisoning via upstream description mutation (S4, HIGH)** - compromised upstream changes tool descriptions to inject prompt manipulation payloads after initial discovery. Prevention: hash tool schemas at first discovery; alert or reject on unexpected change; allow admin freeze of tool definitions per upstream; strip instruction-like content from descriptions.

## Implications for Roadmap

The FEATURES.md critical path and ARCHITECTURE.md build order agree: upstream connection infrastructure must come first because everything else depends on it. Client auth can be built in parallel with Phase 1 but policy requires both auth (for team identity) and connections (for tool resolution). Audit/OTel wraps all prior phases and is easiest to add after the other layers are stable.

### Phase 1: Upstream Connection Foundation
**Rationale:** Everything else depends on working upstream connections. Without this, there is no product - just a wall. ARCHITECTURE.md names this as the foundation layer explicitly.
**Delivers:** A session can discover and call tools on a single upstream HTTP MCP server. Static credentials (env var / profile config) sufficient for this phase.
**Addresses:** T12 (upstream registry), T11 (session lifecycle), T2 (proxy core), T4 (namespacing), T10 (error handling)
**Avoids:** S2 (SSRF on upstream URLs), R1 (SSE lifecycle), R3 (session memory leak), M1 (protocol version mismatch), M3 (initialize handshake correctness)

### Phase 2: Client Authentication Gate
**Rationale:** Policy (Phase 3) needs resolved team identity. Phase 1 can work with static auth for development. Client auth is a prerequisite, not the first thing to build.
**Delivers:** Only authenticated clients create sessions. Identity attached to session. Unauthenticated requests rejected before any upstream resource is consumed.
**Addresses:** T1 (OIDC + API key auth)
**Uses:** `openid-client` 6.x, existing `EnterpriseAuthProvider`/`JwksCache`/`InboundAuthTokenStore`
**Avoids:** (enables S3 - confused deputy prevention by establishing canonical team identity)

### Phase 3: Pass-Through Credentials + Policy
**Rationale:** Replaces static env-var credentials from Phase 1 with client-supplied tokens. Policy depends on both auth (Phase 2) and connections (Phase 1) being stable. These two features ship together because they complete the security gate: credentials in, policy enforced, denied calls never reach upstream.
**Delivers:** Clients supply their own upstream tokens at session init. Team-level allow/deny enforced on tools/list and tools/call. Denied calls return structured MCP errors.
**Addresses:** T3 (pass-through credentials), T5 (allow/deny policy), T7 (extend token redaction)
**Uses:** In-house policy engine (Zod-validated Map), existing `ToolFilterService` strategy pattern
**Avoids:** S1 (credential leakage), S3 (confused deputy via immutable provider IDs), S5 (policy bypass via tool name normalization)

### Phase 4: Audit + Observability
**Rationale:** Compliance requirement but cross-cutting - wraps all prior phases. Easier to add after the core pipeline is stable. Rate limiting extension is low-effort and rounds out the security posture.
**Delivers:** Every tool call logged with identity, team, tool name, upstream, outcome, trace ID. Distributed traces from client through gateway to upstream. Prometheus metrics with gateway dimensions. Per-client rate limiting.
**Addresses:** T6 (audit logging), T8 (rate limiting extension), D6 (Prometheus with gateway dimensions), D2 (OTel tracing)
**Uses:** `pino` 10.x, OTel SDK + `@opentelemetry/instrumentation-express` + `@opentelemetry/instrumentation-http`, existing prom-client
**Avoids:** O1 (audit log gaps under load), O2 (multi-hop debugging gaps)

### Phase 5: Production Hardening
**Rationale:** Health checks and circuit breakers require observability (Phase 4) to be meaningful. Notification forwarding depends on stable upstream connections (Phase 1). These round out the "production-trustworthy" story.
**Delivers:** Upstream circuit breakers prevent cascading failure. tools/list_changed propagated to clients. OpenAPI + MCP hybrid mode operational. Policy dry-run for admin validation.
**Addresses:** T9 (health checks/circuit breaker), D3 (notification forwarding), D1 (hybrid mode), D5 (policy dry-run)
**Avoids:** R2 (cascading failure), R4 (notification storm amplification), M2 (tool schema validation), M4 (cross-session cache poisoning)

### Phase Ordering Rationale

- Phase 1 before Phase 2: upstream connections are a prerequisite for policy; auth can be stubbed for local dev
- Phase 2 before Phase 3: pass-through credentials need canonical team identity to avoid confused deputy (S3)
- Phase 3 combines credentials + policy: both complete the security gate; shipping credentials without policy leaves governance open
- Phase 4 after the pipeline is stable: audit wraps all stages; adding it early means re-wrapping as stages are added
- Phase 5 last: health checks, notifications, and hybrid mode are "make it production-trustworthy" features that only make sense once the core pipeline is proven

### Research Flags

Phases likely needing deeper research during planning:
- **Phase 1:** SSE upstream connection state machine design (LibreChat #11868 is a real pattern; the reconnect + heartbeat + buffering logic needs concrete API design before implementation)
- **Phase 1:** MCP protocol version negotiation (spec has had 3 revisions in 12 months; upstream compatibility matrix needs to be established early)
- **Phase 3:** Credential pass-through transport design (how clients deliver upstream credentials at initialize - custom header vs init params - needs MCP spec validation)

Phases with standard patterns (skip research-phase):
- **Phase 2:** OIDC token validation via openid-client is a solved problem with official docs; `EnterpriseAuthProvider` already does JWKS-based JWT validation
- **Phase 4:** pino audit logging and OTel tracing are well-documented; the integration pattern is standard Express middleware
- **Phase 5:** Circuit breaker pattern is textbook; notification debounce is a well-understood event-driven pattern

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | All recommendations verified on npm with explicit versions; alternatives explicitly rejected with rationale |
| Features | MEDIUM-HIGH | Cross-referenced against 3+ MCP gateway products; some differentiator features (D3-D7) are inferred from adjacent markets |
| Architecture | HIGH | Pipeline model verified against Envoy/Kong/Microsoft mcp-gateway; existing codebase integration points confirmed by code review |
| Pitfalls | HIGH | S1-S5 backed by OWASP MCP Top 10, real CVEs, Invariant Labs PoC; R1-R3 backed by MCP spec discussion and real implementations |

**Overall confidence:** HIGH

### Gaps to Address

- **OTel + prom-client coexistence under load:** prom-client exemplar support is documented but the dual-system integration needs an early integration test to confirm no registry conflicts. Flag for Phase 4 planning.
- **Express 5 + OTel instrumentation compatibility:** `@opentelemetry/instrumentation-express` lists Express 5 support but it is not the default tested version. Add an integration test in Phase 4 before committing to this pairing.
- **Upstream credential delivery mechanism:** The MCP spec 2025-03-26 does not define a standard for clients to supply upstream credentials at initialize. Custom header vs initialize params vs out-of-band. This needs a concrete design decision in Phase 3 that is compatible with the spec and with common MCP client implementations.
- **Per-upstream connection pooling at scale:** The architecture notes that 1K+ sessions with N providers each will need connection pooling per upstream. The v1 in-memory Map is sufficient for initial deployment but the pool design should be considered in Phase 1 to avoid a breaking refactor later.

## Sources

### Primary (HIGH confidence)
- `src/auth/auth-redaction.ts`, `src/security/ssrf-validator.ts`, `src/profile/upstream-mcp-config.ts`, `src/transport/http-transport.ts` - existing codebase; primary reference for integration points
- [MCP Spec 2025-03-26](https://modelcontextprotocol.io/specification/2025-03-26/basic/lifecycle) - session lifecycle and capability requirements
- [MCP Security Best Practices (draft)](https://modelcontextprotocol.io/specification/draft/basic/security_best_practices) - official security guidance
- [OWASP MCP Top 10](https://owasp.org/www-project-mcp-top-10/) - authoritative MCP risk taxonomy
- [Invariant Labs - MCP Tool Poisoning](https://invariantlabs.ai/blog/mcp-security-notification-tool-poisoning-attacks) - working PoC for S4
- [@modelcontextprotocol/sdk on npm](https://www.npmjs.com/package/@modelcontextprotocol/sdk) - Client API, version 1.28.0
- [openid-client on npm](https://www.npmjs.com/package/openid-client) - version 6.8.2, OpenID Certified
- [pino on npm](https://www.npmjs.com/package/pino) - version 10.3.1
- [OpenTelemetry JS SDK 2.0 announcement](https://opentelemetry.io/blog/2025/otel-js-sdk-2-0/) - SDK stability confirmation
- [Microsoft mcp-gateway](https://github.com/microsoft/mcp-gateway) - session-aware routing reference implementation

### Secondary (MEDIUM confidence)
- [Composio: 10 Best MCP Gateways 2026](https://composio.dev/content/best-mcp-gateway-for-developers) - competitive landscape
- [Kong: What is an MCP Gateway?](https://konghq.com/blog/learning-center/what-is-a-mcp-gateway) - enterprise requirements framing
- [MintMCP docs](https://www.mintmcp.com/docs/security/audit-observability) - audit and rate limit patterns
- [LibreChat #11868](https://github.com/danny-avila/LibreChat/issues/11868) - real SSE reconnection bug (R1 evidence)
- [MCP Discussion #102](https://github.com/modelcontextprotocol/modelcontextprotocol/discussions/102) - session garbage collection known problem (R3 evidence)
- [Envoy AI Gateway MCP Implementation](https://aigateway.envoyproxy.io/blog/mcp-implementation/) - pipeline pattern reference

### Tertiary (LOW confidence)
- [MCP Gateway Architecture Comparison (Skywork)](https://skywork.ai/blog/mcp-server-vs-mcp-gateway-comparison-2025/) - aggregator content, used for competitive context only

---
*Research completed: 2026-03-26*
*Ready for roadmap: yes*
