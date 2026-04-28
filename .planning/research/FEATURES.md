# Feature Landscape

**Domain:** Enterprise MCP Gateway / Proxy
**Researched:** 2026-03-26
**Overall confidence:** MEDIUM-HIGH

## Table Stakes (Must Have)

Features enterprises expect before adopting a gateway. Missing any of these means the product is evaluated as "not enterprise-ready" and rejected.

| # | Feature | Why Expected | Complexity | Notes |
|---|---------|--------------|------------|-------|
| T1 | **Client authentication gate (SSO/OIDC + API keys)** | Every enterprise gateway authenticates inbound traffic. No auth = no deployment. Kong, Envoy, AWS API GW all gate on identity first. | Medium | Already have OAuth 2.0 provider and multi-auth. Need OIDC token validation (Entra ID, Okta, Keycloak) and API key registry. Use `jose` (already in deps) for JWT/JWKS validation. |
| T2 | **Upstream MCP proxy (tools/list + tools/call forwarding)** | The core value proposition. Without forwarding tool calls to upstream servers, there is no gateway - just a wall. | High | Session-scoped upstream connections. Must handle streamable HTTP MCP transport. Map downstream sessions to upstream sessions 1:1. |
| T3 | **Pass-through credential forwarding** | Enterprises will not let a gateway store upstream secrets (vault integration is a whole compliance exercise). Pass-through means the gateway holds no secrets beyond the session lifetime. | Medium | Extract credentials from session init, store in session context, forward on each upstream call. Credentials must never persist to disk or logs. |
| T4 | **Tool namespacing** | Multiple upstream servers will have tools named `search`, `create_issue`, etc. Without namespacing, collisions make the gateway unusable. Every MCP gateway in the market (Kong AI Gateway, MintMCP, Microsoft mcp-gateway) namespaces tools. | Low | Prefix with provider name: `github__search`, `slack__send_message`. Separator must be valid in MCP tool names. |
| T5 | **Team-level allow/deny tool policy** | Enterprises need to restrict which teams can call which tools. This is the governance story. Without policy, security teams will not approve deployment. Kong and Envoy both gate on policy before forwarding. | Medium | Allow/deny lists per team identity. Evaluated after auth, before upstream call. Start with tool-name and upstream-server granularity. |
| T6 | **Structured audit logging** | Compliance (SOC 2, ISO 27001, GDPR) requires immutable records of who called what, when, and what happened. Every enterprise API gateway provides this. MintMCP and Portkey both market audit logging as a primary feature. | Medium | Structured JSON logs: client identity, team, tool name, upstream server, request timestamp, response status, duration. Must support export to SIEM (stdout JSON is sufficient for v1 - Fluentd/Logstash picks it up). |
| T7 | **Token/secret redaction in logs and errors** | Credentials must never appear in logs, error messages, or metrics labels. This is a security baseline, not a feature. Already partially implemented in mcp4openapi. | Low | Already have token redaction. Extend to cover upstream credentials in session context, error stack traces, and any new log paths. |
| T8 | **Rate limiting (per-client, per-tool)** | Prevents runaway AI agents from overwhelming upstream servers. Standard in every API gateway. Already have token-bucket rate limiting in the interceptor chain. | Low | Extend existing rate limiter to support per-client-identity and per-tool dimensions. Existing interceptor chain handles the mechanics. |
| T9 | **Health checks for upstream servers** | Gateway must know when an upstream is down. Without health checks, failed calls cascade and clients get opaque errors. Kong, Envoy, and every production proxy implement active/passive health checks. | Medium | Passive health checks (track error rates per upstream) for v1. Active health checks (periodic pings) can follow. Circuit breaker pattern: closed -> open -> half-open. |
| T10 | **Graceful error handling and upstream failure reporting** | When an upstream fails, clients need structured MCP errors (not HTTP 502 pages). Gateway must translate upstream failures into proper MCP error responses. | Low | Map upstream HTTP errors and MCP errors to downstream MCP error responses. Include upstream provider name in error for debuggability (but not credentials). |
| T11 | **Session lifecycle management** | MCP is stateful. Gateway must manage downstream-to-upstream session mapping, handle reconnects (SSE replay), and clean up sessions on disconnect. Microsoft mcp-gateway lists session-aware routing as a core feature. | High | 1:1 downstream-to-upstream session mapping. Session store (in-memory for single-node, Redis/similar for multi-node). TTL-based cleanup. Reconnect with SSE event replay. |
| T12 | **Configuration-driven upstream registry** | Admins must be able to add/remove upstream MCP servers without code changes. Profile-driven configuration is already the pattern in mcp4openapi. | Low | Extend existing profile/config system. UpstreamMcpProvider schema already exists (PR #219). Add registry of upstream providers to gateway config. |

## Differentiators

Features that create competitive/adoption advantage but are not blocking for v1 adoption. Build these to stand out from Microsoft mcp-gateway and raw Envoy-based solutions.

| # | Feature | Value Proposition | Complexity | Notes |
|---|---------|-------------------|------------|-------|
| D1 | **OpenAPI + MCP hybrid mode** | Unique to mcp4openapi. Serve both OpenAPI-backed tools AND proxied upstream MCP tools through the same gateway. No competitor does this - they are either pure MCP proxy (Microsoft mcp-gateway) or pure API gateway (Kong). | Medium | Already have OpenAPI tool generation. Proxy mode is additive. Tools from both sources appear in tools/list. Namespacing distinguishes origin. |
| D2 | **OpenTelemetry trace propagation** | Distributed tracing through the gateway to upstream servers. Enables enterprises to see the full request path in Jaeger/Zipkin/Datadog. Goes beyond basic logging. | Medium | Propagate W3C traceparent header. Emit spans for: client auth, policy evaluation, upstream call, response. OTel SDK for Node.js is mature. |
| D3 | **Upstream notification forwarding (tools/list_changed)** | When upstream servers add/remove tools, downstream clients learn immediately. Without this, clients have stale tool lists until session restart. | Medium | Subscribe to upstream SSE events. Forward tools/list_changed to downstream. Replay on reconnect. Requires upstream session management to be solid first. |
| D4 | **Per-tool rate limiting with budget constraints** | Beyond per-client rate limiting: set quotas per tool (e.g., "team X can call expensive_analysis at most 100 times/day"). Lunar.dev MCPX and MintMCP offer this. | Medium | Extend rate limiter with tool-name dimension and configurable windows (per-minute, per-hour, per-day). Store counters per (client, tool) pair. |
| D5 | **Policy dry-run / simulation mode** | Let admins test policy changes before enforcing them. Log what would be denied without actually denying. Reduces risk of misconfigured policies breaking production. | Low | Add `mode: enforce | audit` to policy config. In audit mode, log the deny decision but allow the call through. Simple flag check in policy evaluator. |
| D6 | **Prometheus metrics with gateway dimensions** | Extend existing Prometheus metrics with gateway-specific dimensions: upstream_provider, client_team, tool_name, policy_decision. Enables dashboards and alerting. | Low | Already have prom-client. Add counters/histograms for: tool_calls_total{upstream, team, tool, status}, policy_decisions_total{team, tool, decision}, upstream_latency_seconds{upstream}. |
| D7 | **Tool description rewriting / parameter locking** | Customize how upstream tools appear to clients. Rewrite descriptions for clarity, lock parameters to fixed values (e.g., always set `org` to "acme-corp"). Lunar.dev MCPX offers this. | Medium | Transform tool schemas at proxy time. Description override and parameter default/lock in upstream provider config. Applied during tools/list aggregation. |
| D8 | **Multi-upstream tool aggregation with conflict resolution** | When multiple upstreams provide similar tools, gateway can expose a preferred one and hide duplicates. Beyond simple namespacing. | Low | Priority ordering in upstream registry. Admin can mark tools as hidden per upstream. Conflict resolution config in upstream provider definition. |
| D9 | **Request/response payload logging (opt-in)** | For debugging and compliance, optionally log full tool call arguments and responses. Must be opt-in due to data sensitivity. | Low | Configurable per upstream or per tool. Defaults to OFF. When enabled, log payloads with redaction rules applied. Warn in config validation that this captures potentially sensitive data. |

## Anti-Features (Defer from v1)

Features to deliberately NOT build. Each has a clear reason for exclusion.

| # | Anti-Feature | Why Avoid | What to Do Instead |
|---|--------------|-----------|-------------------|
| A1 | **Stdio upstream MCP processes** | Process isolation is undefined. Spawning child processes from a gateway creates security boundary issues, resource management complexity, and makes horizontal scaling nearly impossible. Microsoft mcp-gateway supports this but acknowledges it as a separate deployment model. | Support remote HTTP MCP only. Stdio servers must be wrapped in an HTTP adapter externally (e.g., mcp-proxy, supergateway). Document this as a deployment pattern. |
| A2 | **Server-side credential storage / vault integration** | Pass-through model eliminates the need. Vault integration (HashiCorp Vault, AWS Secrets Manager) adds a dependency, compliance surface, and rotation complexity. The pass-through model is simpler and shifts credential management to teams. | Pass-through credentials only. Document that teams manage their own upstream tokens. |
| A3 | **ABAC (Attribute-Based Access Control)** | Team-level allow/deny covers v1 needs. ABAC requires a policy language (OPA/Rego, Cedar), policy authoring tooling, and testing infrastructure. Massive scope expansion for marginal v1 benefit. | Ship team-level allow/deny. Design the policy interface to be replaceable so ABAC can be added later without breaking changes. |
| A4 | **Admin UI / Dashboard** | Building a web UI is a separate product. CLI + config files + Prometheus/Grafana is the standard ops pattern for infrastructure. Kong charges enterprise pricing for its dashboard. | Provide JSON config, CLI validation (`npm run validate`), Prometheus metrics endpoint. Point users to Grafana dashboards. |
| A5 | **Multi-cloud / public internet deployment** | On-prem/private cloud is the deployment target. Public internet exposure requires WAF, DDoS protection, edge TLS termination, geographic routing - all out of scope. | Document Kubernetes/Docker deployment for private networks. SSRF protection already exists for the internal case. |
| A6 | **Request transformation / protocol translation** | Translating between REST, GraphQL, gRPC, and MCP at the gateway layer is a huge scope expansion. The gateway proxies MCP-to-MCP. OpenAPI-to-MCP translation already exists as a separate feature. | Keep MCP-to-MCP proxy clean. OpenAPI tool generation continues as a separate, already-working feature path. |
| A7 | **Built-in secret rotation** | Rotating upstream credentials is the responsibility of the credential owner (the client team), not the gateway. Adding rotation means the gateway must understand each upstream's auth model. | Document that credentials are session-scoped and clients must supply fresh tokens. Short session TTLs naturally force credential refresh. |
| A8 | **Plugin / extension system** | Building a plugin architecture (like Kong's) is a product in itself. Interceptor chain is already extensible in code. A runtime plugin system adds security review burden and compatibility testing. | Interceptor chain is the extension point. Custom interceptors can be added in code. If plugin demand materializes post-v1, design it then. |
| A9 | **Automatic upstream discovery** | Auto-discovering MCP servers on the network (mDNS, service mesh sidecar injection, etc.) adds complexity and security risk. Explicit configuration is more auditable. | Explicit upstream registry in configuration. Admins declare upstreams. No magic. |
| A10 | **Response caching** | MCP tool calls are generally not idempotent (they trigger actions). Caching responses would require understanding tool semantics (read-only vs mutating). Wrong caching = data corruption or stale results. | No caching in v1. If needed later, implement per-tool cache hints where upstream declares cacheability. |
| A11 | **Load balancing across upstream replicas** | MCP sessions are stateful. Load balancing stateful connections requires sticky sessions or distributed session stores, adding complexity. Most enterprises run one instance per upstream MCP server. | Route to a single upstream endpoint per provider. If an upstream needs HA, it handles that internally (its own load balancer). |

## Feature Dependencies

```
T1 (Client auth) ─────────────────┐
                                   ├──> T5 (Tool policy) ──> D5 (Policy dry-run)
T4 (Tool namespacing) ────────────┘

T2 (Upstream proxy) ──────────────┬──> T4 (Tool namespacing)
                                   ├──> T9 (Health checks)
                                   ├──> T11 (Session lifecycle)
                                   ├──> D3 (Notification forwarding)
                                   └──> D7 (Tool rewriting)

T3 (Pass-through credentials) ───> T2 (Upstream proxy)

T11 (Session lifecycle) ──────────> T3 (Pass-through credentials)

T6 (Audit logging) ──────────────> T1 (Client auth) [needs identity]
                                   > T4 (Tool namespacing) [needs tool names]

T8 (Rate limiting) ──────────────> T1 (Client auth) [needs identity for per-client limits]
                                   > T4 (Tool namespacing) [needs tool names for per-tool limits]

T12 (Upstream registry) ─────────> T2 (Upstream proxy)

D1 (Hybrid mode) ────────────────> T4 (Tool namespacing) [distinguish origin]
D2 (OTel tracing) ───────────────> T2 (Upstream proxy) [spans for upstream calls]
D4 (Per-tool rate limits) ───────> T8 (Rate limiting) + T4 (Tool namespacing)
D6 (Prometheus metrics) ─────────> T1 + T4 + T2 [dimensions from auth, tools, upstream]
```

**Critical path:** T12 (config) -> T11 (sessions) -> T3 (credentials) -> T2 (proxy) -> T4 (namespacing) -> T1 (auth) -> T5 (policy) -> T6 (audit)

## MVP Recommendation

### Phase 1: Core proxy (the product works)
1. **T12** - Upstream registry config (extend existing UpstreamMcpProvider schema)
2. **T11** - Session lifecycle management (downstream-to-upstream mapping)
3. **T3** - Pass-through credential forwarding
4. **T2** - Upstream MCP proxy (tools/list + tools/call)
5. **T4** - Tool namespacing
6. **T10** - Graceful error handling

### Phase 2: Security gate (enterprises will adopt)
7. **T1** - Client authentication (SSO/OIDC + API keys)
8. **T5** - Team-level allow/deny policy
9. **T7** - Token redaction (extend existing)
10. **T6** - Structured audit logging
11. **T8** - Rate limiting (extend existing)

### Phase 3: Production hardening (enterprises will trust)
12. **T9** - Upstream health checks / circuit breaker
13. **D6** - Prometheus metrics with gateway dimensions
14. **D2** - OpenTelemetry trace propagation
15. **D1** - OpenAPI + MCP hybrid mode

### Phase 4: Competitive edge
16. **D3** - Upstream notification forwarding
17. **D5** - Policy dry-run mode
18. **D4** - Per-tool rate limiting with budgets
19. **D7** - Tool description rewriting

**Defer indefinitely:** A1-A11 (anti-features listed above)

**Rationale:** Phase 1 proves the product works end-to-end. Phase 2 adds the security story required for enterprise adoption. Phase 3 makes it production-trustworthy. Phase 4 adds competitive differentiation. This ordering ensures each phase delivers usable value and avoids building governance features before the core proxy exists.

## Sources

- [WorkOS: MCP's 2026 roadmap makes enterprise readiness a top priority](https://workos.com/blog/2026-mcp-roadmap-enterprise-readiness) - MCP protocol gaps and enterprise needs
- [Composio: 10 Best MCP Gateways for Developers in 2026](https://composio.dev/content/best-mcp-gateway-for-developers) - Competitive landscape
- [Kong: What is an MCP Gateway?](https://konghq.com/blog/learning-center/what-is-a-mcp-gateway) - Enterprise MCP gateway requirements
- [Microsoft mcp-gateway](https://github.com/microsoft/mcp-gateway) - Session-aware routing, Kubernetes patterns
- [MintMCP: Enterprise Gateway for AI Agents](https://www.mintmcp.com/docs/security/audit-observability) - Audit and observability requirements
- [MintMCP: MCP Gateways for Rate Limiting and Access Control](https://www.mintmcp.com/blog/mcp-gateways-rate-limiting-access-control) - Rate limiting patterns
- [IBM mcp-context-forge: Circuit breakers issue](https://github.com/IBM/mcp-context-forge/issues/301) - Health check and circuit breaker patterns
- [Calmops: API Gateways - Kong, Envoy, Modern API Management 2026](https://calmops.com/software-engineering/api-gateways-kong-envoy-modern-api-management/) - Traditional gateway feature comparison
- [MCP-Manager/MCP-Checklists: Logging, Auditing, Observability](https://github.com/MCP-Manager/MCP-Checklists/blob/main/infrastructure/docs/logging-auditing-observability.md) - MCP-specific observability checklist
- [Paperclipped: MCP Registry & Gateway Enterprise Guide](https://www.paperclipped.de/en/blog/mcp-registry-gateway-enterprise-ai-agents/) - Registry and governance patterns
